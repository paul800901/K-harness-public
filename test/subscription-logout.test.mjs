import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {createClaudeLogin} from '../src/claude-login.mjs';
import {createCodexLogin} from '../src/codex-login.mjs';
import {createGrokLogin} from '../src/grok-login.mjs';
import {startDesktop} from '../src/desktop-server.mjs';
import {remoteRouteAllowed} from '../src/remote-access.mjs';
import {scratchBase} from './scratch.mjs';

test('Claude logout uses the isolated native command, verifies sign-out and never exposes native output', async () => {
  const calls = [],
    invalidations = [];
  let resolveLogout,
    signedOut = false;
  const login = createClaudeLogin({
    cwd: scratchBase,
    env: {CLAUDE_CONFIG_DIR: 'test-only', ANTHROPIC_API_KEY: 'SECRET'},
    resolve: async () => ({command: 'official-claude', argsPrefix: ['prefix']}),
    execImpl: async (command, args, options) => {
      calls.push({command, args, options});
      await new Promise(resolve => {
        resolveLogout = resolve;
      });
      signedOut = true;
      return {stdout: 'SECRET', stderr: 'SECRET'};
    },
    inspect: async () => ({
      available: !signedOut,
      auth: {loggedIn: !signedOut, authMethod: signedOut ? 'none' : 'claude.ai'}
    }),
    invalidate: () => invalidations.push(true)
  });
  const pending = login.logout();
  await new Promise(setImmediate);
  assert.equal(login.progress().login.status, 'running');
  await assert.rejects(login.start(), /正在登出/);
  await assert.rejects(login.logout(), /正在進行/);
  resolveLogout();
  const result = await pending;
  assert.equal(result.auth.loggedIn, false);
  assert.equal(result.login.status, 'idle');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(calls[0].args, ['prefix', '--setting-sources', '', 'auth', 'logout']);
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, 'test-only');
  assert.equal('ANTHROPIC_API_KEY' in calls[0].options.env, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls.length, 1);
  assert.ok(invalidations.length >= 2);
});

test('failed or unconfirmed native Claude logout never claims sign-out or retries', async () => {
  for (const mode of ['error', 'still-signed-in']) {
    let calls = 0;
    const login = createClaudeLogin({
      resolve: async () => ({command: 'fake', argsPrefix: []}),
      execImpl: async () => {
        calls++;
        if (mode === 'error') throw Error('SECRET');
      },
      inspect: async () => ({available: true, auth: {loggedIn: true}})
    });
    await assert.rejects(
      login.logout(),
      error => !error.message.includes('SECRET') && /未確認|尚未確認/.test(error.message)
    );
    assert.equal(calls, 1);
    assert.equal((await login.status()).auth.loggedIn, true);
  }
});

test('Codex logout uses account/logout, confirms no account, and releases only the login host', async () => {
  let account = {type: 'chatgpt'},
    closes = 0;
  const calls = [];
  const login = createCodexLogin({
    hostFactory: () => ({
      closed: new Promise(() => {}),
      notify() {},
      async close() {
        closes++;
      },
      async request(method) {
        calls.push(method);
        if (method === 'account/logout') account = null;
        if (method === 'account/read') return {account};
        return {};
      }
    })
  });
  const result = await login.logout();
  assert.equal(result.auth.loggedIn, false);
  assert.deepEqual(calls, ['initialize', 'account/logout', 'account/read']);
  assert.equal(closes, 1);
  await login.close();
});

test('missing native account fields never count as confirmed logout', async () => {
  const codex = createCodexLogin({
    hostFactory: () => ({
      closed: new Promise(() => {}),
      notify() {},
      async close() {},
      async request() {
        return {};
      }
    })
  });
  await assert.rejects(codex.logout(), /未回報/);
  const claude = createClaudeLogin({
    resolve: async () => ({command: 'fake', argsPrefix: []}),
    execImpl: async () => {},
    inspect: async () => ({available: false, auth: {loggedIn: false, authMethod: 'unknown'}})
  });
  await assert.rejects(claude.logout(), /尚未確認/);
  const cwd = await mkdtemp(path.join(scratchBase, 'unknown-logout-grok-'));
  const grok = createGrokLogin({
    cwd,
    executable: 'fake',
    execImpl: async () => {},
    open: async () => ({
      initialize: {},
      async close() {},
      async request() {
        return {};
      }
    })
  });
  await assert.rejects(grok.logout(), /尚未確認/);
});

test('Grok logout invalidates catalog and confirms subscription sign-out in its K-only home', async () => {
  const cwd = await mkdtemp(path.join(scratchBase, 'logout-grok-'));
  let authenticated = true,
    resolveLogout;
  const calls = [];
  const login = createGrokLogin({
    cwd,
    executable: 'fake-grok',
    env: {XAI_API_KEY: 'SECRET'},
    open: async () => ({
      initialize: {},
      async close() {},
      async request(method) {
        return method === '_x.ai/auth/check_subscription' ? {authenticated} : {};
      }
    }),
    execImpl: async (command, args, options) => {
      calls.push({command, args, options});
      await new Promise(resolve => {
        resolveLogout = resolve;
      });
      authenticated = false;
    }
  });
  await login.status();
  const pending = login.logout();
  while (!resolveLogout) await new Promise(setImmediate);
  await assert.rejects(login.start(), /正在登出/);
  resolveLogout();
  assert.equal((await pending).auth.loggedIn, false);
  assert.deepEqual(calls[0].args, ['logout']);
  assert.equal(calls[0].options.env.GROK_HOME, path.join(cwd, 'agent-home', 'grok'));
  assert.equal('XAI_API_KEY' in calls[0].options.env, false);
  assert.equal(calls.length, 1);
});

test('all four logout routes require the local human session, empty body and controller idle reservation', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'logout-http-'));
  const calls = [];
  const service = provider => ({
    progress: () => ({}),
    async logout() {
      calls.push(provider);
      return {available: false, auth: {loggedIn: false}};
    },
    async close() {}
  });
  const app = await startDesktop({
    root,
    port: 0,
    controllerFactory: () => ({
      state: {},
      async close() {},
      async withAccountChange(provider, change) {
        calls.push(`lock:${provider}`);
        return change();
      }
    }),
    codexLoginFactory: () => service('codex'),
    claudeLoginFactory: () => service('claude'),
    grokLoginFactory: () => service('grok'),
    geminiAccounts: service('gemini')
  });
  try {
    const boot = await fetch(app.createLaunchUrl(), {redirect: 'manual'});
    const Cookie = boot.headers.get('set-cookie').split(';')[0];
    const headers = {Cookie, 'Content-Type': 'application/json', 'X-K-Request': '1'};
    for (const provider of ['codex', 'claude', 'grok', 'gemini']) {
      const route = provider === 'gemini' ? '/api/gemini/accounts/logout' : `/api/${provider}/logout`;
      assert.equal(remoteRouteAllowed('POST', route), true);
      assert.equal(
        (
          await fetch(app.origin + route, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-K-Request': '1'},
            body: '{}'
          })
        ).status,
        403
      );
      assert.equal(
        (
          await fetch(app.origin + route, {
            method: 'POST',
            headers: {...headers, Origin: 'https://evil.test'},
            body: '{}'
          })
        ).status,
        403
      );
      assert.equal((await fetch(app.origin + route, {method: 'POST', headers, body: '{"extra":true}'})).status, 400);
      assert.equal((await fetch(app.origin + route, {method: 'POST', headers, body: '{}'})).status, 200);
    }
    assert.deepEqual(calls, [
      'lock:codex',
      'codex',
      'lock:claude',
      'claude',
      'lock:grok',
      'grok',
      'lock:gemini',
      'gemini'
    ]);
  } finally {
    await app.close();
  }
});
