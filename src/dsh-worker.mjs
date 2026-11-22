import {createAcpWorker} from './acp-worker.mjs';
import {
  openDshAgent,
  dshEnvironment,
  dshExecutable,
  dshHome,
  ensureDshHome,
  dshModelOptions,
  dshEfforts,
  dshToolName,
  DSH_EDIT_TOOLS,
  DSH_MISSING
} from './dsh-acp.mjs';

// A DeepSeek worker: K's worker overlay (no DSH subagents, workflows, goal rounds or background jobs),
// rules in the prompt (DSH ignores session metadata), the model checked against the new session's catalog.
export const DSH_WORKER_PROFILE = {
  provider: 'deepseek',
  label: 'DeepSeek',
  missingBinary: DSH_MISSING,
  executable: dshExecutable,
  home: dshHome,
  ensureHome: ensureDshHome,
  openAgent: openDshAgent,
  toolName: dshToolName,
  editTools: DSH_EDIT_TOOLS,
  metaRules: false,
  async select({created, model, effort, set}) {
    const option = dshModelOptions(created?.configOptions).find(row => row.model === model);
    if (!option) throw Error('目前 DeepSeek 未提供指定模型；未派工。');
    const result = await set('model', option.nativeValue);
    const levels = dshEfforts(result?.configOptions).levels.map(level => level.value);
    if (levels.length ? !levels.includes(effort) : effort != null)
      throw Error('指定 DeepSeek 推理程度目前不可用；未派工。');
    if (effort != null) await set('reasoning_effort', effort);
  }
};

/** `apiKey` returns the human's DeepSeek key; it only reaches the DSH process environment. */
export const createDeepSeekWorker = ({apiKey, ...options} = {}) =>
  createAcpWorker(
    {
      ...DSH_WORKER_PROFILE,
      workerEnvironment: async (env, home, {accessMode}) =>
        dshEnvironment(env, home, {accessMode, apiKey: apiKey ? await apiKey() : null})
    },
    options
  );
