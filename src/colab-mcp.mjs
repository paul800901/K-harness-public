// Minimal client for the official Colab remote MCP server
// (https://colaboratory.googleapis.com/mcp). The server is stateless and answers
// initialize with protocolVersion 2025-11-25 (read 2026-11-13 without credentials),
// so every tools/call is a self-contained POST. The bearer token is supplied by
// colab-auth and never appears in errors, diagnostics or history.

import {randomUUID} from 'node:crypto';
import {redactSecrets} from './secret-redact.mjs';

export const COLAB_MCP_URL = 'https://colaboratory.googleapis.com/mcp';
const PROTOCOL = '2025-11-25';

// A tool error is never classified from its wording. The live server's tool
// errors are plain text (the anonymous get_subscription probe returned isError
// with a message and no status code) and no official page gives them a
// structured status, while words such as RESOURCE_EXHAUSTED or UNAVAILABLE can
// appear in any diagnostic. Only the transport and protocol layers carry a
// trusted structured outcome (HTTP status, JSON-RPC code); every tool error is an
// unknown outcome for the caller.
// JSON-RPC protocol errors: the request was never dispatched to a tool
// (MCP 2025-11-25: unknown tools and invalid arguments are protocol errors, a
// failed tool run is a result with isError).
const NOT_DISPATCHED = new Set([-32700, -32600, -32601, -32602]);
// After POST, an HTTP error alone does not establish whether an intermediary
// forwarded the tool call. Only a valid error-only JSON-RPC protocol refusal
// below is definitive; authentication status still invalidates the cached token.

export class ColabError extends Error {
  // definitive: refused before any tool ran (a JSON-RPC protocol error in a
  //   well-formed error-only response) — no side
  //   effect happened. auth: HTTP 401.
  // Everything else is unknown: the caller must not assume the call did or did
  // not take effect.
  constructor(message, {definitive = false, auth = false, malformed = false} = {}) {
    super(redactSecrets(message));
    this.definitive = definitive;
    this.auth = auth;
    this.malformed = malformed;
  }
}

// Keep at most a short, token-free reason; never echo request bodies or headers.
// Exact known values (e.g. runtime proxy tokens) are removed BEFORE shortening,
// so a cut can never leave part of one behind.
const reason = (value, known) => redactSecrets(value, known).slice(0, 300);
const malformed = what => new ColabError(`Colab 回應格式不符（${what}）；結果不明`, {malformed: true});
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readSse(body, id, onProgress) {
  const decoder = new TextDecoder();
  let buffer = '';
  const frame = text => {
    const data = text
      .split(/\r?\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data) return undefined;
    const message = JSON.parse(data);
    if (message.id === id) return message;
    if (message.method === 'notifications/progress') onProgress?.(message.params);
    return undefined;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, {stream: true});
    let boundary;
    while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
      const message = frame(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (message) return message;
    }
  }
  return buffer.trim() ? frame(buffer) : undefined;
}

export function createColabMcp({accessToken, fetchImpl = fetch, url = COLAB_MCP_URL} = {}) {
  const post = (token, body, signal, method, name) =>
    fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        'mcp-method': method,
        ...(name ? {'mcp-name': name} : {})
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error'
    });

  return {
    // Returns the tool's structured result object. A network failure, a 5xx, a
    // lost or malformed response is NOT definitive: the caller decides what is
    // unknown and never treats it as success or as "gone".
    // `secrets` returns exact in-memory values to remove from any error text.
    async call(name, args = {}, {signal, onProgress, secrets} = {}) {
      const why = value => reason(value, secrets?.());
      const toolError = text => new ColabError(`Colab 回報錯誤：${why(text)}`);
      const token = await accessToken();
      const id = randomUUID();
      const progressToken = onProgress ? randomUUID() : undefined;
      const request = {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {name, arguments: args, ...(progressToken ? {_meta: {progressToken}} : {})}
      };
      const local = new AbortController();
      const cancel = () => {
        // 2025-11-25 Streamable HTTP: notifications/cancelled (Colab execute_code
        // documents this flow), then drop the response stream. Best effort only.
        post(
          token,
          {jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: id, reason: 'K cancelled'}},
          AbortSignal.timeout(10000),
          'notifications/cancelled'
        )
          .then(response => response.body?.cancel())
          .catch(() => {});
        local.abort(signal.reason);
      };
      if (signal?.aborted) throw signal.reason;
      signal?.addEventListener('abort', cancel, {once: true});
      try {
        let response;
        try {
          response = await post(token, request, local.signal, 'tools/call', name);
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          throw new ColabError(`無法連上 Colab（${why(error?.message)}）`);
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new ColabError(`Colab 回應 HTTP ${response.status}；結果不明`, {auth: response.status === 401});
        }
        let message;
        try {
          message = (response.headers.get('content-type') ?? '').includes('text/event-stream')
            ? await readSse(response.body, id, onProgress)
            : await response.json();
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          throw new ColabError(`Colab 回應中斷（${why(error?.message)}）`);
        }
        if (!message) throw new ColabError('Colab 回應在結果前中斷');
        // Only a JSON-RPC 2.0 response to this exact request counts; anything else
        // (wrong id, no result, non-object result) is an unknown outcome. JSON-RPC
        // 2.0 makes result and error mutually exclusive and requires an error's
        // integer code and string message: a response with both, or a malformed
        // error, contradicts itself and is never read as a refusal.
        if (!isObject(message) || message.jsonrpc !== '2.0' || message.id !== id) throw malformed('id 不符');
        const hasError = Object.hasOwn(message, 'error'),
          hasResult = Object.hasOwn(message, 'result');
        if (hasError && hasResult) throw malformed('同時有 result 與 error');
        if (hasError) {
          const {code, message: text} = isObject(message.error) ? message.error : {};
          if (!Number.isInteger(code) || typeof text !== 'string') throw malformed('error 格式不符');
          if (NOT_DISPATCHED.has(code))
            throw new ColabError(`Colab 拒絕請求（JSON-RPC ${code}）：${why(text)}`, {definitive: true});
          throw toolError(`${code} ${text}`);
        }
        if (!isObject(message.result)) throw malformed('缺少結果');
        const result = message.result;
        if (result.isError === true)
          throw toolError(
            (Array.isArray(result.content) ? result.content : []).map(item => item?.text ?? '').join(' ') ||
              'tool error'
          );
        if (isObject(result.structuredContent)) return result.structuredContent;
        const text = (Array.isArray(result.content) ? result.content : []).find(item => item?.type === 'text')?.text;
        if (typeof text === 'string') {
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {}
          if (isObject(parsed)) return parsed;
        }
        throw malformed('結果不是結構化內容');
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    }
  };
}
