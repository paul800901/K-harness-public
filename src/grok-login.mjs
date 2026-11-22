import {spawn} from 'node:child_process';
import {logoutCommand} from './logout-command.mjs';
import {mobileLoginUrl} from '../shared/mobile-login-url.mjs';
import {createNativeLoginProcess} from './native-login-process.mjs';
import {
  openGrokAgent,
  grokEnvironment,
  grokExecutable,
  grokHome,
  ensureGrokHome,
  grokModelsFrom,
  grokQuotaFrom
} from './grok-acp.mjs';

const CATALOG_MS = 5 * 60 * 1000;

// Authentication belongs to grok (auth.x.ai OAuth, tokens in this K-only GROK_HOME).
// K never reads auth.json; it asks grok over ACP whether the subscription is signed in.
export function createGrokLogin({
  cwd,
  env = process.env,
  executable,
  open = openGrokAgent,
  spawnImpl = spawn,
  execImpl
} = {}) {
  const binary = grokExecutable(env, executable),
    home = grokHome(cwd, env),
    childEnv = grokEnvironment(env, home);
  let catalog = null,
    catalogAt = 0,
    loggingOut = null,
    statusPending = null;
  const loginProcess = createNativeLoginProcess({
    name: 'Grok',
    spawnImpl,
    onComplete() {
      catalog = null;
    },
    parse(text) {
      for (const match of text.matchAll(/https:\/\/[^\s\x1b]+(?=[\s\x1b])/g)) {
        const device = mobileLoginUrl('grok', match[0]);
        if (device) {
          const userCode = new URL(device).searchParams.get('user_code');
          if (/^[A-Za-z0-9-]{4,32}$/.test(userCode ?? '')) return {url: device, userCode};
        }
        try {
          const url = new URL(match[0]);
          if (url.protocol === 'https:' && url.hostname === 'auth.x.ai' && !url.port && !url.username && !url.password)
            return {url: url.href};
        } catch {}
      }
    }
  });
  async function inspect() {
    if (!binary) throw Error('找不到 Grok Build；請在設定頁按 Grok「更新」下載官方核心，重開 K 後再登入。');
    await ensureGrokHome(home);
    const agent = await open({executable: binary, env: childEnv, cwd: home});
    try {
      const checkedAt = new Date().toISOString();
      const models = grokModelsFrom(agent.initialize),
        version = agent.initialize?._meta?.agentVersion ?? null;
      let subscription = null,
        billing = null;
      try {
        subscription = await agent.request('_x.ai/auth/check_subscription', {});
        if (typeof subscription?.authenticated !== 'boolean') throw Error('官方未回報可確認的登入狀態。');
      } catch (error) {
        return {
          installed: true,
          available: false,
          version,
          models,
          auth: {status: 'unknown', checkedAt},
          reason: `無法確認 Grok 登入：${error.message}`
        };
      }
      if (subscription?.authenticated !== true)
        return {
          installed: true,
          available: false,
          version,
          models,
          auth: {status: 'signed-out', loggedIn: false, checkedAt},
          reason: '尚未登入 Grok 訂閱，請按「登入 Grok」由本人完成官方登入。'
        };
      try {
        billing = await agent.request('_x.ai/billing', {});
      } catch {}
      const plan = subscription.meta?.subscription_tier ?? billing?.subscription_tier ?? null;
      catalog = models;
      catalogAt = Date.now();
      return {
        installed: true,
        available: true,
        version,
        models,
        plan,
        auth: {status: 'authenticated', loggedIn: true, checkedAt},
        ...(billing ? {quota: grokQuotaFrom(billing, checkedAt)} : {}),
        reason: `已登入 Grok 訂閱${plan ? `（${plan}）` : ''}，官方查詢成功。`
      };
    } finally {
      await agent.close().catch(() => {});
    }
  }
  return {
    home,
    executable: binary,
    async status() {
      if (loggingOut) await loggingOut.catch(() => {});
      statusPending ??= inspect()
        .catch(error => ({installed: !!binary, available: false, models: [], reason: error.message}))
        .finally(() => {
          statusPending = null;
        });
      return statusPending;
    },
    // The official catalog from grok's initialize; refreshed at most every five minutes.
    async models() {
      if (catalog && Date.now() - catalogAt < CATALOG_MS) return catalog;
      const result = await this.status();
      if (!result.available) throw Error(result.reason);
      return result.models;
    },
    progress() {
      return {...loginProcess.progress(), status: loginProcess.running || loggingOut ? 'pending' : 'idle'};
    },
    cancel: () => loginProcess.cancel(),
    close: () => loginProcess.close(),
    async logout() {
      if (loginProcess.running || loggingOut) throw Error('Grok 登入或登出正在進行，請稍候。');
      if (!binary) throw Error('找不到 Grok Build。');
      loggingOut = (async () => {
        if (statusPending) await statusPending;
        await ensureGrokHome(home);
        catalog = null;
        catalogAt = 0;
        await logoutCommand(binary, ['logout'], {cwd: home, env: childEnv, execImpl, name: 'Grok'});
        const result = await inspect();
        if (result.auth?.loggedIn !== false) throw Error('Grok 登出後狀態尚未確認，請刷新狀態；未重試。');
        return result;
      })();
      try {
        return await loggingOut;
      } finally {
        loggingOut = null;
      }
    },
    // Human-requested: grok opens the official auth.x.ai page in the default browser and
    // receives the callback itself. K does not read the code, cookies or tokens.
    async start({remote = false} = {}) {
      if (loggingOut) throw Error('Grok 正在登出，請稍候。');
      if (!binary) throw Error('找不到 Grok Build；請在設定頁按 Grok「更新」下載官方核心，重開 K 後再登入。');
      return loginProcess.start(async () => {
        await ensureGrokHome(home);
        if (loggingOut) throw Error('Grok 正在登出，請稍候。');
        return {command: binary, args: ['login', remote ? '--device-auth' : '--oauth'], cwd: home, env: childEnv};
      });
    }
  };
}
