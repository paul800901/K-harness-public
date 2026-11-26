import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {startDesktop} from '../src/desktop-server.mjs';
import {attentionSummary} from '../src/attention-summary.mjs';
import {remoteRouteAllowed} from '../src/remote-access.mjs';
import {scratchBase} from './scratch.mjs';

test('the attention summary carries unread rooms with titles and the working count', () => {
  const summary = attentionSummary({
    completionAttention: {
      sequence: 4,
      unread: [
        {threadId: 'a', sequence: 3},
        {threadId: 'b', sequence: 4, kind: 'attention'},
        {threadId: 'gone', sequence: 2}
      ]
    },
    conversationActivity: [
      {threadId: 'a', title: '例行追蹤', busy: false},
      {threadId: 'b', title: '', busy: false},
      {threadId: 'c', title: '翻譯', busy: true},
      {threadId: 'd', title: '子代理', busy: false, pendingWorkers: 1, backgroundWork: 'Claude 背景命令未結束'},
      {threadId: 'e', title: '背景工作', busy: false, backgroundWork: 'agy 背景程序保留中'}
    ]
  });
  assert.deepEqual(summary, {
    sequence: 4,
    unread: [
      {threadId: 'a', sequence: 3, kind: 'completed', title: '例行追蹤'},
      {threadId: 'b', sequence: 4, kind: 'attention', title: '未命名聊天室'},
      {threadId: 'gone', sequence: 2, kind: 'completed', title: '未命名聊天室'}
    ],
    working: 3
  });
  assert.deepEqual(attentionSummary({}), {sequence: 0, unread: [], working: 0});
});

test('the phone app routes are readable remotely and nothing else is opened', () => {
  for (const route of ['/api/attention/events', '/api/android/shell', '/api/android/shell.apk'])
    assert.equal(remoteRouteAllowed('GET', route), true, route);
  assert.equal(remoteRouteAllowed('POST', '/api/android/shell'), false);
});

async function app() {
  const root = await mkdtemp(path.join(scratchBase, 'android-shell-'));
  const stubLogin = () => ({
    status: async () => ({}),
    progress: () => ({}),
    start: async () => ({}),
    cancel: async () => ({}),
    submitCode: async () => ({}),
    close: async () => {}
  });
  let onChange;
  const state = {
    threadId: 't1',
    status: 'ready',
    busy: false,
    messages: [],
    tools: [],
    completionAttention: {sequence: 0, unread: []},
    conversationActivity: [{threadId: 't1', title: '例行追蹤', busy: false}]
  };
  const desktop = await startDesktop({
    root,
    executable: 'x',
    port: 0,
    controllerFactory: options => {
      onChange = options.onChange;
      return {
        concurrentConversations: true,
        historyVersion: 1,
        state,
        sessions: async () => ({sessions: []}),
        close: async () => {}
      };
    },
    claudeLoginFactory: stubLogin,
    codexLoginFactory: stubLogin,
    geminiLoginFactory: stubLogin,
    localDictationFactory: () => ({transcribe: async () => ({}), close: async () => {}})
  });
  const boot = await fetch(desktop.createLaunchUrl(), {redirect: 'manual'});
  const cookie = boot.headers.get('set-cookie').split(';')[0];
  return {root, desktop, state, cookie, change: () => onChange()};
}

// Collects SSE data frames until the predicate is satisfied.
function readFrames(url, cookie) {
  const frames = [];
  let waiter = null;
  const req = http.get(url, {headers: {Cookie: cookie}}, res => {
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith('data: ')) frames.push(JSON.parse(block.slice(6)));
      }
      if (waiter && waiter.until(frames)) waiter.resolve();
    });
  });
  return {
    frames,
    until: predicate =>
      new Promise((resolve, reject) => {
        if (predicate(frames)) return resolve();
        waiter = {until: predicate, resolve};
        setTimeout(() => reject(Error(`timed out with ${frames.length} frames`)), 3000);
      }),
    close: () => req.destroy()
  };
}

test('the attention stream sends the summary first and then only real changes', async () => {
  const {desktop, state, cookie, change} = await app();
  const stream = readFrames(new URL('/api/attention/events', desktop.origin), cookie);
  try {
    await stream.until(f => f.length === 1);
    assert.deepEqual(stream.frames[0], {sequence: 0, unread: [], working: 0});
    // An unrelated change (new message text) does not produce a frame.
    state.messages = [{id: 'm1', role: 'assistant', text: 'x'}];
    change();
    state.conversationActivity = [{threadId: 't1', title: '例行追蹤', busy: true}];
    change();
    await stream.until(f => f.length === 2);
    assert.equal(stream.frames[1].working, 1);
    state.conversationActivity = [{threadId: 't1', title: '例行追蹤', busy: false}];
    state.completionAttention = {sequence: 1, unread: [{threadId: 't1', sequence: 1}]};
    change();
    await stream.until(f => f.length === 3);
    assert.deepEqual(stream.frames[2], {
      sequence: 1,
      unread: [{threadId: 't1', sequence: 1, kind: 'completed', title: '例行追蹤'}],
      working: 0
    });
    assert.equal(stream.frames.length, 3);
  } finally {
    stream.close();
    await desktop.close();
  }
});

test('the app installer is offered only after it has been published', async () => {
  const {root, desktop, cookie} = await app();
  try {
    const get = route => fetch(new URL(route, desktop.origin), {headers: {Cookie: cookie}});
    assert.deepEqual(await (await get('/api/android/shell')).json(), {available: false});
    assert.equal((await get('/api/android/shell.apk?versionCode=10001')).status, 404);
    assert.equal((await get('/api/android/shell.apk')).status, 400);
    assert.equal((await get('/api/android/shell.apk?versionCode=../x')).status, 400);
    const dir = path.join(root, '.local', 'android-shell');
    await mkdir(dir, {recursive: true});
    await writeFile(path.join(dir, 'k-shell-10001.apk'), 'APK');
    await writeFile(
      path.join(dir, 'k-shell.json'),
      JSON.stringify({versionCode: 10001, versionName: '1.0.1', size: 3, sha256: 'ab'})
    );
    assert.deepEqual(await (await get('/api/android/shell')).json(), {
      available: true,
      versionCode: 10001,
      versionName: '1.0.1',
      size: 3,
      sha256: 'ab'
    });
    const apk = await get('/api/android/shell.apk?versionCode=10001');
    assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(await apk.text(), 'APK');
  } finally {
    await desktop.close();
  }
});
