import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {createNativeLoginProcess} from '../src/native-login-process.mjs';
import {createGeminiLogin} from '../src/gemini-login.mjs';
import {createGrokLogin} from '../src/grok-login.mjs';
import {createCodexLogin} from '../src/codex-login.mjs';
import {mobileLoginUrl} from '../shared/mobile-login-url.mjs';
import {scratchBase} from './scratch.mjs';

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.writes = [];
  child.stdin.write = (value, callback) => {
    child.writes.push(value);
    callback();
  };
  child.kill = () => {
    child.emit('close', 1);
    return true;
  };
  return child;
};
test('mobile official links reject lookalike hosts, credentials, ports and non-native paths', () => {
  for (const [provider, url] of [
    ['codex', 'https://auth.openai.com/codex/device'],
    ['grok', 'https://accounts.x.ai/oauth2/device?user_code=TEST-1234'],
    ['gemini', 'https://accounts.google.com/o/oauth2/auth?state=FAKE']
  ]) {
    assert.ok(mobileLoginUrl(provider, url));
    for (const bad of [
      url.replace('https:', 'http:'),
      url.replace('https://', 'https://user@'),
      url.replace('.com/', '.com:444/').replace('.ai/', '.ai:444/'),
      url + '#fragment',
      url + '\n',
      url.replace('.com/', '.com.evil/').replace('.ai/', '.ai.evil/')
    ])
      assert.equal(mobileLoginUrl(provider, bad), null, bad);
  }
  assert.equal(mobileLoginUrl('codex', 'https://auth.openai.com/oauth/authorize'), null);
});
test('native login keeps pending work single-flight, sends a code once and exposes no terminal output', async () => {
  const child = fakeChild();
  let starts = 0;
  const login = createNativeLoginProcess({
    name: 'Test',
    spawnImpl: () => {
      starts++;
      return child;
    },
    parse: text =>
      text.includes('READY\n') ? {url: 'https://accounts.google.com/o/oauth2/auth', needsCode: true} : null
  });
  await login.start(async () => ({}));
  await login.start(async () => {
    throw Error('must not restart');
  });
  assert.equal(starts, 1);
  await assert.rejects(login.submitCode({code: 'FAKE'}), /沒有等待/);
  child.stdout.emit('data', 'SECRET TERMINAL\nREADY\n');
  assert.doesNotMatch(JSON.stringify(login.progress()), /SECRET/);
  await assert.rejects(login.submitCode({code: 'FAKE\nSECOND'}), /單行/);
  await login.submitCode({code: '4/FAKE_CODE'});
  await assert.rejects(login.submitCode({code: '4/FAKE_CODE'}), /沒有等待/);
  assert.deepEqual(child.writes, ['4/FAKE_CODE\n']);
  assert.doesNotMatch(JSON.stringify(login.progress()), /FAKE_CODE/);
  child.emit('close', 0);
  assert.equal(login.running, false);
  assert.deepEqual(login.progress(), {login: {status: 'complete'}});
  await login.close();
});
test('failed stop retains ownership, allows another stop and never restarts an unknown child', async () => {
  const child = fakeChild();
  child.kill = () => false;
  let starts = 0;
  const login = createNativeLoginProcess({
    name: 'Test',
    parse: () => null,
    spawnImpl: () => {
      starts++;
      return child;
    }
  });
  await login.start(async () => ({}));
  await assert.rejects(login.cancel(), /尚未確認/);
  assert.equal(login.running, true);
  await login.start(async () => ({}));
  assert.equal(starts, 1);
  child.kill = () => {
    child.emit('close', 1);
    return true;
  };
  await login.cancel();
  assert.equal(login.running, false);
  assert.equal(login.progress().login.status, 'idle');
});
test('cancel during preparation prevents a late native process from opening', async () => {
  let release,
    starts = 0;
  const login = createNativeLoginProcess({
    name: 'Test',
    parse: () => null,
    spawnImpl: () => {
      starts++;
      return fakeChild();
    }
  });
  const pending = login.start(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  await login.cancel();
  release({});
  await pending;
  assert.equal(starts, 0);
  assert.equal(login.running, false);
});
test('a new start between native close and cancel completion cannot orphan another login', async () => {
  const child = fakeChild();
  let starts = 0,
    late;
  // The first child launches another request as soon as close is observed.
  const first = createNativeLoginProcess({
    name: 'Test',
    parse: () => null,
    spawnImpl: () => {
      starts++;
      return child;
    }
  });
  child.kill = () => {
    child.emit('close', 1);
    late = first.start(async () => ({}));
    return true;
  };
  await first.start(async () => ({}));
  await first.cancel();
  await late;
  assert.equal(starts, 1);
  assert.equal(first.running, false);
  assert.equal(first.progress().login.status, 'idle');
});
test('failed code write is uncertain and cannot be replayed', async () => {
  const child = fakeChild();
  child.stdin.write = (_value, callback) => callback(Error('PRIVATE'));
  const login = createNativeLoginProcess({
    name: 'Test',
    parse: () => ({url: 'https://accounts.google.com/o/oauth2/auth', needsCode: true}),
    spawnImpl: () => child
  });
  await login.start(async () => ({}));
  child.stdout.emit('data', 'ready');
  await assert.rejects(login.submitCode({code: '4/FAKE'}), /未確認.*未重送/);
  await assert.rejects(login.submitCode({code: '4/FAKE'}), /沒有等待/);
  await login.close();
});
test('Gemini phone login uses native ACP terminal authentication with isolated SSH environment', async () => {
  const child = fakeChild(),
    calls = [];
  child.pid = 123;
  const stopped = [];
  const login = createGeminiLogin({
    cwd: path.join(scratchBase, 'phone-gemini'),
    executable: 'fake-agy',
    env: {GEMINI_API_KEY: 'PRIVATE', HOME: 'human-home'},
    exists: async () => {},
    killTree: async (pid, options) => {
      stopped.push({pid, options});
      child.emit('close', 0);
    },
    execImpl: async () => {
      throw Error('must not open a desktop window');
    },
    spawnImpl: (...args) => {
      calls.push(args);
      return child;
    }
  });
  await login.start({remote: true});
  assert.deepEqual(calls[0][1], ['acp', '--login']);
  const options = calls[0][2];
  assert.equal(options.windowsHide, true);
  assert.ok(options.env.SSH_CONNECTION);
  assert.equal(options.env.GEMINI_API_KEY, undefined);
  assert.equal(options.env.HOME, path.join(scratchBase, 'phone-gemini/agent-home/gemini/account'));
  child.stdout.emit('data', 'https://accounts.google.com/o/oauth2/auth?state=FA');
  assert.equal(login.progress().login.url, undefined, 'do not publish a truncated OAuth URL');
  child.stdout.emit('data', 'KE&code_challenge=TEST\nPaste the authorization code: ');
  assert.equal(login.progress().login.needsCode, true);
  assert.match(login.progress().login.url, /state=FAKE/);
  await assert.rejects(login.start(), /手機登入/);
  await login.submitCode({code: '4/FAKE_CODE'});
  child.emit('exit', 0);
  assert.equal(login.running, true, 'root exit alone does not confirm inherited pipes have closed');
  await login.cancel();
  assert.equal(stopped[0].pid, 123);
  assert.equal(stopped[0].options.env.HOME, options.env.HOME);
  assert.equal(login.progress().login.status, 'idle');
  await login.close();
});
test('Grok phone login uses device-auth, waits for complete URL chunks and can be cancelled', async () => {
  const child = fakeChild(),
    calls = [];
  const login = createGrokLogin({
    cwd: path.join(scratchBase, 'phone-grok'),
    executable: 'fake-grok',
    spawnImpl: (...args) => {
      calls.push(args);
      return child;
    }
  });
  await login.start({remote: true});
  assert.deepEqual(calls[0][1], ['login', '--device-auth']);
  child.stdout.emit('data', 'https://accounts.x.ai/oauth2/device?user_code=TEST-');
  assert.equal(login.progress().login.url, undefined);
  child.stdout.emit('data', '1234\nConfirm this code in your browser: TEST-1234\n');
  assert.equal(login.progress().login.userCode, 'TEST-1234');
  assert.equal(login.progress().status, 'pending');
  await assert.rejects(login.logout(), /正在進行/);
  await login.cancel();
  assert.equal(login.progress().status, 'idle');
  await login.close();
});
test('Codex phone login uses the official app-server device-code variant, no OAuth fallback', async () => {
  for (const valid of [true, false]) {
    const calls = [];
    let event;
    const login = createCodexLogin({
      hostFactory: options => {
        event = options.onEvent;
        return {
          closed: new Promise(() => {}),
          notify() {},
          async close() {},
          async request(method, params) {
            calls.push([method, params]);
            if (method === 'account/read') return {account: null};
            if (method === 'account/login/start')
              return {
                type: 'chatgptDeviceCode',
                loginId: 'FAKE-ID',
                verificationUrl: valid
                  ? 'https://auth.openai.com/codex/device'
                  : 'https://auth.openai.com/oauth/authorize',
                userCode: 'TEST-12345'
              };
            return {};
          }
        };
      }
    });
    const result = await login.start({remote: true});
    assert.deepEqual(calls.find(([method]) => method === 'account/login/start')[1], {type: 'chatgptDeviceCode'});
    assert.equal(result.login.status, valid ? 'running' : 'error');
    assert.equal(result.login.userCode, valid ? 'TEST-12345' : undefined);
    if (valid) {
      event({method: 'account/login/completed', params: {loginId: 'FAKE-ID', success: true}});
      assert.equal(login.progress().login.status, 'complete');
    }
    assert.equal(calls.filter(([method]) => method === 'account/login/start').length, 1);
    await login.close();
  }
});
