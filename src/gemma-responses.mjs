import {createServer, request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {bearerMatches, readLimitedBody} from './mcp-http-guard.mjs';
import {redactSecrets, redactValue} from './secret-redact.mjs';

// This local Dolphin can stay silent longer than fetch's 300-second body idle limit.
// Keep native cancellation and streaming, without a new dependency or any retry.
export function fetchDolphinInference(url, {idleTimeoutMs = 1230000, ...init}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {method: init.method, headers: init.headers, signal: init.signal}, upstream => {
      if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
        upstream.resume();
        request.destroy(new Error('本機模型推論端點不得重新導向。'));
        return;
      }
      try {
        resolve(
          new Response([204, 205].includes(upstream.statusCode) ? null : Readable.toWeb(upstream), {
            status: upstream.statusCode,
            headers: upstream.headers
          })
        );
      } catch (error) {
        upstream.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    request.setTimeout(idleTimeoutMs, () => request.destroy(new Error('本機模型回應閒置逾時。')));
    request.end(init.body);
  });
}

// Codex 0.163 sends namespace/custom tools; the tested LM Studio Responses endpoint
// exposes only function tools. This translates the wire format, never executes tools,
// runs an agent loop, retries inference, or changes permissions/history.
export function gemmaRequest(body) {
  const aliases = new Map();
  const tools = [];
  const add = (tool, namespace) => {
    if (!['function', 'custom'].includes(tool.type)) throw Error(`自架模型尚未支援工具格式：${tool.type}`);
    const name = namespace ? `${namespace}__${tool.name}` : tool.name;
    if (aliases.has(name)) throw Error('自架模型工具名稱衝突；未送出推論。');
    aliases.set(name, {name: tool.name, namespace, custom: tool.type === 'custom'});
    tools.push(
      tool.type === 'custom'
        ? {
            type: 'function',
            name,
            description: `Transport wrapper: put the complete raw tool text in the JSON input field. The following original instructions apply to that inner text, not the wrapper.\n${tool.description ?? ''}${tool.format?.definition ? '\nInput grammar:\n' + tool.format.definition : ''}`,
            strict: false,
            parameters: {
              type: 'object',
              properties: {input: {type: 'string', description: 'The complete raw tool input.'}},
              required: ['input'],
              additionalProperties: false
            }
          }
        : {...tool, name}
    );
  };
  for (const tool of body.tools ?? []) {
    if (tool.type === 'namespace') for (const child of tool.tools ?? []) add(child, tool.name);
    else add(tool);
  }
  const input = Array.isArray(body.input)
    ? body.input.map(item => {
        if (item.type === 'custom_tool_call') {
          const {input, namespace, ...rest} = item;
          return {
            ...rest,
            type: 'function_call',
            name: namespace ? `${namespace}__${item.name}` : item.name,
            arguments: JSON.stringify({input})
          };
        }
        if (item.type === 'custom_tool_call_output') return {...item, type: 'function_call_output'};
        if (item.type === 'function_call' && item.namespace) {
          const {namespace, ...rest} = item;
          return {...rest, name: `${namespace}__${item.name}`};
        }
        return item;
      })
    : body.input;
  return {body: {...body, input, tools}, aliases};
}

function rawInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText);
    if (typeof parsed?.input === 'string') return parsed.input;
  } catch {}
  // Let the native tool reject malformed model input and return its error to the
  // model. A deterministic argument error must not look like a broken stream.
  return argumentsText ?? '';
}
function nativeItem(item, aliases, {started = false} = {}) {
  const alias = item?.type === 'function_call' && aliases.get(item.name);
  if (!alias) return item;
  const {arguments: args, ...rest} = item;
  return {
    ...rest,
    name: alias.name,
    ...(alias.namespace ? {namespace: alias.namespace} : {}),
    ...(alias.custom ? {type: 'custom_tool_call', input: started ? '' : rawInput(args)} : {arguments: args})
  };
}

export function gemmaResponseEvents(aliases) {
  const custom = new Map();
  return event => {
    const id = event.item?.id ?? event.item_id;
    if (event.type === 'response.output_item.added') {
      const alias = aliases.get(event.item?.name);
      if (alias?.custom) custom.set(id, {args: '', emitted: false});
      return [{...event, item: nativeItem(event.item, aliases, {started: true})}];
    }
    const state = custom.get(id);
    if (event.type === 'response.function_call_arguments.delta' && state) {
      state.args += event.delta ?? '';
      return [];
    }
    const flush = argumentsText => {
      if (!state || state.emitted) return [];
      const input = rawInput(argumentsText ?? state.args);
      state.emitted = true;
      return [
        {type: 'response.custom_tool_call_input.delta', item_id: id, output_index: event.output_index, delta: input},
        {type: 'response.custom_tool_call_input.done', item_id: id, output_index: event.output_index, input}
      ];
    };
    if (event.type === 'response.function_call_arguments.done' && state) return flush(event.arguments);
    if (event.type === 'response.output_item.done')
      return [...flush(event.item?.arguments), {...event, item: nativeItem(event.item, aliases)}];
    if (event.response?.output)
      return [
        {...event, response: {...event.response, output: event.response.output.map(item => nativeItem(item, aliases))}}
      ];
    return [event];
  };
}

// A complete (non-streamed) Responses result replayed as the SSE frames Codex
// reads: each output item done, then the terminal event matching the upstream
// status. Used for the Colab relay (its runtime answers in one piece) and for K's
// own local reply. "failed" and "incomplete" keep their error/incomplete_details;
// any other or missing status is never promoted to completed.
const TERMINAL = {completed: 'response.completed', failed: 'response.failed', incomplete: 'response.incomplete'};
export function terminalFrames(result, aliases) {
  const output = Array.isArray(result?.output) ? result.output.map(item => nativeItem(item, aliases)) : [];
  let response = {...result, output};
  if (!Object.hasOwn(TERMINAL, response.status))
    response = {
      ...response,
      status: 'failed',
      error: {
        code: 'k_selfhost_upstream_status',
        message: `自架模型未回傳完成狀態（${String(result?.status ?? '未標示').slice(0, 40)}）；K 未將它視為完成。`
      }
    };
  const frames = [{type: 'response.created', response: {...response, output: [], status: 'in_progress'}}];
  output.forEach((item, index) => frames.push({type: 'response.output_item.done', output_index: index, item}));
  frames.push({type: TERMINAL[response.status], response});
  return frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
export function localResponse(model, text) {
  const id = `resp_k_local_${randomBytes(8).toString('hex')}`;
  return {
    id,
    object: 'response',
    model,
    status: 'completed',
    output: [
      {
        type: 'message',
        id: `msg_k_local_${randomBytes(8).toString('hex')}`,
        role: 'assistant',
        status: 'completed',
        content: [{type: 'output_text', text, annotations: []}]
      }
    ]
  };
}

// The native room and turn a request belongs to. Native Codex (0.167 observed)
// sends them in x-codex-turn-metadata on every Responses request; null when absent.
export function nativeCaller(headers) {
  try {
    const value = JSON.parse(headers['x-codex-turn-metadata'] ?? 'null');
    return typeof value?.thread_id === 'string' && typeof value?.turn_id === 'string'
      ? {thread: value.thread_id, turn: value.turn_id}
      : null;
  } catch {
    return null;
  }
}
// Native Codex retries 5xx, 408, 409 and 429 within the same turn (0.167 observed:
// 409 four times, 502 twenty-four times) and does not retry 400. A relayed
// Colab answer is sent as 400 whenever a retry could only run inference again.
const RETRIED = status => status >= 500 || [408, 409, 429].includes(status);
const json = (response, status, error) =>
  response.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify({error}));

export async function openGemmaResponses(baseUrl, {fetchImpl = fetch, expectedModel, acquireModel, localReply} = {}) {
  const requests = new Map();
  const token = randomBytes(32).toString('base64url');
  let expectedHost;
  const server = createServer(async (request, response) => {
    if (
      request.headers.host !== expectedHost ||
      request.headers.origin !== undefined ||
      !bearerMatches(request.headers.authorization, token)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    const abort = new AbortController();
    let complete;
    requests.set(
      abort,
      new Promise(resolve => {
        complete = resolve;
      })
    );
    response.on('close', () => abort.abort());
    let lease,
      relay,
      upstreamStarted = false,
      settled = false;
    try {
      let translated, raw;
      try {
        raw = JSON.parse((await readLimitedBody(request, 16 * 1024 * 1024)).toString('utf8'));
        translated = gemmaRequest(raw);
      } catch {
        response
          .writeHead(400, {'content-type': 'application/json'})
          .end(
            JSON.stringify({
              error: {message: '自架模型請求或工具格式無效；未送出推論。', code: 'k_selfhost_request_invalid'}
            })
          );
        return;
      }
      const {body, aliases} = translated;
      if (expectedModel !== undefined && body.model !== expectedModel) {
        response
          .writeHead(400, {'content-type': 'application/json'})
          .end(
            JSON.stringify({
              error: {message: '自架模型與此聊天室連線不符；未送出推論。', code: 'k_selfhost_model_mismatch'}
            })
          );
        return;
      }
      // K answers this request itself (e.g. right after the owner's Colab stop),
      // without acquiring a model: nothing is started and no inference is sent.
      const local = localReply?.(raw, {caller: nativeCaller(request.headers)});
      if (typeof local === 'string') {
        const result = localResponse(body.model, local);
        if (body.stream)
          response.writeHead(200, {'content-type': 'text/event-stream'}).end(terminalFrames(result, aliases));
        else response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(result));
        return;
      }
      if (acquireModel) {
        try {
          lease = await acquireModel({signal: abort.signal, caller: nativeCaller(request.headers)});
        } catch (error) {
          // Busy, refused and unknown preparation are not transient. Codex
          // retries 5xx, which only repeats the same refusal; 400 ends this turn
          // once. The untranslated native CLI result stays in diagnostic.
          const code = /^k_selfhost_/u.test(error?.code ?? '') ? error.code : 'k_selfhost_prepare_failed',
            // The 400 body enters the native history: one redaction boundary for
            // the notice and its diagnostic, whatever the error source.
            text = redactSecrets(error?.message ?? error),
            // Unwrapped native exceptions (e.g. timeouts) are diagnostics, not the notice.
            native = !/\p{Script=Han}/u.test(text),
            diagnostic =
              error?.diagnostic !== undefined ? redactValue(error.diagnostic) : native ? {error: text} : undefined;
          response.writeHead(400, {'content-type': 'application/json'}).end(
            JSON.stringify({
              error: {
                message: native ? '本機模型準備失敗；未送出推論。原始原因見詳細內容。' : text,
                code,
                ...(diagnostic ? {diagnostic} : {})
              }
            })
          );
          return;
        }
        body.model = lease.model;
      }
      abort.signal.throwIfAborted();
      upstreamStarted = true;
      // A Colab lease relays one complete result through its runtime; local routes
      // keep the fixed loopback endpoint.
      relay = lease?.upstream?.respond;
      const upstream = relay
        ? await relay(JSON.stringify({...body, stream: false}), abort.signal)
        : await fetchImpl(`${baseUrl}/responses`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(body),
            signal: abort.signal,
            redirect: 'error'
          });
      if (relay && upstream.ok && body.stream) {
        const result = await upstream.json();
        settled = true;
        await lease.finish({settled: true});
        response.writeHead(200, {'content-type': 'text/event-stream'}).end(terminalFrames(result, aliases));
        return;
      }
      if (relay && RETRIED(upstream.status)) {
        // A complete, known failure of the model server inside the runtime: the
        // runtime stays usable, but a native retry would run inference again.
        const detail = redactSecrets(await upstream.text().catch(() => '')).slice(0, 300);
        settled = true;
        await lease.finish({settled: true});
        json(response, 400, {
          message: `Colab 上的模型服務回傳 HTTP ${upstream.status}；K 不自動重試推論，本回合結束。`,
          code: 'k_selfhost_upstream_status',
          diagnostic: {status: upstream.status, body: detail}
        });
        return;
      }
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      response.writeHead(upstream.status, {'content-type': contentType});
      if (!upstream.ok) {
        const errorBody = await upstream.text();
        settled = true;
        if (relay) await lease.finish({settled: true});
        response.end(errorBody);
        return;
      }
      if (!body.stream) {
        const result = await upstream.json();
        settled = true;
        if (relay) await lease.finish({settled: true});
        response.end(JSON.stringify({...result, output: result.output?.map(item => nativeItem(item, aliases))}));
        return;
      }
      const translate = gemmaResponseEvents(aliases),
        decoder = new TextDecoder();
      let buffer = '';
      const emit = frame => {
        const data = frame
          .split(/\r?\n/u)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data) return;
        if (data === '[DONE]') {
          settled = true;
          response.write('data: [DONE]\n\n');
          return;
        }
        const nativeEvent = JSON.parse(data);
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(nativeEvent.type)) settled = true;
        for (const event of translate(nativeEvent))
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, {stream: true});
        let boundary;
        while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
          emit(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) emit(buffer);
      response.end();
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else if (relay && !settled) {
        // The relayed inference may have run on the runtime; its result is lost.
        // 400 ends this native turn without the native retry that would re-run
        // it; the runtime owner keeps the run unsettled for this turn.
        await lease?.finish({settled: false, cancelled: abort.signal.aborted}).catch(() => {});
        json(response, 400, {
          message:
            'Colab 推論已送出但結果不明（可能已在 runtime 上執行）；K 不重送、不建立新的 runtime，本回合結束。要再試請本人重新送出：K 會先關閉並讀回舊 runtime 再處理。',
          code: 'k_selfhost_inference_unknown',
          diagnostic: {error: redactSecrets(error?.message ?? error).slice(0, 300)}
        });
      } else
        json(response, 502, {
          message: '自架模型協定轉換或連線失敗；未改用其他模型。',
          code: 'k_selfhost_upstream_failed'
        });
    } finally {
      try {
        await lease?.finish({
          settled: !upstreamStarted || settled,
          ...(!settled && upstreamStarted && abort.signal.aborted ? {cancelled: true} : {})
        });
      } catch {
        // The runtime retains an uncertain cancellation/unload result. Do not
        // interrupt K shutdown or retry a possibly completed operation.
      } finally {
        requests.delete(abort);
        complete();
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  expectedHost = `127.0.0.1:${server.address().port}`;
  return {
    baseUrl: `http://${expectedHost}/v1`,
    headers: {Authorization: `Bearer ${token}`},
    async close() {
      for (const abort of requests.keys()) abort.abort();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      await Promise.all(requests.values());
    }
  };
}
