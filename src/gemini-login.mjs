import path from 'node:path';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {antigravityModelNames} from '../shared/antigravity-models.mjs';
import {mobileLoginUrl} from '../shared/mobile-login-url.mjs';
import {createNativeLoginProcess} from './native-login-process.mjs';
import {
  geminiExecutable,
  geminiEnvironment,
  geminiSettings,
  geminiProcess,
  geminiOutcome,
  killGeminiTree
} from './gemini-worker.mjs';

const exec = promisify(execFile);
export function geminiQuotaWindows(text = '') {
  const periods = {
    'Weekly Limit Remaining': {key: 'seven_day', label: '每週', minutes: 10080},
    'Five Hour Limit Remaining': {key: 'five_hour', label: '5 小時', minutes: 300}
  };
  return text.split(/\r?\n/u).flatMap(line => {
    const [group, label, remaining, reset] = line.split('\t'),
      period = periods[label];
    if (group === 'Gemini Models' && period && remaining === 'disabled')
      return [{...period, disabled: true, remainingPercent: null, resetsAt: null}];
    const percent =
        typeof remaining === 'string' && /^\d+(?:\.\d+)?%$/u.test(remaining) ? Number(remaining.slice(0, -1)) : NaN,
      resetsAt = Date.parse(reset) / 1000;
    return group === 'Gemini Models' && period && Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? [{...period, remainingPercent: percent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null}]
      : [];
  });
}
// Authentication belongs to agy and Windows. A model catalog is not proof of login.
export function createGeminiLogin({
  cwd,
  env = process.env,
  executable,
  run = geminiProcess,
  execImpl = exec,
  processAlive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  },
  spawnImpl,
  killTree = killGeminiTree,
  exists = access
} = {}) {
  const binary = geminiExecutable(env, executable),
    home = path.join(cwd, 'agent-home', 'gemini', 'account');
  const childEnv = geminiEnvironment(env, home);
  const remoteLogin = createNativeLoginProcess({
    name: 'Gemini',
    spawnImpl,
    stopChild: child => killTree(child.pid, {env: childEnv}),
    parse(text) {
      for (const match of text.matchAll(/https:\/\/[^\s\x1b]+(?=[\s\x1b])/g)) {
        const url = mobileLoginUrl('gemini', match[0]);
        if (url) return {url, needsCode: true};
      }
    }
  });
  let desktopPid = null;
  const desktopRunning = () => {
    if (desktopPid && !processAlive(desktopPid)) desktopPid = null;
    return desktopPid !== null;
  };
  async function prepare() {
    if (!binary) throw Error('找不到 Antigravity（agy）；請在設定頁按 Antigravity「更新」下載官方核心（或先安裝官方 Antigravity CLI），重開 K 後再登入。');
    try {
      await exists(binary);
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('找不到 Antigravity（agy）；請在設定頁按 Antigravity「更新」下載官方核心（或先安裝官方 Antigravity CLI），重開 K 後再登入。');
      throw error;
    }
    const settings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    await mkdir(path.dirname(settings), {recursive: true});
    // Only initialize a new profile. Refreshing must preserve native onboarding,
    // theme and data-sharing choices made by the user in the official program.
    try {
      await writeFile(settings, JSON.stringify(geminiSettings(home, 'read-only')), {flag: 'wx'});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // agy 1.5.3 warns on and ignores the `unsandboxed(...)` rules older K versions wrote
      // here. Drop only those; every other native choice stays as the user left it.
      let data;
      try {
        data = JSON.parse(await readFile(settings, 'utf8'));
      } catch {
        return;
      }
      let changed = false;
      for (const rules of Object.values(data?.permissions ?? {}))
        if (Array.isArray(rules))
          for (let i = rules.length - 1; i >= 0; i--)
            if (typeof rules[i] === 'string' && rules[i].startsWith('unsandboxed(')) {
              rules.splice(i, 1);
              changed = true;
            }
      if (changed) await writeFile(settings, `${JSON.stringify(data, null, 2)}\n`);
    }
  }
  return {
    progress: remoteLogin.progress,
    get running() {
      return remoteLogin.running || desktopRunning();
    },
    submitCode: data => remoteLogin.submitCode(data),
    async cancel() {
      if (desktopRunning()) throw Object.assign(Error('請先關閉官方 Antigravity 視窗，再取消這次登入。'), {statusCode: 409});
      return remoteLogin.cancel();
    },
    close: () => remoteLogin.close(),
    async status({checkAuth = true} = {}) {
      let installed = false;
      try {
        await prepare();
        installed = true;
        const options = {cwd: home, env: childEnv, timeoutMs: 30000};
        const version = await run(binary, ['--version'], options);
        if (version.code !== 0 || version.reason || version.cleanupError)
          throw Error('無法確認 Antigravity CLI 版本。');
        const base = {installed: true, available: true, version: version.stdout.trim(), models: []};
        if (!checkAuth) {
          const catalog = await run(binary, ['models'], options);
          if (catalog.code !== 0 || catalog.reason || catalog.cleanupError)
            throw Error(geminiOutcome({}, {...catalog, stderr: `${catalog.stdout}\n${catalog.stderr}`}).error);
          return {
            ...base,
            models: antigravityModelNames(catalog.stdout)
          };
        }
        // /usage is answered by the CLI, without a model turn. A successful account
        // quota report proves authentication; the public model catalog does not.
        let report;
        try {
          report = await run(binary, ['-p', '/usage'], options);
        } catch {
          return {...base, auth: {status: 'unknown'}, reason: '無法確認登入狀態，請稍後刷新。'};
        }
        const checkedAt = new Date().toISOString();
        const windows = geminiQuotaWindows(report.stdout);
        const confirmed =
          report.code === 0 &&
          !report.reason &&
          !report.cleanupError &&
          windows.some(w => Number.isFinite(w.remainingPercent));
        if (confirmed)
          return {
            ...base,
            auth: {status: 'authenticated', loggedIn: true, checkedAt},
            quota: {status: 'ready', checkedAt, windows},
            reason: '已登入 Antigravity 訂閱，官方帳號查詢成功。'
          };
        const diagnostic = `${report.stdout}\n${report.stderr}`;
        const temporaryFailure =
          !report.cleanupError &&
          (report.reason === 'timeout' ||
            /\bcode 503\b|\b503 Service Unavailable\b|\bnetwork timeout\b/iu.test(diagnostic));
        const signedOut =
          !temporaryFailure &&
          !report.reason &&
          !report.cleanupError &&
          /authentication required|not (?:logged|signed) in|unauthenticated|login required|please (?:log|sign) in/iu.test(
            diagnostic
          );
        return {
          ...base,
          temporaryFailure,
          auth: {status: signedOut ? 'signed-out' : 'unknown', ...(signedOut ? {loggedIn: false} : {}), checkedAt},
          reason: temporaryFailure
            ? 'Google 額度查詢暫時失敗或逾時；這不代表帳號已登出。'
            : signedOut
              ? '尚未登入 Gemini，請完成官方登入。'
              : '無法確認 Gemini 狀態，請稍後刷新；尚無證據需要重新登入。'
        };
      } catch (error) {
        return {
          installed,
          available: false,
          models: [],
          ...(/未登入/u.test(error.message) ? {auth: {status: 'signed-out', loggedIn: false}} : {}),
          reason: error.message
        };
      }
    },
    async logout() {
      if (this.running) throw Error('請先完成或取消登入。');
      await prepare();
      const result = await run(binary, ['-p', '/logout'], {cwd: home, env: childEnv, timeoutMs: 30000});
      if (result.code !== 0 || result.reason || result.cleanupError || (await this.status()).auth?.status !== 'signed-out')
        throw Error('尚未確認登出，請在官方 Antigravity 輸入 /logout，再回 K 刷新狀態。');
      return {installed: true, auth: {status: 'signed-out', loggedIn: false}};
    },
    async start({remote = false} = {}) {
      if (desktopRunning()) throw Error('請先關閉已開啟的官方 Antigravity 視窗。');
      if (remote)
        return remoteLogin.start(async () => {
          await prepare();
          return {
            command: binary,
            args: ['acp', '--login'],
            cwd: home,
            env: {
              ...childEnv,
              SSH_CONNECTION: '127.0.0.1 12345 127.0.0.1 22',
              SSH_TTY: 'k-remote',
              NO_COLOR: '1',
              TERM: 'dumb'
            }
          };
        });
      if (remoteLogin.running) throw Error('手機登入正在進行，請先完成或取消。');
      await remoteLogin.cancel();
      await prepare();
      // Human-requested interactive console. agy itself opens the official browser
      // OAuth flow when needed; never copy Chrome cookies or capture tokens/codes.
      const {stdout} = await execImpl(
        path.join(env.SystemRoot ?? env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference='Stop'; (Start-Process -FilePath $env:K_AGY_LOGIN_EXECUTABLE -WorkingDirectory $env:HOME -WindowStyle Normal -PassThru).Id"
        ],
        {
          cwd: home,
          env: {...childEnv, K_AGY_LOGIN_EXECUTABLE: binary},
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 4096
        }
      );
      const pid = Number(stdout?.trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('尚未取得官方登入視窗的程序識別，請先確認並關閉該視窗。');
      desktopPid = pid;
      return {
        login: {status: 'opened'},
        reason: '已開啟官方 Antigravity。請依畫面完成登入，關閉該視窗後回到 K 確認。'
      };
    }
  };
}
