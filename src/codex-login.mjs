import {CODEX_NOT_INSTALLED, openCodexHost} from './codex-host.mjs';
import {authExpired, clearAuthExpired} from './auth-expiry.mjs';
import {mobileLoginUrl} from '../shared/mobile-login-url.mjs';

// The official runtime owns credentials and its OAuth callback. Only safe status
// and the official authorization URL cross the local UI boundary.
export function createCodexLogin({cwd, executable, hostFactory = openCodexHost} = {}) {
  let host = null,
    loginId = null,
    login = {status: 'idle'},
    queue = Promise.resolve(),
    starting = 0,
    closed = false;
  const serial = work => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const release = async () => {
    const current = host;
    await current?.close();
    if (host === current) {
      host = null;
      loginId = null;
    }
  };
  const connect = async () => {
    if (host) return host;
    const current = hostFactory({
      cwd,
      executable,
      onEvent: event => {
        if (host === current && event.method === 'account/login/completed' && event.params?.loginId === loginId) {
          login = {status: event.params.success ? 'complete' : 'error'};
          if (event.params.success) clearAuthExpired('codex');
        }
      }
    });
    host = current;
    current.closed?.then(() => {
      if (host === current) {
        host = null;
        loginId = null;
        if (login.status === 'running') login = {status: 'error'};
      }
    });
    await current.request('initialize', {clientInfo: {name: 'k_harness_login', version: '0.1.0'}});
    current.notify({method: 'initialized', params: {}});
    return current;
  };
  const read = async () => {
    const result = await (await connect()).request('account/read', {refreshToken: false});
    if (!result || !Object.hasOwn(result, 'account')) throw Error('Codex 未回報可確認的登入狀態。');
    const {account} = result;
    const verified = account?.type === 'chatgpt';
    // A stored login whose tokens failed to refresh in a turn still appears here.
    if (verified && authExpired('codex'))
      return {
        available: false,
        auth: {loggedIn: true, authMethod: 'chatgpt', planType: null, expired: true},
        reason: 'K 先前偵測到 GPT 登入失效（原生核心無法更新登入權杖），尚未確認恢復；請重新登入 GPT 訂閱。'
      };
    return {
      available: verified,
      auth: {
        loggedIn: !!account,
        authMethod: verified ? 'chatgpt' : null,
        planType: verified ? (account.planType ?? null) : null
      },
      ...(!verified
        ? {reason: account ? '目前不是 ChatGPT 訂閱登入；K 不會改走 API 計費。' : '尚未登入 GPT 訂閱，請完成官方登入。'}
        : {})
    };
  };
  return {
    // A sign-in being set up already counts as running, before the official URL exists.
    progress: () => ({login: starting ? {...login, status: 'running'} : {...login}}),
    status: () =>
      serial(async () => {
        try {
          if (closed) throw new Error();
          return {...(await read()), login: {...login}};
        } catch (error) {
          return {available: false, reason: error.message === CODEX_NOT_INSTALLED ? CODEX_NOT_INSTALLED : '無法讀取 Codex 登入狀態。', login: {...login}};
        } finally {
          if (login.status !== 'running') await release();
        }
      }),
    start: ({remote = false} = {}) => {
      starting++;
      return serial(async () => {
        try {
          if (closed) throw new Error();
          const status = await read();
          if (status.available || login.status === 'running') return {...status, login: {...login}};
          const result = await host.request('account/login/start', {type: remote ? 'chatgptDeviceCode' : 'chatgpt'});
          loginId = result.loginId;
          const url = new URL(remote ? result.verificationUrl : result.authUrl);
          if (
            result.type !== (remote ? 'chatgptDeviceCode' : 'chatgpt') ||
            !loginId ||
            url.protocol !== 'https:' ||
            url.hostname !== 'auth.openai.com' ||
            url.username ||
            url.password ||
            url.port ||
            (remote && (!mobileLoginUrl('codex', url.href) || !/^[A-Za-z0-9-]{4,32}$/.test(result.userCode ?? '')))
          )
            throw new Error();
          login = {status: 'running', url: url.href, ...(remote ? {userCode: result.userCode} : {})};
          return {...status, login: {...login}};
        } catch {
          login = {status: 'error'};
          return {available: false, login: {...login}};
        } finally {
          if (login.status !== 'running') await release();
        }
      }).finally(() => starting--);
    },
    cancel: () =>
      serial(async () => {
        try {
          if (host && loginId) await host.request('account/login/cancel', {loginId});
        } finally {
          login = {status: 'idle'};
          await release();
        }
        return {login: {...login}};
      }),
    logout: () =>
      serial(async () => {
        if (closed || login.status === 'running') throw Error('GPT 登入正在進行或已關閉，請先完成或停止。');
        try {
          await (await connect()).request('account/logout');
          const status = await read();
          if (status.auth.loggedIn) throw Error('GPT 登出後狀態尚未確認，請刷新狀態；未重試。');
          clearAuthExpired('codex');
          login = {status: 'idle'};
          return {...status, login: {...login}};
        } finally {
          await release();
        }
      }),
    close: () =>
      serial(async () => {
        closed = true;
        login = {status: 'idle'};
        await release();
      })
  };
}
