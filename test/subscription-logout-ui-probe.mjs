// Built UI and fake native account APIs only; never touches a real provider login.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {preview} from 'vite';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';

const output = probeEvidenceDir('subscription-logout');
await mkdir(output, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 5293, strictPort: true}});
let browser;
try {
  browser = await launchProbeBrowser();
  for (const [width, remote] of [
    [1440, false],
    [390, false],
    [360, true],
    [390, true]
  ]) {
    const page = await browser.newPage({viewport: {width, height: 1000}});
    const signedIn = {codex: true, claude: true, grok: true, gemini: true},
      posts = [],
      errors = [],
      commands = [],
      loginStates = {};
    if (remote)
      await page.route('http://127.0.0.1:5293/', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: (await response.text()).replace('<html', '<html data-k-remote="true"')});
      });
    let rejectLogout = true,
      loginPending = false;
    const state = {
      threadId: null,
      workspace: process.cwd(),
      provider: 'codex',
      status: 'idle',
      busy: false,
      messages: [],
      questions: [],
      tools: [],
      artifacts: [],
      capabilities: {},
      conversationActivity: []
    };
    const accounts = () => ({mode: 'official', enabled: true, loginPending, activeAccountId: null, accounts: []});
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(initial => {
      window.EventSource = class {
        constructor() {
          setTimeout(() => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: initial})}), 0);
        }
        close() {}
      };
    }, state);
    await page.route('**/api/**', async route => {
      const request = route.request(),
        url = new URL(request.url());
      if (request.method() === 'POST') {
        posts.push(url.pathname);
        if (remote) {
          assert.equal(request.headers()['x-k-request'], '1');
          const command = request.headers()['x-k-command'];
          assert.match(command, /^[a-f0-9-]{36}$/);
          assert.ok(!commands.includes(command));
          commands.push(command);
        }
      }
      if (url.pathname.endsWith('/logout')) {
        if (rejectLogout) return route.fulfill({status: 409, json: {error: '還有工作，請等結束後再登出。'}});
        const provider = url.pathname.split('/')[2];
        signedIn[provider] = false;
        return route.fulfill({
          json:
            provider === 'gemini' ? accounts() : {available: false, auth: {loggedIn: false}, login: {status: 'idle'}}
        });
      }
      let body = {};
      if (url.pathname === '/api/state') body = state;
      else if (url.pathname === '/api/sessions') body = {sessions: []};
      else if (url.pathname === '/api/projects') body = {projects: []};
      else if (url.pathname === '/api/models') body = {models: []};
      else if (url.pathname === '/api/gemini/accounts') body = accounts();
      else if (url.pathname === '/api/gemini/accounts/login') {
        loginPending = true;
        loginStates.gemini = {
          status: 'running',
          url: 'https://accounts.google.com/o/oauth2/auth?state=FAKE',
          needsCode: true
        };
        body = accounts();
      } else if (url.pathname === '/api/gemini/accounts/code') {
        assert.equal(request.postDataJSON().code, '4/FAKE-GOOGLE-CODE');
        loginStates.gemini = {status: 'complete'};
        body = accounts();
      } else if (url.pathname === '/api/gemini/accounts/finish') {
        loginPending = false;
        signedIn.gemini = true;
        body = accounts();
      } else if (url.pathname === '/api/gemini/login') {
        body = {login: loginStates.gemini ?? {status: 'idle'}};
      } else if (url.pathname === '/api/claude/login/code') {
        assert.equal(request.postDataJSON().code, 'FAKE-CLAUDE-CODE#FAKE-STATE');
        loginStates.claude = {status: 'complete'};
        signedIn.claude = true;
        body = {login: loginStates.claude};
      } else if (url.pathname.endsWith('/login/cancel')) {
        const provider = url.pathname.split('/')[2];
        loginStates[provider] = {status: 'idle'};
        body = {login: loginStates[provider]};
      } else if (/^\/api\/(codex|claude|grok|gemini)\/auth$/.test(url.pathname)) {
        const provider = url.pathname.split('/')[2];
        body = {
          available: signedIn[provider],
          installed: true,
          auth: {
            loggedIn: signedIn[provider],
            authMethod: provider === 'codex' ? 'chatgpt' : 'claude.ai',
            apiProvider: 'firstParty',
            subscriptionType: 'pro'
          },
          login: loginStates[provider] ?? {status: 'idle'}
        };
      } else if (/^\/api\/(codex|claude)\/login$/.test(url.pathname)) {
        if (request.method() === 'POST')
          loginStates[url.pathname.split('/')[2]] = {
            status: 'running',
            url: url.pathname.includes('codex')
              ? remote
                ? 'https://auth.openai.com/codex/device'
                : 'https://auth.openai.com/oauth/authorize?state=fake'
              : 'https://claude.ai/oauth/authorize?state=fake',
            ...(remote && url.pathname.includes('codex') ? {userCode: 'CODEX-TEST'} : {})
          };
        body = {login: loginStates[url.pathname.split('/')[2]]};
      } else if (url.pathname === '/api/grok/login') {
        if (request.method() === 'POST')
          loginStates.grok = {
            status: 'running',
            url: 'https://accounts.x.ai/oauth2/device?user_code=GROK-TEST',
            userCode: 'GROK-TEST'
          };
        body = {login: loginStates.grok ?? {status: 'idle'}};
      }
      await route.fulfill({json: body});
    });
    await page.goto('http://127.0.0.1:5293');
    if (width < 700) await page.getByRole('button', {name: '展開側欄', exact: true}).click();
    await page.getByRole('button', {name: '設定', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: '設定', exact: true});
    const names = {codex: '登出 GPT / Codex', claude: '登出 Claude', grok: '登出 Grok', gemini: '登出 Gemini'};
    for (const name of Object.values(names)) await dialog.getByRole('button', {name, exact: true}).waitFor();
    await dialog.getByRole('button', {name: names.claude, exact: true}).click();
    await dialog.getByText('還有工作，請等結束後再登出。', {exact: true}).waitFor();
    assert.equal(signedIn.claude, true);
    await page.screenshot({path: path.join(output, `connected-${width}-${remote}.png`)});
    rejectLogout = false;
    for (const [provider, name] of Object.entries(names)) {
      const button = dialog.getByRole('button', {name, exact: true});
      const rect = await button.boundingBox();
      assert.ok(rect.width > 40 && rect.x >= 0 && rect.x + rect.width <= width, name + ' fits viewport');
      await button.click();
      await button.waitFor({state: 'detached'});
      assert.equal(signedIn[provider], false);
    }
    assert.equal(
      await dialog.getByText('saved@example.test', {exact: true}).count(),
      0,
      'Public Gemini login uses no saved account'
    );
    await page.screenshot({path: path.join(output, `signed-out-${width}-${remote}.png`)});
    for (const name of ['登入 GPT / Codex', '登入 Claude 訂閱', '登入 Grok', '開啟官方登入'])
      assert.equal(await dialog.getByRole('button', {name, exact: true}).isEnabled(), true);
    await dialog.getByRole('button', {name: '登入 GPT / Codex', exact: true}).click();
    await dialog.getByRole('button', {name: '登入 Claude 訂閱', exact: true}).click();
    await dialog.getByLabel('Claude 官方授權碼', {exact: true}).waitFor();
    await dialog.getByRole('button', {name: '登入 Grok', exact: true}).click();
    await dialog.getByRole('button', {name: '開啟官方登入', exact: true}).click();
    await dialog.getByRole('button', {name: '確認登入', exact: true}).waitFor();
    for (const route of ['/api/codex/login', '/api/claude/login', '/api/grok/login', '/api/gemini/accounts/login'])
      assert.equal(posts.filter(item => item === route).length, 1, route);
    if (remote) {
      assert.equal(await page.locator('html').getAttribute('data-k-remote'), 'true');
      await dialog.getByText('CODEX-TEST', {exact: true}).waitFor();
      await dialog.getByText('GROK-TEST', {exact: true}).waitFor();
      await dialog.getByLabel('Claude 官方授權碼', {exact: true}).fill('FAKE-CLAUDE-CODE#FAKE-STATE');
      const claudeRow = dialog
        .locator('.provider-auth-row')
        .filter({has: page.getByText('Claude 訂閱', {exact: true})});
      await claudeRow.getByRole('button', {name: '交付官方驗證', exact: true}).click();
      const google = dialog.getByLabel('Gemini 官方授權碼', {exact: true});
      await google.waitFor();
      await page.screenshot({path: path.join(output, `remote-phone-code-entry-${width}.png`)});
      await google.fill(' 4/FAKE-GOOGLE-CODE ');
      const geminiRow = dialog.locator('.gemini-account-row');
      assert.equal(await dialog.getByRole('button', {name: '確認登入', exact: true}).isDisabled(), true);
      await geminiRow.getByRole('button', {name: '交付官方驗證', exact: true}).click();
      await dialog.getByText('官方流程已結束，請確認登入狀態。', {exact: true}).waitFor();
      await dialog.getByRole('button', {name: '確認登入', exact: true}).click();
      await dialog.getByRole('button', {name: '登出 Gemini', exact: true}).waitFor();
      assert.equal(await dialog.locator('input[type=password]').count(), 0);
      assert.doesNotMatch(await page.locator('body').innerText(), /FAKE-GOOGLE-CODE|FAKE-CLAUDE-CODE/);
      await page.screenshot({path: path.join(output, `remote-phone-auth-${width}.png`)});
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    JSON.stringify({
      passed: true,
      fourProviders: true,
      widths: [1440, 390],
      rejectionPreservesLogin: true,
      officialSessionOnly: true,
      output
    })
  );
} finally {
  await browser?.close();
  await server.httpServer.close();
}
