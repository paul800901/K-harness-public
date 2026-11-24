import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {atomicWrite} from './atomic-write.mjs';
import {killAcpTree, openAcpAgent} from './acp-agent.mjs';

// DeepSeek Harness (DSH) is DeepSeek's own agent core. K runs the official desktop package's bundled CLI
// (`dsh --profile acp`, ACP JSON-RPC over stdio) under Electron-as-Node. DeepSeek has no subscription: the
// core uses the human's DeepSeek API key, the one saved in K's discussion API settings.
export const dshHome = (root, env = {}) =>
  env.K_DSH_HOME && path.isAbsolute(env.K_DSH_HOME) ? env.K_DSH_HOME : path.join(root, 'agent-home', 'deepseek');
export function dshExecutable(env = process.env, explicit) {
  const value = explicit ?? env.K_DSH_EXECUTABLE;
  return value ? path.resolve(value) : null;
}
// The CLI entry inside the official package, beside `DeepSeek Harness.exe`.
export const dshCli = executable =>
  path.join(
    path.dirname(executable),
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js'
  );

// K-owned profile overlays (written on every start). A main agent keeps DSH's goal rounds and background
// jobs: K watches DSH's own session log, shows that autonomous work as a turn and can stop it. A K worker
// is one bounded turn that never delegates: its goal rounds, background execution (run_in_background, or
// a command moved to the background when it outlives its timeout), subagents and workflows are off.
const off = id => `- id: ${id}\n  disabled: true\n`;
const patches = {
  main: [],
  worker: [
    ...['goal', 'goal-round-driver', 'command-goal', 'tool-goal', 'tool-jobs'].map(off),
    '- id: tool-pwsh\n  config:\n    enableRunInBackground: false\n    promoteOnTimeout: false\n',
    ...['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow'].map(off)
  ]
};
export const dshPatch = (home, role = 'main') => path.join(home, `k-${role}.patch.yml`);
export async function ensureDshHome(home) {
  await mkdir(home, {recursive: true});
  // Atomic: a worker starting at the same moment never reads a half-written overlay.
  for (const [role, entries] of Object.entries(patches))
    // DSH refuses a patch file that is empty or only comments; an empty overlay is written as `[]`.
    await atomicWrite(dshPatch(home, role), `# K HARNESS 產生，每次啟動重寫。\n${entries.join('') || '[]\n'}`);
}

export function dshEnvironment(source = process.env, home, {accessMode = 'workspace-write', apiKey} = {}) {
  if (!apiKey) throw Error('尚未設定 DeepSeek API 金鑰：請在設定頁「API 連線」新增 DeepSeek（https://api.deepseek.com）連線。');
  const env = {...source};
  // Only K's own values reach the core: no inherited key, home, permission mode or K paths.
  for (const key of Object.keys(env))
    if (/^(DEEPSEEK_API_KEY|DSH_HOME|DSH_PERMISSION_MODE|ELECTRON_RUN_AS_NODE|K_DSH_EXECUTABLE|K_DSH_HOME)$/iu.test(key))
      delete env[key];
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home,
    DSH_PERMISSION_MODE: accessMode,
    DEEPSEEK_API_KEY: apiKey,
    NO_COLOR: '1'
  };
}

// DSH's file tools (packages/fs); DSH reports them as kind `other`, so K recognises them by name.
export const DSH_EDIT_TOOLS = ['write', 'edit', 'str_replace_editor'];
// DSH names MCP tools `mcp__<server>__<tool>`; K matches its own servers by `<server>__<tool>`.
export const dshToolName = toolCall => String(toolCall.title ?? 'tool').replace(/^mcp__/u, '');
export const DSH_MISSING = '找不到 DeepSeek Harness；請在設定頁按 DeepSeek「更新」下載官方核心，重開 K。';

export const killDshTree = (pid, options = {}) => killAcpTree(pid, {...options, label: 'DeepSeek'});

/** One `dsh --profile acp` process with K's main or worker overlay; see openAcpAgent. */
export const openDshAgent = ({executable, env, role = 'main', ...options} = {}) =>
  openAcpAgent({
    executable,
    env,
    args: executable
      ? ['--expose-internals', dshCli(executable), '--profile', 'acp', '--patch', dshPatch(env?.DSH_HOME ?? '', role)]
      : [],
    label: 'DeepSeek',
    missing: DSH_MISSING,
    killTree: killDshTree,
    ...options
  });

// DSH publishes its catalog as session config options: model values are opaque JSON
// `[provider, model]` strings. K names a model by its model ID and keeps the opaque value.
export function dshModelOptions(configOptions = []) {
  const option = configOptions.find(o => o?.id === 'model');
  return (option?.options ?? [])
    .flatMap(group => (Array.isArray(group?.options) ? group.options : [group]))
    .map(row => {
      let parsed;
      try {
        parsed = JSON.parse(row?.value);
      } catch {
        return null;
      }
      const model = Array.isArray(parsed) ? parsed[1] : null;
      return typeof model === 'string' && /^deepseek-[a-z0-9][\w.-]*$/u.test(model)
        ? {model, displayName: row.name || model, description: row.description ?? '', nativeValue: row.value}
        : null;
    })
    .filter(Boolean);
}
export function dshEfforts(configOptions = []) {
  const option = configOptions.find(o => o?.id === 'reasoning_effort');
  return {
    levels: (option?.options ?? []).filter(o => typeof o?.value === 'string'),
    current: typeof option?.currentValue === 'string' ? option.currentValue : null
  };
}
