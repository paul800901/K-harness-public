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
import {createOfficialGeminiAccount} from './gemini-official-account.mjs';
import path from 'node:path';
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {googleOpsMcp} from './google-ops-mcp.mjs';
import {desktopControlMcp, DESKTOP_CONTROL_GUIDANCE} from './desktop-control-mcp.mjs';
import {geminiProjectMcp} from './gemini-project-mcp.mjs';
import {atomicWrite} from './atomic-write.mjs';
import {createGeminiLogin} from './gemini-login.mjs';
import {openAcpAgent, killAcpTree} from './acp-agent.mjs';
import {
  geminiExecutable,
  geminiEnvironment,
  geminiAccessArgs,
  geminiCommandsAllowed,
  geminiSettings,
  geminiMcpConfig,
  isAcpEditTool,
  acpEditTargets,
  geminiAcpPermissionDecision,
  geminiAcpPromptBlocks,
  GEMINI_BROWSER_GUIDANCE,
  geminiToolGuidance,
  GEMINI_MEDIA_GUIDANCE
} from './gemini-worker.mjs';
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
import {writeGeminiCommonRule} from './common-memory.mjs';
import {browserSessionKey} from './browser-mcp-config.mjs';
import {antigravityModelId, antigravitySupportsMedia} from '../shared/antigravity-models.mjs';

const sessionId = id => typeof id === 'string' && /^gemini-[0-9a-f-]{36}$/iu.test(id);
const nativeId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/iu.test(id);
const access = value => {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value))
    throw Error('Gemini 提供唯讀、工作區編輯或完整存取權；未提供互動核准／自動審查。');
  return value;
};
const now = () => new Date().toISOString();

const roomOperations = new Map();
const pendingRollbackSaves = new Map();
function roomKey(history) {
  const absolute = path.resolve(history);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function queueRoomOperation(history, operation) {
  // A closed controller can still have a pending steer rollback for the reopened room.
  const key = roomKey(history);
  const pending = (roomOperations.get(key) ?? Promise.resolve()).then(operation);
  const tail = pending.catch(() => {});
  roomOperations.set(key, tail);
  void tail.then(() => {
    if (roomOperations.get(key) === tail) roomOperations.delete(key);
  });
  return pending;
}

function flushPendingRollbackSave(history) {
  return pendingRollbackSaves.get(roomKey(history))?.();
}

function toAcpMcpServers(mcpServers = {}) {
  return Object.entries(mcpServers).map(([name, server]) => {
    const url = server.serverUrl ?? server.url;
    if (url)
      return {
        type: 'http',
        name,
        url,
        headers: Object.entries(server.http_headers ?? server.headers ?? {}).map(([key, value]) => ({
          name: key,
          value: String(value)
        }))
      };
    return {
      name,
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      env: Object.entries(server.env ?? {}).map(([key, value]) => ({
        name: key,
        value: String(value)
      }))
    };
  });
}

function acpUpdateWriteTarget(update = {}) {
  return isAcpEditTool(update) ? (acpEditTargets(update)[0] ?? null) : null;
}

// Resolves a target path via its nearest existing ancestor so junctions/symlinks cannot bypass workspace boundaries.
async function resolveAcpPath(baseDir, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const trimmed = candidate.trim();
  if (process.platform === 'win32' && /^[a-z]:(?![\\/])/iu.test(trimmed)) return null;
  let current = baseDir ? path.resolve(baseDir, trimmed) : path.resolve(trimmed);
  const suffix = [];
  for (;;) {
    try {
      await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      suffix.push(path.basename(current));
      current = parent;
      continue;
    }
    try {
      const real = await realpath(current);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      return null;
    }
  }
}

function mapGeminiAcpError(error) {
  const text = String(error?.message ?? '');
  if (/authentication required|not (?:logged|signed) in|unauthenticated|login required/iu.test(text))
    return 'agy 未登入；請由使用者操作官方登入。';
  if (/quota|resource.exhausted|rate.limit|credits?.*(?:exhausted|insufficient)/iu.test(text))
    return 'agy 額度或速率限制；未重試或換模。';
  return text || 'agy 回合失敗。';
}
// agy 1.4.3 expands a rule's @[label](path) include (live probe), so one shared file reaches every room's HOME.
const memoryGuidance = (file, accessMode) =>
  `長期記憶：本人糾正做法或要求記住時，先寫出要記的規則並取得本人同意再寫入。只適用本工作區的寫進工作區的 AGENTS.md；跨工作區都適用的寫進 ${file}（各 Gemini 聊天室都會讀到）。不要寫進本聊天室的 ~/.gemini/config，那只屬於這個聊天室。本人也可輸入 /learn。${accessMode === 'read-only' ? '目前唯讀，只寫出建議的規則，由本人決定是否改權限後寫入。' : ''}`;

// Every choice comes from `agy models`, including its supported effort variants.
export function geminiModelsFrom(names) {
  const groups = new Map();
  for (const id of names) {
    if (!/^[a-z0-9][\w.-]*$/u.test(id)) continue;
    const match = id.match(/^(.*)-(low|medium|high|xhigh|max)$/u),
      native = match?.[1] ?? id,
      model = antigravityModelId(native),
      effort = match?.[2] ?? null;
    let row = groups.get(model);
    if (!row) {
      row = {
        model,
        displayName:
          native
            .replace(/^gemini-/u, 'Gemini ')
            .replace(/^claude-/u, 'Claude ')
            .replace(/^gpt-oss-/u, 'GPT-OSS ')
            .replace(/(\d)-(?=\d(?:-|$))/gu, '$1.')
            .replaceAll('-', ' ')
            .replace(/^GPT OSS (\d+)b/u, 'GPT-OSS $1B')
            .replace(/\b(flash|pro|sonnet|opus|thinking)\b/gu, s => s[0].toUpperCase() + s.slice(1)) +
          (native.startsWith('gemini-') ? '' : '（Antigravity）'),
        provider: 'gemini',
        available: true,
        inputModalities: antigravitySupportsMedia(model) ? ['text', 'image', 'pdf', 'audio', 'video'] : ['text'],
        supportedReasoningEfforts: [],
        defaultReasoningEffort: effort,
        nativeModels: {}
      };
      groups.set(model, row);
    }
    row.nativeModels[effort ?? 'default'] = id;
    if (effort && !row.supportedReasoningEfforts.some(item => item.reasoningEffort === effort))
      row.supportedReasoningEfforts.push({reasoningEffort: effort});
  }
  return [...groups.values()];
}

/** K stores presentation only. agy owns execution, native history and compression. */
export function createGeminiController({
  root,
  geminiExecutable: executable,
  env = process.env,
  openAgent = openAcpAgent,
  killTree = pid => killAcpTree(pid, {label: 'Gemini'}),
  stopGraceMs = 5000,
  loginFactory = createGeminiLogin,
  officialGeminiAccount,
  accounts,
  onChange = () => {},
  timeoutMs = 0,
  componentEnabled = () => true,
  browserConfig = async () => null,
  closeBrowser = async () => {},
  bridgeFactory = null,
  gatewayFactory,
  workerCatalog,
  roomTools,
  colabAdmin,
  onContinueConversation,
  onConversationSettled
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw Error('Gemini timeoutMs 無效。');
  const login = loginFactory({cwd: root, executable, env}),
    binary = geminiExecutable(env, executable);
  const official = officialGeminiAccount ?? createOfficialGeminiAccount({
    status: options => accounts ? accounts.inspect(() => login.status(options)) : login.status(options)
  }, onChange);
  const state = {
    provider: 'gemini',
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
      steer: true,
      goal: true,
      compact: false,
      fileSearch: false,
      review: false,
      turnDiffs: false,
      reasoningSummary: false,
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
    usage: {gemini: official.quota}
  };
  const activity = createWorkActivity(state);
  let record = null,
    selected = null,
    opening = false,
    stopping = 0,
    stopSequence = 0,
    turn = null,
    persist = Promise.resolve(),
    unresolvedPid = null,
    // An agy process kept after its turn because native background commands still run in it
    // (closing stdin makes agy terminate them). agy sends nothing while no prompt is open; the
    // next prompt on this same process first delivers what happened meanwhile.
    held = null;
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
    if (!sessionId(id)) throw Error('Gemini 對話 ID 無效。');
    return path.join(root, '.runtime/gemini-sessions', `${id}.json`);
  };
  const home = () => path.join(root, 'agent-home', 'gemini', 'main', state.threadId);
  const save = (activityAt, {rollback = false} = {}) => {
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
      goal: state.goal,
      messages: state.messages,
      tools: state.tools,
      artifacts: state.artifacts,
      lastUsedModel: state.lastUsedModel,
      modelChanges: state.modelChanges,
      lastOpenedAt: now()
    });
    record = snapshot;
    const history = file(snapshot.threadId);
    const key = roomKey(history);
    const write = async () => {
      await atomicWrite(history, JSON.stringify(snapshot, null, 2));
      await saveMainSession(root, snapshot, {activityAt});
      pendingRollbackSaves.delete(key);
    };
    persist = persist.catch(() => {}).then(write);
    if (rollback)
      persist = persist.catch(() => {
        const retry = () => {
          const next = persist.catch(() => {}).then(() => {
            // A successful save queued after the rollback can already have superseded it.
            if (pendingRollbackSaves.get(key) === retry) return write();
          });
          persist = next.catch(() => {});
          return next;
        };
        pendingRollbackSaves.set(key, retry);
      });
    return persist;
  };
  const read = async id => JSON.parse(await readFile(file(id), 'utf8'));
  // Sends and model changes go to a held process; anything that would replace it waits.
  const idle = (allowHeld = false) => {
    official.assertStable();
    if (state.busy || opening || unresolvedPid || held?.stopping) throw Error('請先結束或查明目前 Gemini 工作。');
    if (held && !allowHeld)
      throw Error('agy 背景命令仍在本聊天室執行；等它完成（下一次送出時由 agy 回報）或按停止後再切換。');
  };
  // Ends the background command records of one agy process; `unresolved` keeps them unsettled.
  const settleCommands = (proc, status, ids = [...proc.commands.keys()], output) => {
    output ??= {
      stopped: 'agy 背景程序已停止；未取得命令完成結果，未重播。',
      ended: 'agy 程序已結束；背景命令結果未知，未重播。',
      unresolved: 'agy 背景程序停止尚未確認；命令結果未知，未重播。'
    }[status];
    for (const toolCallId of ids) {
      const item = proc.commands.get(toolCallId);
      if (!item) continue;
      const worker = state.workers.find(w => w.requestId === item.requestId);
      if (worker && !worker.settled)
        Object.assign(worker, {
          status,
          settled: status !== 'unresolved',
          ...(output === undefined ? {} : {output}),
          ...(status === 'unresolved' ? {} : {endedAt: now()})
        });
      const tool = state.tools.find(t => t.id === item.key);
      if (tool?.status === 'running') tool.status = 'interrupted';
      proc.commands.delete(toolCallId);
    }
  };
  const releaseHeld = async (proc, settled) => {
    const lease = proc.lease;
    proc.lease = null;
    try {
      await lease?.release({settled, refresh: true});
    } catch {
      state.status = 'uncertain';
      state.error = 'Gemini 帳號狀態保存失敗；原工作未重送。';
    }
  };
  const heldExited = async proc => {
    if (held !== proc || proc.stopping) return;
    held = null;
    proc.route.update = proc.route.request = null;
    const unknown = proc.commands.size > 0;
    settleCommands(proc, 'ended', undefined, 'agy 程序已結束；背景命令結果未知，未重播。');
    if (unknown) {
      state.status = 'uncertain';
      state.error = 'agy 程序在背景命令結果回報前結束；結果未知，未重送。';
    }
    await releaseHeld(proc, true);
    await save().catch(() => {});
    changed();
  };
  const holdProcess = (proc, lease) => {
    held = proc;
    proc.lease = lease;
    proc.hold();
    for (const item of proc.commands.values()) {
      if (state.workers.some(w => w.requestId === item.requestId)) continue;
      state.workers.push({
        provider: 'gemini-native',
        kind: 'command',
        requestId: item.requestId,
        name: 'agy 背景命令',
        task: item.title,
        status: 'running',
        settled: false,
        startedAt: now(),
        output: 'agy 程序保留中；原生閒置時不保證推送完成結果，下次送出訊息時讀回。'
      });
    }
    if (!proc.watching) {
      proc.watching = true;
      void proc.agent.closed
        ?.then(() => {
          if (proc.agent.exited) return heldExited(proc);
        })
        .catch(() => {});
    }
    if (proc.agent.exited) void heldExited(proc);
  };
  // Stopping a held process ends its background commands (agy terminates them on exit).
  const stopHeld = async () => {
    const proc = held;
    if (!proc) return;
    if (proc.stopping) return proc.stopPromise;
    proc.stopping = true;
    proc.route.update = proc.route.request = null;
    proc.stopPromise = (async () => {
      try {
        await proc.agent.close({graceMs: stopGraceMs});
      } catch (error) {
        unresolvedPid = proc.agent.pid;
        settleCommands(proc, 'unresolved');
        state.status = 'uncertain';
        state.error = `agy 背景命令停止未確認：${error.message}`;
        await releaseHeld(proc, false);
        return;
      }
      settleCommands(proc, 'stopped');
      await releaseHeld(proc, true);
    })().finally(() => {
      if (held === proc) held = null;
    });
    return proc.stopPromise;
  };
  const sharedRules = path.join(root, 'agent-home', 'gemini', 'shared', 'learned-rules.md');
  const insideWorkspace = absolute => {
    const relative = path.relative(state.workspace, absolute);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  // K workers (k_luna) for this room, as in the Claude main entry: the bridge owns
  // worker execution; this room records them, delivers each notice at most once and
  // relays worker approvals. Settings never change while a worker is unsettled.
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
  // a send that may have reached agy is never repeated.
  async function deliverWorkers() {
    let handoff =
      ['ready', 'blocked'].includes(geminiHandoff?.status) && geminiHandoff.epoch === geminiIntentEpoch
        ? geminiHandoff
        : null;
    if (
      notifying ||
      preparingContinuation ||
      !record ||
      state.busy ||
      opening ||
      unresolvedPid ||
      !['completed', 'ready'].includes(state.status) ||
      (!workerQueue.size && !handoff)
    )
      return;
    // This room's native history stays on its bound account; a ready event for another
    // account cannot continue here, so it is shown once instead of failing a send.
    if (
      handoff?.status === 'ready' &&
      record.accountId &&
      handoff.accountId &&
      handoff.accountId !== record.accountId
    ) {
      geminiHandoff = consumeGeminiHandoff(geminiHandoff, handoff);
      for (const n of state.notices) if (n.kind === 'gemini-handoff') n.resolved = true;
      state.notices.push({
        id: randomUUID(),
        kind: 'gemini-handoff',
        level: 'warning',
        message:
          'Gemini 共用帳號已換成其他帳號；本聊天室的原生歷史綁定原帳號，不能在新帳號接續。剩餘工作請開新的 Gemini 聊天室交接；原工單未重播。',
        createdAt: now()
      });
      handoff = null;
      changed();
    }
    for (const [id, queued] of workerQueue)
      if (
        !workerNoticeCurrent(
          queued,
          state.workers.find(w => w.requestId === id)
        )
      )
        workerQueue.delete(id);
    // A live question can be the reason a worker has not settled. Hold the
    // account receipt and other notices while its parent answers.
    const questionsOnly = handoff && state.workers.some(w => w.settled !== true && w.provider !== 'gemini-native');
    if (questionsOnly) handoff = null;
    const waiting = geminiWaitingJobs(geminiHandoff),
      batch = [...workerQueue.values()].filter(row => !waiting.has(row.requestId) && (!questionsOnly || row.pendingQuestion));
    if (!batch.length && !handoff) return;
    // A stop, close or room switch during preparation ends this delivery unsent.
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
        // A user turn that won the race delivers this notice when it ends.
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
      // A user turn that ended while this delivery held the flag could not schedule it.
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
    // Cleared before cancelling: a cancelled job must not return as a completion notice.
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
  // Returns the k_luna MCP endpoint for this room's current thread, workspace, access and worker policy.
  async function configureGateway() {
    if (!bridgeFactory) return null;
    const key = gatewayKeyOf(state.threadId, state.workspace, state.accessMode, state.workerPolicy);
    if (gateway && gatewayKey === key) return gatewayServer;
    if (await unsettledWorkers()) throw Error(WORKERS_RUNNING);
    // Another conversation's pending notices never reach this one.
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
        provider: 'gemini'
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
        if (opening || stopping || epoch !== bridgeEpoch || !bridgeInstance)
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
      // The gateway acknowledges only after the model-facing result is prepared successfully.
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
    // Only this main room's turn gets room tools; K workers have no K gateway.
    const mainTurn = () => {
      if (state.threadId !== parent || !state.busy) throw Error('只能在本主聊天室的進行中回合使用。');
      return parent;
    };
    // agy native subagents may inherit this MCP configuration and there is no caller identity: refuse
    // while any native subagent or background command of this room is unsettled.
    const continuationCaller = () => {
      const current = turn;
      if (
        state.threadId !== parent ||
        !state.busy ||
        !current ||
        current.goalObjective ||
        current.closing ||
        current.stopping ||
        opening ||
        preparingContinuation ||
        unresolvedPid
      )
        throw Error('只能在本主聊天室的進行中回合換房；未受理。');
      if (noticePending()) throw Error('K 子代理通知尚未送達本聊天室；待通知送完後再換房。');
      // A running execute command only becomes a background worker when the turn ends; agy's
      // native multi-agent tools (subagent, swarm, run_workflow) inherit this MCP configuration.
      if (
        state.workers.some(w => w.provider === 'gemini-native' && !w.settled) ||
        state.tools.some(
          t => t.status === 'running' && (t.kind === 'execute' || /subagent|swarm|workflow/iu.test(t.name ?? ''))
        )
      )
        throw Error('原生子代理或背景命令尚未結算；待結束後再換房。');
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
                  unresolvedPid ||
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
                turnId: sourceTurn.id,
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
  function choose(catalog, model, effort) {
    const choice = catalog.find(item => item.model === model);
    if (!choice) throw Error('目前 agy 未提供指定 Gemini 模型；未換模。');
    const level = effort ?? choice.defaultReasoningEffort;
    if (!choice.nativeModels[level ?? 'default']) throw Error('指定 Gemini 推理程度目前不可用；未換模。');
    return {choice, level};
  }
  async function prepare({assertActive, lastCommonKey, resume = false} = {}) {
    if (!binary) throw Error('找不到 Antigravity（agy）；請在設定頁按 Antigravity「更新」下載官方核心（或先安裝官方 Antigravity CLI），重開 K 後再登入。');
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
              provider: 'gemini'
            });
      browserMode = state.accessMode;
    }
    const temps = Object.entries(env)
      .filter(([key]) => /^(TEMP|TMP)$/iu.test(key))
      .map(([, value]) => value);
    const googleOps = componentEnabled('google') ? await googleOpsMcp(state.workspace, {root}) : null;
    const desktop = componentEnabled('desktop') && await desktopControlMcp({root, fullAccess: state.accessMode === 'danger-full-access'});
    const projectMcp = await geminiProjectMcp(root, state.workspace, state.accessMode);
    const settings = geminiSettings(state.workspace, state.accessMode, temps, browserServer, googleOps, projectMcp, {
      writable: [sharedRules],
      gateway: !!lunaServer,
      desktop
    });
    // The sandbox's AppContainer data lives under this HOME's LOCALAPPDATA (geminiEnvironment).
    const isolateTemp = state.accessMode !== 'danger-full-access';
    const isolatedTemp = isolateTemp ? path.join(home(), 'tmp') : null;
    await mkdir(path.join(home(), 'AppData', 'Local'), {recursive: true});
    if (isolatedTemp) await mkdir(isolatedTemp, {recursive: true});
    await mkdir(path.dirname(sharedRules), {recursive: true});
    await writeFile(sharedRules, '# K 共用學習規則（各 Gemini 聊天室共用）\n', {flag: 'wx'}).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const mcpConfig = geminiMcpConfig(browserServer, googleOps, projectMcp, lunaServer, desktop);
    await atomicWrite(path.join(home(), '.gemini/config/mcp_config.json'), JSON.stringify(mcpConfig, null, 2));
    await atomicWrite(path.join(home(), '.gemini/antigravity-cli/settings.json'), JSON.stringify(settings, null, 2));
    await atomicWrite(
      path.join(home(), '.gemini/config/rules/k-model-roles.md'),
      `---\ntrigger: always_on\n---\n${workerInstructions}\n${geminiToolGuidance(state.accessMode, googleOps, {acp: true})}\n${state.inputModalities.includes('audio') ? GEMINI_MEDIA_GUIDANCE + '\n' : ''}${workspaceGuidance(state)}${browserServer ? `${GEMINI_BROWSER_GUIDANCE}\n` : ''}${desktop ? `${DESKTOP_CONTROL_GUIDANCE}\n` : ''}`
    );
    await atomicWrite(
      path.join(home(), '.gemini/config/rules/k-learned-rules.md'),
      `---\ntrigger: always_on\n---\n${memoryGuidance(sharedRules, state.accessMode)}\n@[K 共用學習規則](${sharedRules})\n`
    );
    const roomHome = home();
    const common = await queueRoomOperation(file(state.threadId), () =>
      writeGeminiCommonRule(roomHome, root, lastCommonKey, {resume, assertActive})
    );
    const allowedMcpRules = settings.permissions.allow.filter(rule => /^mcp\(([\w-]+)\/[^()]+\)$/u.test(rule));
    const knownMcpServers = Object.keys(mcpConfig.mcpServers ?? {});
    const rawDeniedWrites = settings.permissions.deny
      .map(rule => /^write_file\((.+)\)$/u.exec(rule)?.[1])
      .filter(target => target && target !== '*');
    const rawTemps = [...temps, ...(isolatedTemp ? [isolatedTemp] : [])];
    const resolveList = async list => {
      const out = new Set();
      for (const item of list) out.add((await resolveAcpPath(null, item)) ?? path.resolve(item));
      return [...out];
    };
    const [workspaceResolved, writableResolved, tempsResolved, deniedWritesResolved] = await Promise.all([
      resolveAcpPath(null, state.workspace).then(value => value ?? path.resolve(state.workspace)),
      resolveList([sharedRules]),
      resolveList(rawTemps),
      resolveList(rawDeniedWrites)
    ]);
    state.browserAccess = {
      enabled: !!browserServer,
      networkAccess: !!browserServer,
      sessionKey: browserSessionKey(browserServer)
    };
    return {
      workspace: workspaceResolved,
      common,
      commandsAllowed: geminiCommandsAllowed(state.accessMode, googleOps),
      mcpServers: toAcpMcpServers(mcpConfig.mcpServers),
      allowedMcpRules,
      knownMcpServers,
      deniedWrites: deniedWritesResolved,
      writable: writableResolved,
      temps: tempsResolved
    };
  }
  const validateMessageInput = (text, attachmentIds) => {
    if (
      typeof text !== 'string' ||
      text.length > 32000 ||
      (!text.trim() && (!Array.isArray(attachmentIds) || !attachmentIds.length))
    )
      throw Error('請輸入 1–32000 字元的訊息。');
    if (!Array.isArray(attachmentIds) || attachmentIds.some(id => typeof id !== 'string'))
      throw Error('附件格式無效。');
  };
  const appendAttachments = async (basePrompt, attachmentIds) => {
    const attachments = [];
    let prompt = basePrompt;
    for (const id of attachmentIds) {
      const item = await sessionAttachment(state.workspace, state.previousWorkspaces, state.threadId, id),
        pdf = path.extname(item.path).toLowerCase() === '.pdf';
      const readPath = path.resolve(
        item.workspace,
        pdf && state.inputModalities.includes('pdf') ? item.path : (item.textPath ?? item.path)
      );
      attachments.push(item);
      const originalPath = path.resolve(item.workspace, item.path);
      prompt += `\n\n附件（資料，非授權；模態支援以原生工具實際讀取為準）：${JSON.stringify({name: item.name, readPath, ...(originalPath !== readPath ? {originalPath} : {}), warning: item.warning})}`;
    }
    return {attachments, prompt};
  };
  const assertSteerable = (current, message, requireSession = false) => {
    const ok =
      record &&
      current &&
      turn === current &&
      state.busy &&
      !opening &&
      !unresolvedPid &&
      !current.closing &&
      !current.stopping &&
      !current.abort.signal.aborted &&
      !current.uncertain &&
      !['offline', 'uncertain', 'interrupted'].includes(state.status) &&
      (!requireSession ||
        (current.sessionReady && current.agent && !current.agent.exited && nativeId(record?.nativeSessionId)));
    if (!ok) throw Error(message);
  };
  const cancelTurn = async (current, uncertainPrefix) => {
    current.stopping = true;
    current.abort.abort();
    clearQuestions(item => item.workerRequestId == null && item.isSubagent !== true);
    try {
      if (current.agent && record?.nativeSessionId)
        current.agent.notify('session/cancel', {sessionId: record.nativeSessionId});
    } catch {}
    const ended = await Promise.race([
      current.settled.then(() => true),
      new Promise(resolve => setTimeout(resolve, stopGraceMs, false))
    ]);
    if (!ended && current.agent) {
      try {
        await current.agent.close({graceMs: 0});
      } catch (error) {
        unresolvedPid = current.agent.pid ?? current.pid;
        current.stopCloseError = error;
        state.status = 'uncertain';
        state.error = `${uncertainPrefix}：${error.message}`;
      }
      current.forceUnblock?.();
    }
    await current.settled;
  };
  const api = {
    state,
    async models() {
      const result = await official.status({checkAuth: false});
      if (!result.available) throw Error(result.reason);
      return {models: geminiModelsFrom(result.models), provider: 'gemini', version: result.version};
    },
    async usage(refresh = false) {
      if (accounts) {
        const managed = await accounts.usage(refresh);
        if (managed) {
          state.usage.gemini = managed;
          return {gemini: managed};
        }
      }
      state.usage.gemini = await official.usage(refresh);
      return {gemini: state.usage.gemini};
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
      await resetBrowser();
      state.workspace = workspace;
      state.threadId = null;
      state.title = '';
      state.messages = [];
      state.tools = [];
      state.artifacts = [];
      state.workers = [];
      state.status = 'idle';
      state.error = null;
      record = null;
      changed();
      return {workspace};
    },
    async open(
      {threadId, model, effort, accessMode = 'workspace-write', permissionConfirmed = false, workerPolicy} = {},
      {signal, relocation, onHistory, continuation, onCreated} = {}
    ) {
      if (continuation && (continuation.mode !== 'fresh' || threadId))
        throw Object.assign(Error('接續只能建立全新的 Gemini 聊天室；未建立新聊天室。'), {notCreated: true});
      idle();
      activity.clear();
      opening = true;
      const openedAt = stopSequence;
      const assertActive = () => {
        signal?.throwIfAborted();
        if (openedAt !== stopSequence) throw Error('Gemini 聊天室開啟已停止。');
      };
      let previousBrowserClosed = false,
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
        const saved = threadId
          ? await queueRoomOperation(file(threadId), async () => {
              assertActive();
              const rollbackSave = flushPendingRollbackSave(file(threadId));
              if (rollbackSave) {
                await rollbackSave;
                assertActive();
              }
              return read(threadId);
            })
          : null;
        if (saved && (saved.threadId !== threadId || saved.model !== model))
          throw Error('對話設定已更新，請重新整理清單。');
        if (saved?.nativeStarted && !nativeId(saved.nativeSessionId))
          throw Error('上次 Gemini 送出後尚未取得原生對話 ID；不能自動建立新對話或重送。');
        const {choice, level} = choose((await api.models()).models, model, effort ?? saved?.effort),
          mode = access(saved?.accessMode ?? accessMode);
        if (!saved && mode === 'danger-full-access' && !permissionConfirmed)
          throw Error('請明確確認 Gemini 完整存取權。');
        const common = threadId ? (await listMainSessions(root, {threadId})).sessions[0] : null;
        const workspace = await validateWorkspace(
          relocation?.workspace ?? common?.workspace ?? saved?.workspace ?? state.workspace
        );
        signal?.throwIfAborted();
        const policy = normalizeWorkerPolicy(workerPolicy ?? saved?.workerPolicy ?? common?.workerPolicy);
        // Refuse before touching the room: a running K worker keeps its gateway and settings.
        if (
          gateway &&
          gatewayKey !== gatewayKeyOf(saved?.threadId, workspace, mode, policy) &&
          (await unsettledWorkers())
        )
          throw Error(WORKERS_RUNNING);
        await resetBrowser();
        previousBrowserClosed = true;
        selected = choice;
        record = saved ?? {
          threadId: `gemini-${randomUUID()}`,
          nativeSessionId: null,
          nativeStarted: false,
          archived: false,
          pinned: false,
          createdAt: now(),
          ...(continuation ? {title: `新對話 · ${continuation.parentTitle || '接續工作'}`.slice(0, 120)} : {})
        };
        Object.assign(state, {
          threadId: record.threadId,
          workspace,
          model,
          modelDisplayName: choice.displayName,
          inputModalities: [...choice.inputModalities],
          effort: level,
          efforts: choice.supportedReasoningEfforts.map(e => e.reasoningEffort),
          accessMode: mode,
          title: record.title ?? '',
          messages: record.messages ?? [],
          // Saved history is not evidence of a live owned process after reopening.
          tools: (record.tools ?? []).map(t => (t.status === 'running' ? {...t, status: 'interrupted'} : t)),
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
        state.goal = record.goal
          ? {...record.goal, ...(['active', 'starting'].includes(record.goal.status) ? {status: 'unknown'} : {})}
          : null;
        await onHistory?.(state);
        assertActive();
        await prepare({assertActive});
        if (bridgeInstance) for (const item of await bridgeInstance.list()) recordWorker(item);
        assertActive();
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
        if (previousBrowserClosed) {
          state.status = relocation ? 'error' : 'failed';
          state.error = error.message;
          // A browser stop failure is recorded as uncertain; the original open error (and its
          // notCreated / createdThreadId marks) is what the caller must see.
          await resetBrowser().catch(() => {});
        }
        throw error;
      } finally {
        opening = false;
      }
    },
    async selectModel({threadId, model, effort}) {
      idle(true);
      if (!record || threadId !== state.threadId) throw Error('Gemini 對話已切換。');
      const {choice, level} = choose((await api.models()).models, model, effort);
      selected = choice;
      state.model = model;
      state.modelDisplayName = choice.displayName;
      state.inputModalities = [...choice.inputModalities];
      state.effort = level;
      state.efforts = choice.supportedReasoningEfforts.map(e => e.reasoningEffort);
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
      const changes = {
        ...(title === undefined ? {} : {title: title.trim()}),
        ...(archived === undefined ? {} : {archived}),
        ...(pinned === undefined ? {} : {pinned})
      };
      const history = file(threadId);
      const updated = await queueRoomOperation(history, async () => {
        await flushPendingRollbackSave(history);
        const next = {...(await read(threadId)), ...changes};
        if (threadId === state.threadId && state.status !== 'offline') {
          record = {...record, title: next.title, archived: next.archived, pinned: next.pinned};
          state.title = next.title;
          await save();
          changed();
        } else {
          await atomicWrite(history, JSON.stringify(next, null, 2));
          await saveMainSession(root, next);
        }
        return next;
      });
      return {threadId, title: updated.title, archived: updated.archived, pinned: updated.pinned};
    },
    async upload(data) {
      if (!record || data.threadId !== state.threadId) throw Error('對話已切換，請重新加入附件。');
      const threadId = state.threadId,
        workspace = state.workspace;
      return saveAttachment(workspace, threadId, data, {inputModalities: state.inputModalities});
    },
    async uploadStream(data, stream) {
      if (!record || data.threadId !== state.threadId) throw Error('對話已切換，請重新加入附件。');
      const threadId = state.threadId,
        workspace = state.workspace;
      return saveAttachmentStream(workspace, threadId, {...data, stream}, {inputModalities: state.inputModalities});
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
      if (internal && text.length > 14000)
        text = text.slice(0, 14000) + '\n…（通知過長已截斷；完整結果請用 luna_inspect 查詢原 requestId）';
      try {
        idle(true);
        if (!record || !['ready', 'completed', 'failed', 'interrupted'].includes(state.status))
          throw Error('請先開啟 Gemini 對話。');
        if (record.nativeStarted && !nativeId(record.nativeSessionId))
          throw Error('前次送出後沒有原生對話 ID；請先查明，不會重送或另開原生對話。');
        validateMessageInput(text, attachmentIds);
        const mode = access(accessMode ?? state.accessMode),
          level = effort || state.effort;
        if (!selected.nativeModels[level ?? 'default']) throw Error('指定 Gemini 推理程度目前不可用。');
        if (mode === 'danger-full-access' && state.accessMode !== mode && !permissionConfirmed)
          throw Error('請明確確認 Gemini 完整存取權。');
        // The next prompt goes to the held process: a new agy would mean closing the old one,
        // which ends its background commands. Permission flags are fixed when agy starts.
        if (held?.agent.exited) {
          await heldExited(held);
          throw Error('agy 背景程序已結束；請先核對原工作結果，未送出新訊息。');
        }
        const reuse = held;
        if (reuse && mode !== reuse.mode)
          throw Error('agy 背景命令仍在本聊天室執行；權限要等它完成（下一次送出時由 agy 回報）或按停止後才能變更。');
        let finish, readyResolve;
        const current = {
          id: randomUUID(),
          abort: new AbortController(),
          pid: null,
          agent: null,
          closing: false,
          stopping: false,
          uncertain: false,
          error: null,
          stopCloseError: null,
          forceUnblock: null,
          sessionReady: false,
          readyPromise: new Promise(resolve => {
            readyResolve = resolve;
          }),
          prompts: [],
          inFlight: new Map(),
          latestPromptId: null,
          activeAssistantPromptId: null,
          denied: [],
          lastStopReason: 'end_turn',
          goalObjective,
          goalConfirmed: false,
          discussionId: discussionTurn?.id ?? null,
          done: null,
          settled: null
        };
        current.settled = new Promise(resolve => {
          finish = resolve;
        });
        turn = current;
        state.busy = true;
        activity.begin();
        state.status = 'working';
        state.error = null;
        changed();
        let launched = false,
          accountLease;
        try {
          // A held process keeps the lease it started with until it ends.
          accountLease = reuse
            ? reuse.lease
            : await accounts?.acquire({
                accountId: record.accountId,
                unboundHistory: record.nativeStarted && !record.accountId
              });
          if (accountLease?.accountId) record.accountId = accountLease.accountId;
          if (goalObjective) state.goal = {objective: goalObjective, status: 'starting'};
          const {attachments, prompt} = await appendAttachments(
            goalObjective ? '/goal ' + goalObjective : text,
            attachmentIds
          );
          current.abort.signal.throwIfAborted();
          const previous = {accessMode: state.accessMode, effort: state.effort};
          state.accessMode = mode;
          state.effort = level;
          let launchConfig;
          try {
            launchConfig = await prepare({
              assertActive: () => current.abort.signal.throwIfAborted(),
              lastCommonKey: reuse?.commonKey,
              resume: !reuse && Boolean(record.nativeSessionId)
            });
          } catch (error) {
            // Nothing was sent; the room keeps the settings that actually apply.
            Object.assign(state, previous);
            throw error;
          }
          const groupId = discussionTurn?.id ?? randomUUID(),
            user = {
              id: randomUUID(),
              role: 'user',
              text,
              attachments,
              createdAt: now(),
              groupId,
              turnId: current.id,
              ...(internal
                ? {kind: internal.kind, summary: internal.summary}
                : {source: source === 'continuation' ? 'continuation' : 'local'})
            };
          state.messages.push(user);
          if (discussionTurn) {
            current.discussionId = discussionTurn.id;
            await discussionTurn.bind({groupId, messageId: user.id});
          }
          if (!internal) state.title ||= (text.trim() || attachments[0]?.name || '').slice(0, 40);
          if (state.lastUsedModel && state.lastUsedModel !== state.model)
            state.modelChanges.push({turnId: user.id, fromModel: state.lastUsedModel, toModel: state.model, at: now()});
          state.lastUsedModel = state.model;
          const initialBlocks = geminiAcpPromptBlocks({
            prompt,
            text,
            goalObjective: Boolean(goalObjective),
            internal: Boolean(internal),
            discussionTurn: Boolean(discussionTurn),
            contextNotice: launchConfig.common.notice
          });
          const nativeModel = selected.nativeModels[level ?? 'default'];
          // Keep ACP mode on `default` so edits/commands/MCP always consult host request_permission
          // (auto and accept-edits skip request_permission and bypass deniedWrites/junction checks).
          const acpMode = 'default';
          const isolateTemp = mode !== 'danger-full-access';
          const args = ['acp', '--stdio', ...geminiAccessArgs(mode), '--log-file', path.join(home(), `${user.id}.log`)];
          record.nativeStarted = true;
          await save();
          current.abort.signal.throwIfAborted();
          launched = true;
          attempted = true;
          // This turn owns the process (held or new) until it ends.
          if (reuse) held = null;
          const proc = reuse ?? {
            agent: null,
            route: {},
            mode,
            commands: new Map(),
            toolKeys: new Map(),
            lease: null,
            commonKey: launchConfig.common.key
          };
          proc.lease = null;
          const roomHome = home();
          current.refreshCommonRule = assertActive =>
            writeGeminiCommonRule(roomHome, root, proc.commonKey, {assertActive});

          const startPrompt = (entry, blocks, commonKey) => {
            current.prompts.push(entry);
            current.inFlight.set(entry.id, entry);
            current.latestPromptId = entry.id;
            if (!current.activeAssistantPromptId || !current.inFlight.has(current.activeAssistantPromptId))
              current.activeAssistantPromptId = entry.id;
            const rpc = current.agent.request('session/prompt', {
              sessionId: record.nativeSessionId,
              prompt: blocks
            });
            const previousCommonKey = proc.commonKey;
            proc.commonKey = commonKey;
            entry.rpc = rpc;
            entry.promise = rpc.then(
              result => {
                current.inFlight.delete(entry.id);
                entry.stopReason = result?.stopReason;
                if (!entry.stopReason) entry.error = Error('agy 未提供此回覆的結束原因。');
                current.lastStopReason = entry.stopReason;
                const usage = result?.usage;
                if (Number.isFinite(usage?.totalTokens))
                  state.progress.tokenUsage = {
                    last: {
                      totalTokens: usage.totalTokens,
                      inputTokens: usage.inputTokens ?? 0,
                      outputTokens: usage.outputTokens ?? 0
                    }
                  };
                if (entry.assistant) {
                  entry.goalCompleted = Boolean(
                    current.goalConfirmed && entry.rawText.includes('<!-- GOAL_COMPLETE -->')
                  );
                  entry.assistant.text = current.goalConfirmed
                    ? entry.rawText.replace(/<!-- GOAL_COMPLETE -->/g, '').trim()
                    : entry.rawText;
                  delete entry.assistant.streaming;
                  if (entry.stopReason === 'end_turn' && !current.abort.signal.aborted) {
                    entry.assistant.completedAt = now();
                  } else entry.assistant.partial = true;
                }
                if (current.inFlight.size > 0) {
                  if (current.activeAssistantPromptId === entry.id)
                    current.activeAssistantPromptId = current.inFlight.keys().next().value;
                  void save(entry.assistant ? now() : undefined).catch(() => {});
                  changed();
                }
                return {ok: true, result};
              },
              error => {
                if (error?.notSent === true && proc.commonKey === commonKey) proc.commonKey = previousCommonKey;
                current.inFlight.delete(entry.id);
                entry.error = error;
                if (entry.assistant) {
                  delete entry.assistant.streaming;
                  entry.assistant.partial = true;
                }
                if (error?.notSent !== true && !current.abort.signal.aborted && !current.error) current.error = error;
                if (current.inFlight.size > 0) {
                  if (current.activeAssistantPromptId === entry.id)
                    current.activeAssistantPromptId = current.inFlight.keys().next().value;
                  if (error?.notSent !== true) changed();
                }
                return {ok: false, error};
              }
            );
          };
          current.startPrompt = startPrompt;

          const handleUpdate = params => {
            if (!params || (record.nativeSessionId && params.sessionId && params.sessionId !== record.nativeSessionId))
              return;
            const update = params.update;
            if (!update || typeof update !== 'object') return;
            const activeTurn = turn === current && !current.abort.signal.aborted;
            if (update.sessionUpdate === 'user_message_chunk') {
              const chunkText = update.content?.type === 'text' ? update.content.text : '';
              if (
                current.goalObjective &&
                !current.goalConfirmed &&
                typeof chunkText === 'string' &&
                !chunkText.trimStart().startsWith('/goal') &&
                chunkText.includes(current.goalObjective)
              ) {
                current.goalConfirmed = true;
                state.goal = {...state.goal, status: 'active'};
                changed();
              }
              if (activeTurn && chunkText) activity.record();
              const echoed = current.prompts.find(p => p.awaitEcho);
              if (echoed) {
                echoed.awaitEcho = false;
                // This echo closes the previous command's reply before the new prompt starts answering.
                if (activeTurn && proc.wake) {
                  delete proc.wake.streaming;
                  delete proc.wake.partial;
                  proc.wake.completedAt = now();
                  proc.wake = null;
                  changed();
                }
                proc.wakeGroup = null;
              }
              return;
            }
            if (update.sessionUpdate === 'agent_message_chunk') {
              const delta = update.content?.type === 'text' ? update.content.text : '';
              if (typeof delta !== 'string' || !delta || current.abort.signal.aborted) return;
              // On a held process agy first delivers its own reply to a finished background command
              // (live probe: before echoing this prompt). It continues the turn that started the command.
              const beforePrompt = activeTurn && (current.prompts[0]?.awaitEcho || (reuse && !current.prompts.length));
              if (held === proc || beforePrompt) {
                const commandGroup = proc.wakeGroup ?? [...proc.commands.values()].at(-1)?.groupId;
                if (!proc.wake || (commandGroup && proc.wake.groupId !== commandGroup)) {
                  if (proc.wake) delete proc.wake.streaming;
                  proc.wake = {
                    id: randomUUID(),
                    role: 'assistant',
                    text: '',
                    attachments: [],
                    createdAt: now(),
                    groupId: commandGroup ?? groupId,
                    partial: true
                  };
                  const at = beforePrompt ? state.messages.indexOf(user) : -1;
                  state.messages.splice(at < 0 ? state.messages.length : at, 0, proc.wake);
                }
                proc.wake.text += delta;
                if (beforePrompt) proc.wake.streaming = true;
                if (activeTurn) activity.record();
                changed();
                return;
              }
              const target =
                current.inFlight.get(current.activeAssistantPromptId) ??
                current.inFlight.get(current.latestPromptId);
              if (!target) return;
              target.rawText += delta;
              if (!target.assistant) {
                const msg = {
                  id: randomUUID(),
                  role: 'assistant',
                  text: '',
                  attachments: [],
                  createdAt: now(),
                  groupId: target.groupId,
                  streaming: true
                };
                state.messages.push(msg);
                target.assistant = msg;
              }
              target.assistant.text = current.goalConfirmed
                ? target.rawText.replace(/<!-- GOAL_COMPLETE -->/g, '').trim()
                : target.rawText;
              if (activeTurn) activity.record();
              changed();
              return;
            }
            if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
              const toolId = String(update.toolCallId ?? randomUUID());
              // A held process reports an earlier turn's tool under that turn's entry.
              const key = proc.toolKeys.get(toolId) ?? `${current.id}-${toolId}`;
              proc.toolKeys.set(toolId, key);
              const index = state.tools.findIndex(t => t.id === key);
              const existing = index >= 0 ? state.tools[index] : null;
              const name = update.name ?? existing?.name ?? update.title ?? update.kind ?? 'tool';
              const status =
                update.status === 'failed'
                  ? 'failed'
                  : update.status === 'completed'
                    ? 'completed'
                    : (existing?.status ?? 'running') === 'completed'
                      ? 'completed'
                      : 'running';
              const entry = {
                id: key,
                kind: update.kind ?? existing?.kind ?? name,
                name,
                status,
                details: update.rawInput ?? update.args ?? existing?.details ?? {},
                error: status === 'failed' ? (existing?.error ?? update.title ?? '工具執行失敗') : null
              };
              if (index < 0) state.tools.push(entry);
              else state.tools[index] = {...existing, ...entry};
              // A running native command may go to the background when the model ends its turn.
              const command = proc.commands.get(toolId);
              if (status === 'running' && entry.kind === 'execute' && !command)
                proc.commands.set(toolId, {
                  key,
                  requestId: `gemini-command:${key}`,
                  title: typeof update.title === 'string' ? update.title : name,
                  groupId: (current.inFlight.get(current.activeAssistantPromptId) ?? current.prompts.at(-1))?.groupId
                });
              else if (status !== 'running' && command) {
                proc.wakeGroup = command.groupId;
                const output = (Array.isArray(update.content) ? update.content : [])
                  .map(item => (item?.content?.type === 'text' ? item.content.text : ''))
                  .join('\n')
                  .slice(0, 4000);
                settleCommands(proc, status, [toolId], output);
              }
              if (activeTurn)
                activity.tool(key, status !== 'running', /luna_wait$/u.test(name) ? 'worker' : 'tool', name);
              if (status === 'completed') {
                const targetPath = acpUpdateWriteTarget(update);
                if (typeof targetPath === 'string') {
                  const absolute = path.resolve(state.workspace, targetPath);
                  const rel = path.relative(state.workspace, absolute).replaceAll('\\', '/');
                  if (insideWorkspace(absolute) && !state.artifacts.includes(rel)) state.artifacts.push(rel);
                }
              }
              for (const info of update.subagent_info?.subagents ?? []) {
                const requestId = `gemini-native:${info.conversation_id}`;
                if (!nativeId(info.conversation_id) || state.workers.some(w => w.requestId === requestId)) continue;
                state.workers.push({
                  provider: 'gemini-native',
                  requestId,
                  nativeConversationId: info.conversation_id,
                  name: info.role || info.type_name || 'agy 原生子代理',
                  task: typeof info.initial_prompt === 'string' ? info.initial_prompt.slice(0, 2000) : '',
                  status: 'running',
                  settled: false,
                  startedAt: now(),
                  turnId: user.id
                });
              }
              if (!activeTurn) void save().catch(() => {});
              changed();
            }
          };

          current.done = (async () => {
            let sessionNewAttempted = false,
              keep = false;
            const unblockPromise = new Promise(resolve => {
              current.forceUnblock = () => resolve({unblocked: true});
            });
            const awaitStep = promise =>
              Promise.race([
                promise,
                unblockPromise.then(() => {
                  throw current.stopCloseError ?? Object.assign(Error('agy 已停止。'), {name: 'AbortError'});
                })
              ]);
            try {
              // The same automatic decision applies to this turn and, while the process is held,
              // to agy's own follow-up work after a background command (no K turn is open then).
              const permissionHandler = (active, denied) => async request => {
                if (request?.method === 'session/request_permission') {
                  const params = request.params ?? {};
                  const isActive = () => Boolean(record && active() && params.sessionId === record.nativeSessionId);
                  if (!isActive()) return {outcome: {outcome: 'cancelled'}};
                  const toolCall = params.toolCall ?? {};
                  let resolvedPaths = null;
                  if (mode === 'workspace-write' && isAcpEditTool(toolCall)) {
                    const targets = acpEditTargets(toolCall);
                    if (targets.length) {
                      resolvedPaths = Object.create(null);
                      for (const target of targets)
                        resolvedPaths[target] = await resolveAcpPath(state.workspace, target);
                      if (!isActive()) return {outcome: {outcome: 'cancelled'}};
                    }
                  }
                  const decision = geminiAcpPermissionDecision({
                    accessMode: mode,
                    workspace: launchConfig.workspace,
                    writable: launchConfig.writable,
                    allowedMcpRules: launchConfig.allowedMcpRules,
                    knownMcpServers: launchConfig.knownMcpServers,
                    deniedWrites: launchConfig.deniedWrites,
                    resolvedPaths,
                    commandsAllowed: launchConfig.commandsAllowed,
                    temps: launchConfig.temps,
                    toolCall
                  });
                  const options = Array.isArray(params.options) ? params.options : [];
                  if (decision.allow) {
                    if (!isActive()) return {outcome: {outcome: 'cancelled'}};
                    const opt = options.find(o => o.kind === 'allow_once');
                    if (opt) return {outcome: {outcome: 'selected', optionId: opt.optionId}};
                    denied.push({
                      tool: decision.tool,
                      target: decision.target,
                      message: 'agy 未提供可用的核准選項，已取消工具執行。'
                    });
                    return {outcome: {outcome: 'cancelled'}};
                  }
                  denied.push({
                    tool: decision.tool,
                    target: decision.target,
                    message: decision.message
                  });
                  const rejectOpt = options.find(o => o.kind === 'reject_once');
                  return rejectOpt
                    ? {outcome: {outcome: 'selected', optionId: rejectOpt.optionId}}
                    : {outcome: {outcome: 'cancelled'}};
                }
                throw Object.assign(Error(`不支援的 ACP 請求：${request?.method ?? 'unknown'}`), {code: -32601});
              };
              proc.route.update = handleUpdate;
              proc.route.request = permissionHandler(
                () => turn === current && !current.stopping && !current.closing && !current.abort.signal.aborted,
                current.denied
              );
              proc.hold = () => (proc.route.request = permissionHandler(() => held === proc && !proc.stopping, []));
              const agent =
                proc.agent ??
                (await openAgent({
                  executable: binary,
                  args,
                  label: 'Gemini',
                  missing: '找不到 Antigravity（agy）；請在設定頁按 Antigravity「更新」下載官方核心（或先安裝官方 Antigravity CLI），重開 K 後再登入。',
                  cwd: state.workspace,
                  env: geminiEnvironment(env, home(), {isolateTemp}),
                  killTree,
                  signal: current.abort.signal,
                  onNotification(msg) {
                    if (msg?.method === 'session/update') proc.route.update?.(msg.params);
                  },
                  onRequest: request =>
                    proc.route.request ? proc.route.request(request) : {outcome: {outcome: 'cancelled'}}
                }));
              proc.agent = agent;
              current.agent = agent;
              current.pid = agent.pid;
              void save(user.createdAt).catch(error => {
                state.error = `對話活動時間保存失敗：${error.message}`;
                changed();
              });
              current.abort.signal.throwIfAborted();
              if (reuse) {
                // The held process still has this session open. session/resume would drop what agy
                // queued meanwhile (live probe), so the next prompt goes straight to it.
              } else if (record.nativeSessionId) {
                await awaitStep(
                  agent.request('session/resume', {
                    sessionId: record.nativeSessionId,
                    cwd: state.workspace,
                    mcpServers: launchConfig.mcpServers
                  })
                );
              } else {
                sessionNewAttempted = true;
                const created = await awaitStep(
                  agent.request('session/new', {
                    cwd: state.workspace,
                    mcpServers: launchConfig.mcpServers
                  })
                );
                if (!nativeId(created?.sessionId)) throw Error('agy 沒有回傳原生對話 ID；不能自動重送。');
                record.nativeSessionId = created.sessionId;
                await awaitStep(save());
              }
              current.abort.signal.throwIfAborted();
              await awaitStep(
                agent.request('session/set_model', {
                  sessionId: record.nativeSessionId,
                  modelId: nativeModel
                })
              );
              await awaitStep(
                agent.request('session/set_mode', {
                  sessionId: record.nativeSessionId,
                  modeId: acpMode
                })
              );
              current.abort.signal.throwIfAborted();
              startPrompt(
                {
                  id: randomUUID(),
                  user,
                  groupId,
                  assistant: null,
                  rawText: '',
                  awaitEcho: Boolean(reuse)
                },
                initialBlocks,
                launchConfig.common.key
              );
              current.sessionReady = true;
              readyResolve();
              while (true) {
                const pendingPrompts = [...current.inFlight.values()].map(item => item.promise);
                if (!pendingPrompts.length || current.stopCloseError) {
                  current.closing = true;
                  break;
                }
                await Promise.race([Promise.allSettled(pendingPrompts), unblockPromise]);
              }
              current.closing = true;
              // Closing stdin makes agy terminate its background commands (live probe), so a turn
              // that ends normally with one still running keeps the process for this room.
              keep =
                !current.stopCloseError && !current.abort.signal.aborted && !agent.exited && proc.commands.size > 0;
              if (!current.stopCloseError && !keep) {
                try {
                  await agent.close({graceMs: stopGraceMs});
                } catch (error) {
                  unresolvedPid = agent.pid ?? current.pid;
                  state.status = 'uncertain';
                  state.error = `agy 程序結束未確認，未重送：${error.message}`;
                }
              }
              const anyOutput = current.prompts.some(p => p.rawText.trim().length > 0);
              const anyGoalComplete = current.prompts.some(p => p.goalCompleted);
              const firstError = current.error ?? current.prompts.find(p => p.error)?.error ?? null;
              if (unresolvedPid) {
                // Keep uncertain status & error set during close/stop escalation.
              } else if (current.abort.signal.aborted) {
                state.status = 'interrupted';
                state.error = null;
              } else if (current.uncertain || firstError?.processEnded) {
                state.status = 'uncertain';
                state.error = firstError?.message
                  ? `agy 程序在回合中結束；結果未知，未重送：${firstError.message}`
                  : 'agy 送出狀態未確認；結果未知，未重送。';
              } else if (firstError) {
                state.status = 'failed';
                state.error = mapGeminiAcpError(firstError);
              } else if (current.lastStopReason === 'refusal') {
                state.status = 'failed';
                state.error = 'agy 拒絕這項要求。';
              } else if (!anyOutput && current.denied.length > 0) {
                state.status = 'failed';
                state.error = current.denied.at(-1).message;
              } else if (current.lastStopReason === 'cancelled') {
                state.status = anyOutput ? 'interrupted' : 'failed';
                state.error = 'agy 回合已結束：操作未獲核准或被取消。';
              } else if (current.lastStopReason !== 'end_turn') {
                state.status = 'failed';
                state.error = 'agy 在回覆完成前結束，已保留收到的內容。';
              } else if (!anyOutput) {
                state.status = 'failed';
                state.error = 'agy no output produced（沒有最終回答）。';
              } else if (!record.nativeSessionId) {
                state.status = 'uncertain';
                state.error = 'agy 沒有回傳原生對話 ID；不能自動重送。';
              } else {
                state.status = 'completed';
                state.error = null;
              }
              if (goalObjective)
                state.goal = {
                  ...state.goal,
                  status: unresolvedPid
                    ? 'unknown'
                    : state.status === 'interrupted'
                      ? 'interrupted'
                      : state.status !== 'completed'
                        ? 'failed'
                        : anyGoalComplete
                          ? 'complete'
                          : 'ended'
                };
            } catch (error) {
              current.closing = true;
              readyResolve();
              if (error.unresolvedPid) {
                unresolvedPid = error.unresolvedPid;
                state.status = 'uncertain';
                state.error = error.message;
                if (goalObjective) state.goal = {...state.goal, status: 'unknown'};
              } else {
                keep = Boolean(
                  current.agent && !current.agent.exited && proc.commands.size && !current.abort.signal.aborted
                );
                if (current.agent && !current.stopCloseError && !keep) {
                  try {
                    await current.agent.close({graceMs: stopGraceMs});
                  } catch (closeError) {
                    unresolvedPid = current.agent.pid ?? current.pid;
                    state.status = 'uncertain';
                    state.error = `agy 程序結束未確認，未重送：${closeError.message}`;
                  }
                }
                if (!unresolvedPid) {
                  if (!sessionNewAttempted && !record.nativeSessionId) record.nativeStarted = false;
                  if (current.abort.signal.aborted || error.name === 'AbortError') {
                    state.status = 'interrupted';
                    state.error = null;
                  } else {
                    state.status = 'failed';
                    state.error = mapGeminiAcpError(error);
                  }
                }
                if (goalObjective)
                  state.goal = {
                    ...state.goal,
                    status: unresolvedPid ? 'unknown' : state.status === 'interrupted' ? 'interrupted' : 'failed'
                  };
              }
            } finally {
              readyResolve();
              let anyAssistant = false;
              for (const item of current.prompts) {
                if (item.assistant) {
                  anyAssistant = true;
                  delete item.assistant.streaming;
                  if (!item.assistant.completedAt) item.assistant.partial = true;
                }
              }
              if (proc.wake && current.prompts[0]?.awaitEcho) {
                delete proc.wake.streaming;
                proc.wake = null;
              }
              keep &&= !current.abort.signal.aborted && !proc.agent.exited;
              if (keep) holdProcess(proc, accountLease);
              else if (proc.commands.size)
                settleCommands(proc, unresolvedPid ? 'unresolved' : current.abort.signal.aborted ? 'stopped' : 'ended');
              if (keep) accountLease = null;
              const heldKeys = new Set(keep ? [...proc.commands.values()].map(c => c.key) : []);
              for (const tool of state.tools)
                if (tool.status === 'running' && !heldKeys.has(tool.id)) tool.status = 'interrupted';
              for (const worker of state.workers)
                if (
                  worker.provider === 'gemini-native' &&
                  worker.kind !== 'command' &&
                  worker.turnId === user.id &&
                  !worker.settled
                )
                  Object.assign(
                    worker,
                    unresolvedPid ? {status: 'unresolved'} : {status: 'ended', settled: true, endedAt: now()}
                  );
              try {
                await save(anyAssistant ? now() : undefined);
              } catch (error) {
                state.status = 'uncertain';
                state.error = `對話保存失敗；未重送：${error.message}`;
              }
              try {
                await accountLease?.release({settled: !unresolvedPid, refresh: true});
              } catch {
                state.status = 'uncertain';
                state.error = 'Gemini 帳號狀態保存失敗；原工作未重送。';
              }
              state.busy = false;
              turn = null;
              finish();
              changed();
              turnEnds++;
              const settled = {threadId: state.threadId, turnId: current.id, status: state.status};
              if (onConversationSettled)
                queueMicrotask(() => {
                  if (state.threadId === settled.threadId) onConversationSettled(settled);
                });
              scheduleWorkers();
            }
          })();
          return {sent: true};
        } catch (error) {
          if (!launched) {
            readyResolve();
            if (goalObjective && state.goal?.objective === goalObjective) state.goal.status = 'failed';
            if (!reuse) await accountLease?.release();
            if (!record.nativeSessionId) {
              record.nativeStarted = false;
              await save().catch(() => {});
            }
            state.busy = false;
            state.status = current.abort.signal.aborted ? 'interrupted' : 'failed';
            state.error = error.message;
            turn = null;
            finish();
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
      await cancelTurn(current, '主持回合程序停止未確認');
      if (unresolvedPid) throw Error('主持回合程序停止未確認。');
    },
    async stop() {
      stopSequence++;
      stopping++;
      try {
        const current = turn;
        const previousUnresolved = !current ? unresolvedPid : null;
        if (current) await cancelTurn(current, 'agy 停止未確認');
        const hadHeld = Boolean(held);
        if (hadHeld) await stopHeld();
        if (previousUnresolved) {
          await killTree(previousUnresolved);
          unresolvedPid = null;
          // Native subagents lived inside that confirmed-ended agy process.
          for (const worker of state.workers)
            if (worker.provider === 'gemini-native' && !worker.settled)
              Object.assign(worker, {
                status: 'ended',
                settled: true,
                endedAt: now(),
                ...(worker.kind === 'command'
                  ? {output: 'agy 背景程序已停止；未取得命令完成結果，未重播。'}
                  : {})
              });
          state.status = 'interrupted';
          state.error = null;
        }
        await resetBrowser();
        if ((current || hadHeld) && state.status !== 'uncertain') state.status = 'interrupted';
        // As in the Claude entry, stopping the room also stops its K workers.
        try {
          await closeWorkers();
        } catch (error) {
          state.status = 'uncertain';
          state.error = error.message;
          changed();
          throw error;
        }
        if (state.status !== 'offline') await save();
        changed();
        return {stopped: true};
      } finally {
        stopping--;
      }
    },
    async close() {
      await api.stop();
      if (unresolvedPid) throw Error('agy 程序停止尚未確認。');
      await persist;
      state.status = 'offline';
      changed();
    },
    async steer({text = '', attachmentIds = [], automatic = false, canDeliver} = {}) {
      let attempted = false;
      try {
        validateMessageInput(text, attachmentIds);
        const current = turn;
        assertSteerable(current, '請在 Gemini 回合執行中立即送入訊息。');
        if (current.goalObjective) throw Error('目標模式回合不支援立即送入。');
        if (!current.sessionReady) await current.readyPromise;
        assertSteerable(current, '回合已進入收尾或停止階段，未立即送入。', true);
        const {attachments, prompt} = await appendAttachments(text, attachmentIds);
        assertSteerable(current, '回合已進入收尾或停止階段，未立即送入。', true);
        const groupId = randomUUID();
        const user = {
          id: randomUUID(),
          role: 'user',
          text,
          attachments,
          createdAt: now(),
          groupId,
          turnId: current.id,
          source: 'steer'
        };
        const assertDelivery = () => {
          assertSteerable(current, '回合已進入收尾或停止階段，未立即送入。', true);
          if (automatic && (state.questions.length || canDeliver?.() === false))
            throw Error('送出前對話狀態已改變；訊息保留排隊。');
        };
        await queueRoomOperation(file(state.threadId), async () => {
          assertDelivery();
          const previousTitle = state.title;
          let entry;
          const rollbackSteer = async () => {
            if (entry) {
              current.inFlight.delete(entry.id);
              const pIdx = current.prompts.indexOf(entry);
              if (pIdx >= 0) current.prompts.splice(pIdx, 1);
              if (current.latestPromptId === entry.id)
                current.latestPromptId = current.prompts.at(-1)?.id ?? null;
              if (current.activeAssistantPromptId === entry.id)
                current.activeAssistantPromptId = current.latestPromptId;
            }
            const mIdx = state.messages.indexOf(user);
            if (mIdx >= 0) state.messages.splice(mIdx, 1);
            state.title = previousTitle;
            await save(undefined, {rollback: true});
          };
          state.title ||= (text.trim() || attachments[0]?.name || '').slice(0, 40);
          state.messages.push(user);
          try {
            await save();
            const common = await current.refreshCommonRule(assertDelivery);
            assertDelivery();
            const blocks = geminiAcpPromptBlocks({prompt, text, contextNotice: common.notice});
            entry = {
              id: randomUUID(),
              user,
              groupId,
              assistant: null,
              rawText: ''
            };
            current.startPrompt(entry, blocks, common.key);
            attempted = true;
            let writeError;
            void entry.rpc.catch(error => {
              writeError = error;
            });
            // ACP writes synchronously. Let an immediate rejection restore the version before handing off the queue.
            await Promise.resolve();
            if (writeError) {
              if (writeError.notSent === true) {
                await rollbackSteer();
                throw writeError;
              }
              current.uncertain = true;
              user.delivery = 'uncertain';
              state.status = 'uncertain';
              state.error = `立即送入後失去連線，結果未知，未重送：${writeError.message}`;
              await save().catch(() => {});
              changed();
              throw writeError;
            }
          } catch (error) {
            if (!attempted) await rollbackSteer();
            throw error;
          }
        });
        changed();
        return {steered: true};
      } catch (error) {
        if (!attempted) error.notSent = true;
        throw error;
      }
    },
    async compact() {
      throw Error('Gemini 由原生核心管理上下文；目前沒有手動壓縮介面。');
    },
    // Read during the source turn: goal({refresh}) refuses while busy.
    async continuationGoal() {
      if (!record || opening) throw Error('來源聊天室尚未就緒；未受理換房。');
      return {goal: structuredClone(state.goal)};
    },
    async prepareContinuation({turnId: expectedTurnId, mode, sourceCurrent, notificationsMayResume} = {}) {
      const ended = () =>
        record &&
        !opening &&
        !state.busy &&
        !turn &&
        !held &&
        !unresolvedPid &&
        !noticePending() &&
        state.status === 'completed' &&
        !state.questions.length &&
        !['starting', 'active', 'unknown'].includes(state.goal?.status) &&
        state.messages.findLast(m => m.role === 'user')?.turnId === expectedTurnId;
      let locked = false;
      try {
        if (mode !== 'fresh') throw Error('Gemini 只支援全新聊天室接續；未建立新聊天室。');
        if (preparingContinuation || !ended()) throw Error('原回合尚未確認正常結束；未建立新聊天室。');
        // Held to the end of the checks: a K notice cannot start a source turn while the move is decided.
        preparingContinuation = locked = true;
        const parent = state.threadId;
        sourceCurrent?.();
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
    async goal({objective, clear = false, refresh = false, editOnly = false} = {}) {
      if (editOnly) throw Error('目前 Gemini 原生介面不支援只修改目標文字；未重新啟動工作。');
      idle(true);
      if (!record) throw Error('請先開啟 Gemini 對話。');
      if (refresh) return {goal: structuredClone(state.goal)};
      if (clear) {
        state.goal = null;
        await save();
        changed();
        return {goal: null};
      }
      if (typeof objective !== 'string' || !objective.trim() || objective.length > 32000)
        throw Error('請輸入完整目標（最多 32000 字元）。');
      return api.send({text: objective.trim()}, objective.trim());
    },
    // Only K worker approvals reach here; agy itself denies what it cannot ask in headless mode.
    async answer({id, accept} = {}) {
      const item = pending.get(id);
      if (!item) throw Error('核准請求已失效或已回答；Gemini 本身的操作不提供互動核准。');
      if (typeof accept !== 'boolean') throw Error('核准狀態無效。');
      pending.delete(id);
      state.questions = state.questions.filter(q => q.id !== id);
      item.resolve(item.approval.reply(accept));
      changed();
      return {answered: true};
    },
    async fork() {
      throw Error('Gemini 尚未接入原生分支；可明確交接到其他供應商的新對話。');
    }
  };
  return api;
}
