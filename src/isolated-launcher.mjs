import path from 'node:path';
import {mkdir, realpath, stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createOwnerBrowserRegistry} from './owner-browser-registry.mjs';
import {startIsolatedDesktop} from './isolated-desktop.mjs';
import {createCoreUpdates, selectedCoreExecutables} from './core-updates.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const inferredCandidateRoot =
  path.basename(path.dirname(moduleDirectory)).toLowerCase() === 'trusted-runtime'
    ? path.resolve(moduleDirectory, '../..')
    : path.resolve(moduleDirectory, '..');
export const ISOLATED_CANDIDATE_ROOT = inferredCandidateRoot;
export const ISOLATED_FORMAL_PORT = 47831;

export function isolatedLauncherPaths(candidateRoot = process.env.K_CANDIDATE_ROOT || ISOLATED_CANDIDATE_ROOT) {
  if (!path.isAbsolute(candidateRoot)) throw Error('Candidate root must be absolute.');
  const root = path.resolve(candidateRoot),
    vault = path.join(root, 'vault'),
    trustedRuntime = path.join(root, 'trusted-runtime');
  const trustedProviders = path.join(root, 'trusted-providers');
  return {
    root,
    vault,
    trustedRuntime,
    trustedProviders,
    stateRoot: path.join(vault, 'private-state'),
    workspace: path.join(root, 'workspace'),
    agentHome: path.join(root, 'agent-home'),
    browserProfiles: path.join(vault, 'profiles'),
    browserOutput: path.join(root, 'browser-output'),
    electronExecutable: path.join(trustedRuntime, 'node_modules', 'electron', 'dist', 'electron.exe'),
    executable: path.join(root, 'trusted-providers', 'codex', 'codex.exe'),
    claudeCommand: path.join(root, 'trusted-providers', 'claude.exe')
  };
}

async function requiredFile(file) {
  try {
    if (!(await stat(file)).isFile()) throw Error(`Required trusted file is missing: ${file}`);
  } catch (error) {
    if (error.code === 'ENOENT') throw Error(`Required trusted file is missing: ${file}`);
    throw error;
  }
}
// A core the person has not set up yet is simply absent: only that provider's work fails.
async function optionalFile(file) {
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}
async function requiredDirectory(directory) {
  if (!(await stat(directory)).isDirectory()) throw Error(`Required isolated directory is missing: ${directory}`);
}
async function checkUnder(parent, target) {
  const base = await realpath(parent),
    actual = await realpath(target),
    relative = path.relative(base, actual);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw Error('Isolated path escaped its owner root.');
  return actual;
}

/** Starts the native production runtime with owner-selected workspaces. */
export async function startIsolatedOwner({
  paths = isolatedLauncherPaths(),
  sourceEnv = process.env,
  nodeExecutable = process.execPath,
  gatewayFactory,
  browserFactory = createOwnerBrowserRegistry,
  desktopFactory = startIsolatedDesktop,
  selfUpdateRequest
} = {}) {
  const p = paths;
  if (!path.isAbsolute(nodeExecutable ?? '')) throw Error('A trusted absolute Node executable is required.');
  await requiredFile(nodeExecutable);
  for (const key of [
    'root',
    'vault',
    'trustedRuntime',
    'trustedProviders',
    'stateRoot',
    'workspace',
    'agentHome',
    'browserProfiles',
    'browserOutput',
    'executable',
    'claudeCommand'
  ]) {
    if (!path.isAbsolute(p?.[key] ?? '')) throw Error(`Missing absolute isolated launch path: ${key}`);
  }
  await requiredDirectory(p.root);
  await requiredDirectory(p.vault);
  await requiredDirectory(p.trustedRuntime);
  // Created empty on a first start; cores arrive later through the settings page update.
  await mkdir(p.trustedProviders, {recursive: true});
  await requiredDirectory(p.workspace);
  await requiredDirectory(p.agentHome);
  await requiredDirectory(p.browserProfiles);
  await requiredDirectory(p.browserOutput);
  const installed = {codex: await optionalFile(p.executable), claude: await optionalFile(p.claudeCommand)};
  await checkUnder(p.root, p.trustedRuntime);
  await checkUnder(p.root, p.trustedProviders);
  for (const file of Object.values(installed)) if (file) await checkUnder(p.trustedProviders, file);
  await checkUnder(p.root, p.workspace);
  await checkUnder(p.root, p.agentHome);
  await checkUnder(p.vault, p.browserProfiles);
  await checkUnder(p.root, p.browserOutput);
  await checkUnder(p.vault, p.stateRoot).catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(p.stateRoot, {recursive: false});
    await checkUnder(p.vault, p.stateRoot);
  });
  // State is created by the trusted owner under the candidate vault. Existing candidate state remains untouched.
  const env = {
    ...sourceEnv,
    CODEX_HOME: path.join(p.agentHome, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(p.agentHome, '.claude')
  };
  // Only cores that exist count as installed; a missing one is downloaded by its update button.
  const cores = await selectedCoreExecutables(p.trustedProviders, {
    ...installed,
    gemini: null,
    grok: null,
    deepseek: null
  });
  env.K_GEMINI_EXECUTABLE = cores.gemini ?? path.join(p.trustedProviders, 'gemini', 'agy.exe');
  if (cores.grok) env.K_GROK_EXECUTABLE = cores.grok;
  else delete env.K_GROK_EXECUTABLE;
  if (cores.deepseek) env.K_DSH_EXECUTABLE = cores.deepseek;
  else delete env.K_DSH_EXECUTABLE;
  env.K_GROK_HOME = path.join(p.agentHome, 'grok');
  env.K_DSH_HOME = path.join(p.agentHome, 'deepseek');
  const coreUpdates = createCoreUpdates({
    root: p.trustedProviders,
    active: cores,
    versionEnv: {GROK_HOME: env.K_GROK_HOME}
  });
  // Keep provider subscription homes and prevent inherited API billing credentials.
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|DEEPSEEK_API_KEY|XAI_API_KEY|GROK_DEPLOYMENT_KEY)$/i.test(
        key
      )
    )
      delete env[key];
  }
  let browsers, app;
  try {
    browsers = browserFactory({vault: p.browserProfiles, outputRoot: p.browserOutput, testOnly: false, gatewayFactory});
    app = await desktopFactory({
      root: p.stateRoot,
      workspace: p.workspace,
      port: ISOLATED_FORMAL_PORT,
      // A missing core keeps its fixed K path, so starting it reports how to install it.
      executable: cores.codex ?? p.executable,
      commandSpec: {command: cores.claude ?? p.claudeCommand, argsPrefix: []},
      env,
      browsers,
      readColabBalance: gatewayFactory?.readColabBalance,
      coreUpdates,
      // The tray launcher performs the update; K only asks it, from the repository root's records.
      ...(selfUpdateRequest
        ? {selfUpdate: {repoRoot: path.resolve(p.root, '../..'), request: selfUpdateRequest}}
        : {}),
      allowLogin: true,
      workspaceLabel: '私人工作區'
    });
    return {app, browsers};
  } catch (error) {
    await app?.close().catch(() => {});
    await browsers?.close().catch(() => {});
    throw error;
  }
}

/** Private supervisor protocol for the native workbench. */
export function runIsolatedLauncherProtocol({
  app,
  input = process.stdin,
  output = process.stdout,
  onExit = code => {
    process.exitCode = code;
  },
  onOpen,
  autoReady = true
} = {}) {
  if (!app || typeof app.close !== 'function') throw Error('A running isolated desktop is required.');
  const lines = createInterface({input, crlfDelay: Infinity});
  let closing = false,
    closePromise = null,
    resolveDone;
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });
  const emit = event => output.write(`${JSON.stringify(event)}\n`);
  const issue = type => emit({type, presentation: 'native', origin: app.origin, pid: process.pid});
  const ready = () => issue('ready');
  const close = () => {
    if (closePromise) return closePromise;
    const started = Date.now();
    const rejected = error => {
      // Only fixed categories cross the launcher boundary; never error text or cause.
      const stages = {
        K_SHUTDOWN_RPC_TIMEOUT: 'owner-rpc',
        K_SHUTDOWN_RESOURCE_FAILURE: 'owner-resources',
        K_SHUTDOWN_DISCONNECTED: 'owner-rpc'
      };
      const code = Object.hasOwn(stages, error?.code) ? error.code : 'K_SHUTDOWN_UNCONFIRMED';
      emit({
        type: 'closed',
        confirmed: false,
        pid: process.pid,
        diagnostic: {stage: stages[code] ?? 'owner-close', code, elapsedMs: Math.max(0, Date.now() - started)}
      });
      closing = false;
      closePromise = null;
      return {closed: false};
    };
    closePromise = (async () => {
      closing = true;
      try {
        await app.close();
        emit({type: 'closed', confirmed: true, pid: process.pid});
        onExit(0);
        resolveDone({closed: true});
        lines.close();
        return {closed: true};
      } catch (error) {
        return rejected(error);
      }
    })().catch(rejected);
    return closePromise;
  };
  lines.on('line', line => {
    if (line === 'open' && !closing) {
      Promise.resolve(onOpen?.())
        .then(() => issue('open'))
        .catch(() => emit({type: 'error', code: 'native-open-failed'}));
    } else if (line === 'close') void close();
    else emit({event: 'error', code: 'unknown-command'});
  });
  lines.once('close', () => {
    if (!closing) void close();
  });
  if (autoReady) ready();
  return {done, close, ready};
}
