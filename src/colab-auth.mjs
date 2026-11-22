// Colab authorization for K (OAuth 2.0 installed-app flow with PKCE, scope
// https://www.googleapis.com/auth/colaboratory per the official REST reference
// and the MCP protected-resource metadata; openid/email only to confirm which
// Google account consented). Google remote MCP servers do not support dynamic
// client registration, so the owner supplies their own OAuth "Desktop app"
// client file. K only opens the official consent URL in the default browser; the
// owner signs in and consents. The client secret and refresh token never enter
// Node: scripts/colab-credentials.ps1 keeps them (Windows Credential Manager).

import {execFile} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const helperPath = fileURLToPath(new URL('../scripts/colab-credentials.ps1', import.meta.url));
const SCOPES = 'https://www.googleapis.com/auth/colaboratory openid email';
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const HELPER_ERRORS = {
  client_missing: '尚未放入 Colab OAuth 用戶端檔',
  client_invalid: 'Colab OAuth 用戶端檔格式無效（需為 Google Cloud「電腦版應用程式」用戶端 JSON）',
  invalid_client: 'Google 拒絕此 OAuth 用戶端（invalid_client）',
  unauthorized_client: 'Google 不允許此 OAuth 用戶端（unauthorized_client）',
  access_denied: '授權被拒絕',
  invalid_grant: '授權碼或登入已失效',
  token_failed: '向 Google 換發權杖失敗',
  token_incomplete: 'Google 未回傳完整權杖',
  id_token_invalid: '無法確認授權的 Google 帳號',
  input_invalid: '授權回呼內容無效',
  credential: 'Windows 憑證管理員操作失敗',
  unknown: 'Colab 授權 helper 失敗'
};

export function colabAuthFailure(message) {
  const error = new Error(message);
  error.code = 'k_selfhost_colab_signin';
  error.definitive = true;
  return error;
}

export function createColabAuth({
  root,
  account = null,
  openUrl,
  env = process.env,
  execImpl = promisify(execFile),
  clock = Date.now
}) {
  const clientFile = path.join(root, '.runtime', 'colab-oauth-client.json');
  const namespace = createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 32);
  const powershell = path.join(
    env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  let cached = null, // {token, expiresAt, email}
    known = {signedIn: null, email: null},
    login = null,
    loginTimer = null,
    opening = false,
    closed = false,
    pending = Promise.resolve();

  async function helper(operation, input) {
    const run = pending.then(async () => {
      let stdout;
      try {
        const child = execImpl(
          powershell,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'RemoteSigned',
            '-File',
            helperPath,
            '-Operation',
            operation,
            '-Namespace',
            namespace,
            '-ClientFile',
            clientFile
          ],
          {windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024}
        );
        if (input !== undefined) child.child?.stdin?.end(JSON.stringify(input));
        else child.child?.stdin?.end();
        ({stdout} = await child);
      } catch (error) {
        stdout = error?.stdout;
      }
      let value;
      try {
        value = JSON.parse(String(stdout ?? '').trim());
      } catch {
        value = {error: 'unknown'};
      }
      return value && typeof value === 'object' ? value : {error: 'unknown'};
    });
    pending = run.catch(() => {});
    return run;
  }
  const remember = value => {
    if (typeof value.accessToken !== 'string' || !value.accessToken || !Number.isFinite(value.expiresIn))
      throw colabAuthFailure('Colab 授權 helper 回傳無效；未呼叫 Colab。');
    known = {signedIn: true, email: typeof value.email === 'string' ? value.email : null};
    cached = {token: value.accessToken, expiresAt: clock() + value.expiresIn * 1000, email: known.email};
    return cached.token;
  };
  const closedFailure = () => colabAuthFailure('K 正在關閉；未開啟授權頁。');
  const mismatch = email => account && String(email ?? '').toLowerCase() !== account.toLowerCase();

  async function finishLogin({code, verifier, redirectUri}) {
    // After K closed this connection a late callback is never exchanged or saved.
    if (closed) return {ok: false, message: 'K 已關閉此 Colab 連線；未保存任何授權。'};
    const value = await helper('exchange', {code, verifier, redirectUri, expectedAccount: account});
    // Closed during the exchange: the helper may already have saved the login for
    // a later K, but this closed connection does not take it into use.
    if (closed) return {ok: false, message: 'K 已關閉此 Colab 連線；本次不使用這個授權結果。'};
    if (value.error === 'account_mismatch') {
      known = {signedIn: false, email: null};
      return {ok: false, message: `授權的帳號 ${value.email} 不是指定的 Colab 帳號 ${account}；未保存。`};
    }
    if (value.error) return {ok: false, message: `${HELPER_ERRORS[value.error] ?? HELPER_ERRORS.unknown}；未保存。`};
    remember(value);
    return {ok: true, email: known.email};
  }

  return {
    clientFile,
    // Local only (file presence + last helper result); never calls Google.
    state() {
      if (!existsSync(clientFile)) return 'no-client';
      if (known.signedIn === false) return 'signed-out';
      if (known.signedIn === true) return 'signed-in';
      return 'unknown';
    },
    email: () => known.email,
    async refreshStatus() {
      const value = await helper('status');
      if (!value.error) known = {signedIn: value.signedIn === true, email: value.email ?? null};
      return {
        client: value.client === true,
        signedIn: known.signedIn,
        email: known.email,
        account,
        error: value.error ?? null
      };
    },
    invalidate() {
      cached = null;
    },
    // Bearer token for Colab calls; refreshed by the helper a minute before expiry.
    async accessToken() {
      if (cached && cached.expiresAt - clock() > 60000) return cached.token;
      cached = null;
      const value = await helper('access');
      if (value.error === 'signed_out') {
        known = {signedIn: false, email: null};
        throw colabAuthFailure('Colab 尚未授權（或授權已失效）；未呼叫 Colab。');
      }
      if (value.error) throw colabAuthFailure(`${HELPER_ERRORS[value.error] ?? HELPER_ERRORS.unknown}；未呼叫 Colab。`);
      if (mismatch(value.email))
        throw colabAuthFailure(`已保存的授權帳號 ${value.email} 不是指定的 ${account}；未呼叫 Colab。`);
      return remember(value);
    },
    // Opens the official consent page once and waits (bounded) for the owner.
    // Returns immediately; the caller tells the owner to send again afterwards.
    // close() may run during any await below: each one is followed by a check
    // that drops whatever this call has set up and never opens the page after it.
    async beginLogin() {
      if (closed) throw closedFailure();
      if (login || opening) return {opened: false, waiting: true};
      opening = true;
      try {
        return await openLogin();
      } finally {
        opening = false;
      }
    },
    close() {
      closed = true;
      clearTimeout(loginTimer);
      login?.close();
      login?.closeAllConnections?.();
      login = null;
    }
  };

  async function openLogin() {
    const status = await helper('status');
    if (closed) throw closedFailure();
    if (!status.client || typeof status.clientId !== 'string')
      throw colabAuthFailure(`${HELPER_ERRORS[status.error] ?? HELPER_ERRORS.client_missing}；未開啟授權頁。`);
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    let timer;
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
        response.writeHead(404).end();
        return;
      }
      const iss = url.searchParams.get('iss');
      const code = url.searchParams.get('code');
      const done = message => {
        response
          .writeHead(200, {'content-type': 'text/html; charset=utf-8'})
          .end(`<p>${message.replace(/[<>&"]/gu, c => `&#${c.charCodeAt(0)};`)}</p><p>可以關閉此頁，回到 K。</p>`);
        clearTimeout(timer);
        server.close();
        login = null;
      };
      if ((iss && iss !== 'https://accounts.google.com') || !code) {
        done('Colab 授權未完成或被拒絕；K 未保存任何授權。');
        return;
      }
      finishLogin({code, verifier, redirectUri})
        .then(result => done(result.ok ? `已授權 ${result.email}。請回到 K 再送出一次。` : result.message))
        .catch(() => done('Colab 授權保存失敗；K 未保存任何授權。'));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    if (closed) {
      server.close();
      throw closedFailure();
    }
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    timer = setTimeout(() => {
      server.close();
      login = null;
    }, LOGIN_WINDOW_MS);
    timer.unref?.();
    // From here close() stops this listener (and its window timer) itself.
    login = server;
    loginTimer = timer;
    const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [key, value] of Object.entries({
      client_id: status.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
      ...(account ? {login_hint: account} : {})
    }))
      consent.searchParams.set(key, value);
    try {
      await openUrl(consent.href);
    } catch {
      clearTimeout(timer);
      server.close();
      login = null;
      throw colabAuthFailure('無法以預設瀏覽器開啟 Google 授權頁；未保存任何授權。');
    }
    // Closed while the browser was opening: close() already stopped the listener.
    if (closed) throw colabAuthFailure('K 已關閉此 Colab 連線；授權頁可能已開啟，但 K 不再等待回呼，未保存任何授權。');
    return {opened: true, waiting: true};
  }
}
