// Colab control adapter for colab-runtime.mjs, using only documented official
// behaviour (https://developers.google.com/colab/api/reference/mcp, read
// 2026-11-13):
//   - create_runtime with a caller-chosen runtimeId and UUID4 requestId, on a spec
//     list_runtime_specs marks eligible; delete_runtime(allowMissing).
//   - presence is read from list_runtimes ("all Colab runtimes currently assigned
//     to the requesting user"): a well-formed list without K's name is the only
//     evidence of "gone". Its schema does not require `runtimes` and proto3 JSON
//     omits an empty repeated field, so a validated `{}` is an empty list. Error
//     text (e.g. a NOT_FOUND substring) or an empty or malformed get_runtime
//     answer never is.
//   - execute_code in a named session with an executionId. A step is sent once
//     and never reissued: the official page says the same executionId starts a
//     NEW execution once its result was returned, and tool errors carry no
//     structured status to tell a reattach point from anything else. An unknown
//     outcome is settled from K's own terminal-state record on the runtime.
//   - file transfer via connectionInfo.url with X-Colab-Runtime-Proxy-Token
//     (PUT /api/contents, GET /files). No other runtime port is assumed reachable:
//     inference is relayed inside the runtime to its own loopback server.
// The connection token is held in memory only and never logged; every error that
// leaves this adapter has the proxy tokens it has seen removed (see `guard`).

import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ColabError} from './colab-mcp.mjs';
import {colabAuthFailure} from './colab-auth.mjs';
import {redactSecrets, redactValue} from './secret-redact.mjs';

const RUNTIME_CODE = readFileSync(fileURLToPath(new URL('../scripts/colab-k-runtime.py', import.meta.url)), 'utf8');
// llama.cpp master at 2026-11-12T23:11:58Z; its server README documents POST /v1/responses.
export const LLAMA_CPP_COMMIT = '5676dfbe01e7ebe0387913680eee0ed39bf4a363';
// GPU memory (GB) of accelerator names Colab uses; unknown names are never chosen.
const VRAM = {T4: 15, L4: 22, A100: 40, H100: 80, G4: 96};
const GB = 1e9;
const VENICE_12_Q4 = '1c76a921c568b5f652c2a5d87d5b051abb1cb8519ceec32b673b766a47b4e9f1';
const base = file => file.path.split('/').at(-1);
// Auxiliary GGUF files that are not the language model itself: vision projectors
// and multi-token-prediction drafts (e.g. "…-FastMTP-32K.gguf"). They are
// downloaded and verified with the source but K does not load them (unverified).
const MMPROJ = /mmproj/iu;
const MTP = /(?:^|[-_.])(?:fast-?)?mtp(?:[-_.]|$)/iu;

// Decide engine input before any runtime exists, so an unsupported source costs nothing.
export function colabPlan(source, contextWindow = 32768) {
  const files = source.files;
  const gguf = files.filter(f => f.path.endsWith('.gguf'));
  const tensors = files.filter(f => f.path.endsWith('.safetensors'));
  let plan;
  if (gguf.length && !tensors.length) {
    const firsts = gguf.filter(f => !/-\d{5}-of-\d{5}\.gguf$/u.test(f.path) || /-00001-of-\d{5}\.gguf$/u.test(f.path));
    const mmproj = firsts.filter(f => MMPROJ.test(base(f)));
    let main = firsts.filter(f => !mmproj.includes(f));
    let mtp = [];
    // An MTP draft is set aside only when exactly one other model file remains;
    // otherwise the source stays ambiguous and is refused.
    if (main.length > 1) {
      const drafts = main.filter(f => MTP.test(base(f)));
      const rest = main.filter(f => !drafts.includes(f));
      if (drafts.length && rest.length === 1) [main, mtp] = [rest, drafts];
    }
    if (main.length !== 1) throw colabRefusal('來源含多個主要 GGUF 檔，K 無法確定要載入哪一個');
    plan = {
      kind: 'gguf',
      main: main[0].path,
      weights: gguf,
      auxiliary: [...mmproj.map(f => ({path: f.path, role: 'mmproj'})), ...mtp.map(f => ({path: f.path, role: 'mtp'}))]
    };
  } else if (tensors.length && !gguf.length && files.some(f => f.path === 'config.json')) {
    const outtype = {BF16: 'bf16', F16: 'f16'}[String(source.quantization ?? '').toUpperCase()];
    // Converting at the published precision only; anything else would change the model.
    if (!outtype) throw colabRefusal(`safetensors 精度 ${source.quantization ?? '未標示'} 無法原精度轉換`);
    plan = {kind: 'safetensors', outtype, weights: tensors, auxiliary: []};
  } else throw colabRefusal('來源不是單一格式的 GGUF 或含 config.json 的 safetensors');
  const bytes = plan.weights.reduce((sum, f) => sum + f.bytes, 0);
  if (
    gguf.length === 1 &&
    plan.kind === 'gguf' &&
    bytes === 14333923104 &&
    gguf[0].sha256 === VENICE_12_Q4 &&
    contextWindow === 49152
  ) {
    // Venice 1.2's 40 layers have 8 KV heads with dimensions of 128 each.
    // K and V use Q8_0 (34 bytes per 32 values), preserving the pinned weights.
    const kvBytes = (2 * 40 * 8 * 128 * contextWindow * 34) / 32;
    return {...plan, bytes, kvCacheQ8: true, needGb: (bytes + kvBytes) / GB + 3};
  }
  // Weights (auxiliary files included, conservatively) plus a KV-cache/runtime
  // margin; never quantize to fit. An estimate, not evidence that it loads.
  return {...plan, bytes, needGb: (bytes * 1.1) / GB + Math.max(6, contextWindow / 4096)};
}
function colabRefusal(message) {
  const error = new Error(`${message}；未建立 runtime、未消耗運算單元。`);
  error.code = 'k_selfhost_prepare_failed';
  error.definitive = true;
  return error;
}
export function chooseSpec(specs, needGb) {
  const fit = (specs ?? [])
    .filter(s => s?.eligible === true && s.key?.variant === 'VARIANT_GPU' && VRAM[s.key.accelerator] >= needGb)
    .sort(
      (a, b) =>
        VRAM[a.key.accelerator] - VRAM[b.key.accelerator] ||
        (b.key.shape === 'SHAPE_HIGHMEM') - (a.key.shape === 'SHAPE_HIGHMEM')
    );
  return fit[0]?.key ?? null;
}
const lines = stdout => String(stdout ?? '').split(/\r?\n/u);
const marker = (stdout, name) => lines(stdout).some(line => line === name || line.startsWith(`${name} `));
const directoryOf = source => `${source.repository.replace('/', '--')}--${source.revision.slice(0, 12)}`;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A runtime step that raised. Only the exception class name and K's own marker
// (K_VERIFY_FAILED, K_SERVER_EXITED, …) are kept; the exception value and
// traceback can carry anything the runtime printed, so they never leave here.
function stepFailure(executionError) {
  const name = /^[A-Za-z_][\w.]{0,79}$/u.test(String(executionError?.name ?? '')) ? executionError.name : 'Error';
  const k = String(executionError?.value ?? '').match(/\bK_[A-Z][A-Z_]{1,40}\b/u)?.[0];
  const error = new Error(`Colab runtime 步驟失敗（${name}${k ? ` ${k}` : ''}）`);
  error.step = {name, marker: k ?? null};
  return error;
}

export function createColabAdapter({mcp, auth, fetchImpl = fetch, engineCommit = LLAMA_CPP_COMMIT, sleep}) {
  const connections = new Map(); // name -> {url, token, expiresAt}
  let subscription = null;
  const wait =
    sleep ??
    ((ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const done = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', done);
          resolve();
        }, ms);
        timer.unref?.();
        signal?.addEventListener('abort', done, {once: true});
      }));
  // Every runtime proxy token Colab has handed this adapter (memory only; it has
  // no documented format, so only exact values can be removed from text).
  const secrets = new Set();
  const known = () => [...secrets];

  async function call(name, args, options) {
    try {
      return await mcp.call(name, args, {...options, secrets: known});
    } catch (error) {
      if (error?.auth) auth.invalidate();
      throw error;
    }
  }
  const saw = runtime => {
    if (typeof runtime?.connectionInfo?.token === 'string') secrets.add(runtime.connectionInfo.token);
  };
  // The single exit for errors: every text an error carries (message, stack, the
  // runtime's exception class name, diagnostics) loses the exact proxy tokens
  // seen so far before it leaves the adapter. Errors are plain objects here, so a
  // changed field is replaced in place.
  function scrub(error) {
    if (error === null || typeof error !== 'object') return new Error(redactSecrets(error, known()));
    for (const key of new Set(['message', 'stack', ...Object.keys(error)])) {
      const value = error[key];
      if (typeof value !== 'string' && (value === null || typeof value !== 'object')) continue;
      const clean = typeof value === 'string' ? redactSecrets(value, known()) : redactValue(value, known());
      let same = false;
      try {
        same = JSON.stringify(clean) === JSON.stringify(value);
      } catch {}
      if (!same)
        Object.defineProperty(error, key, {
          value: clean,
          writable: true,
          configurable: true,
          enumerable: Object.keys(error).includes(key)
        });
    }
    return error;
  }
  const guard =
    fn =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        throw scrub(error);
      }
    };
  const remember = runtime => {
    saw(runtime);
    const info = runtime?.connectionInfo;
    if (!isObject(info) || typeof info.url !== 'string' || typeof info.token !== 'string') return;
    let url;
    try {
      url = new URL(info.url);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return;
    connections.set(runtime.name, {
      url: url.href.replace(/\/$/u, ''),
      token: info.token,
      expiresAt: Date.parse(info.expireTime)
    });
  };
  async function connection(name, signal) {
    const cached = connections.get(name);
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached;
    const runtime = await call('get_runtime', {name}, {signal});
    saw(runtime);
    if (runtime?.name !== name) throw new ColabError('Colab get_runtime 回應不符', {malformed: true});
    remember(runtime);
    const fresh = connections.get(name);
    if (!fresh) throw new ColabError('Colab 未回傳 runtime 連線資訊');
    return fresh;
  }
  // Files through the documented runtime proxy; a 404 means a missing/expired token.
  async function transfer(name, method, file, body, signal) {
    for (let attempt = 0; ; attempt++) {
      const info = await connection(name, signal);
      const response = await fetchImpl(`${info.url}/${method === 'PUT' ? 'api/contents' : 'files'}/${file}`, {
        method,
        headers: {'X-Colab-Runtime-Proxy-Token': info.token, ...(body ? {'content-type': 'application/json'} : {})},
        body: body ? JSON.stringify({type: 'file', format: 'text', content: body}) : undefined,
        signal,
        redirect: 'error'
      });
      if (response.status === 404 && attempt === 0) {
        await response.body?.cancel();
        connections.delete(name);
        continue;
      }
      if (!response.ok) throw new ColabError(`Colab runtime 檔案傳輸失敗（HTTP ${response.status}）`);
      return method === 'GET' ? response.text() : (await response.body?.cancel(), undefined);
    }
  }
  // One step of K's runtime code, sent exactly once. The step runs inside k_step,
  // which records its terminal state on the runtime under this executionId. When
  // the call's own answer is not a definitive refusal (a tool error, network
  // loss, a 5xx, a cut stream — whatever its wording), the outcome is unknown and
  // the step is never sent again: K reads the record with read-only k_state calls
  // in a separate session (so they do not queue behind the step) until it is
  // terminal. No record, an ended kernel or unreadable answers stay unknown.
  async function run(name, session, invocation, signal, background = false) {
    const executionId = randomUUID();
    // The invocation keeps its own line (Python joins lines inside parentheses).
    const program = `${RUNTIME_CODE}\nk_step(${JSON.stringify(executionId)}, lambda: (\n${invocation}\n))\n`;
    const args = {
      session: `${name}/sessions/${session}`,
      code: background
        ? `${RUNTIME_CODE}\nk_launch(${JSON.stringify(executionId)}, ${JSON.stringify(program)})\n`
        : program,
      executionId
    };
    let result;
    try {
      result = await call('execute_code', args, {signal, onProgress() {}});
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!(error instanceof ColabError) || error.definitive) throw error;
      return terminal(name, executionId, error, signal, background);
    }
    const stdout = stepResult(result, executionId);
    return background ? terminal(name, executionId, null, signal, true) : stdout;
  }
  function stepResult(result, executionId) {
    if (!isObject(result) || (result.executionId !== undefined && result.executionId !== executionId))
      throw new ColabError('Colab execute_code 結果不屬於本次執行', {malformed: true});
    if (result.executionError) throw stepFailure(result.executionError);
    return typeof result.stdout === 'string' ? result.stdout : '';
  }
  async function preparationRecord(name, executionId, signal) {
    const info = await connection(name, signal);
    const response = await fetchImpl(`${info.url}/files/content/k/state/${executionId}.json`, {
      headers: {'X-Colab-Runtime-Proxy-Token': info.token},
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      redirect: 'error'
    });
    if (!response.ok) {
      await response.body?.cancel();
      // This can be a missing file or an expired proxy token. Neither proves
      // that the preparation job is absent.
      return null;
    }
    return response.json();
  }

  async function probeRecord(name, executionId, signal) {
    const probeId = randomUUID();
    const stdout = stepResult(
      await call(
        'execute_code',
        {
          session: `${name}/sessions/k-state`,
          code: `${RUNTIME_CODE}\nk_state(${JSON.stringify(executionId)})\n`,
          executionId: probeId
        },
        {signal}
      ),
      probeId
    );
    return JSON.parse(
      lines(stdout)
        .find(line => line.startsWith('K_STATE '))
        ?.slice(8) ?? 'null'
    );
  }

  // The terminal state of a step whose call outcome is unknown, from K's own
  // record. A missing record is not proof that the step will not start, and an
  // unreadable probe proves nothing, so both are bounded and end as unknown.
  async function terminal(name, executionId, cause, signal, background) {
    const unknown = why =>
      new ColabError(`Colab runtime 步驟結果不明（${why}）；K 未重送${cause ? `：${cause.message}` : '。'}`);
    let missing = 0,
      failed = 0,
      failedProcessChecks = 0,
      checkProcessAt = Date.now() + 180000;
    for (let delay = 2000; ; delay = Math.min(delay * 2, 30000)) {
      await wait(delay, signal);
      let record;
      try {
        // Regular detached-job polls are file reads, saving execute_code quota
        // for server startup and inference. Periodically check process liveness
        // when the file still says running.
        record = background
          ? await preparationRecord(name, executionId, signal)
          : await probeRecord(name, executionId, signal);
        if (isObject(record) && record.id !== executionId) record = null;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.definitive) throw error;
        record = null;
      }
      if (background && record?.state === 'running' && Date.now() >= checkProcessAt) {
        checkProcessAt = Date.now() + 180000;
        let check;
        try {
          check = await probeRecord(name, executionId, signal);
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          if (error?.definitive) throw error;
        }
        if (check?.id === executionId && ['running', 'done', 'failed', 'dead'].includes(check.state)) {
          record = check;
          failedProcessChecks = 0;
        } else if (++failedProcessChecks >= 2) {
          throw unknown('無法確認背景準備程序仍在執行');
        }
      }
      const state = isObject(record) ? record.state : null;
      if (state === 'done' && Array.isArray(record.out) && record.out.every(line => typeof line === 'string'))
        return record.out.map(line => `${line}\n`).join('');
      if (state === 'failed') throw stepFailure({name: record.name, value: record.marker ?? ''});
      if (state === 'dead') throw unknown('執行它的 kernel 已結束、沒有終態紀錄');
      if (state === 'running') {
        failed = 0;
        missing = 0;
      } else if (state === 'absent' || state === 'claimed') {
        if (++missing >= 3) throw unknown('runtime 上沒有完成的步驟紀錄');
      } else if (++failed >= 5) throw unknown('無法讀取步驟紀錄');
    }
  }
  const specs = async signal => {
    const value = await call('list_runtime_specs', {}, {signal});
    if (value.runtimeSpecs !== undefined && !Array.isArray(value.runtimeSpecs))
      throw new ColabError('Colab list_runtime_specs 回應不符', {malformed: true});
    return value.runtimeSpecs ?? [];
  };
  // Read-only planning before any create is recorded or sent: engine input and
  // the smallest eligible GPU that fits. Throws (definitive) to refuse.
  async function planRuntime({source, contextWindow, signal}) {
    const plan = colabPlan(source, contextWindow);
    const runtimeSpec = chooseSpec(await specs(signal), plan.needGb);
    if (!runtimeSpec)
      throw colabRefusal(`沒有符合資格且顯存至少約 ${Math.ceil(plan.needGb)} GB 的 Colab GPU；K 不會自動降精度`);
    return {runtimeSpec, auxiliary: plan.auxiliary};
  }
  const py = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`;

  function transport(name) {
    return {
      // Inference: upload the request, relay it once inside the runtime, read the result.
      respond: guard(async (bodyText, signal) => {
        const id = randomUUID();
        await transfer(name, 'PUT', `content/k/req/${id}.json`, bodyText, signal);
        const stdout = await run(name, 'k-relay', `k_relay(${JSON.stringify(id)})`, signal);
        if (!marker(stdout, 'K_DONE')) throw new Error('Colab 推論結果未確認');
        const result = JSON.parse(await transfer(name, 'GET', `content/k/res/${id}.json`, null, signal));
        // Error bodies enter native history through the bridge. Exact opaque
        // tokens must be removed here, before the bridge shortens diagnostics.
        if (result.status >= 400) result.body = redactSecrets(result.body, known());
        return new Response(result.body, {status: result.status, headers: {'content-type': 'application/json'}});
      })
    };
  }

  const api = {
    authState: () => auth.state(),
    // The Google account behind the current authorization (verified ID token
    // email from the helper). Never opens a consent page.
    async account() {
      await auth.accessToken();
      return auth.email?.() ?? null;
    },
    async ready() {
      try {
        await auth.accessToken();
      } catch (error) {
        if (auth.state() === 'signed-out' || auth.state() === 'unknown') {
          const opened = await auth.beginLogin();
          throw colabAuthFailure(
            opened.opened
              ? 'Colab 尚未授權：K 已用預設瀏覽器開啟 Google 授權頁。請以指定的 Colab 帳號登入並同意；授權只讓 K 查詢與關閉，不代表允許開卡。未建立 runtime、未消耗運算單元。'
              : 'Colab 授權頁已開啟、等待你完成登入與同意。未建立 runtime。'
          );
        }
        throw error;
      }
      subscription ??= (await call('get_subscription', {}).catch(() => null))?.tier ?? null;
    },
    // For the colab_status tool. Local by default (helper status: file presence and
    // saved account, no Google call); live=true adds read-only Colab facts.
    async describe({live = false} = {}) {
      const authInfo = await auth.refreshStatus();
      const value = {auth: {state: auth.state(), ...authInfo, clientFile: auth.clientFile}, subscription};
      if (!live || authInfo.signedIn !== true) return value;
      try {
        subscription = (await call('get_subscription', {}))?.tier ?? null;
        const eligible = (await specs()).filter(s => s?.eligible === true).map(s => s.key);
        return {...value, subscription, eligibleSpecs: eligible, checkedAt: new Date().toISOString()};
      } catch (error) {
        return {...value, liveError: redactSecrets(error?.message ?? error, known()).slice(0, 300)};
      }
    },
    // Owner-requested sign-in from the read-only Colab entry: the helper's local
    // status first; only when not signed in, open the consent page (same step as
    // ready()). Never exchanges, stores or reads a credential itself.
    async signIn() {
      const status = await auth.refreshStatus();
      if (status.signedIn === true) return {opened: false, signedIn: true, email: status.email ?? null};
      const opened = await auth.beginLogin();
      return {
        ...opened,
        signedIn: false,
        message: opened.opened
          ? '已用預設瀏覽器開啟 Google 授權頁；請本人以指定帳號登入並同意。授權只讓 K 查詢與關閉，不代表允許開卡。'
          : '授權頁已開啟、等待本人完成登入與同意。'
      };
    },
    planRuntime,
    async createRuntime({runtimeId, source, contextWindow, plan}) {
      const runtimeSpec = plan?.runtimeSpec ?? (await planRuntime({source, contextWindow})).runtimeSpec;
      const runtime = await call('create_runtime', {runtime: {runtimeSpec}, runtimeId, requestId: randomUUID()});
      saw(runtime);
      if (runtime?.name === `runtimes/${runtimeId}`) remember(runtime);
      return {name: typeof runtime?.name === 'string' ? runtime.name : null};
    },
    // {name} when list_runtimes lists it; null only when a well-formed list does
    // not. Any failure or malformed answer throws (unknown), never "gone".
    async getRuntime(name, {signal} = {}) {
      const value = await call('list_runtimes', {}, {signal});
      // `value` is a validated JSON-RPC 2.0 result object for this request. The
      // official output schema has the single, not required field `runtimes`, and
      // proto3 JSON omits an empty repeated field, so `{}` is the empty list. Any
      // other field (e.g. a get_runtime-shaped answer), a non-array value or an
      // element without a string name is malformed, never "gone".
      const runtimes = value?.runtimes === undefined ? [] : value.runtimes;
      if (
        !isObject(value) ||
        !Object.keys(value).every(key => key === 'runtimes') ||
        !Array.isArray(runtimes) ||
        !runtimes.every(item => isObject(item) && typeof item.name === 'string')
      )
        throw new ColabError('Colab list_runtimes 回應不符', {malformed: true});
      runtimes.forEach(saw);
      const found = runtimes.find(item => item.name === name);
      if (!found) {
        connections.delete(name);
        return null;
      }
      remember(found);
      return {name};
    },
    async deleteRuntime(name) {
      await call('delete_runtime', {name, allowMissing: true});
      connections.delete(name);
    },
    async serve({name, model, source, contextWindow = 32768, signal}) {
      const plan = colabPlan(source, contextWindow);
      const directory = directoryOf(source);
      const step = (invocation, background = false) => run(name, 'k-serve', invocation, signal, background);
      const gguf = plan.kind === 'gguf';
      await step('k_prepare()');
      await step(
        `k_fetch(**${py({repository: source.repository, revision: source.revision, directory, files: source.files.map(({path, bytes, sha256}) => ({path, bytes, sha256}))})})`,
        gguf
      );
      await step(`k_engine(${JSON.stringify(engineCommit)}${gguf ? ', True' : ''})`, gguf);
      let modelPath = `/content/k/models/${directory}/${plan.main ?? ''}`;
      if (plan.kind === 'safetensors') {
        await step(`k_convert(${JSON.stringify(directory)}, ${JSON.stringify(plan.outtype)})`);
        modelPath = `/content/k/models/${directory}.${plan.outtype}.gguf`;
      }
      const ready = await step(
        `k_start(${JSON.stringify(modelPath)}, ${JSON.stringify(model)}, ${Number(contextWindow)}${plan.kvCacheQ8 ? ', True' : ''})`
      );
      if (!marker(ready, 'K_READY')) throw new Error('Colab 模型服務未回報就緒');
      return transport(name);
    },
    // Reuse check for a runtime K already serves: a short, cancellable health step.
    async endpoint({name, signal}) {
      if (!marker(await run(name, 'k-serve', 'k_health()', signal), 'K_HEALTH ok'))
        throw new Error('Colab 模型服務未運作');
      return transport(name);
    },
    close() {
      auth.close?.();
    }
  };
  for (const key of [
    'account',
    'ready',
    'describe',
    'signIn',
    'planRuntime',
    'createRuntime',
    'getRuntime',
    'deleteRuntime',
    'serve',
    'endpoint'
  ])
    api[key] = guard(api[key]);
  return api;
}
