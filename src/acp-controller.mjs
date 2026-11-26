import path from 'node:path';
import {readFile, realpath} from 'node:fs/promises';
import {watch} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createWorkActivity} from './work-activity.mjs';
import {
  discardStaleWorkerQuestions,
  workerNoticeKey,
  workerNoticeCurrent,
  workerNoticeText,
  workerNeedsAttention
} from './worker-watch.mjs';
import {
  mergeGeminiHandoff,
  consumeGeminiHandoff,
  consumeGeminiWaitResult,
  geminiWaitingJobs,
  geminiHandoffText,
  geminiHandoffNotice
} from './gemini-handoff.mjs';
import {lunaResult} from './luna-bridge.mjs';
import {approvalRequest} from './desktop-permissions.mjs';
import {atomicWrite} from './atomic-write.mjs';
import {saveMainSession, listMainSessions} from './main-sessions.mjs';
import {validateWorkspace, listWorkspaceDirectories} from './workspaces.mjs';
import {saveAttachment, saveAttachmentStream, readPresentedFile} from './desktop-files.mjs';
import {
  sessionAttachment,
  sessionAttachmentSource,
  sessionArtifact,
  sessionArtifactSource,
  workspaceGuidance
} from './session-workspace.mjs';
import {normalizeWorkerPolicy, workerPolicyConfig, MODEL_PROTOCOL_GUIDANCE} from './worker-policy.mjs';
import {claudeCommonBlock, commonMemoryReference} from './common-memory.mjs';
import {desktopControlMcp, DESKTOP_CONTROL_GUIDANCE} from './desktop-control-mcp.mjs';
import {browserSessionKey} from './browser-mcp-config.mjs';
import {GEMINI_BROWSER_GUIDANCE} from './gemini-worker.mjs';

const nativeId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/iu.test(id);
const now = () => new Date().toISOString();
const MAX_THOUGHT_CHARS = 40000;
export const ACP_ACCESS_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
// The names the permission picker shows for the ACP cores.
const ACCESS_NAMES = {'read-only': '唯讀', 'workspace-write': '要求核准', 'danger-full-access': '完整存取權'};
// K's own MCP servers (worker gateway, browser) are tools K already scoped to this room.
const K_SERVERS = ['k_luna', 'k_browser'];

export function writeTargets(toolCall = {}) {
  const targets = new Set();
  for (const item of toolCall.content ?? [])
    if (item?.type === 'diff' && typeof item.path === 'string') targets.add(item.path);
  for (const item of toolCall.locations ?? []) if (typeof item?.path === 'string') targets.add(item.path);
  const input = toolCall.rawInput ?? {};
  for (const key of ['file_path', 'path', 'target_file']) if (typeof input[key] === 'string') targets.add(input[key]);
  return [...targets];
}

/**
 * One ACP core's main entry (Grok Build, DeepSeek Harness). K stores presentation only; the native
 * core owns execution, sessions, history and compaction. `profile` holds what differs per core:
 * names, launch, permission wording, tool naming, session resume and usage.
 */
export function createAcpController(
  profile,
  {
    root,
    executable,
    env = process.env,
    openAgent = profile.openAgent,
    loginFactory = profile.loginFactory,
    onChange = () => {},
    componentEnabled = () => true,
    browserConfig = async () => null,
    closeBrowser = async () => {},
    bridgeFactory = null,
    gatewayFactory,
    workerCatalog,
    roomTools,
    colabAdmin,
    onContinueConversation,
    onConversationSettled,
    stopGraceMs = 10000,
    killTree = profile.killTree
  } = {}
) {
  const {provider, label} = profile;
  const sessionId = id =>
    typeof id === 'string' && id.startsWith(`${profile.idPrefix}-`) && nativeId(id.slice(profile.idPrefix.length + 1));
  const access = value => {
    if (!ACP_ACCESS_MODES.includes(value)) throw Error(profile.accessError);
    return value;
  };
  const login = loginFactory({cwd: root, executable, env}),
    binary = profile.executable(env, executable),
    home = profile.home(root, env);
  let usagePending = null,
    usageAttemptAt = 0;
  const state = {
    provider,
    status: 'idle',
    threadId: null,
    model: null,
    modelDisplayName: null,
    inputModalities: ['text'],
    workspace: root,
    accessMode: 'workspace-write',
    workerPolicy: normalizeWorkerPolicy(),
    title: '',
    effort: null,
    efforts: [],
    lastUsedModel: null,
    modelChanges: [],
    messages: [],
    tools: [],
    artifacts: [],
    workers: [],
    questions: [],
    notices: [],
    reasoning: [],
    turnDiffs: [],
    goal: null,
    busy: false,
    error: null,
    browserAccess: {enabled: false, networkAccess: false},
    capabilities: {
      steer: false,
      goal: false,
      compact: false,
      fileSearch: false,
      review: false,
      turnDiffs: false,
      reasoningSummary: false,
      thoughts: !!profile.thoughts,
      nativeFork: false
    },
    progress: {
      plan: [],
      explanation: null,
      compaction: 'native',
      compactions: null,
      compactionsComplete: false,
      tokenUsage: null
    },
    usage: {[provider]: structuredClone(profile.initialQuota)}
  };
  const activity = createWorkActivity(state);
  let record = null,
    opening = false,
    turn = null,
    persist = Promise.resolve(),
    agent = null,
    agentKey = null,
    agentUnresolved = null,
    halting = 0,
    usageSeq = 0,
    commonKey = null,
    rulesKey = null,
    mcpServers = [],
    rules = '';
  let browserMode = null,
    browserServer = null;
  async function resetBrowser() {
    if (browserServer)
      try {
        await closeBrowser();
      } catch (error) {
        state.status = 'uncertain';
        state.error = `瀏覽器停止尚未確認：${error.message}`;
        throw error;
      }
    browserMode = null;
    browserServer = null;
    state.browserAccess = {enabled: false, networkAccess: false};
  }
  const changed = () => {
    try {
      onChange(state);
    } catch {}
  };
  const file = id => {
    if (!sessionId(id)) throw Error(`${label} 對話 ID 無效。`);
    return path.join(root, '.runtime', profile.sessionsDir, `${id}.json`);
  };
  const save = activityAt => {
    if (!record) return Promise.resolve();
    const snapshot = structuredClone({
      ...record,
      model: state.model,
      effort: state.effort,
      title: state.title,
      workspace: state.workspace,
      previousWorkspaces: state.previousWorkspaces,
      previousArtifacts: state.previousArtifacts,
      accessMode: state.accessMode,
      workerPolicy: state.workerPolicy,
      workerNotifications,
      messages: state.messages,
      tools: state.tools,
      artifacts: state.artifacts,
      lastUsedModel: state.lastUsedModel,
      modelChanges: state.modelChanges,
      lastOpenedAt: now()
    });
    record = snapshot;
    const next = persist
      .catch(() => {})
      .then(async () => {
        await atomicWrite(file(snapshot.threadId), JSON.stringify(snapshot, null, 2));
        await saveMainSession(root, snapshot, {activityAt});
      });
    persist = next;
    return next;
  };
  const read = async id => JSON.parse(await readFile(file(id), 'utf8'));
  const idle = () => {
    if (state.busy || opening || agentUnresolved || halting) throw Error(`請先結束或查明目前 ${label} 工作。`);
  };
  const insideWorkspace = absolute => {
    const relative = path.relative(state.workspace, absolute);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  // A write is inside only if its nearest existing ancestor resolves inside: a junction
  // cannot widen the workspace.
  async function writableInside(name) {
    let target = path.resolve(state.workspace, name);
    if (!insideWorkspace(target)) return false;
    const base = await realpath(state.workspace);
    for (;;) {
      try {
        const resolved = await realpath(target);
        const relative = path.relative(base, resolved);
        return (
          resolved === base ||
          (!!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        );
      } catch (error) {
        if (error.code !== 'ENOENT') return false;
        const parent = path.dirname(target);
        if (parent === target) return false;
        target = parent;
      }
    }
  }

  // ---- K workers (k_luna) for this room, as in the Claude and Gemini main entries ----
  let bridge = null,
    bridgeInstance = null,
    bridgeInitPromise = null,
    bridgeEpoch = 0,
    gateway = null,
    gatewayKey = null,
    gatewayServer = null,
    gatewayThread = null,
    stops = 0,
    workerInstructions = MODEL_PROTOCOL_GUIDANCE,
    workerNotifications = {},
    notifying = false,
    turnEnds = 0,
    stopping = 0,
    preparingContinuation = false,
    geminiHandoff = null,
    geminiIntentEpoch = 0;
  const workerArmed = new Set(),
    workerQueue = new Map(),
    handoffJobs = new Set(),
    pending = new Map();
  const WORKERS_RUNNING = 'K 子代理尚未結束；待工人完成後再切換對話，或變更權限、工作區、子代理設定。';
  const gatewayKeyOf = (threadId, workspace, accessMode, workerPolicy) =>
    JSON.stringify([threadId ?? null, workspace, accessMode, workerPolicy]);
  const unsettledWorkers = async () =>
    !!bridgeInstance && (await bridgeInstance.list()).some(r => !r.settled && r.executionUnowned !== true);
  // A queued or in-flight K notice is a native turn still owed to this room; a room move must not race it.
  const noticePending = () =>
    notifying ||
    workerQueue.size > 0 ||
    (['ready', 'blocked'].includes(geminiHandoff?.status) && geminiHandoff.epoch === geminiIntentEpoch);
  const clearQuestions = matches => {
    for (const [id, item] of pending) {
      if (matches && !matches(item)) continue;
      item.resolve(item.cancelValue);
      pending.delete(id);
      state.questions = state.questions.filter(q => q.id !== id);
    }
  };
  function workerApproval(request, item) {
    if (request.method === 'k/claude/requestApproval' && (request.params?.parentId !== state.threadId || opening))
      return undefined;
    const approval = approvalRequest(request, item);
    if (!approval) return undefined;
    const id = randomUUID();
    return new Promise(resolve => {
      pending.set(id, {
        resolve,
        cancelValue: approval.cancel?.() ?? {decision: 'cancel'},
        approval,
        workerRequestId: request.method === 'k/claude/requestApproval' ? request.params?.requestId : undefined
      });
      const {reply, cancel, ...display} = approval;
      state.questions.push({
        id,
        kind: 'approval',
        threadId: state.threadId,
        isSubagent: true,
        ...display,
        provider: 'codex-luna'
      });
      changed();
    });
  }
  const scheduleWorkers = () =>
    queueMicrotask(() => {
      void deliverWorkers();
    });
  const recordWorker = item => {
    if (!item || item.parentId !== state.threadId) return;
    const index = state.workers.findIndex(w => w.requestId === item.requestId);
    if (index < 0) state.workers.push(item);
    else state.workers[index] = item;
    const before = state.artifacts.length;
    for (const name of item.outputFiles ?? []) {
      if (typeof name !== 'string') continue;
      const absolute = path.resolve(state.workspace, name);
      const relative = path.relative(state.workspace, absolute).replaceAll('\\', '/');
      if (insideWorkspace(absolute) && !state.artifacts.includes(relative)) state.artifacts.push(relative);
    }
    if (state.artifacts.length !== before) void save().catch(() => {});
    const queued = workerQueue.get(item.requestId);
    if (queued && !workerNoticeCurrent(queued, item)) workerQueue.delete(item.requestId);
    if (
      workerArmed.has(item.requestId) &&
      !workerNotifications[workerNoticeKey(item)] &&
      (item.settled || workerNeedsAttention(item)) &&
      !opening
    ) {
      workerQueue.set(item.requestId, structuredClone(item));
      scheduleWorkers();
    }
    changed();
  };
  const recordGeminiHandoff = event => {
    if (
      !event ||
      event.parentId !== state.threadId ||
      opening ||
      ['interrupted', 'offline', 'uncertain'].includes(state.status)
    )
      return;
    const requestIds = (event.requestIds ?? []).filter(id => handoffJobs.has(id)),
      queryIds = event.queryIds ?? [];
    if (!requestIds.length && !queryIds.length) return;
    for (const n of state.notices) if (n.kind === 'gemini-handoff') n.resolved = true;
    geminiHandoff = mergeGeminiHandoff(geminiHandoff, {...event, requestIds, queryIds, epoch: geminiIntentEpoch});
    if (['ready', 'blocked'].includes(event.status)) for (const id of requestIds) handoffJobs.delete(id);
    state.notices.push({
      id: randomUUID(),
      kind: 'gemini-handoff',
      level: event.status === 'blocked' ? 'warning' : 'info',
      message: geminiHandoffNotice(event),
      createdAt: now()
    });
    if (event.status !== 'waiting') scheduleWorkers();
    changed();
  };
  const cancelGeminiHandoff = () => {
    geminiIntentEpoch++;
    geminiHandoff = null;
    handoffJobs.clear();
    bridgeInstance?.cancelGeminiHandoff?.();
    for (const n of state.notices) if (n.kind === 'gemini-handoff') n.resolved = true;
  };
  // A notice is a new native turn on this conversation. It is marked before sending;
  // a send that may have reached the core is never repeated.
  async function deliverWorkers() {
    let handoff =
      ['ready', 'blocked'].includes(geminiHandoff?.status) && geminiHandoff.epoch === geminiIntentEpoch
        ? geminiHandoff
        : null;
    if (
      notifying ||
      stopping ||
      preparingContinuation ||
      !record ||
      state.busy ||
      opening ||
      agentUnresolved ||
      !['completed', 'ready'].includes(state.status) ||
      (!workerQueue.size && !handoff)
    )
      return;
    for (const [id, queued] of workerQueue)
      if (
        !workerNoticeCurrent(
          queued,
          state.workers.find(w => w.requestId === id)
        )
      )
        workerQueue.delete(id);
    const questionsOnly = handoff && state.workers.some(w => w.settled !== true);
    if (questionsOnly) handoff = null;
    const waiting = geminiWaitingJobs(geminiHandoff),
      batch = [...workerQueue.values()].filter(row => !waiting.has(row.requestId) && (!questionsOnly || row.pendingQuestion));
    if (!batch.length && !handoff) return;
    const stop = stops,
      thread = state.threadId,
      ends = turnEnds,
      current = () => stop === stops && thread === state.threadId;
    notifying = true;
    let attempted = false,
      notSent = false,
      discardedQuestions = false;
    try {
      for (const row of batch) workerQueue.delete(row.requestId);
      for (const row of batch) if (row.settled) workerArmed.delete(row.requestId);
      const results = await Promise.all(batch.map(lunaResult));
      if (!current()) return;
      for (const row of batch) workerNotifications[workerNoticeKey(row)] = 'delivery-attempted';
      await save();
      if (!current()) {
        for (const row of batch) delete workerNotifications[workerNoticeKey(row)];
        return;
      }
      discardStaleWorkerQuestions(batch, results, state.workers, workerNotifications);
      if (!batch.length && !handoff) {
        discardedQuestions = true;
        return;
      }
      const text =
        (handoff ? geminiHandoffText(handoff) : '') +
        (batch.length ? workerNoticeText(batch) + JSON.stringify(results) : '');
      const summary = !batch.length
        ? 'Gemini 帳號排程通知'
        : batch.every(row => row.pendingQuestion)
          ? `K 工人提問（${batch.map(row => row.requestId).join('、')}）`
          : `K 子代理${batch.some(row => !row.settled) ? '狀態待確認' : '工作完成'}：${batch.map(row => row.requestId).join('、')}`;
      attempted = true;
      await api.send({text}, null, {kind: 'worker-completion', summary});
    } catch (error) {
      notSent = !attempted || error.notSent === true;
      if (notSent) {
        for (const row of batch) {
          delete workerNotifications[workerNoticeKey(row)];
          if (
            workerNoticeCurrent(
              row,
              state.workers.find(w => w.requestId === row.requestId)
            )
          )
            workerQueue.set(row.requestId, row);
        }
        await save().catch(() => {});
        if (!state.busy) state.error = `K 子代理通知尚未送出；可用 luna_inspect 查詢原 requestId：${error.message}`;
      } else state.error = `K 子代理通知未確認；未重送工作或通知：${error.message}`;
    } finally {
      if (handoff && attempted && !notSent) {
        geminiHandoff = consumeGeminiHandoff(geminiHandoff, handoff);
        if (geminiHandoff?.status !== 'ready')
          for (const n of state.notices) if (n.kind === 'gemini-handoff' && n.level === 'info') n.resolved = true;
      }
      notifying = false;
      changed();
      if (discardedQuestions || (notSent && turnEnds !== ends)) scheduleWorkers();
    }
  }
  // Rebuilding the gateway for new settings keeps pending notices; stopping (closeWorkers) drops them.
  async function closeGateway() {
    bridgeEpoch++;
    if (bridgeInitPromise) await bridgeInitPromise.catch(() => {});
    const oldGateway = gateway,
      oldBridge = bridge;
    gatewayKey = gatewayServer = null;
    if (oldGateway) await oldGateway.close();
    if (oldBridge) await oldBridge.close();
    gateway = bridge = bridgeInstance = null;
  }
  async function closeWorkers() {
    cancelGeminiHandoff();
    stops++;
    bridgeEpoch++;
    workerArmed.clear();
    workerQueue.clear();
    if (bridgeInitPromise) await bridgeInitPromise.catch(() => {});
    if (bridgeInstance) {
      const active = bridgeInstance;
      for (const item of await active.list()) {
        if (item?.settled || item?.executionUnowned === true) continue;
        await active.cancel({requestId: item.requestId});
        const waited = await active.wait({requestId: item.requestId, timeoutMs: 10000});
        const verified = await active.inspect({requestId: item.requestId});
        if (verified?.executionUnowned === true) continue;
        if (!waited?.settled || !verified?.settled) throw Error(`子代理 ${item.requestId} 的停止狀態未確認。`);
      }
    }
    clearQuestions();
    await closeGateway();
  }
  async function configureGateway() {
    if (!bridgeFactory) return null;
    const key = gatewayKeyOf(state.threadId, state.workspace, state.accessMode, state.workerPolicy);
    if (gateway && gatewayKey === key) return gatewayServer;
    if (await unsettledWorkers()) throw Error(WORKERS_RUNNING);
    if (gatewayThread !== state.threadId) {
      cancelGeminiHandoff();
      workerArmed.clear();
      workerQueue.clear();
    }
    await closeGateway();
    if (workerCatalog)
      workerInstructions = workerPolicyConfig(state.workerPolicy, {
        models: (await workerCatalog()).models,
        geminiGateway: true,
        claudeGateway: true,
        componentEnabled,
        provider
      }).developer_instructions;
    const parent = state.threadId,
      epoch = bridgeEpoch,
      options = {
        root,
        workspace: state.workspace,
        parentId: parent,
        accessMode: state.accessMode,
        workerPolicy: structuredClone(state.workerPolicy)
      };
    const ensureBridge = () => {
      if (bridgeInstance) return Promise.resolve(bridgeInstance);
      if (!bridgeInitPromise)
        bridgeInitPromise = Promise.resolve()
          .then(() =>
            bridgeFactory({
              ...options,
              onRequest: workerApproval,
              onChange: recordWorker,
              onGeminiHandoff: event => {
                if (state.threadId === parent && epoch === bridgeEpoch) recordGeminiHandoff(event);
              }
            })
          )
          .then(value => (bridgeInstance = value))
          .finally(() => {
            bridgeInitPromise = null;
          });
      return bridgeInitPromise;
    };
    const disarm = requestId => {
      workerArmed.delete(requestId);
      workerQueue.delete(requestId);
    };
    const lazyBridge = {
      workerPolicy: options.workerPolicy,
      async start(args) {
        workerArmed.add(args.requestId);
        handoffJobs.add(args.requestId);
        return (await ensureBridge()).start(args);
      },
      inspect: args => ensureBridge().then(value => value.inspect(args)),
      reconcile: args => ensureBridge().then(value => value.reconcile(args)),
      wait: args => ensureBridge().then(value => value.wait(args)),
      async answer(args) {
        if (opening || stopping || roomClosing || epoch !== bridgeEpoch || !bridgeInstance)
          throw Error('本對話目前沒有可回覆的工人提問。');
        return bridgeInstance.answer(args);
      },
      async cancel(args) {
        disarm(args.requestId);
        const result = await (await ensureBridge()).cancel(args);
        clearQuestions(item => item.workerRequestId === args.requestId);
        changed();
        return result;
      },
      resultReady(args, result) {
        geminiHandoff = consumeGeminiWaitResult(geminiHandoff, args.requestId, result);
        if (result?.settled) disarm(args.requestId);
        else if (workerNeedsAttention(result ?? {})) {
          workerNotifications[workerNoticeKey(result)] = 'delivery-attempted';
          const queued = workerQueue.get(args.requestId);
          if (queued && workerNoticeKey(queued) === workerNoticeKey(result)) workerQueue.delete(args.requestId);
          void save().catch(() => {});
        }
      },
      list: args => ensureBridge().then(value => value.list(args)),
      accounts: () => ensureBridge().then(value => value.accounts()),
      async close() {
        const value = bridgeInstance ?? (bridgeInitPromise ? await bridgeInitPromise.catch(() => null) : null);
        if (value) {
          await value.close();
          if (bridgeInstance === value) bridgeInstance = null;
        }
      }
    };
    const factory = gatewayFactory ?? (await import('./luna-gateway.mjs')).createLunaGateway;
    const mainTurn = () => {
      if (state.threadId !== parent || !state.busy) throw Error('只能在本主聊天室的進行中回合使用。');
      return parent;
    };
    // A core's native subagents may inherit this MCP configuration and there is no caller identity:
    // refuse while any native subagent-like tool or background job of this room is still running.
    const continuationCaller = () => {
      const current = turn;
      if (
        state.threadId !== parent ||
        !state.busy ||
        !current?.turnId ||
        current.native ||
        current.ended ||
        current.abort.signal.aborted ||
        opening ||
        halting ||
        stopping ||
        preparingContinuation ||
        agentUnresolved
      )
        throw Error('只能在本主聊天室的進行中回合換房；未受理。');
      if (noticePending()) throw Error('K 子代理通知尚未送達本聊天室；待通知送完後再換房。');
      // Grok shows MCP calls under a display label; the native name may be in the title or rawInput.
      if (
        state.nativeJobs?.length ||
        state.tools.some(t => {
          if (t.status !== 'running') return false;
          const names = [t.name, t.title, t.details?.tool_name].filter(v => typeof v === 'string');
          return (
            !names.some(v => /^(mcp__)?k_luna__conversation_create$/u.test(v)) &&
            names.some(v => /agent|task|workflow/iu.test(v))
          );
        })
      )
        throw Error('原生子代理或背景工作尚未結束；待結束後再換房。');
      return current;
    };
    const selection = () =>
      JSON.stringify([state.model, state.workspace, state.workerPolicy, state.effort ?? null, state.accessMode]);
    gateway = await factory({
      bridge: lazyBridge,
      ...(onContinueConversation
        ? {
            continueFreshOnly: true,
            continueConversation: async args => {
              const sourceTurn = continuationCaller(),
                sourceSelection = selection();
              const stillCurrent = () => {
                if (continuationCaller() !== sourceTurn || selection() !== sourceSelection)
                  throw Error('來源回合或設定已變更；未受理交接。');
              };
              const afterTurnCurrent = () => {
                if (
                  state.threadId !== parent ||
                  selection() !== sourceSelection ||
                  opening ||
                  halting ||
                  stopping ||
                  agentUnresolved ||
                  noticePending() ||
                  state.status === 'interrupted'
                )
                  throw Error('來源已停止或變更；未送出交接。');
              };
              const resolveTarget = async () => {
                const model = args.model ?? state.model;
                const {level} = choose(
                  (await api.models()).models,
                  model,
                  args.effort !== undefined ? (args.effort ?? undefined) : model === state.model ? state.effort : undefined
                );
                stillCurrent();
                return {targetModel: model, targetEffort: level ?? null};
              };
              return onContinueConversation({
                ...args,
                resolveTarget,
                threadId: parent,
                turnId: sourceTurn.turnId,
                stillCurrent,
                afterTurnCurrent
              });
            }
          }
        : {}),
      ...(roomTools
        ? {
            rooms: {
              rename: args => roomTools.rename(mainTurn(), args),
              list: () => roomTools.list(mainTurn()),
              note: args => roomTools.note(mainTurn(), args),
              schedule: (action, args) => roomTools.schedule(mainTurn(), action, args)
            }
          }
        : {}),
      // Read-only Colab entry (sign-in and eligibility; no runtime or inference).
      ...(colabAdmin && componentEnabled('colab')
        ? {
            colab: {
              status: args => {
                mainTurn();
                return colabAdmin.status(args);
              },
              login: () => {
                mainTurn();
                return colabAdmin.status({signIn: true});
              }
            }
          }
        : {})
    });
    bridge = lazyBridge;
    gatewayKey = key;
    gatewayThread = parent;
    const server = gateway.mcpConfig?.mcpServers?.k_luna;
    gatewayServer = server ? {url: server.url, headers: server.headers} : null;
    return gatewayServer;
  }

  // ---- Native ACP agent for this room ----
  const httpServer = (name, server) => ({
    type: 'http',
    name,
    url: server.url,
    headers: Object.entries(server.http_headers ?? server.headers ?? {}).map(([key, value]) => ({
      name: key,
      value: String(value)
    }))
  });
  const newTurn = (extra = {}) => {
    let finish;
    const settled = new Promise(resolve => (finish = resolve));
    return {abort: new AbortController(), loading: false, settled, finish, ...extra};
  };
  // Ends one turn: the last state is saved, the room is idle again and pending worker notices may follow.
  async function settleTurn(current, assistant) {
    if (current.ended) return;
    current.ended = true;
    if (assistant) {
      delete assistant.streaming;
      if (state.status !== 'completed') assistant.partial = true;
    }
    for (const tool of state.tools) if (tool.status === 'running') tool.status = 'interrupted';
    clearQuestions(item => !!item.native);
    refreshUsage();
    try {
      await save(assistant ? now() : undefined);
    } catch (error) {
      state.status = 'uncertain';
      state.error = `對話保存失敗；未重送：${error.message}`;
    }
    // A K turn that leaves DSH working (background jobs, a queued goal round) hands over to DSH's own turn
    // before the room is released, so no queued message or setting change slips into the gap.
    const thread = record?.threadId;
    let native = null;
    // A newer read (log watch or update) that started meanwhile wins: read again until this read is the
    // latest, so an older 'not working' never releases a room DSH is still working in.
    let stale = false;
    for (let tries = 0; !current.native && !current.abort.signal.aborted && tries < 5; tries++) {
      const seq = ++nativeSeq;
      native = await readNative();
      stale = seq !== nativeSeq;
      if (!stale) break;
    }
    if (native && !stale && record?.threadId === thread) applyNative(native);
    // Reads overtaken every time mean DSH keeps writing: treat it as still working; the log watch ends it.
    if (stale) native = {...native, running: true, jobs: native?.jobs ?? []};
    if (turn === current) turn = null;
    current.finish();
    turnEnds++;
    const settled = {threadId: state.threadId, turnId: current.turnId, status: state.status};
    const notifySettled = handedOver =>
      onConversationSettled &&
      queueMicrotask(() => {
        if (state.threadId === settled.threadId)
          onConversationSettled(handedOver ? {...settled, status: 'continuing'} : settled);
      });
    // A stop that arrived meanwhile refuses the handover (halting, aborted, no process); the room then
    // settles normally.
    if (
      native?.running &&
      !current.abort.signal.aborted &&
      record?.threadId === thread &&
      beginNativeTurn(
        native.jobs.length
          ? `DeepSeek 背景工作執行中（${native.jobs.length} 個），完成後會自己繼續`
          : 'DeepSeek 自主繼續工作'
      )
    ) {
      notifySettled(true);
      watchNative();
      return;
    }
    state.busy = false;
    changed();
    notifySettled(false);
    scheduleWorkers();
    watchNative();
  }

  // ---- A core's own autonomous work (DSH goal rounds and background jobs) ----
  // DSH reports it only as session updates outside any prompt; whether it is still working comes from its
  // own session log. K shows it as a turn the human can stop; nothing here starts, repeats or resumes work.
  let nativeWatch = null,
    nativeTimer = null,
    nativeSeq = 0,
    watchLife = 0,
    roomClosing = false,
    // Only this process's part of DSH's log can describe live work: a job or turn left open by a process
    // that was stopped or killed is not running any more. The boundary is DSH's own event sequence when
    // this process took the session (not the wall clock).
    processAfterSeq = Infinity;
  function unwatchNative() {
    nativeSeq++;
    watchLife++;
    clearTimeout(nativeTimer);
    nativeWatch?.close();
    nativeWatch = null;
  }
  // Returns the log state; the caller applies it only once it knows the read is still current.
  async function readNative() {
    if (!profile.nativeState || !record?.nativeSessionId) return null;
    try {
      return await profile.nativeState(home, record.nativeSessionId, {afterSeq: processAfterSeq});
    } catch {
      return null;
    }
  }
  function applyNative(native) {
    state.goal = native.goal;
    state.nativeJobs = native.jobs;
    if (turn?.native && native.goalRound) {
      const message = state.messages.findLast(m => m.id === turn.turnId);
      if (message) message.text = message.summary = `DeepSeek 自主繼續：目標第 ${native.goalRound} 輪`;
    }
  }
  function watchNative() {
    if (!profile.nativeState || !record?.nativeSessionId || roomClosing) return;
    if (nativeWatch?.thread !== record.threadId) attachNativeWatch();
    checkNative();
  }
  function attachNativeWatch() {
    nativeWatch?.close();
    nativeWatch = null;
    const thread = record.threadId,
      life = watchLife;
    void profile
      .nativeFolder(home, record.nativeSessionId)
      .catch(() => null)
      .then(folder => {
        if (!folder || record?.threadId !== thread || nativeWatch || life !== watchLife || roomClosing) return;
        try {
          const watcher = watch(folder, () => checkNative());
          watcher.on('error', () => {});
          nativeWatch = {thread, close: () => watcher.close()};
        } catch {}
      });
  }
  function beginNativeTurn(summary) {
    if (turn || !record || opening || halting || !agent || agent.exited) return null;
    const current = newTurn({native: true});
    turn = current;
    state.busy = true;
    activity.begin();
    state.status = 'working';
    state.error = null;
    const groupId = randomUUID(),
      user = {
        id: randomUUID(),
        role: 'user',
        text: summary,
        attachments: [],
        createdAt: now(),
        groupId,
        kind: 'native-autonomous',
        summary
      };
    user.turnId = current.turnId = user.id;
    state.messages.push(user);
    current.view = renderTurn(current, user, groupId);
    void save(user.createdAt).catch(() => {});
    changed();
    return current;
  }
  // Read after DSH's log settles for a moment, so the gap between a turn and its queued next round is not
  // taken for the end of the work.
  function checkNative() {
    if (!profile.nativeState || !record?.nativeSessionId || roomClosing) return;
    clearTimeout(nativeTimer);
    const seq = ++nativeSeq;
    nativeTimer = setTimeout(async () => {
      const native = await readNative();
      // A read that a newer read, a room change or the end of the turn has overtaken changes nothing.
      if (!native || seq !== nativeSeq) return;
      applyNative(native);
      const current = turn;
      if (current?.native && !native.running && !current.abort.signal.aborted && !current.ended) {
        state.status = 'completed';
        await settleTurn(current, current.view.assistant());
        return;
      }
      // A K turn that ended with background jobs still running stays visible as DSH's own work.
      if (!current && native.jobs.length)
        beginNativeTurn(`DeepSeek 背景工作執行中（${native.jobs.length} 個），完成後會自己繼續`);
      changed();
    }, profile.nativeSettleMs ?? 600);
  }

  // Streams native updates of one turn (a K send or DSH's own autonomous work) into its messages and tools.
  function renderTurn(current, user, groupId) {
    // This turn's tool entries are keyed `${user.id}-${toolCallId}`.
    current.toolKey = toolCallId => `${user.id}-${toolCallId}`;
    let assistant = null;
    const ensureAssistant = () =>
      (assistant ??=
        (state.messages.push({
          id: randomUUID(),
          role: 'assistant',
          text: '',
          attachments: [],
          createdAt: now(),
          groupId,
          streaming: true
        }),
        state.messages.at(-1)));
    current.update = update => {
      if (current.abort.signal.aborted) return;
      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk' && typeof update.content?.text === 'string') {
        activity.record();
        ensureAssistant().text += update.content.text;
      } else if (kind === 'agent_thought_chunk') {
        activity.record();
        // DSH sends each step's whole reasoning once the step is committed, not token by token.
        if (!profile.thoughts || typeof update.content?.text !== 'string' || !update.content.text) return;
        // A step may carry only thoughts and tool calls; the turn needs its reply to show them under.
        ensureAssistant();
        let entry = state.reasoning.find(r => r.groupId === groupId);
        if (!entry) state.reasoning.push((entry = {id: `${user.id}-thoughts`, groupId, text: ''}));
        entry.text = (entry.text ? `${entry.text}\n\n` : '') + update.content.text;
        // Only the tail matters for a running view; keep memory and pushed state bounded.
        if (entry.text.length > MAX_THOUGHT_CHARS) entry.text = `…${entry.text.slice(-MAX_THOUGHT_CHARS)}`;
        if (state.reasoning.length > 50) state.reasoning.splice(0, state.reasoning.length - 50);
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const key = `${user.id}-${update.toolCallId}`,
          index = state.tools.findIndex(t => t.id === key),
          previousTool = index < 0 ? null : state.tools[index];
        const status =
          update.status === 'completed'
            ? 'completed'
            : update.status === 'failed'
              ? 'failed'
              : (previousTool?.status ?? 'running');
        const entry = {
          id: key,
          groupId,
          createdAt: previousTool?.createdAt ?? now(),
          kind: update.kind ?? previousTool?.kind ?? 'tool',
          name: profile.toolLabel?.(update) ?? previousTool?.name ?? profile.toolName(update),
          title: update.title ?? previousTool?.title ?? null,
          status,
          details: update.rawInput ?? previousTool?.details ?? {},
          error:
            update.status === 'failed'
              ? String(update.content?.find?.(c => c?.content?.text)?.content?.text ?? '工具失敗。').slice(0, 2000)
              : null
        };
        if (index < 0) state.tools.push(entry);
        else state.tools[index] = entry;
        activity.tool(key, status !== 'running', 'tool', entry.name);
        if (status === 'completed' && (entry.kind === 'edit' || profile.editTools?.includes(entry.name)))
          for (const target of writeTargets({...update, rawInput: update.rawInput ?? previousTool?.details})) {
            const absolute = path.resolve(state.workspace, target),
              name = path.relative(state.workspace, absolute).replaceAll('\\', '/');
            if (insideWorkspace(absolute) && !state.artifacts.includes(name)) state.artifacts.push(name);
          }
      } else if (kind === 'usage_update' && Number.isFinite(update.used) && Number.isFinite(update.size))
        state.progress.contextUsage = {used: update.used, size: update.size};
      else if (kind === 'plan' && Array.isArray(update.entries))
        state.progress.plan = update.entries.map(e => ({
          step: String(e.content ?? ''),
          status: e.status ?? 'pending'
        }));
      else return;
      changed();
    };
    current.notification = (method, update) => {
      if (profile.notification?.(method, update, state)) changed();
    };
    return {assistant: () => assistant};
  }

  // Usage a core records only in its own log (DeepSeek token counts) is read after each turn and on open,
  // in the background: opening a room or finishing a turn never waits on it, and a result for a room that
  // is no longer shown is dropped.
  function refreshUsage() {
    if (!profile.refreshUsage || !record?.nativeSessionId) return;
    const seq = ++usageSeq,
      thread = record.threadId;
    void profile
      .refreshUsage({home, record, login})
      .then(roomUsage => {
        if (!roomUsage || seq !== usageSeq || record?.threadId !== thread) return;
        state.progress = {...state.progress, roomUsage};
        changed();
      })
      .catch(() => {});
  }
  const processKey = () =>
    JSON.stringify([
      state.threadId,
      state.workspace,
      mcpServers,
      profile.processPerAccessMode ? state.accessMode : null
    ]);
  async function closeAgent() {
    const current = agent;
    agent = null;
    agentKey = null;
    processAfterSeq = Infinity;
    if (!current) return;
    try {
      await current.close();
    } catch (error) {
      agentUnresolved = current;
      throw error;
    }
  }
  function choose(catalog, model, effort) {
    const choice = catalog.find(item => item.model === model);
    if (!choice) throw Error(`目前 ${label} 未提供指定模型；未換模。`);
    const levels = choice.supportedReasoningEfforts.map(e => e.reasoningEffort);
    const level = effort ?? choice.defaultReasoningEffort;
    if (levels.length ? !levels.includes(level) : level != null)
      throw Error(`指定 ${label} 推理程度目前不可用；未換模。`);
    return {choice, level: levels.length ? level : null};
  }
  async function prepare() {
    if (!binary) throw Error(profile.missingBinary);
    // First, so a refused settings change (a K worker still running) touches nothing else.
    const lunaServer = await configureGateway();
    if (browserMode !== state.accessMode) {
      await resetBrowser();
      browserServer =
        state.accessMode === 'read-only'
          ? null
          : await browserConfig({
              appRoot: root,
              conversationId: state.threadId,
              accessMode: state.accessMode,
              provider
            });
      browserMode = state.accessMode;
    }
    const desktop = componentEnabled('desktop') && await desktopControlMcp({root, fullAccess: state.accessMode === 'danger-full-access'});
    mcpServers = [
      ...(lunaServer ? [httpServer('k_luna', lunaServer)] : []),
      ...(browserServer ? [httpServer('k_browser', browserServer)] : []),
      ...(desktop
        ? [
            {
              name: 'k_desktop',
              command: desktop.command,
              args: desktop.args,
              env: Object.entries(desktop.env ?? {}).map(([name, value]) => ({name, value}))
            }
          ]
        : [])
    ];
    rules = [
      workerInstructions,
      profile.accessGuidance[state.accessMode],
      workspaceGuidance(state),
      browserServer ? GEMINI_BROWSER_GUIDANCE : '',
      desktop ? DESKTOP_CONTROL_GUIDANCE : '',
      commonMemoryReference(root)
    ]
      .filter(Boolean)
      .join('\n');
    state.browserAccess = {
      enabled: !!browserServer,
      networkAccess: !!browserServer,
      sessionKey: browserSessionKey(browserServer)
    };
    // A new MCP set or workspace (or, for a core whose sandbox is fixed per process, a new access
    // mode) needs a fresh native process; the native session itself continues.
    const key = processKey();
    if (agent && agentKey !== key) await closeAgent();
  }
  function onNotification(message) {
    const params = message.params ?? {};
    if (!record || params.sessionId !== record.nativeSessionId) return;
    let current = turn;
    if (profile.nativeState) {
      if (!current && message.method === 'session/update' && !stopping)
        current = beginNativeTurn('DeepSeek 自主繼續工作');
      checkNative();
    }
    if (!current || current.loading) return;
    if (message.method === 'session/update') current.update?.(params.update ?? {});
    else current.notification?.(message.method, params.update ?? {});
  }
  // Every native permission prompt is decided here; nothing is approved for longer than once.
  async function onRequest(message) {
    if (message.method !== 'session/request_permission') throw Error(`K 未支援這項 ${label} 用戶端請求。`);
    const params = message.params ?? {},
      options = params.options ?? [];
    const pick = kind => options.find(o => o.kind === kind)?.optionId;
    const allow = () => ({outcome: {outcome: 'selected', optionId: pick('allow_once')}}),
      reject = () =>
        pick('reject_once')
          ? {outcome: {outcome: 'selected', optionId: pick('reject_once')}}
          : {outcome: {outcome: 'cancelled'}};
    const current = turn,
      live = () => turn === current && !current.abort.signal.aborted;
    if (!current || !live() || !record || params.sessionId !== record.nativeSessionId || !pick('allow_once'))
      return reject();
    // DSH names only the call id; the call itself already arrived in this turn as a tool_call update.
    const callId = params.toolCall?.toolCallId,
      known = callId ? state.tools.find(t => t.id === current.toolKey?.(callId)) : null;
    const toolCall = {
      ...(known ? {title: known.title, kind: known.kind, rawInput: known.details} : {}),
      ...params.toolCall
    };
    const name = profile.toolName(toolCall),
      server = name.split('__')[0];
    if (state.accessMode === 'read-only') return reject();
    if (state.accessMode === 'danger-full-access') return allow();
    // Nothing to show the human: never ask them to approve an operation they cannot see.
    const filled = v =>
      typeof v === 'string' ? v.trim() !== '' : !!v && typeof v === 'object' && Object.keys(v).length > 0;
    if (![toolCall.title, toolCall.rawInput, toolCall.content].some(filled)) return reject();
    if (name.includes('__') && K_SERVERS.includes(server) && mcpServers.some(s => s.name === server)) return allow();
    if (toolCall.kind === 'edit') {
      const targets = writeTargets(toolCall);
      if (targets.length && (await Promise.all(targets.map(writableInside))).every(Boolean))
        return live() ? allow() : reject();
      if (!live()) return reject();
    }
    const id = randomUUID(),
      diff = (toolCall.content ?? []).find(item => item?.type === 'diff'),
      input = toolCall.rawInput ?? {};
    const details = {
      toolName: name,
      ...(typeof input.command === 'string' ? {command: input.command, cwd: state.workspace} : {}),
      ...(diff ? {path: diff.path, newText: String(diff.newText ?? '').slice(0, 20000)} : {}),
      ...(!diff && typeof input.command !== 'string' ? {input} : {}),
      scope: '只核准這一次'
    };
    return new Promise(resolve => {
      pending.set(id, {resolve, cancelValue: {outcome: {outcome: 'cancelled'}}, native: {allow, reject}});
      state.questions.push({
        id,
        kind: 'approval',
        threadId: state.threadId,
        provider,
        title: `${label} 需要操作核准`,
        text: `${toolCall.title ?? name}${toolCall.kind === 'edit' ? '（工作區外或無法確認位置的寫入）' : ''}`,
        details,
        acceptLabel: '只核准這一次',
        canAccept: true
      });
      changed();
    });
  }
  async function ensureAgent(current) {
    if (agent && !agent.exited) return agent;
    agent = null;
    await profile.ensureHome(home);
    let opened;
    try {
      opened = await openAgent({
        executable: binary,
        env: await profile.environment(env, home, {accessMode: state.accessMode}),
        cwd: state.workspace,
        onNotification,
        onRequest,
        signal: current.abort.signal
      });
    } catch (error) {
      if (error.unresolvedPid) agentUnresolved = error.unresolvedProcess ?? {pid: error.unresolvedPid};
      throw error;
    }
    // Held before any session request, so a stop can always reach the process.
    agent = opened;
    void opened.closed?.then(() => {
      const current = turn;
      if (current?.native && !current.abort.signal.aborted && !current.ended && agent === opened) {
        nativeSeq++;
        state.status = 'uncertain';
        state.error = `${label} 程序在自主工作中結束；結果未知，未重送。`;
        void settleTurn(current, current.view.assistant());
      }
    });
    // A new process has not seen K's rules or the common memory block yet.
    rulesKey = null;
    commonKey = null;
    const meta = profile.metaRules ? {_meta: {rules}} : {};
    try {
      current.loading = true;
      const resumed = !!record.nativeSessionId;
      if (resumed) {
        const params = {sessionId: record.nativeSessionId, cwd: state.workspace, mcpServers, ...meta};
        try {
          await opened.request('session/resume', params);
        } catch (error) {
          if (!profile.loadFallback) throw error;
          await opened.request('session/load', params);
        }
      } else {
        const created = await opened.request('session/new', {cwd: state.workspace, mcpServers, ...meta});
        if (!nativeId(created?.sessionId)) throw Error(`${label} 沒有回傳原生對話 ID；未送出。`);
        record.nativeSessionId = created.sessionId;
        await save();
        // A new session has no earlier process: everything in its log is this process's work.
        processAfterSeq = -1;
      }
      // A resumed session's live-work boundary. A log that exists but cannot be read leaves it unknown:
      // the process is not used, rather than counting work its predecessor left open as live.
      if (profile.nativeLastSeq && resumed) processAfterSeq = await profile.nativeLastSeq(home, record.nativeSessionId);
    } catch (error) {
      // A stop that cannot be confirmed leaves agentUnresolved set and blocks new work.
      if (agent === opened) await closeAgent();
      throw error;
    } finally {
      current.loading = false;
    }
    agentKey = processKey();
    return agent;
  }

  const api = {
    state,
    get backgroundWork() {
      if (agentUnresolved) return `${label} 程序停止待確認`;
      return agent && !agent.exited && state.nativeJobs?.length ? `${label} 背景工作執行中（${state.nativeJobs.length} 個）` : null;
    },
    async models() {
      return {models: await login.models(), provider};
    },
    async usage(refresh = false) {
      if (usagePending) return usagePending;
      if (!refresh && Date.now() - usageAttemptAt < 60000) return {[provider]: state.usage[provider]};
      usageAttemptAt = Date.now();
      usagePending = (async () => {
        let result;
        try {
          result = await login.status();
        } catch {
          result = {reason: '官方額度查詢失敗，請稍後刷新。'};
        }
        const previous = state.usage[provider];
        state.usage[provider] = result.quota
          ? {...result.quota, plan: result.plan ?? result.quota.plan}
          : {
              ...previous,
              status: profile.hasQuota(previous) ? 'stale' : 'unavailable',
              note: result.reason ?? '無法取得官方額度。'
            };
        changed();
        return {[provider]: state.usage[provider]};
      })();
      try {
        return await usagePending;
      } finally {
        usagePending = null;
      }
    },
    async workers() {
      if (bridgeInstance) for (const item of await bridgeInstance.list()) recordWorker(item);
      if (geminiHandoff?.status === 'ready') scheduleWorkers();
      return structuredClone(state.workers);
    },
    async directories(parent = state.workspace) {
      return listWorkspaceDirectories(parent);
    },
    async selectWorkspace({path: requested}) {
      idle();
      const workspace = await validateWorkspace(requested);
      await persist;
      if (await unsettledWorkers()) throw Error('K 子代理尚未結束；待工人完成後再切換工作區。');
      await closeWorkers();
      await closeAgent();
      await resetBrowser();
      Object.assign(state, {
        workspace,
        threadId: null,
        title: '',
        messages: [],
        tools: [],
        reasoning: [],
        artifacts: [],
        workers: [],
        status: 'idle',
        error: null
      });
      record = null;
      changed();
      return {workspace};
    },
    async open(
      {threadId, model, effort, accessMode = 'workspace-write', permissionConfirmed = false, workerPolicy} = {},
      {signal, relocation, onHistory, continuation, onCreated} = {}
    ) {
      if (continuation && (continuation.mode !== 'fresh' || threadId))
        throw Object.assign(Error(`接續只能建立全新的 ${label} 聊天室；未建立新聊天室。`), {notCreated: true});
      idle();
      opening = true;
      let previousClosed = false,
        saving = false;
      const originalWorkspace = relocation
        ? {
            workspace: state.workspace,
            previousWorkspaces: state.previousWorkspaces,
            previousArtifacts: state.previousArtifacts,
            artifacts: state.artifacts
          }
        : null;
      try {
        await persist;
        signal?.throwIfAborted();
        const saved = threadId ? await read(threadId) : null;
        if (saved && (saved.threadId !== threadId || saved.model !== model))
          throw Error('對話設定已更新，請重新整理清單。');
        if (saved?.nativeStarted && !nativeId(saved.nativeSessionId))
          throw Error(`上次 ${label} 送出後尚未取得原生對話 ID；不能自動建立新對話或重送。`);
        const common = threadId ? (await listMainSessions(root, {threadId})).sessions[0] : null;
        const workspace = await validateWorkspace(
          relocation?.workspace ?? common?.workspace ?? saved?.workspace ?? state.workspace
        );
        // These cores bind resume/load to the original physical directory. Refuse before closing the old
        // process or changing presentation/persistence, including when called outside the unified API.
        if (
          relocation && saved?.nativeSessionId && profile.resumeSameDirectory &&
          workspace !== (await validateWorkspace(saved.workspace))
        )
          throw Error(`${label} 已有原生對話的聊天室無法移到不同實體目錄；請在新工作區開新聊天室。`);
        signal?.throwIfAborted();
        const {choice, level} = choose((await api.models()).models, model, effort ?? saved?.effort),
          mode = access(saved?.accessMode ?? accessMode);
        if (!saved && mode === 'danger-full-access' && !permissionConfirmed)
          throw Error(`請明確確認 ${label} 完整存取權。`);
        signal?.throwIfAborted();
        const policy = normalizeWorkerPolicy(workerPolicy ?? saved?.workerPolicy ?? common?.workerPolicy);
        if (
          gateway &&
          gatewayKey !== gatewayKeyOf(saved?.threadId, workspace, mode, policy) &&
          (await unsettledWorkers())
        )
          throw Error(WORKERS_RUNNING);
        activity.clear();
        usageSeq++;
        await closeAgent();
        await resetBrowser();
        previousClosed = true;
        record = saved ?? {
          threadId: `${profile.idPrefix}-${randomUUID()}`,
          nativeSessionId: null,
          nativeStarted: false,
          archived: false,
          pinned: false,
          createdAt: now(),
          ...(continuation ? {title: `新對話 · ${continuation.parentTitle || '接續工作'}`.slice(0, 120)} : {})
        };
        commonKey = null;
        Object.assign(state, {
          threadId: record.threadId,
          workspace,
          model,
          modelDisplayName: choice.displayName,
          nativeModel: choice.nativeValue ?? model,
          inputModalities: [...choice.inputModalities],
          effort: level,
          efforts: choice.supportedReasoningEfforts.map(e => e.reasoningEffort),
          accessMode: mode,
          title: record.title ?? '',
          messages: record.messages ?? [],
          tools: record.tools ?? [],
          reasoning: [],
          artifacts: record.artifacts ?? [],
          lastUsedModel: record.lastUsedModel ?? null,
          modelChanges: record.modelChanges ?? [],
          status: 'ready',
          error: null,
          busy: false,
          workers: [],
          workerPolicy: policy
        });
        workerNotifications = structuredClone(saved?.workerNotifications ?? {});
        state.previousWorkspaces = relocation?.previousWorkspaces ?? common?.previousWorkspaces ?? [];
        state.previousArtifacts = relocation?.previousArtifacts ?? common?.previousArtifacts ?? [];
        state.artifacts = relocation
          ? [...state.previousArtifacts]
          : [...new Set([...state.previousArtifacts, ...state.artifacts])];
        await onHistory?.(state);
        signal?.throwIfAborted();
        state.progress = {...state.progress, contextUsage: null, roomUsage: null};
        state.goal = null;
        state.nativeJobs = [];
        unwatchNative();
        refreshUsage();
        watchNative();
        await prepare();
        if (bridgeInstance) for (const item of await bridgeInstance.list()) recordWorker(item);
        signal?.throwIfAborted();
        saving = true;
        await save();
        if (continuation) await onCreated?.({threadId: state.threadId});
        changed();
        return {threadId: state.threadId};
      } catch (error) {
        if (originalWorkspace) Object.assign(state, originalWorkspace);
        if (continuation) {
          // Before the room is saved nothing exists: the view must not keep the uncreated id.
          if (saving) error.createdThreadId = state.threadId;
          else {
            error.notCreated = true;
            record = null;
            state.threadId = null;
          }
        }
        if (previousClosed) {
          state.status = relocation ? 'error' : 'failed';
          state.error = error.message;
          await resetBrowser().catch(() => {});
        }
        throw error;
      } finally {
        opening = false;
      }
    },
    async selectModel({threadId, model, effort}) {
      idle();
      if (!record || threadId !== state.threadId) throw Error(`${label} 對話已切換。`);
      const {choice, level} = choose((await api.models()).models, model, effort);

      Object.assign(state, {
        model,
        modelDisplayName: choice.displayName,
        nativeModel: choice.nativeValue ?? model,
        inputModalities: [...choice.inputModalities],
        effort: level,
        efforts: choice.supportedReasoningEfforts.map(e => e.reasoningEffort)
      });
      await save();
      changed();
      return {threadId, model, effort: level};
    },
    async metadata({threadId, title, archived, pinned}) {
      if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 120))
        throw Error('標題須為 1–120 字元。');
      if (
        (archived !== undefined && typeof archived !== 'boolean') ||
        (pinned !== undefined && typeof pinned !== 'boolean')
      )
        throw Error('封存或釘選狀態無效。');
      await persist;
      const saved = await read(threadId),
        updated = {
          ...saved,
          ...(title === undefined ? {} : {title: title.trim()}),
          ...(archived === undefined ? {} : {archived}),
          ...(pinned === undefined ? {} : {pinned})
        };
      if (threadId === state.threadId) {
        record = {...record, title: updated.title, archived: updated.archived, pinned: updated.pinned};
        state.title = updated.title;
        await save();
        changed();
      } else {
        await atomicWrite(file(threadId), JSON.stringify(updated, null, 2));
        await saveMainSession(root, updated);
      }
      return {threadId, title: updated.title, archived: updated.archived, pinned: updated.pinned};
    },
    async upload(data) {
      if (!record || data.threadId !== state.threadId) throw Error('對話已切換，請重新加入附件。');
      return saveAttachment(state.workspace, state.threadId, data, {inputModalities: state.inputModalities});
    },
    async uploadStream(data, stream) {
      if (!record || data.threadId !== state.threadId) throw Error('對話已切換，請重新加入附件。');
      return saveAttachmentStream(
        state.workspace,
        state.threadId,
        {...data, stream},
        {inputModalities: state.inputModalities}
      );
    },
    async attachmentFile(id) {
      const item = await sessionAttachment(state.workspace, state.previousWorkspaces, state.threadId, id);
      return {...(await readPresentedFile(item.workspace, item.path)), name: item.name};
    },
    async attachmentSource(id, context = {}) {
      if (context.threadId && context.threadId !== state.threadId)
        throw new Error('聊天室已切換，請回到原對話下載附件。');
      return sessionAttachmentSource(state.workspace, state.previousWorkspaces, state.threadId, id);
    },
    async artifact(name) {
      if (!state.artifacts.includes(name)) throw Error('只開啟本對話已記錄的成果。');
      return sessionArtifact(state.workspace, state.previousWorkspaces, name);
    },
    async artifactSource(name) {
      if (!state.artifacts.includes(name)) throw Error('只開啟本對話已記錄的成果。');
      return sessionArtifactSource(state.workspace, state.previousWorkspaces, name);
    },
    // `internal` marks a K event turn (worker notice); it is not a user message.
    async send(
      {text = '', attachmentIds = [], accessMode, effort, permissionConfirmed = false, discussionTurn, source} = {},
      goalObjective = null,
      internal = null
    ) {
      let attempted = false;
      try {
        if (goalObjective) throw Error(`${label} 目前沒有原生目標模式；請直接送出訊息。`);
        if (internal && stopping) throw Error('聊天室正在停止；K 通知未送出。');
        idle();
        if (!record || !['ready', 'completed', 'failed', 'interrupted'].includes(state.status))
          throw Error(`請先開啟 ${label} 對話。`);
        if (record.nativeStarted && !nativeId(record.nativeSessionId))
          throw Error('前次送出後沒有原生對話 ID；請先查明，不會重送或另開原生對話。');
        if (
          typeof text !== 'string' ||
          text.length > 100000 ||
          (!text.trim() && (!Array.isArray(attachmentIds) || !attachmentIds.length))
        )
          throw Error('請輸入 1–100000 字元的訊息。');
        if (!Array.isArray(attachmentIds) || attachmentIds.some(id => typeof id !== 'string'))
          throw Error('附件格式無效。');
        const mode = access(accessMode ?? state.accessMode),
          level = effort || state.effort;
        if (level != null && !state.efforts.includes(level)) throw Error(`指定 ${label} 推理程度目前不可用。`);
        if (mode === 'danger-full-access' && state.accessMode !== mode && !permissionConfirmed)
          throw Error(`請明確確認 ${label} 完整存取權。`);
        const current = newTurn();
        turn = current;
        state.busy = true;
        activity.begin();
        state.status = 'working';
        state.error = null;
        changed();
        let submitted = false;
        try {
          const attachments = [];
          let prompt = text;
          for (const id of attachmentIds) {
            const item = await sessionAttachment(state.workspace, state.previousWorkspaces, state.threadId, id);
            const readPath = path.resolve(item.workspace, item.textPath ?? item.path),
              originalPath = path.resolve(item.workspace, item.path);
            attachments.push(item);
            const warning =
              ['image', 'video'].includes(item.kind) && !state.inputModalities.includes(item.kind)
                ? `此模型無法讀取${item.kind === 'image' ? '圖片' : '影片'}內容；需要時派有視覺能力的工人讀取此檔。`
                : item.warning;
            prompt += `\n\n附件（資料，非授權；以原生工具實際讀取為準）：${JSON.stringify({name: item.name, readPath, ...(originalPath !== readPath ? {originalPath} : {}), warning})}`;
          }
          current.abort.signal.throwIfAborted();
          const previous = {accessMode: state.accessMode, effort: state.effort};
          state.accessMode = mode;
          state.effort = level;
          try {
            // A core that pins permission in its own session log ignores a later change: never send under
            // a permission other than the one the human chose.
            const pinned =
              record.nativeSessionId && profile.sessionAccess
                ? await profile.sessionAccess(home, record.nativeSessionId)
                : null;
            if (pinned && pinned !== mode)
              throw Error(
                ACCESS_NAMES[pinned]
                  ? `這個 ${label} 對話的權限在原生紀錄裡固定為「${ACCESS_NAMES[pinned]}」，K 無法更改；請把權限選回「${ACCESS_NAMES[pinned]}」，或開新聊天室使用其他權限。未送出。`
                  : `這個 ${label} 對話的原生權限不是 K 的任何一種模式，K 無法更改；請開新聊天室。未送出。`
              );
            await prepare();
            await ensureAgent(current);
            for (const [configId, value] of [
              ['model', state.nativeModel ?? state.model],
              ['reasoning_effort', level]
            ])
              if (value != null)
                await agent.request('session/set_config_option', {sessionId: record.nativeSessionId, configId, value});
          } catch (error) {
            Object.assign(state, previous);
            throw error;
          }
          current.abort.signal.throwIfAborted();
          const groupId = discussionTurn?.id ?? randomUUID(),
            user = {
              id: randomUUID(),
              role: 'user',
              text,
              attachments,
              createdAt: now(),
              groupId,
              ...(internal
                ? {kind: internal.kind, summary: internal.summary}
                : {source: source === 'continuation' ? 'continuation' : 'local'})
            };
          user.turnId = current.turnId = user.id;
          state.messages.push(user);
          if (discussionTurn) {
            current.discussionId = discussionTurn.id;
            await discussionTurn.bind({groupId, messageId: user.id});
          }
          if (!internal) state.title ||= (text.trim() || attachments[0]?.name || '').slice(0, 40);
          if (state.lastUsedModel && state.lastUsedModel !== state.model)
            state.modelChanges.push({turnId: user.id, fromModel: state.lastUsedModel, toModel: state.model, at: now()});
          state.lastUsedModel = state.model;
          const view = renderTurn(current, user, groupId);
          // Common memory travels in a tagged block only when it changed since this process's last delivery;
          // so do K's rules for a core that does not take them as session metadata.
          const common = claudeCommonBlock(root, commonKey),
            rulesBlock =
              !profile.metaRules && rules !== rulesKey ? {type: 'text', text: `<k_rules>\n${rules}\n</k_rules>`} : null;
          // The owner's own extra rules for this core travel once, in the first turn of a new chat room; the
          // native history keeps them after that. A missing or empty file sends nothing.
          const extra = !record.nativeStarted && profile.extraRules ? await profile.extraRules(home) : null;
          const blocks = [
            ...(rulesBlock ? [rulesBlock] : []),
            ...(common.block ? [common.block] : []),
            ...(extra ? [{type: 'text', text: extra}] : []),
            {type: 'text', text: prompt}
          ];
          record.nativeStarted = true;
          await save(user.createdAt);
          current.abort.signal.throwIfAborted();
          const sentAgent = agent;
          attempted = true;
          submitted = true;
          current.done = (async () => {
            try {
              const result = await sentAgent.request('session/prompt', {
                sessionId: record.nativeSessionId,
                prompt: blocks
              });
              if (common.block) commonKey = common.key;
              if (rulesBlock) rulesKey = rules;
              const stop = result?.stopReason;
              state.status = stop === 'cancelled' ? 'interrupted' : stop === 'refusal' ? 'failed' : 'completed';
              state.error =
                stop === 'refusal'
                  ? `${label} 拒絕這項要求。`
                  : stop === 'max_tokens'
                    ? `${label} 達到輸出上限，回覆可能不完整。`
                    : stop === 'cancelled' && !current.abort.signal.aborted
                      ? `${label} 回合已結束：操作未獲核准或被取消。`
                      : null;
            } catch (error) {
              if (error.processEnded && current.abort.signal.aborted) state.status = 'interrupted';
              else {
                state.status = error.processEnded ? 'uncertain' : 'failed';
                state.error = error.processEnded
                  ? `${label} 程序在回合中結束；結果未知，未重送：${error.message}`
                  : `${label} 回合失敗；未重送：${error.message}`;
              }
            } finally {
              await settleTurn(current, view.assistant());
            }
          })();
          return {sent: true};
        } catch (error) {
          if (!submitted) {
            if (!record.nativeSessionId) {
              record.nativeStarted = false;
              await save().catch(() => {});
            }
            state.busy = false;
            state.status = current.abort.signal.aborted ? 'interrupted' : 'failed';
            state.error = error.message;
            turn = null;
            current.finish();
            changed();
          }
          throw error;
        }
      } catch (error) {
        if (!attempted) error.notSent = true;
        throw error;
      }
    },
    async interruptDiscussion(id) {
      const current = turn;
      if (!current) return;
      if (current.discussionId !== id) throw Error('主持回合歸屬已改變；未中止其他工作。');
      await api.stopTurn();
    },
    // Cancel natively first; only when the core does not end the turn is its process tree ended.
    // A stop holds the work lock (halting) until it is complete, so no send or setting change starts a new
    // native process while the old one is still closing.
    async stopTurn() {
      const current = turn;
      if (!current) return;
      halting++;
      try {
        current.abort.abort();
        clearQuestions(item => !!item.native);
        try {
          if (agent && record?.nativeSessionId) agent.notify('session/cancel', {sessionId: record.nativeSessionId});
        } catch {}
        // DSH's own turn never settles from a cancel by itself, so it goes straight to closing the process.
        const ended = current.native
          ? false
          : await Promise.race([current.settled.then(() => true), new Promise(r => setTimeout(r, stopGraceMs, false))]);
        // A core whose native cancel leaves its own subagents running (DSH) is also closed: they end with
        // the process, and the next send resumes the same native session.
        if (ended && !profile.closeOnStop) return;
        try {
          await closeAgent();
        } catch (error) {
          state.status = 'uncertain';
          state.error = `${label} 停止未確認：${error.message}`;
          changed();
          throw error;
        }
        if (current.native) {
          state.status = 'interrupted';
          await settleTurn(current, current.view.assistant());
        }
        await current.settled;
      } finally {
        halting--;
      }
    },
    async stop() {
      // Before the first await: no worker notice may start a new native turn while stopping.
      stopping++;
      stops++;
      cancelGeminiHandoff();
      workerArmed.clear();
      workerQueue.clear();
      const current = turn;
      try {
        await api.stopTurn();
        if (agentUnresolved) {
          if (!agentUnresolved.exited) await killTree(agentUnresolved.pid);
          agentUnresolved = null;
          state.status = 'interrupted';
          state.error = null;
        }
        await resetBrowser();
        if (current && state.status !== 'uncertain') state.status = 'interrupted';
        await closeWorkers();
      } catch (error) {
        state.status = 'uncertain';
        state.error = error.message;
        changed();
        throw error;
      } finally {
        stopping--;
      }
      changed();
      return {stopped: true};
    },
    async close() {
      usageSeq++;
      roomClosing = true;
      unwatchNative();
      try {
        await api.stop();
        await closeAgent();
        await persist;
      } finally {
        unwatchNative();
        roomClosing = false;
      }
      // A turn that was still running finished during the stop and asked for usage again; void that too.
      usageSeq++;
      state.status = 'offline';
      changed();
    },
    async steer() {
      throw Error(`${label} 執行中請使用待送佇列；此接法目前不支援立即送入。`);
    },
    async compact() {
      throw Error(`${label} 由原生核心自動壓縮上下文；目前沒有手動壓縮介面。`);
    },
    async continuationGoal(afterTurn = false) {
      if (!record || opening) throw Error('來源聊天室尚未就緒；未受理換房。');
      if (!profile.nativeState) return {goal: null};
      const native = await readNative();
      if (!native || !Number.isFinite(native.lastSeq) || native.lastSeq < 0 ||
          native.jobs.length || native.queued || (afterTurn && native.running) ||
          (native.goal && !['complete', 'paused'].includes(native.goal.status)))
        throw Error('DeepSeek 原生紀錄未確認目標與背景工作可交接；未建立新聊天室。');
      applyNative(native);
      return {goal: native.goal};
    },
    async prepareContinuation({turnId: expectedTurnId, mode, sourceCurrent, notificationsMayResume} = {}) {
      const ended = () =>
        record &&
        !opening &&
        !halting &&
        !stopping &&
        !agentUnresolved &&
        !noticePending() &&
        !state.busy &&
        !turn &&
        state.status === 'completed' &&
        !state.questions.length &&
        !state.nativeJobs?.length &&
        state.messages.findLast(m => m.role === 'user')?.turnId === expectedTurnId;
      let locked = false;
      try {
        if (mode !== 'fresh') throw Error(`${label} 只支援全新聊天室接續；未建立新聊天室。`);
        if (preparingContinuation || !ended()) throw Error('原回合尚未確認正常結束；未建立新聊天室。');
        // Held to the end of the checks: a K notice cannot start a source turn while the move is decided.
        preparingContinuation = locked = true;
        const parent = state.threadId;
        sourceCurrent?.();
        await api.continuationGoal(true);
        const currentWorkers = await api.workers();
        sourceCurrent?.(state.goal, currentWorkers);
        if (currentWorkers.some(w => w.settled !== true)) throw Error('原工作或子代理未確認結束；未建立新聊天室。');
        if (!ended() || state.threadId !== parent) throw Error('原回合與接續來源不符；未建立新聊天室。');
        return {
          mode: 'fresh',
          model: state.model,
          workspace: state.workspace,
          effort: state.effort,
          accessMode: state.accessMode,
          workerPolicy: structuredClone(state.workerPolicy)
        };
      } catch (error) {
        error.notCreated = true;
        throw error;
      } finally {
        const release = () => {
          preparingContinuation = false;
          if (noticePending()) scheduleWorkers();
        };
        if (locked) {
          if (notificationsMayResume) void notificationsMayResume.then(release);
          else release();
        }
      }
    },
    // DSH's goal is set by the model with its own goal tools; K reads it from the log and never edits it.
    async goal({refresh = false} = {}) {
      if (profile.nativeState) {
        if (refresh) {
          const thread = record?.threadId,
            native = await readNative();
          if (record?.threadId === thread) state.goal = native?.goal ?? null;
          changed();
          return {goal: state.goal};
        }
        throw Error(`要設定或修改 ${label} 的目標，請直接在對話中告訴它；K 只顯示它的原生目標，不另做目標指令。`);
      }
      if (refresh) return {goal: null};
      throw Error(`${label} 目前沒有原生目標模式。`);
    },
    async answer({id, accept} = {}) {
      const item = pending.get(id);
      if (!item) throw Error('核准請求已失效或已回答。');
      if (typeof accept !== 'boolean') throw Error('核准狀態無效。');
      pending.delete(id);
      state.questions = state.questions.filter(q => q.id !== id);
      item.resolve(item.native ? (accept ? item.native.allow() : item.native.reject()) : item.approval.reply(accept));
      changed();
      return {answered: true};
    },
    async fork() {
      throw Error(`${label} 尚未接入原生分支；可明確交接到其他供應商的新對話。`);
    }
  };
  return api;
}
