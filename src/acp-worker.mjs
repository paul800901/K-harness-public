import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {createWorkActivity} from './work-activity.mjs';
import {WORKER_SERVICE_RULE, workerTaskScope} from './worker-policy.mjs';
import {askWorkerParent, workerQuestionFrom, WORKER_QUESTION_GUIDANCE} from './worker-question.mjs';
import {claudeCommonBlock, commonMemoryReference} from './common-memory.mjs';

export const ACP_OUTPUT_FILES_NOTE = '僅列本原生回合已知寫檔；空清單不證明無成果，不代表完整成果或內容已驗收。';

// One bounded native ACP session (Grok Build, DeepSeek Harness). The existing bridge owns its work ID,
// persistence, completion delivery and cancellation. A K worker never delegates: the core's own
// subagents are disabled and it gets no K gateway. `profile` holds what differs per core.
export function createAcpWorker(
  profile,
  {
    root,
    workspace,
    accessMode = 'workspace-write',
    env = process.env,
    openAgent = profile.openAgent,
    stopGraceMs = 10000,
    executable
  } = {}
) {
  const {label} = profile;
  if (!path.isAbsolute(workspace ?? '') || !['read-only', 'workspace-write', 'danger-full-access'].includes(accessMode))
    throw Error(`${label} 子代理工作區或權限無效。`);
  const binary = profile.executable(env, executable),
    home = profile.home(root, env);
  const inside = (base, file) => {
    const relative = path.relative(base, file);
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  async function writableInside(name) {
    let target = path.resolve(workspace, name);
    if (!inside(workspace, target)) return false;
    const base = await realpath(workspace);
    for (;;) {
      try {
        const resolved = await realpath(target);
        return resolved === base || inside(base, resolved);
      } catch (error) {
        if (error.code !== 'ENOENT') return false;
        const parent = path.dirname(target);
        if (parent === target) return false;
        target = parent;
      }
    }
  }
  const targets = toolCall => {
    const found = new Set();
    for (const item of toolCall.content ?? [])
      if (item?.type === 'diff' && typeof item.path === 'string') found.add(item.path);
    for (const item of toolCall.locations ?? []) if (typeof item?.path === 'string') found.add(item.path);
    const input = toolCall.rawInput ?? {};
    for (const key of ['file_path', 'path', 'target_file']) if (typeof input[key] === 'string') found.add(input[key]);
    return [...found];
  };
  return {
    async run({task, model, effort, signal, askParent, onStart = () => {}, onActivity = () => {}} = {}) {
      if (!binary) throw Error(profile.missingBinary);
      const state = {},
        activity = createWorkActivity(state),
        files = new Set(),
        edits = new Map();
      let agent = null,
        sessionId = null,
        output = '',
        turnOutput = '';
      const denied = [];
      const decide = async params => {
        const toolCall = params.toolCall ?? {},
          options = params.options ?? [];
        const pick = kind => options.find(o => o.kind === kind)?.optionId;
        const allow = {outcome: {outcome: 'selected', optionId: pick('allow_once')}},
          reject = pick('reject_once')
            ? {outcome: {outcome: 'selected', optionId: pick('reject_once')}}
            : {outcome: {outcome: 'cancelled'}};
        if (signal?.aborted || !pick('allow_once') || params.sessionId !== sessionId) return reject;
        if (accessMode === 'danger-full-access') return allow;
        if (accessMode === 'workspace-write' && toolCall.kind === 'edit') {
          const names = targets(toolCall);
          if (names.length && (await Promise.all(names.map(writableInside))).every(Boolean)) return allow;
        }
        denied.push(profile.toolName(toolCall).slice(0, 300));
        return reject;
      };
      const update = value => {
        const kind = value.sessionUpdate;
        if (kind === 'agent_message_chunk' && typeof value.content?.text === 'string') {
          turnOutput += value.content.text;
          output = turnOutput;
          activity.record();
        } else if (kind === 'tool_call' || kind === 'tool_call_update') {
          activity.tool(String(value.toolCallId), ['completed', 'failed'].includes(value.status), 'tool', value.title);
          // grok sends the tool kind on an earlier update, not always on the completed one (live probe);
          // DSH names its edit tools instead of marking them as edits.
          const known = edits.get(value.toolCallId) ?? {edit: false, names: new Set()};
          if (value.kind === 'edit' || profile.editTools?.includes(value.title)) known.edit = true;
          for (const name of targets(value)) known.names.add(name);
          edits.set(value.toolCallId, known);
          if (value.status === 'completed' && known.edit)
            for (const name of known.names) {
              const absolute = path.resolve(workspace, name);
              if (inside(workspace, absolute)) files.add(path.relative(workspace, absolute).replaceAll('\\', '/'));
            }
        } else return;
        onActivity(state.activity);
      };
      const close = async () => {
        if (agent) await agent.close();
      };
      // Cancel the native turn first; if the core does not end it, end the process (confirmed by close()).
      let abortTimer = null,
        stopFailed;
      const stopFailure = new Promise((_, reject) => (stopFailed = reject));
      stopFailure.catch(() => {});
      const abort = () => {
        if (!agent) return;
        try {
          if (sessionId) agent.notify('session/cancel', {sessionId});
        } catch {}
        abortTimer = setTimeout(
          () =>
            void agent
              .close()
              .catch(error =>
                stopFailed(
                  Object.assign(Error(`${label} 子代理停止未確認：${error.message}；不得重播。`), {settled: false})
                )
              ),
          sessionId ? stopGraceMs : 0
        );
      };
      // Every wait after the process exists also ends on an unconfirmed stop.
      const guarded = promise => Promise.race([stopFailure, promise]);
      const evidence = () => ({
        output,
        outputFiles: [...files],
        outputFilesNote: ACP_OUTPUT_FILES_NOTE,
        ...(denied.length ? {deniedTools: denied} : {}),
        ...(sessionId ? {nativeSessionId: sessionId} : {})
      });
      try {
        signal?.throwIfAborted();
        await profile.ensureHome(home);
        agent = await openAgent({
          executable: binary,
          env: await profile.workerEnvironment(env, home, {accessMode}),
          role: 'worker',
          cwd: workspace,
          onNotification: message => {
            if (message.method === 'session/update' && message.params?.sessionId === sessionId)
              update(message.params.update ?? {});
          },
          onRequest: async message => {
            if (message.method !== 'session/request_permission') throw Error(`K 未支援這項 ${label} 用戶端請求。`);
            return decide(message.params ?? {});
          },
          signal
        }).catch(error => {
          // Startup cleanup not confirmed: keep the PID for a later stop check; never report it ended.
          if (error.unresolvedPid) {
            onStart(error.unresolvedPid);
            error.settled = false;
          }
          throw error;
        });
        onStart(agent.pid);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
        profile.preflight?.(agent, model, effort);
        const restriction = {
          'read-only': '唯讀：不得寫檔或執行非唯讀命令；K 會拒絕這類操作。',
          // DSH runs sandboxed commands itself (DSH_PERMISSION_MODE); only escalations reach K.
          'workspace-write':
            profile.provider === 'deepseek'
              ? '只能編輯指定工作區內檔案；命令只在原生沙盒內執行，提權與工作區外寫入會被 K 拒絕。'
              : '只能編輯指定工作區內檔案；命令與工作區外寫入會被 K 拒絕。',
          'danger-full-access': '完整存取：可在任務範圍內讀寫與執行命令。'
        }[accessMode];
        const rules = `你是 K HARNESS 的 ${label} 子代理。不再派工、不改變登入或計費。${restriction}\n${WORKER_SERVICE_RULE}\n${commonMemoryReference(root)}`;
        const created = await guarded(
          agent.request('session/new', {
            cwd: workspace,
            mcpServers: [],
            ...(profile.metaRules ? {_meta: {rules}} : {})
          })
        );
        sessionId = created?.sessionId;
        if (!sessionId) throw Error(`${label} 沒有回傳原生對話 ID；未派工。`);
        await guarded(
          profile.select({
            created,
            model,
            effort,
            set: (configId, value) => agent.request('session/set_config_option', {sessionId, configId, value})
          })
        );
        signal?.throwIfAborted();
        activity.begin();
        onActivity(state.activity);
        let commonKey = null,
          common = claudeCommonBlock(root);
        let prompt = [
          ...(profile.metaRules ? [] : [{type: 'text', text: `<k_rules>\n${rules}\n</k_rules>`}]),
          ...(common.block ? [common.block] : []),
          ...(askParent ? [{type: 'text', text: WORKER_QUESTION_GUIDANCE}] : []),
          {
            type: 'text',
            text: `你是 K HARNESS 的 ${label} 子代理，只做以下有範圍的工作。工作目錄：${workspace}，權限：${accessMode}。${workerTaskScope(accessMode)}\n<DELEGATED_TASK>\n${task}\n</DELEGATED_TASK>`
          }
        ];
        let result;
        for (;;) {
          signal?.throwIfAborted();
          turnOutput = '';
          output = '';
          result = await guarded(agent.request('session/prompt', {sessionId, prompt}));
          if (common.block) commonKey = common.key;
          output = turnOutput;
          const question = askParent && result?.stopReason === 'end_turn' && workerQuestionFrom(turnOutput);
          if (!question) break;
          const answer = askWorkerParent(askParent, question, signal);
          const text = await guarded(
            agent.closed
              ? Promise.race([
                  answer,
                  agent.closed.then(() => {
                    throw Error(`${label} 子代理在等待主代理答覆時已結束。`);
                  })
                ])
              : answer
          );
          common = claudeCommonBlock(root, commonKey);
          prompt = [...(common.block ? [common.block] : []), {type: 'text', text}];
        }
        await close();
        const cancelled = signal?.aborted || (result?.stopReason === 'cancelled' && !denied.length);
        return {
          status: cancelled
            ? 'cancelled'
            : result?.stopReason === 'end_turn' || result?.stopReason === 'max_turn_requests'
              ? 'completed'
              : 'failed',
          settled: true,
          output,
          outputFiles: [...files],
          outputFilesNote: ACP_OUTPUT_FILES_NOTE,
          acceptance: 'not-reviewed',
          ...(denied.length ? {deniedTools: denied} : {}),
          ...(!cancelled && !['end_turn', 'max_turn_requests'].includes(result?.stopReason)
            ? {
                error: denied.length
                  ? `${label} 子代理有 ${denied.length} 項操作超出權限被 K 拒絕，回合已結束。`
                  : `${label} 回合未正常結束（${result?.stopReason ?? '未知'}）。`
              }
            : {})
        };
      } catch (error) {
        // Every failure exit keeps what this run already produced; the bridge records it unaccepted.
        if (error.settled === false) throw Object.assign(error, {workerResult: evidence()});
        try {
          await close();
        } catch (closeError) {
          throw Object.assign(Error(`${label} 子代理停止未確認：${closeError.message}；不得重播。`), {
            settled: false,
            workerResult: evidence()
          });
        }
        if (signal?.aborted)
          return {
            status: 'cancelled',
            settled: true,
            output,
            outputFiles: [...files],
            outputFilesNote: ACP_OUTPUT_FILES_NOTE,
            acceptance: 'not-reviewed'
          };
        throw Object.assign(error, {workerResult: evidence()});
      } finally {
        clearTimeout(abortTimer);
        signal?.removeEventListener('abort', abort);
      }
    }
  };
}
