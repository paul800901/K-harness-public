import {createAcpWorker, ACP_OUTPUT_FILES_NOTE} from './acp-worker.mjs';
import {openGrokAgent, grokEnvironment, grokExecutable, grokHome, ensureGrokHome, grokModelsFrom} from './grok-acp.mjs';

export const GROK_OUTPUT_FILES_NOTE = ACP_OUTPUT_FILES_NOTE;

// A Grok worker: native grok subagents off (GROK_SUBAGENTS=0), rules as session metadata,
// the model checked against grok's own initialize catalog before any session exists.
export const GROK_WORKER_PROFILE = {
  label: 'Grok',
  missingBinary: '找不到 Grok Build；請在設定頁更新 Grok 核心後重開 K。',
  executable: grokExecutable,
  home: grokHome,
  ensureHome: ensureGrokHome,
  openAgent: openGrokAgent,
  workerEnvironment: (env, home) => ({...grokEnvironment(env, home), GROK_SUBAGENTS: '0'}),
  toolName: toolCall => String(toolCall.title ?? toolCall._meta?.['x.ai/tool']?.name ?? 'tool'),
  metaRules: true,
  preflight(agent, model, effort) {
    const choice = grokModelsFrom(agent.initialize).find(row => row.model === model);
    if (!choice) throw Error('目前 Grok 未提供指定模型；未派工。');
    const levels = choice.supportedReasoningEfforts.map(e => e.reasoningEffort);
    if (levels.length ? !levels.includes(effort) : effort != null) throw Error('指定 Grok 推理程度目前不可用；未派工。');
  },
  async select({model, effort, set}) {
    await set('model', model);
    if (effort != null) await set('reasoning_effort', effort);
  }
};

export const createGrokWorker = options => createAcpWorker(GROK_WORKER_PROFILE, options);
