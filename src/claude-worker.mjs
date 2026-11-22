import path from 'node:path';
import {openClaudeHost} from './claude-host.mjs';
import {createWorkActivity, claudeWorkActivity} from './work-activity.mjs';
import {validateWorkerPolicy, workerTaskScope} from './worker-policy.mjs';
import {realpath} from 'node:fs/promises';
import {claudeCommonBlock, commonMemoryReference} from './common-memory.mjs';

// One bounded native Claude session. The existing bridge owns its work ID,
// persistence, completion delivery and cancellation; no second agent framework.
export function createClaudeWorker({
  root,
  workspace,
  accessMode = 'workspace-write',
  hostFactory = openClaudeHost,
  commandSpec,
  env = process.env
} = {}) {
  if (!path.isAbsolute(workspace ?? '') || !['read-only', 'workspace-write', 'danger-full-access'].includes(accessMode))
    throw Error('Claude 子代理工作區或權限無效。');
  return {
    async run({
      task,
      model,
      effort,
      sessionId,
      signal,
      mcpConfig,
      instructions = '',
      onStart = () => {},
      onActivity = () => {},
      onPermission,
      askParent
    } = {}) {
      const state = {},
        activity = createWorkActivity(state),
        tools = new Map(),
        files = new Set();
      let host,
        result,
        output = '',
        resolveResult,
        closePromise;
      const finished = new Promise(resolve => {
        resolveResult = resolve;
      });
      const close = () => (host ? (closePromise ??= host.close()) : Promise.resolve());
      const abort = () => {
        if (host)
          void host
            .interrupt()
            .catch(() => {})
            .finally(() => close().catch(() => {}));
      };
      const permission = async ({toolName, input}) => {
        if (signal?.aborted) return {behavior: 'deny', message: '工作已取消。'};
        if (toolName === 'AskUserQuestion') {
          if (!askParent) return {behavior: 'deny', message: '目前無法將問題送回派工者。'};
          const questions = input?.questions;
          if (
            !Array.isArray(questions) ||
            !questions.length ||
            questions.some(q => typeof q?.question !== 'string' || !q.question.trim() || q.isSecret === true) ||
            new Set(questions.map(q => q.question)).size !== questions.length
          )
            return {behavior: 'deny', message: '請使用不同且非機密的問題文字向派工者提問。'};

          const answers = [];
          for (const question of questions) {
            const options = Array.isArray(question.options)
              ? question.options
                  .filter(option => typeof option?.label === 'string')
                  .map(({label, description}) => `- ${label}${description ? `（${description}）` : ''}`)
              : [];
            const text = [
              question.question,
              ...(question.multiSelect ? ['可複選，選項名稱以逗號分隔。'] : []),
              ...options
            ].join('\n');
            try {
              signal?.throwIfAborted();
              const answer = await askParent(text);
              signal?.throwIfAborted();
              if (typeof answer !== 'string' || !answer.trim()) throw Error('Missing parent answer');
              answers.push([question.question, answer]);
            } catch {
              return {behavior: 'deny', message: '本次提問未收到可用的派工者回覆。'};
            }
          }
          // Native Claude keys answers by the original question text.
          return {behavior: 'allow', updatedInput: {...input, answers: Object.fromEntries(answers)}};
        }
        if (mcpConfig && typeof toolName === 'string' && toolName.startsWith('mcp__k_luna__'))
          return {behavior: 'allow', updatedInput: input};
        if (['ExitPlanMode', 'Agent', 'Task', 'TaskOutput', 'TaskStop'].includes(toolName))
          return {behavior: 'deny', message: '子代理不能改變權限或再委派。'};
        if (accessMode !== 'danger-full-access' && ['Bash', 'PowerShell', 'WebFetch', 'WebSearch'].includes(toolName))
          return {behavior: 'deny', message: '目前子代理權限不允許執行命令或連網。'};
        if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
          if (accessMode === 'read-only') return {behavior: 'deny', message: '唯讀子代理不能寫入。'};
          if (accessMode === 'workspace-write') {
            const name = input?.file_path ?? input?.path ?? input?.notebook_path;
            if (typeof name !== 'string') return {behavior: 'deny', message: '缺少實際寫入路徑，未核准。'};
            try {
              const inside = file => {
                const relative = path.relative(workspace, file);
                return (
                  relative !== '' &&
                  relative !== '..' &&
                  !relative.startsWith('..' + path.sep) &&
                  !path.isAbsolute(relative)
                );
              };
              let target = path.resolve(workspace, name);
              if (!inside(target)) throw Error('Outside workspace');
              // Native Write can create nested paths; resolve the nearest existing
              // ancestor so a junction cannot grant writes outside the workspace.
              for (;;) {
                try {
                  const resolved = await realpath(target);
                  if (resolved !== (await realpath(workspace)) && !inside(resolved)) throw Error('Outside workspace');
                  break;
                } catch (error) {
                  if (error.code !== 'ENOENT') throw error;
                  target = path.dirname(target);
                }
              }
            } catch {
              return {behavior: 'deny', message: '寫入不在授權工作區內，未核准。'};
            }
          }
        }
        return onPermission?.({toolName, input}) ?? {behavior: 'deny', message: '尚未核准這項操作。'};
      };
      const message = value => {
        if (value.isReplay) return;
        claudeWorkActivity(activity, value);
        onActivity(state.activity);
        if (value.type === 'assistant')
          for (const block of value.message?.content ?? []) {
            if (block.type === 'text') output += (output ? '\n' : '') + block.text;
            if (block.type === 'tool_use') tools.set(block.id, block);
          }
        if (value.type === 'user' && Array.isArray(value.message?.content))
          for (const block of value.message.content) {
            const tool = tools.get(block.tool_use_id);
            if (
              block.type !== 'tool_result' ||
              block.is_error ||
              !tool ||
              !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool.name)
            )
              continue;
            const name = tool.input?.file_path ?? tool.input?.path ?? tool.input?.notebook_path;
            if (typeof name === 'string') {
              const relative = path.relative(workspace, path.resolve(workspace, name));
              if (relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
                files.add(relative.replaceAll('\\', '/'));
            }
          }
        if (value.type === 'result') {
          result = value;
          resolveResult();
        }
      };
      try {
        signal?.throwIfAborted();
        host = await hostFactory({
          commandSpec,
          commonMemoryInstructions: commonMemoryReference(root),
          env,
          cwd: workspace,
          model,
          effort,
          sessionId,
          signal,
          worker: true,
          // Only a nested-capable worker gets a K gateway and the main room's worker catalog.
          nestedWorker: Boolean(mcpConfig),
          mcpConfig: mcpConfig ?? {mcpServers: {}},
          ...(mcpConfig
            ? {
                // The worker-role catalog (no main-agent rules); waiting rules live in WORKER_PROTOCOL_GUIDANCE.
                workspaceInstructions: `\n${instructions}`
              }
            : {}),
          accessMode:
            accessMode === 'danger-full-access'
              ? 'claude-bypassPermissions'
              : accessMode === 'read-only'
                ? 'claude-plan'
                : 'claude-manual',
          workerAccessMode: accessMode,
          onMessage: message,
          onPermission: permission
        });
        // Record the process as soon as it exists, so a stop that later cannot be confirmed can be re-checked.
        onStart(host.pid);
        validateWorkerPolicy({model, effort}, host.models, {claudeGateway: true});
        signal?.addEventListener('abort', abort, {once: true});
        signal?.throwIfAborted();
        activity.begin();
        onActivity(state.activity);
        const role = mcpConfig
          ? '你是 K HARNESS 的 Claude 統籌工人，只做以下有範圍的工作。可用 k_luna 派一層小工人，每次派工必須明確指定原生目錄提供且已接通的 model 與 effort（沒有推理設定時傳 null）。小工人不能再派工。交差前必須使用 luna_wait 等到所有小工人 settled 並親自檢查成果。不重播未知工作。'
          : '你是 K HARNESS 的 Claude 子代理，只做以下有範圍的工作，不再派工。';
        const delegated = {
          type: 'text',
          text: [
            role,
            `工作區為 ${workspace}。${workerTaskScope(accessMode)}`,
            ...(accessMode !== 'danger-full-access' ? ['此權限模式不允許執行指令或連網。'] : []),
            ...(askParent
              ? ['需要釐清工單時，用 AskUserQuestion 向派工者提問並等待回覆。回覆只能釐清現有任務範圍。']
              : []),
            `<DELEGATED_TASK>\n${task}\n</DELEGATED_TASK>`
          ].join('\n')
        };
        await host.start([claudeCommonBlock(root).block, delegated]);
        await Promise.race([finished, host.closed]);
        await close();
        const cancelled = signal?.aborted;
        return {
          status: cancelled ? 'cancelled' : !result || result.is_error ? 'failed' : 'completed',
          settled: true,
          output: typeof result?.result === 'string' ? result.result : output,
          outputFiles: [...files],
          outputFilesNote: '僅列本原生回合已知寫檔；空清單不證明無成果，不代表完整成果或內容已驗收。',
          acceptance: 'not-reviewed',
          ...(!cancelled && !result
            ? {error: 'Claude 程序已結束，但沒有原生結果；副作用未知，先檢查已有成果，不得重播。'}
            : !cancelled && result?.is_error
              ? {error: result.result ?? 'Claude 原生回合失敗。'}
              : {})
        };
      } catch (error) {
        try {
          await close();
        } catch (closeError) {
          throw Object.assign(Error(`Claude 子代理停止未確認：${closeError.message}；不得重播。`), {settled: false});
        }
        if (signal?.aborted)
          return {status: 'cancelled', settled: true, output, outputFiles: [...files], acceptance: 'not-reviewed'};
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    }
  };
}
