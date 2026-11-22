import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {killAcpTree, openAcpAgent} from './acp-agent.mjs';

// Grok Build (grok agent stdio) speaks ACP JSON-RPC. K keeps one native process per open
// room; grok owns sessions, history, compaction and tools. K only presents and coordinates.
// The launcher names the K-only home (beside CODEX_HOME / CLAUDE_CONFIG_DIR); tests fall back under root.
export const grokHome = (root, env = {}) =>
  env.K_GROK_HOME && path.isAbsolute(env.K_GROK_HOME) ? env.K_GROK_HOME : path.join(root, 'agent-home', 'grok');
export function grokExecutable(env = process.env, explicit) {
  const value = explicit ?? env.K_GROK_EXECUTABLE;
  return value ? path.resolve(value) : null;
}

// grok 1.0.70 config reference: these toggles scan other vendors' user-global hooks, MCP
// servers and skills. K keeps each core's own configuration, so they start off.
const K_CONFIG = `# K HARNESS 建立；已存在時不覆寫。
[cli]
auto_update = false

[compat.claude]
hooks = false
mcps = false
skills = false

[compat.codex]
hooks = false
skills = false

[compat.cursor]
hooks = false
mcps = false
skills = false
`;
export async function ensureGrokHome(home) {
  await mkdir(home, {recursive: true});
  await writeFile(path.join(home, 'config.toml'), K_CONFIG, {flag: 'wx'}).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
}

export function grokEnvironment(source = process.env, home) {
  const env = {...source};
  // Subscription login only: no inherited API keys, deployment keys or config overlays.
  for (const key of Object.keys(env))
    if (
      /^(XAI_API_KEY|GROK_DEPLOYMENT_KEY|GROK_CONFIG|GROK_CONFIG_PATH|GROK_SANDBOX|GROK_AGENT|GROK_AUTH_PROVIDER_COMMAND|GROK_PROXY_URL|K_GROK_EXECUTABLE|K_GROK_HOME)$/iu.test(
        key
      )
    )
      delete env[key];
  return {
    ...env,
    GROK_HOME: home,
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_DISABLE_API_KEY_AUTH: '1',
    GROK_TELEMETRY_ENABLED: '0',
    GROK_FEEDBACK_ENABLED: '0',
    GROK_CLAUDE_HOOKS_ENABLED: '0',
    GROK_CLAUDE_MCPS_ENABLED: '0',
    GROK_CLAUDE_SKILLS_ENABLED: '0',
    GROK_CURSOR_HOOKS_ENABLED: '0',
    GROK_CURSOR_MCPS_ENABLED: '0',
    GROK_CURSOR_SKILLS_ENABLED: '0',
    NO_COLOR: '1'
  };
}

export const killGrokTree = (pid, options = {}) => killAcpTree(pid, {...options, label: 'Grok'});

/** One `grok agent stdio` process; see openAcpAgent. */
export const openGrokAgent = options =>
  openAcpAgent({
    args: ['agent', 'stdio'],
    label: 'Grok',
    missing: '找不到 Grok Build；請在設定頁更新 Grok 核心後重開 K。',
    killTree: killGrokTree,
    ...options
  });

// The catalog comes from grok's own initialize response (modelState), never a K list.
export function grokModelsFrom(initialize) {
  const state = initialize?._meta?.modelState,
    image = initialize?.agentCapabilities?.promptCapabilities?.image === true;
  return (state?.availableModels ?? [])
    .filter(row => typeof row?.modelId === 'string' && /^grok-[a-z0-9][\w.-]*$/u.test(row.modelId))
    .map(row => {
      const efforts = (row._meta?.reasoningEfforts ?? []).filter(e => typeof e?.value === 'string');
      return {
        model: row.modelId,
        displayName: row.name || row.modelId,
        description: row.description ?? '',
        provider: 'grok',
        available: true,
        inputModalities: image ? ['text', 'image'] : ['text'],
        supportedReasoningEfforts: row._meta?.supportsReasoningEffort
          ? efforts.map(e => ({reasoningEffort: e.value, description: e.description ?? ''}))
          : [],
        defaultReasoningEffort: row._meta?.supportsReasoningEffort
          ? (efforts.find(e => e.default)?.value ?? row._meta?.reasoningEffort ?? null)
          : null,
        isDefault: row.modelId === state.currentModelId
      };
    });
}

// Keep the provider's reset date even when it does not report a usage percentage.
export function grokQuotaFrom(billing, checkedAt = new Date().toISOString()) {
  const config = billing?.config ?? {},
    period = config.currentPeriod ?? {},
    weekly = period.type === 'USAGE_PERIOD_TYPE_WEEKLY',
    raw = config.creditUsagePercent,
    // Only an official number in range is a percentage; null, '' and other values stay unknown.
    percent = typeof raw === 'number' && raw >= 0 && raw <= 100 ? raw : NaN;
  const end = Date.parse(period.end ?? config.billingPeriodEnd ?? '');
  return {
    status: Number.isFinite(percent) ? 'available' : 'partial',
    plan: typeof billing?.subscription_tier === 'string' ? billing.subscription_tier : null,
    checkedAt,
    windows: [
      {
        key: weekly ? 'weekly' : 'period',
        label: weekly ? '每週' : '本期',
        minutes: weekly ? 10080 : null,
        remainingPercent: Number.isFinite(percent) ? Math.max(0, Math.min(100, 100 - percent)) : null,
        resetsAt: Number.isFinite(end) ? Math.floor(end / 1000) : null
      }
    ],
    note: Number.isFinite(percent) ? null : 'Grok 官方本次未提供已用百分比；只顯示官方週期與重設時間。'
  };
}
