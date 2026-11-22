import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {openGemmaResponses, fetchDolphinInference} from './gemma-responses.mjs';
import {createLocalModelRuntime} from './local-model-runtime.mjs';
import {createColabBalance} from './colab-balance.mjs';
import {createColabRuntime, NOT_APPROVED} from './colab-runtime.mjs';
import {createColabAuth} from './colab-auth.mjs';
import {createColabMcp} from './colab-mcp.mjs';
import {createColabAdapter} from './colab-adapter.mjs';
import {openInDefaultBrowser} from './open-url.mjs';

const defaults = {local: {baseUrl: 'http://127.0.0.1:1234/v1', model: 'gemma-4-12b-it-qat', contextWindow: 32768}};
// LM Studio key gemma-4-12b-it-qat is google/gemma-4-12B-it-qat-q4_0-gguf (model registry).
const localName = model =>
  `${model === defaults.local.model ? 'Gemma 4 12B IT QAT · Q4_0' : `Gemma 4 · ${model}`} · 本機`;
// colab = a Colab runtime K creates only for a real request (see colab-runtime.mjs).
const locationNames = {local: '本機', colab: 'Colab 雲端'};
// The owner cancelled the owner-managed SSH cloud route (gemma-cloud/…, location
// "cloud") in favour of Colab. Saved IDs keep their provider and history files but
// are never listed, prepared or redirected to another model.
const RETIRED = '自管 SSH 雲端路線已取消（改用 Colab 雲端）；此對話紀錄保留，但不會啟動、不改用其他模型或轉送歷史。';
const retired = slot => ({
  slot,
  retired: true,
  nativeModel() {
    throw new Error(RETIRED);
  },
  async models() {
    return {models: []};
  },
  async close() {}
});
const colabText = {
  unconfigured:
    'Colab 未設定：需要本人先建立 Google Cloud OAuth 用戶端並放到 K 私有狀態（見工程文件），目前無法送出；不會建立 runtime 或消耗運算單元。',
  'signin-required':
    'Colab 尚未授權。送出時 K 只會用預設瀏覽器開啟 Google 授權頁，由你登入並同意；完成前不會建立 runtime。',
  idle: '未啟動。選取與開新對話不會啟動 Colab；本人另行允許開卡後，送出工作才由 K 建立 runtime，從發布倉庫固定版本下載並逐檔校驗。尚未完成推論驗證。',
  starting: '啟動中：K 正在為目前工作建立 Colab runtime 並準備模型。',
  ready: '已就緒（依 K 最近一次讀回；取消、說結束或 K 關閉時由 K 關閉並讀回）。尚未完成推論驗證。',
  stopping: '關閉中：K 正在關閉自己建立的 Colab runtime 並讀回。',
  'stop-unconfirmed':
    '關閉待確認：K 尚未確認自己建立的 Colab runtime 已關閉；已送出的關閉不重送，下次送出或 colab_stop 時先讀回確認，確認前不建立新的 runtime。',
  unknown:
    '狀態待確認：上一個 Colab 操作結果不明；已送出的建立／關閉不重送、推論不重送。下次送出或 colab_stop 時先讀回，確認是 K 持有的 runtime 才關閉並讀回；確認前不建立新的 runtime。'
};
const isColabStop = item =>
  item?.type === 'function_call' &&
  ((item.name === 'colab_stop' && item.namespace === 'mcp__k_gemini') || item.name === 'mcp__k_gemini__colab_stop');
const TOOL_OUTPUT = new Set(['function_call_output', 'custom_tool_call_output']);
// A native continuation within the turn in which this room called colab_stop
// (possibly alongside other tools) is answered by K itself, because the model's
// runtime may already be gone. Returns {callId, output} for that call (output null
// when missing), or undefined when this is not such a continuation. A new human
// message ends that window.
function colabStopCall(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  if (!TOOL_OUTPUT.has(input.at(-1)?.type)) return undefined;
  let start = 0;
  for (let index = input.length - 1; index >= 0; index--)
    if (input[index]?.type === 'message' && input[index].role === 'user') {
      start = index + 1;
      break;
    }
  const turn = input.slice(start);
  const call = turn.findLast(isColabStop);
  if (!call) return undefined;
  const output = turn.find(item => TOOL_OUTPUT.has(item?.type) && item.call_id === call.call_id);
  return {callId: call.call_id, output: output ? output.output : null};
}
const RECEIPT = /k-colab-stop-[a-f0-9]{24}/gu;

// A fixed published revision with per-file size and SHA-256; Colab downloads from
// the publisher, never from an upload of the owner's local copy.
function validSource(source) {
  const file = item =>
    typeof item?.path === 'string' &&
    /^[\w.+-]+(?:\/[\w.+-]+)*$/u.test(item.path) &&
    !item.path.split('/').some(part => part === '.' || part === '..') &&
    Number.isSafeInteger(item.bytes) &&
    item.bytes > 0 &&
    /^[0-9a-f]{64}$/u.test(item.sha256);
  if (
    !/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/u.test(source?.repository ?? '') ||
    source.repository.split('/').some(part => part === '.' || part === '..') ||
    !/^[0-9a-f]{40}$/u.test(source?.revision ?? '') ||
    !Array.isArray(source.files) ||
    !source.files.length ||
    !source.files.every(file) ||
    new Set(source.files.map(item => item.path)).size !== source.files.length
  )
    throw new Error('Colab 模型需要發布倉庫、固定 revision 與逐檔大小／SHA-256。');
  return structuredClone(source);
}

// Self-hosted inference, not an OpenAI API billing route. K neither rents a server
// nor stores/transfers a provider credential.
export async function loadGemmaConnections(
  root,
  {
    fetchImpl = fetch,
    localRuntimeFactory = createLocalModelRuntime,
    dolphinFetchImpl = fetchDolphinInference,
    colabRuntimeFactory = createColabRuntime,
    colabClientFactory = defaultColabClient,
    readColabBalance
  } = {}
) {
  try {
    return await readConnections(
      root,
      fetchImpl,
      localRuntimeFactory,
      dolphinFetchImpl,
      colabRuntimeFactory,
      colabClientFactory,
      readColabBalance
    );
  } catch {
    // A bad optional Gemma file cannot take the existing three providers offline.
    const model = `gemma-local/${defaults.local.model}`;
    return [
      {
        slot: 'local',
        model,
        nativeModel() {
          throw new Error('自架模型連線設定無效；未切換模型或計費。');
        },
        async models() {
          return {
            models: [
              {
                model,
                provider: 'gemma',
                displayName: localName(defaults.local.model),
                location: 'local',
                available: false,
                description: '自架模型連線設定無效，請修正 K 私有狀態中的 gemma-main.json。'
              }
            ]
          };
        }
      },
      retired('cloud')
    ];
  }
}
// Official Colab control: owner-consented OAuth (colab-auth), the remote MCP
// server (colab-mcp) and K's runtime adapter. Nothing here calls Google until a
// real request or an owner-requested status/stop.
function defaultColabClient({root, account}) {
  const auth = createColabAuth({root, account, openUrl: openInDefaultBrowser});
  return createColabAdapter({mcp: createColabMcp({accessToken: () => auth.accessToken()}), auth});
}
// The read-only Colab entry K offers every working main agent (Codex, Claude,
// Gemini, Grok, DeepSeek, local models), so the owner can check sign-in and
// eligibility before any runtime exists and without waking a self-hosted model.
// It never creates, stops or reuses a runtime, spends compute units or sends an
// inference. live=true adds read-only Colab calls (subscription tier, eligible
// specs). signIn=true only opens the official consent page in the owner's
// default browser (the step a Colab send would take); the owner signs in and
// consents there, and a sign-in never permits creating a runtime.
const manualBalance = () => ({
  state: 'manual',
  officialUrl: 'https://colab.research.google.com/signup',
  note: '請在 Colab 官方方案頁確認目前登入帳號的運算單元。'
});

function colabAdmin(colab, client, balance) {
  return {
    balance,
    async status({live = false, signIn = false, balance: queryBalance = false} = {}) {
      let login;
      if (signIn)
        try {
          login = await client.signIn();
        } catch (error) {
          login = {opened: false, error: String(error?.message ?? error).slice(0, 300)};
        }
      return {
        runtime: {state: colab.status().state, name: colab.runtimeName()},
        createPolicy: {...colab.policy(), ...(colab.policy().createAllowed ? {} : {note: NOT_APPROVED})},
        ...(await client.describe({live})),
        ...(queryBalance ? {balance: (await balance?.refresh()) ?? manualBalance()} : {}),
        ...(login ? {signIn: login} : {})
      };
    }
  };
}
// Only a missing file means "no record". An unreadable or unparsable journal is
// passed on as an error so the runtime owner blocks instead of creating anew;
// its content is validated there.
async function readJournal(file) {
  let content;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return {error: `讀取失敗 ${error?.code ?? 'unknown'}`};
  }
  try {
    return {record: JSON.parse(content)};
  } catch {
    return {error: '內容不是有效 JSON'};
  }
}
async function readConnections(
  root,
  fetchImpl,
  localRuntimeFactory,
  dolphinFetchImpl,
  colabRuntimeFactory,
  colabClientFactory,
  readColabBalance
) {
  let settings = {};
  try {
    settings = JSON.parse(await readFile(path.join(root, '.runtime', 'gemma-main.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Gemma 連線設定無法讀取；未改用其他供應商。');
  }
  const extra = settings.selfHosted ?? [];
  if (!Array.isArray(extra)) throw new Error('自架模型清單無效。');
  // Opt in with the owner's installed CLI, never install an engine or change cloud
  // billing. All managed local connections share one memory/inference owner.
  let localRuntime;
  if (settings.localRuntime !== undefined) {
    const executable = settings.localRuntime?.executable;
    if (typeof executable !== 'string' || !path.isAbsolute(executable))
      throw new Error('本機模型需要已安裝的原生 lms 完整路徑。');
    localRuntime = localRuntimeFactory({executable, fetchImpl});
  }
  // One Colab runtime owner shared by every Colab connection, created only when
  // one is configured. The expected account is optional private configuration.
  const account = settings.colab?.account;
  if (account !== undefined && !/^[^@\s]+@[^@\s]+$/u.test(account)) throw new Error('Colab 指定帳號格式無效。');
  // Creating a runtime (spending compute units) is a separate, explicit owner
  // approval bound to the expected account; OAuth consent alone never allows it.
  const allowCreate = settings.colab?.allowRuntimeCreation;
  if (allowCreate !== undefined && typeof allowCreate !== 'boolean') throw new Error('Colab 開卡授權設定無效。');
  if (allowCreate === true && account === undefined) throw new Error('Colab 開卡授權必須同時指定帳號。');
  let colab = null,
    colabClient = null,
    admin = null;
  if (extra.some(entry => entry?.location === 'colab')) {
    const stateFile = path.join(root, '.runtime', 'colab-runtime.json');
    colabClient = colabClientFactory({root, account: account ?? null});
    colab = colabRuntimeFactory({
      client: colabClient,
      diagnosticsFile: path.join(root, '.runtime', 'diagnostics', 'colab-runtime.jsonl'),
      stateFile,
      journal: await readJournal(stateFile),
      allowCreate: allowCreate === true,
      account: account ?? null
    });
    // balanceAccounts lists every subscribed account; the older single binding still works.
    const accounts =
      settings.colab?.balanceAccounts ?? (account ? [{account, profileId: settings.colab?.balanceProfileId}] : []);
    const balance = createColabBalance({read: readColabBalance, accounts});
    admin = colabAdmin(colab, colabClient, balance);
  }
  const ids = new Set();
  const configuredLocal = [];
  if (settings.local != null && settings.local !== false) {
    if (typeof settings.local !== 'object' || Array.isArray(settings.local)) throw Error('本機模型設定須為設定物件。');
    const local = {...defaults.local, ...settings.local};
    configuredLocal.push(connection(root, fetchImpl, {
      slot: 'local',
      prefix: 'gemma-local',
      location: 'local',
      displayName: localName(local.model),
      dolphinFetchImpl,
      localRuntime,
      config: local
    }));
  }
  return [
    ...configuredLocal,
    // Other self-hosted main agents keep their real model name and location; each has
    // its own stable ID, native home and controller, even when sharing one endpoint.
    ...extra.map(entry => {
      if (
        typeof entry?.id !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(entry.id) ||
        ids.has(entry.id) ||
        !(Object.hasOwn(locationNames, entry.location) || entry.location === 'cloud') ||
        typeof entry.label !== 'string' ||
        !entry.label.trim()
      )
        throw new Error('自架模型需要唯一 id、名稱與 local／colab 地點。');
      if (entry.location === 'colab' && entry.baseUrl !== undefined)
        throw new Error('Colab 模型端點由 K 建立 runtime 後取得，設定中不得填 baseUrl。');
      ids.add(entry.id);
      const prefix = `selfhost-${entry.id}`;
      if (entry.location === 'cloud') return retired(prefix);
      return connection(root, fetchImpl, {
        slot: prefix,
        prefix,
        location: entry.location,
        displayName: `${entry.label.trim()} · ${locationNames[entry.location]}`,
        dolphinFetchImpl,
        localRuntime,
        ...(entry.location === 'colab' ? {colab, colabClient, admin, source: validSource(entry.source)} : {}),
        config: {
          baseUrl: entry.location === 'colab' ? null : (entry.baseUrl ?? defaults.local.baseUrl),
          model: entry.model,
          contextWindow: entry.contextWindow ?? defaults.local.contextWindow
        }
      });
    }),
    retired('cloud')
  ];
}
function connection(
  root,
  fetchImpl,
  {slot, prefix, location, displayName, config, localRuntime, dolphinFetchImpl, colab, colabClient, admin, source}
) {
  const url = colab ? null : new URL(config.baseUrl);
  if (
    url &&
    (url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.replace(/\/$/u, '') !== '/v1')
  )
    throw new Error('自架本機模型端點須為本機 /v1，不在設定中放憑證。');
  if (
    typeof config.model !== 'string' ||
    !config.model.trim() ||
    // The full K ID must fit the saved-conversation model limit (validMainModel).
    `${prefix}/${config.model}`.length > 256 ||
    !Number.isInteger(config.contextWindow) ||
    config.contextWindow < 1024
  )
    throw new Error('自架模型 ID 或上下文設定無效。');
  const baseUrl = url?.href.replace(/\/$/u, '') ?? null;
  // The installed CLI controls the owner's local :1234 backend only. Other local
  // servers retain their existing wire protocol.
  const managed = location === 'local' && url.port === '1234' ? localRuntime : null;
  const sourceText = source
    ? `來源 ${source.repository}@${source.revision.slice(0, 7)}（固定版本，${source.files.length} 個檔案逐檔校驗）。`
    : '';
  const dolphin = location === 'local' && url.port === '1234' && slot === 'selfhost-dolphin-mistral-24b-venice';
  const model = `${prefix}/${config.model}`;
  const home = path.join(root, '.runtime', `${prefix}-home`);
  const catalogFile = path.join(home, 'model-catalog.json');
  let prepared, transport;
  // colab_stop receipts K issued in this room: receipt -> {report, epoch, callId}.
  // A receipt is honoured only while it is the newest one, no request has used
  // Colab since it was issued (epoch), and for the one tool call that first
  // carried it; anything else is reported as "no receipt", never as closed.
  const stopReceipts = new Map();
  let epoch = 0;
  const newestReceipts = new Map();
  const colabLocalReply = (body, {caller} = {}) => {
    const call = colabStopCall(body);
    if (call === undefined) return null;
    const textOutput = typeof call.output === 'string' ? call.output : JSON.stringify(call.output ?? '');
    const receipts = [...new Set(textOutput.match(RECEIPT) ?? [])];
    const entry =
      receipts.length === 1 && receipts[0] === newestReceipts.get(caller?.thread)
        ? stopReceipts.get(receipts[0])
        : null;
    if (
      entry &&
      caller?.thread === entry.caller?.thread &&
      caller?.turn === entry.caller?.turn &&
      typeof call.callId === 'string' &&
      entry.epoch === epoch &&
      (entry.callId ?? call.callId) === call.callId
    ) {
      entry.callId = call.callId;
      return `${entry.report}\nK 沒有再呼叫雲端模型。`;
    }
    const {state} = colab.status(config.model, source);
    return `這次 colab_stop 沒有取得 K 的關閉收據（工具可能未執行、被拒絕或結果不明），K 不能確認已關閉 Colab。K 本機目前的紀錄：${colabText[state]}如仍要關閉，請再要求一次。K 沒有再呼叫雲端模型。`;
  };
  const row = {
    id: model,
    model,
    provider: 'gemma',
    displayName,
    location,
    ...(typeof source?.quantization === 'string' && {quantization: source.quantization}),
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ['text'],
    serviceTiers: []
  };
  return {
    slot,
    model,
    home,
    nativeModel(value) {
      if (value !== model) throw new Error('自架模型連線與聊天室模型不符，請建立新對話；未轉送歷史。');
      return config.model;
    },
    async models({signal} = {}) {
      if (colab) {
        // Local record only: listing never calls Colab or starts a runtime.
        const {state} = colab.status(config.model, source);
        const approval =
          state === 'unconfigured' || colab.policy?.().createAllowed ? '' : '本人尚未允許開卡：送出不會建立 runtime。';
        return {
          models: [
            {
              ...row,
              runtimeStatus: state,
              available: state !== 'unconfigured',
              description: `${config.model}；${colabText[state]}${approval}${sourceText}`
            }
          ]
        };
      }
      try {
        if (managed) {
          const result = await managed.catalog({signal});
          if (result.offline)
            return {
              models: [
                {
                  ...row,
                  available: true,
                  description: `${config.model}；目前無法連上 LM Studio。查清單不會叫醒它，送出工作後才由 K 在背景啟動、載入並確認模型存在。尚未完成推論驗證。`
                }
              ]
            };
          const offered = result.models.some(entry => entry.type === 'llm' && entry.key === config.model);
          return {
            models: [
              {
                ...row,
                available: offered,
                description: offered
                  ? `${config.model}；選取不會載入，送出工作後才由 K 在背景載入，無須另開模型介面。尚未完成推論驗證。`
                  : `本機尚未提供模型 ${config.model}。`
              }
            ]
          };
        }
        const timeout = AbortSignal.timeout(3000);
        const response = await fetchImpl(`${baseUrl}/models`, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          redirect: 'error'
        });
        if (!response.ok) throw new Error('endpoint unavailable');
        const result = await response.json();
        if (!result.data?.some(entry => entry.id === config.model))
          return {models: [{...row, available: false, description: `端點未提供模型 ${config.model}。`}]};
        return {
          models: [
            {
              ...row,
              available: true,
              description: `${config.model}；沿用 K 原生操作。端點列出模型不代表已完成推論驗證。`
            }
          ]
        };
      } catch (error) {
        signal?.throwIfAborted();
        return {
          models: [
            {
              ...row,
              available: false,
              description: '本機模型服務尚未連通。'
            }
          ]
        };
      }
    },
    async prepare() {
      return (prepared ??= (async () => {
        await mkdir(home, {recursive: true});
        try {
          await writeFile(path.join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n', {flag: 'wx'});
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        // Complete metadata for the installed native catalog contract; no GPT branding,
        // fake effort/Fast options, or fabricated multimodal support.
        await writeFile(
          catalogFile,
          JSON.stringify({
            models: [
              {
                slug: config.model,
                display_name: displayName,
                description: config.model,
                default_reasoning_level: null,
                supported_reasoning_levels: [],
                shell_type: 'unified_exec',
                visibility: 'list',
                supported_in_api: true,
                priority: 0,
                additional_speed_tiers: [],
                service_tiers: [],
                availability_nux: null,
                upgrade: null,
                model_messages: null,
                include_skills_usage_instructions: true,
                include_plugin_usage_instructions: true,
                include_apps_usage_instructions: true,
                default_reasoning_summary: 'none',
                support_verbosity: false,
                default_verbosity: null,
                apply_patch_tool_type: 'freeform',
                web_search_tool_type: 'text_and_image',
                truncation_policy: {mode: 'tokens', limit: 10000},
                supports_image_detail_original: false,
                context_window: config.contextWindow,
                max_context_window: config.contextWindow,
                comp_hash: null,
                effective_context_window_percent: 95,
                experimental_supported_tools: [],
                input_modalities: ['text'],
                supports_search_tool: false,
                supports_experimental_context: false,
                use_responses_lite: false,
                supports_reasoning_effort_updates: false,
                node_repl_auto_review_required: false,
                node_repl_disabled: false,
                base_instructions:
                  'You are a helpful assistant. Follow the user and project instructions. Use the available tools when needed. Never claim an action or result without evidence.',
                tool_mode: null,
                multi_agent_version: null
              }
            ]
          })
        );
        transport = await openGemmaResponses(baseUrl, {
          fetchImpl: dolphin ? dolphinFetchImpl : fetchImpl,
          expectedModel: config.model,
          ...(colab
            ? {
                acquireModel: ({signal, caller}) => {
                  epoch++; // a real request: earlier stop reports no longer describe the present
                  return colab.acquire({
                    model: config.model,
                    source,
                    contextWindow: config.contextWindow,
                    signal,
                    caller
                  });
                },
                localReply: colabLocalReply
              }
            : managed
              ? {
                  acquireModel: ({signal}) =>
                    managed.acquire({
                      model: config.model,
                      instanceId: `k-${prefix}`,
                      contextWindow: config.contextWindow,
                      signal
                    })
                }
              : {})
        });
      })().catch(error => {
        prepared = null;
        throw error;
      }));
    },
    async close() {
      await prepared?.catch(() => {});
      await transport?.close();
      transport = null;
      prepared = null;
      await managed?.close?.().catch(() => {});
      await colab?.close().catch(() => {});
    },
    // AI tools for this Colab room (k_gemini gateway): status is local unless
    // live=true asks for read-only Colab facts; stop closes only K's own runtime
    // and answers from K's readback.
    ...(colab
      ? {
          // The read-only Colab entry for every main agent (see colabAdmin).
          colabAdmin: admin,
          colabTools: {
            async status({live = false, balance = false} = {}) {
              return {
                model: config.model,
                runtime: {...colab.status(config.model, source), name: colab.runtimeName()},
                createPolicy: {...colab.policy(), ...(colab.policy().createAllowed ? {} : {note: NOT_APPROVED})},
                ...(await colabClient.describe({live})),
                ...(balance ? {balance: (await admin.balance?.refresh()) ?? manualBalance()} : {})
              };
            },
            // A native turn of a room on this connection is over (any outcome).
            release: caller => colab.release(caller),
            // The receipt binds K's local end-of-turn report to this exact tool
            // result in this room; a missing, denied or stale call carries none.
            // `caller` is the verified native room/turn calling it.
            async stop(caller) {
              const result = await colab.stop(caller);
              const receipt = `k-colab-stop-${randomBytes(12).toString('hex')}`;
              stopReceipts.set(receipt, {
                report: `colab_stop 結果（K 讀回：${result.readback}）：${result.message}`,
                epoch,
                caller: caller ? {...caller} : null,
                callId: null
              });
              newestReceipts.set(caller?.thread, receipt);
              while (stopReceipts.size > 32) {
                const oldest = stopReceipts.keys().next().value;
                const owner = stopReceipts.get(oldest).caller?.thread;
                if (newestReceipts.get(owner) === oldest) newestReceipts.delete(owner);
                stopReceipts.delete(oldest);
              }
              return {...result, receipt};
            }
          }
        }
      : {}),
    configOverrides() {
      if (!transport) throw new Error('自架模型連線尚未準備完成；未繞過工具格式轉換。');
      return [
        `model_catalog_json=${JSON.stringify(catalogFile)}`,
        'model_provider="k_gemma"',
        `model=${JSON.stringify(config.model)}`,
        `review_model=${JSON.stringify(config.model)}`,
        `model_providers.k_gemma={name="K self-hosted",base_url=${JSON.stringify(transport.baseUrl)},wire_api="responses",requires_openai_auth=false,supports_websockets=false,${dolphin || colab ? 'stream_idle_timeout_ms=1200000,' : ''}http_headers={Authorization=${JSON.stringify(transport.headers.Authorization)}}}`,
        'web_search="disabled"',
        // The fresh, unauthenticated self-host home has no OpenAI account plugins.
        // Avoid native startup downloading the curated marketplace. K MCP tools stay intact.
        'features.plugins=false',
        'features.apps=false'
      ];
    }
  };
}
