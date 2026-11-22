import test from 'node:test';
import assert from 'node:assert/strict';
import {lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConversationController} from '../src/conversation-controller.mjs';
import {createDesktopController} from '../src/desktop-controller.mjs';
import {saveMainSession, listMainSessions} from '../src/main-sessions.mjs';
import {listProjects} from '../src/projects.mjs';
import {scratchBase} from './scratch.mjs';

const base = scratchBase,
  model = 'gpt-6.1-sol';
async function fixture() {
  await mkdir(base, {recursive: true});
  const root = await mkdtemp(path.join(base, 'chat-continuation-'));
  const owners = [],
    calls = [];
  let sequence = 0,
    forkFailure,
    sendFailure,
    childOpenGate,
    childSendGate;
  const sessionFactory = hooks => {
    const state = {
      provider: 'codex',
      threadId: null,
      model,
      workspace: root,
      accessMode: 'read-only',
      effort: 'medium',
      serviceTier: 'default',
      busy: false,
      status: 'ready',
      questions: [],
      queuedMessages: [],
      messages: [],
      workers: [],
      goal: null
    };
    const owner = {
      state,
      hooks,
      async models() {
        return {models: []};
      },
      async selectWorkspace({path}) {
        state.workspace = path;
      },
      async open(data, {continuation, onCreated} = {}) {
        if (continuation) {
          calls.push([
            continuation.mode === 'fresh' ? 'start' : 'fork',
            {turnId: continuation.throughTurnId},
            continuation.forkFrom
          ]);
          if (forkFailure) throw forkFailure;
          if (childOpenGate) {
            childOpenGate.enter();
            await childOpenGate.promise;
          }
        }
        Object.assign(state, data);
        state.threadId ??= `room-${++sequence}`;
        await saveMainSession(root, {
          ...state,
          ...(continuation?.mode === 'fresh'
            ? {title: '新對話 · 測試'}
            : continuation
              ? {parentThreadId: continuation.forkFrom}
              : {})
        });
        if (continuation) await onCreated({threadId: state.threadId});
        return {threadId: state.threadId};
      },
      async goal() {
        return {goal: state.goal};
      },
      async workers() {
        return state.workers;
      },
      async prepareContinuation(data) {
        return {
          ...(data.mode === 'fresh'
            ? {mode: 'fresh'}
            : {forkFrom: state.threadId, nativeSourceId: state.threadId, throughTurnId: data.turnId}),
          model,
          workspace: state.workspace,
          accessMode: state.accessMode,
          effort: state.effort,
          serviceTier: state.serviceTier,
          workerPolicy: state.workerPolicy
        };
      },
      async send(data) {
        calls.push(['send', data, state.threadId]);
        if (data.source === 'continuation' && childSendGate) {
          childSendGate.enter();
          await childSendGate.promise;
        }
        if (sendFailure) throw sendFailure;
        state.busy = true;
        state.status = 'working';
        state.messages.push({
          id: 'next-user',
          role: 'user',
          turnId: `turn-${sequence}`,
          text: data.text,
          source: data.source ?? 'local'
        });
        return {sent: true};
      },
      async steer(data) {
        calls.push(['steer', data]);
      },
      async queue(data) {
        calls.push(['queue', data]);
      },
      async stop() {
        state.busy = false;
        state.status = 'interrupted';
        calls.push(['stop', state.threadId]);
      },
      async close() {
        state.busy = false;
        state.status = 'offline';
      }
    };
    owners.push(owner);
    return owner;
  };
  const c = createConversationController({root, sessionFactory});
  const opened = await c.open({model, workspace: root}),
    source = owners.find(o => o.state.threadId === opened.threadId);
  source.state.busy = true;
  source.state.status = 'working';
  source.state.messages = [{id: 'human', role: 'user', turnId: 'transfer-turn', text: '換一間接著做', source: 'local'}];
  const request = (mode = 'fork') =>
    source.hooks.onContinueConversation({
      mode,
      threadId: source.state.threadId,
      turnId: 'transfer-turn',
      nextInstruction: '第2階段尚未完成；先核對已保存結果。'
    });
  const finish = async (status = 'completed') => {
    source.state.busy = false;
    source.state.status = status;
    source.hooks.onConversationSettled({threadId: source.state.threadId, turnId: 'transfer-turn', status});
    await wait(
      () =>
        (c.state.continuation?.status !== 'pending' && calls.some(x => ['fork', 'start'].includes(x[0]))) ||
        c.state.continuation?.status === 'cancelled'
    );
    await new Promise(r => setTimeout(r, 30));
  };
  const receipt = id =>
    readFile(path.join(root, '.runtime/chat-continuations', `${id ?? opened.threadId}.json`), 'utf8').then(JSON.parse);
  return {
    root,
    c,
    source,
    owners,
    calls,
    opened,
    request,
    finish,
    receipt,
    failFork: error => {
      forkFailure = error;
    },
    failSend: error => {
      sendFailure = error;
    },
    blockChildOpen: gate => {
      childOpenGate = gate;
    },
    blockChildSend: gate => {
      childSendGate = gate;
    }
  };
}
// File receipts can be held by Windows Defender for ~2s under load; atomicWrite waits up to 10s.
async function wait(check) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error('test wait timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

test('fresh handoff creates once, preserves settings without parent history, and is not recursive human authority', async () => {
  const f = await fixture();
  try {
    f.source.state.workerPolicy = {model: 'auto', effort: 'auto'};
    f.source.state.messages.unshift({role: 'assistant', turnId: 'old', text: 'old context'});
    assert.equal((await f.request('fresh')).mode, 'fresh');
    await f.request('fresh');
    await assert.rejects(f.request('fork'), /模式衝突/);
    await f.finish();
    await wait(() => f.calls.filter(c => c[0] === 'send').length === 1);
    assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'fork').length, 0);
    const child = f.owners.find(o => o.state.threadId === f.c.state.threadId),
      saved = (await f.c.sessions()).sessions.find(s => s.threadId === child.state.threadId);
    for (const key of ['model', 'workspace', 'accessMode', 'effort', 'serviceTier', 'workerPolicy'])
      assert.deepEqual(child.state[key], f.source.state[key]);
    assert.equal(saved.parentThreadId, null);
    assert.equal(saved.branchType, null);
    assert.equal(saved.inheritedAttachments, null);
    assert.match(saved.title, /新對話/);
    assert.equal(child.state.messages.length, 1);
    const sent = f.calls.find(c => c[0] === 'send')[1];
    assert.match(sent.text, /未帶入舊歷史、壓縮/);
    assert.doesNotMatch(sent.text, /原生歷史已保留/);
    assert.match(sent.text, /只有本次本人明確要求建立新目標/);
    assert.equal((await f.receipt()).status, 'sent');
    assert.equal((await f.receipt(child.state.threadId)).parentThreadId, undefined);
    await assert.rejects(
      child.hooks.onContinueConversation({
        mode: 'fresh',
        threadId: child.state.threadId,
        turnId: child.state.messages[0].turnId,
        nextInstruction: 'recursive'
      }),
      /真人訊息/
    );
    f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
    await new Promise(r => setTimeout(r, 20));
    assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
  } finally {
    await f.c.close();
  }
});

test('same-turn fork then fresh conflicts without creating a second room', async () => {
  const f = await fixture();
  try {
    await f.request();
    await assert.rejects(f.request('fresh'), /模式衝突/);
    await f.finish();
    assert.equal(f.calls.filter(c => c[0] === 'fork').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'start').length, 0);
  } finally {
    await f.c.close();
  }
});

test('fresh pending handoffs cancel on new human input, stop, or shutdown', async () => {
  for (const action of ['send', 'steer', 'queue', 'stop', 'close']) {
    const f = await fixture();
    try {
      await f.request('fresh');
      if (action === 'failed') await f.finish('failed');
      else if (action === 'close') await f.c.close();
      else await f.c[action]({threadId: f.opened.threadId, text: 'new human intent'});
      f.source.state.busy = false;
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
      await new Promise(r => setTimeout(r, 20));
      assert.equal((await f.receipt()).status, 'cancelled');
      assert.equal(f.calls.filter(c => c[0] === 'start').length, 0);
    } finally {
      await f.c.close();
    }
  }
});

test('fresh unknown creation or send outcomes do not replay; known children remain discoverable', async () => {
  for (const phase of ['create', 'send']) {
    const f = await fixture();
    try {
      if (phase === 'create') f.failFork(Error('start response unknown'));
      else f.failSend(Error('submission unknown'));
      await f.request('fresh');
      await f.finish();
      await wait(async () => (await f.receipt()).status === 'uncertain');
      await f.request('fresh');
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
      await new Promise(r => setTimeout(r, 20));
      assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
      assert.equal(f.calls.filter(c => c[0] === 'send').length, phase === 'send' ? 1 : 0);
      if (phase === 'send') {
        const id = (await f.receipt()).newThreadId;
        assert.ok((await f.c.sessions()).sessions.some(s => s.threadId === id));
      }
    } finally {
      await f.c.close();
    }
  }
});

test('fresh handoff does not select its child over another room being viewed', async () => {
  const f = await fixture();
  try {
    await f.request('fresh');
    const other = await f.c.open({model, workspace: f.root});
    await f.finish();
    await wait(async () => (await f.receipt()).status === 'sent');
    assert.equal(f.c.state.threadId, other.threadId);
    assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  } finally {
    await f.c.close();
  }
});

test('a continuation accepted during an idle probe cannot be closed by its late read', async () => {
  const f = await fixture();
  let resolveRead,
    reading = false,
    closes = 0,
    reads = 0;
  const pending = new Promise(resolve => {
    resolveRead = resolve;
  });
  const close = f.source.close;
  f.source.close = async () => {
    closes++;
    return close();
  };
  f.source.workers = async () => {
    if (++reads === 1) {
      reading = true;
      return pending;
    }
    return [];
  };
  try {
    f.source.state.busy = false;
    f.source.state.status = 'completed';
    for (let i = 0; i < 4; i++) await f.c.open({model, workspace: f.root});
    await wait(() => reading);
    f.source.state.busy = true;
    f.source.state.status = 'working';
    assert.equal((await f.request()).accepted, true);
    // Completion may precede delivery of its callback; pending ownership still protects the room.
    f.source.state.busy = false;
    f.source.state.status = 'completed';
    resolveRead([]);
    await wait(() => reads >= 3);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closes, 0);
    assert.equal((await f.receipt()).status, 'pending');
    await f.c.open({threadId: f.opened.threadId, model});
    assert.equal(f.c.state.threadId, f.opened.threadId);
    await f.finish();
    assert.equal(f.calls.filter(c => c[0] === 'fork').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  } finally {
    resolveRead([]);
    await f.c.close();
  }
});

test('AI move uses no message button, branches once after its turn and leaves the source owner intact', async () => {
  const f = await fixture();
  try {
    const accepted = await f.request();
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.created, false);
    assert.equal(f.calls.length, 0);
    await f.request();
    assert.equal(f.calls.length, 0);
    await f.finish();
    await wait(() => f.c.state.threadId !== f.opened.threadId);
    assert.equal(f.calls.filter(c => c[0] === 'fork').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
    assert.equal(f.source.state.threadId, f.opened.threadId);
    assert.equal(f.source.state.status, 'completed');
    assert.equal(f.c.state.workspace, f.source.state.workspace);
    assert.equal((await f.c.sessions()).sessions.length, 2);
    const sent = f.calls.find(c => c[0] === 'send')[1];
    assert.equal(sent.source, 'continuation');
    assert.match(sent.text, /先讀回目前成果檔案/);
    assert.match(sent.text, /第2階段尚未完成/);
    f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
    await new Promise(r => setTimeout(r, 20));
    assert.equal(f.calls.filter(c => c[0] === 'fork').length, 1);
    const child = f.owners.find(o => o.state.threadId === f.c.state.threadId);
    await assert.rejects(
      child.hooks.onContinueConversation({
        threadId: child.state.threadId,
        turnId: child.state.messages.at(-1).turnId,
        nextInstruction: 'again'
      }),
      /真人訊息/
    );
  } finally {
    await f.c.close();
  }
});
for (const status of ['failed', 'interrupted'])
  test(`the transfer-request turn ending ${status} cancels without creating or replaying`, async () => {
    const f = await fixture();
    try {
      await f.request();
      await f.finish(status);
      assert.equal(f.calls.length, 0);
      assert.equal((await f.receipt()).status, 'cancelled');
    } finally {
      await f.c.close();
    }
  });
test('active goals, budgeted goals, live and unconfirmed workers refuse acceptance', async () => {
  const f = await fixture();
  try {
    for (const goal of [{status: 'active'}, {status: 'paused', tokenBudget: 100}]) {
      f.source.state.goal = goal;
      for (const mode of ['fork', 'fresh']) await assert.rejects(f.request(mode), /原生目標/);
    }
    f.source.state.goal = null;
    for (const worker of [
      {status: 'running', settled: false},
      {status: 'unresolved', executionUnowned: true, settled: false}
    ]) {
      f.source.state.workers = [worker];
      for (const mode of ['fork', 'fresh']) await assert.rejects(f.request(mode), /子代理/);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.source.state.workers = [];
    await f.c.close();
  }
});
test('new human input or an explicit stop cancels a pending move', async () => {
  for (const stop of [false, true]) {
    const f = await fixture();
    try {
      await f.request();
      if (stop) await f.c.stop({threadId: f.opened.threadId});
      else await f.c.send({threadId: f.opened.threadId, text: '別換了'});
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
      await new Promise(r => setTimeout(r, 20));
      assert.equal(f.calls.filter(c => c[0] === 'fork').length, 0);
      assert.equal((await f.receipt()).status, 'cancelled');
    } finally {
      await f.c.close();
    }
  }
});
test('an uncertain fork or new-room send never creates or sends a second time', async () => {
  for (const phase of ['fork', 'send']) {
    const f = await fixture();
    try {
      if (phase === 'fork') f.failFork(Error('native outcome unknown'));
      else f.failSend(Error('send outcome unknown'));
      await f.request();
      f.source.state.busy = false;
      f.source.state.status = 'completed';
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
      await wait(async () => (await f.receipt()).status === 'uncertain');
      const saved = await f.receipt();
      assert.equal(saved.status, 'uncertain');
      await f.request();
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
      await new Promise(r => setTimeout(r, 20));
      assert.equal(f.calls.filter(c => c[0] === 'fork').length, 1);
      assert.equal(f.calls.filter(c => c[0] === 'send').length, phase === 'send' ? 1 : 0);
    } finally {
      await f.c.close();
    }
  }
});
test('shutdown cancels pending creation', async () => {
  const f = await fixture();
  await f.request();
  await f.c.close();
  assert.equal((await f.receipt()).status, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('native continuation captures stored history including old failed turns without opening or closing the source', async () => {
  await mkdir(base, {recursive: true});
  const root = await mkdtemp(path.join(base, 'native-continuation-'));
  const calls = [];
  let hooks,
    gateway,
    ended,
    goal = null,
    terminals = [];
  const history = [
    {id: 'old-failure', status: 'failed', items: [{id: 'partial', type: 'agentMessage', text: 'unfinished'}]},
    {id: 'transfer-turn', status: 'completed', items: []}
  ];
  const host = {
    closed: new Promise(r => (ended = r)),
    notify() {},
    async close() {
      calls.push(['close']);
      ended();
    },
    async request(method, p) {
      calls.push([method, p]);
      if (method === 'model/list')
        return {
          data: [{model, supportedReasoningEfforts: [{reasoningEffort: 'medium'}], defaultReasoningEffort: 'medium'}]
        };
      if (method === 'account/read') return {account: {type: 'chatgpt'}};
      if (method === 'config/read') return {config: {}};
      if (method === 'thread/start') return {thread: {id: 'parent', turns: []}};
      if (method === 'thread/goal/get') return {goal};
      if (method === 'thread/backgroundTerminals/list') return {data: terminals};
      if (method === 'thread/read') return {thread: {id: 'parent', turns: history}};
      if (method === 'thread/fork') return {thread: {id: 'child', turns: structuredClone(history)}};
      if (method === 'turn/start') {
        hooks.onEvent({
          method: 'turn/started',
          params: {threadId: 'parent', turn: {id: 'transfer-turn', status: 'inProgress'}}
        });
        return {turn: {id: 'transfer-turn'}};
      }
      return {};
    }
  };
  const c = createDesktopController({
    root,
    hostFactory: h => {
      if (!h.onEvent) return {...host, close: async () => {}};
      hooks = h;
      return host;
    },
    gatewayFactory: async g => {
      gateway = g;
      return {
        mcpConfig: {mcpServers: {k_gemini: {url: 'http://fake/mcp', headers: {Authorization: 'fake'}}}},
        close: async () => {}
      };
    },
    onContinueConversation: async data => ({accepted: true, ...data})
  });
  try {
    await c.open({model, effort: 'medium', accessMode: 'read-only'});
    await c.send({text: 'move'});
    await assert.rejects(
      gateway.continueConversation(
        {nextInstruction: 'continue'},
        {'x-codex-turn-metadata': JSON.stringify({thread_id: 'worker', turn_id: 'transfer-turn'})}
      ),
      /目前主對話/
    );
    const accepted = await gateway.continueConversation(
      {nextInstruction: 'continue'},
      {'x-codex-turn-metadata': JSON.stringify({thread_id: 'parent', turn_id: 'transfer-turn'})}
    );
    assert.equal(accepted.turnId, 'transfer-turn');
    assert.doesNotThrow(accepted.stillCurrent);
    hooks.onEvent({
      method: 'item/completed',
      params: {
        threadId: 'parent',
        turnId: 'transfer-turn',
        item: {id: 'native-human', type: 'userMessage', content: [{type: 'text', text: 'move'}]}
      }
    });
    assert.equal(c.state.messages.filter(m => m.role === 'user').length, 1);
    assert.equal(c.state.messages.find(m => m.role === 'user').source, 'native');
    hooks.onEvent({
      method: 'turn/completed',
      params: {threadId: 'parent', turn: {id: 'transfer-turn', status: 'completed'}}
    });
    assert.throws(accepted.stillCurrent, /目前主對話/);
    goal = {status: 'active'};
    await assert.rejects(c.prepareContinuation({turnId: 'transfer-turn'}), /原生目標/);
    goal = null;
    for (const value of [{status: 'active'}, {status: 'paused', tokenBudget: 100}]) {
      goal = value;
      await assert.rejects(c.prepareContinuation({turnId: 'transfer-turn', mode: 'fresh'}), /原生目標/);
    }
    goal = null;
    terminals = [{id: 'live-command'}];
    await assert.rejects(c.prepareContinuation({turnId: 'transfer-turn', mode: 'fresh'}), /未確認結束/);
    terminals = null;
    await assert.rejects(c.prepareContinuation({turnId: 'transfer-turn', mode: 'fresh'}), /無法確認背景命令/);
    terminals = [];
    const fresh = await c.prepareContinuation({turnId: 'transfer-turn', mode: 'fresh'});
    assert.equal(fresh.mode, 'fresh');
    assert.equal(fresh.forkFrom, undefined);
    assert.equal(fresh.nativeSourceId, undefined);
    assert.equal(fresh.throughTurnId, undefined);
    assert.equal(fresh.workspace, root);
    const prepared = await c.prepareContinuation({turnId: 'transfer-turn'});
    assert.equal(prepared.forkFrom, 'parent');
    assert.equal(prepared.throughTurnId, 'transfer-turn');
    assert.equal(c.state.threadId, 'parent');
    assert.equal(
      calls.some(c => ['thread/fork', 'thread/resume', 'close'].includes(c[0])),
      false
    );
    assert.equal((await listMainSessions(root)).sessions.length, 1);
    await c.send({text: 'program continuation', source: 'continuation'});
    for (const method of ['item/started', 'item/completed'])
      hooks.onEvent({
        method,
        params: {
          threadId: 'parent',
          turnId: 'transfer-turn',
          item: {id: 'native-control', type: 'userMessage', content: [{type: 'text', text: 'program continuation'}]}
        }
      });
    assert.equal(c.state.messages.filter(m => m.text === 'program continuation').length, 1);
    assert.equal(c.state.messages.find(m => m.text === 'program continuation').source, 'continuation');
  } finally {
    await c.close();
  }
});

test('acceptance uses a fresh snapshot after awaited checks and revalidates native metadata after persistence', async () => {
  for (const phase of ['goal', 'receipt']) {
    const f = await fixture();
    try {
      const mutable = f.source.state;
      Object.defineProperty(f.source, 'state', {get: () => ({...mutable})});
      if (phase === 'goal')
        f.source.goal = async () => {
          mutable.busy = false;
          return {goal: null};
        };
      await assert.rejects(
        f.source.hooks.onContinueConversation({
          threadId: f.opened.threadId,
          turnId: 'transfer-turn',
          nextInstruction: 'remaining',
          stillCurrent: () => {
            if (phase === 'receipt') throw Error('native turn ended');
          }
        }),
        phase === 'goal' ? /來源已變更/ : /native turn ended/
      );
      if (phase === 'receipt') assert.equal((await f.receipt()).status, 'cancelled');
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
      await new Promise(r => setTimeout(r, 20));
      assert.equal(f.calls.length, 0);
    } finally {
      await f.c.close();
    }
  }
});

test('a later real human native echo may request another move, not the program continuation', async () => {
  const f = await fixture();
  try {
    f.source.state.accessMode = 'danger-full-access';
    await f.request();
    await f.finish();
    await wait(() => f.c.state.threadId !== f.opened.threadId);
    const child = f.owners.find(o => o.state.threadId === f.c.state.threadId);
    assert.equal(child.state.accessMode, 'danger-full-access');
    assert.equal(child.state.permissionConfirmed, true);
    child.state.messages.push({
      id: 'human-2',
      role: 'user',
      turnId: 'human-turn-2',
      text: '再次換房',
      source: 'native'
    });
    const accepted = await child.hooks.onContinueConversation({
      threadId: child.state.threadId,
      turnId: 'human-turn-2',
      nextInstruction: 'another explicit move'
    });
    assert.equal(accepted.accepted, true);
  } finally {
    await f.c.close();
  }
});

test('steering or queueing real input cancels the pending move; native error takes precedence', async () => {
  for (const method of ['steer', 'queue']) {
    const f = await fixture();
    try {
      await f.request();
      await f.c[method]({threadId: f.opened.threadId, text: 'new instruction'});
      assert.equal((await f.receipt()).status, 'cancelled');
      assert.equal(f.calls.filter(c => c[0] === 'fork').length, 0);
    } finally {
      await f.c.close();
    }
  }
  const f = await fixture();
  try {
    await f.request();
    await f.finish('failed');
    f.source.state.error = 'actual native failure';
    assert.equal(f.c.state.error, 'actual native failure');
  } finally {
    await f.c.close();
  }
});

test('reopening an incomplete receipt persists cancellation or uncertainty and never dispatches', async () => {
  for (const status of ['pending', 'creating', 'created']) {
    const f = await fixture();
    await f.c.close();
    const file = path.join(f.root, '.runtime/chat-continuations', `${f.opened.threadId}.json`);
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(
      file,
      JSON.stringify({sourceThreadId: f.opened.threadId, turnId: 'old-turn', status, nextInstruction: 'never replay'})
    );
    const c = createConversationController({
      root: f.root,
      sessionFactory: hooks => ({
        ...f.source,
        hooks,
        state: {...f.source.state, status: 'ready', busy: false},
        close: async () => {}
      })
    });
    try {
      await c.open({threadId: f.opened.threadId, model});
      assert.equal((await f.receipt()).status, status === 'pending' ? 'cancelled' : 'uncertain');
      assert.equal(f.calls.length, 0);
    } finally {
      await c.close();
    }
  }
});

test('background notification turns cannot authorize a move', async () => {
  const f = await fixture();
  try {
    f.source.state.messages = [];
    await assert.rejects(f.request(), /真人訊息/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.c.close();
  }
});

test('known pre-fork failures cancel but uncertain fork attempts remain blocked without retry', async () => {
  for (const notCreated of [true, false]) {
    const f = await fixture();
    try {
      f.failFork(Object.assign(Error('open failed'), {notCreated}));
      await f.request();
      f.source.state.busy = false;
      f.source.state.status = 'completed';
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
      await wait(async () => (await f.receipt()).status === (notCreated ? 'cancelled' : 'uncertain'));
      f.source.state.busy = true;
      f.source.state.messages.push({role: 'user', turnId: 'next-human', source: 'native', text: 'explicit new move'});
      const request = () =>
        f.source.hooks.onContinueConversation({
          threadId: f.opened.threadId,
          turnId: 'next-human',
          nextInstruction: 'remaining'
        });
      if (notCreated) assert.equal((await request()).accepted, true);
      else await assert.rejects(request(), /前次換房結果尚未確認/);
      assert.equal(f.calls.filter(c => c[0] === 'fork').length, 1);
    } finally {
      await f.c.close();
    }
  }
});

test('the real adapter preserves known pre-fork rejection and never marks a sent fork as not created', async () => {
  for (const phase of ['catalog', 'history', 'config', 'fork', 'mcp']) {
    await mkdir(base, {recursive: true});
    const root = await mkdtemp(path.join(base, 'continuation-open-failure-'));
    let ended;
    const calls = [];
    const host = {
      closed: new Promise(r => (ended = r)),
      notify() {},
      close: async () => {
        ended();
      },
      waitForMcp: async () => {
        if (phase === 'mcp') throw Error('MCP wait failed');
      },
      request: async (method, p) => {
        calls.push(method);
        if (method === 'model/list') {
          if (phase === 'catalog') throw Error('catalog failed');
          return {data: [{model, supportedReasoningEfforts: [{reasoningEffort: 'medium'}]}]};
        }
        if (method === 'account/read') return {account: {type: 'chatgpt'}};
        if (method === 'thread/read')
          return {
            thread: {
              id: 'parent',
              turns: [{id: phase === 'history' ? 'changed-turn' : 'last-turn', status: 'completed', items: []}]
            }
          };
        if (method === 'config/read') {
          if (phase === 'config') throw Error('config read failed');
          return {config: {}};
        }
        if (method === 'thread/fork') {
          if (phase === 'fork') throw Error('fork response unknown');
          return {thread: {id: 'new-child', turns: []}};
        }
        return {};
      }
    };
    const c = createDesktopController({
      root,
      hostFactory: h => (h.onEvent ? host : {...host, close: async () => {}}),
      gatewayFactory: async () => ({
        mcpConfig: {mcpServers: {k_gemini: {url: 'http://fake/mcp', headers: {Authorization: 'fake'}}}},
        close: async () => {}
      })
    });
    try {
      await assert.rejects(
        c.open(
          {model, effort: 'medium', accessMode: 'danger-full-access', permissionConfirmed: true},
          {continuation: {forkFrom: 'parent', nativeSourceId: 'parent', throughTurnId: 'last-turn'}}
        ),
        error => {
          assert.equal(error.notCreated === true, ['catalog', 'history', 'config'].includes(phase));
          return true;
        }
      );
      assert.equal(calls.filter(c => c === 'thread/fork').length, ['fork', 'mcp'].includes(phase) ? 1 : 0);
      if (phase === 'mcp') assert.equal(c.state.threadId, 'new-child');
    } finally {
      await c.close();
    }
  }
});

test('accepted fresh handoff survives an exact failed native turn and still creates and sends only once', async () => {
  const f = await fixture();
  try {
    await f.request('fresh');
    await f.finish('failed');
    assert.equal((await f.receipt()).status, 'sent');
    assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
    f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'failed'});
    await new Promise(r => setTimeout(r, 20));
    assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  } finally {
    await f.c.close();
  }
});

for (const change of ['busy', 'unknown', 'goal', 'newHuman', 'worker', 'command', 'question', 'queued'])
  test(`fresh accepted handoff refuses changed ${change} state before creation`, async () => {
    const f = await fixture();
    try {
      await f.request('fresh');
      f.source.state.busy = false;
      f.source.state.status = 'failed';
      if (change === 'busy') f.source.state.busy = true;
      if (change === 'goal') f.source.state.goal = {status: 'paused', objective: 'changed'};
      if (change === 'newHuman')
        f.source.state.messages.push({role: 'user', turnId: 'new', text: 'stop changing rooms'});
      if (change === 'worker') f.source.state.workers = [{threadId: 'new-worker', settled: true, status: 'completed'}];
      if (change === 'command')
        f.source.state.tools = [{id: 'new-command', kind: 'commandExecution', status: 'completed'}];
      if (change === 'question') f.source.state.questions = [{id: 'approval'}];
      if (change === 'queued') f.source.state.queuedMessages = [{text: 'new'}];
      f.source.hooks.onConversationSettled({
        threadId: f.opened.threadId,
        turnId: 'transfer-turn',
        status: change === 'unknown' ? 'unknown' : 'failed'
      });
      await wait(async () => (await f.receipt()).status === 'cancelled');
      assert.equal(f.calls.length, 0);
    } finally {
      await f.c.close();
    }
  });

for (const action of ['stop', 'send', 'steer', 'queue'])
  test(`human ${action} cancels a fresh handoff during awaited preparation`, async () => {
    const f = await fixture();
    let enter, release;
    const entered = new Promise(r => (enter = r)),
      gate = new Promise(r => (release = r));
    const prepare = f.source.prepareContinuation;
    f.source.prepareContinuation = async data => {
      enter();
      await gate;
      return prepare(data);
    };
    try {
      await f.request('fresh');
      f.source.state.busy = false;
      f.source.state.status = 'failed';
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'failed'});
      await entered;
      if (action === 'stop') assert.equal((await f.c.stop({threadId: f.opened.threadId})).continuationCancelled, true);
      else await assert.rejects(f.c[action]({threadId: f.opened.threadId, text: 'new intent'}), /正在重新連線/);
      release();
      await wait(async () => (await f.receipt()).status === 'cancelled');
      assert.equal(f.calls.length, 0);
    } finally {
      release();
      await f.c.close();
    }
  });

async function failedNativeFixture() {
  await mkdir(base, {recursive: true});
  const root = await mkdtemp(path.join(base, 'failed-native-handoff-'));
  let hooks,
    gateway,
    accepted,
    ended,
    goal = null,
    terminals = [];
  const history = [];
  const host = {
    closed: new Promise(r => (ended = r)),
    notify() {},
    async close() {
      ended();
    },
    async request(method) {
      if (method === 'model/list')
        return {
          data: [{model, supportedReasoningEfforts: [{reasoningEffort: 'medium'}], defaultReasoningEffort: 'medium'}]
        };
      if (method === 'account/read') return {account: {type: 'chatgpt'}};
      if (method === 'config/read') return {config: {}};
      if (method === 'thread/start') return {thread: {id: 'parent', turns: []}};
      if (method === 'thread/goal/get') return {goal};
      if (method === 'thread/backgroundTerminals/list') return {data: terminals};
      if (method === 'thread/read') return {thread: {id: 'parent', turns: history}};
      if (method === 'turn/start') {
        hooks.onEvent({
          method: 'turn/started',
          params: {threadId: 'parent', turn: {id: 'transfer-turn', status: 'inProgress'}}
        });
        return {turn: {id: 'transfer-turn'}};
      }
      return {};
    }
  };
  const c = createDesktopController({
    root,
    hostFactory: h => {
      if (!h.onEvent) return {...host, close: async () => {}};
      hooks = h;
      return host;
    },
    gatewayFactory: async g => {
      gateway = g;
      return {
        mcpConfig: {mcpServers: {k_gemini: {url: 'http://fake/mcp', headers: {Authorization: 'fake'}}}},
        close: async () => {}
      };
    },
    onContinueConversation: async data => {
      accepted = data;
      return {accepted: true};
    }
  });
  await c.open({model, effort: 'medium', accessMode: 'read-only'});
  await c.send({text: 'fresh move'});
  await gateway.continueConversation(
    {mode: 'fresh', nextInstruction: 'remaining'},
    {'x-codex-turn-metadata': JSON.stringify({thread_id: 'parent', turn_id: 'transfer-turn'})}
  );
  const finish = (status, error) => {
    history.splice(0, history.length, {id: 'transfer-turn', status, error, items: []});
    hooks.onEvent({method: 'turn/completed', params: {threadId: 'parent', turn: history[0]}});
  };
  return {
    c,
    history,
    finish,
    prepare: () =>
      c.prepareContinuation({turnId: 'transfer-turn', mode: 'fresh', sourceCurrent: accepted.afterTurnCurrent}),
    setTerminals: value => (terminals = value)
  };
}

for (const code of [
  'serverOverloaded',
  'streamFailure',
  {responseTooManyFailedAttempts: {httpStatusCode: 429}},
  'rateLimitExceeded'
])
  test(`native fresh preparation permits accepted exact failed ${JSON.stringify(code)} but never failed fork`, async () => {
    const f = await failedNativeFixture();
    try {
      f.finish('failed', {message: 'exact native failure', codexErrorInfo: code});
      const prepared = await f.prepare();
      assert.equal(prepared.mode, 'fresh');
      assert.equal(
        prepared.notBefore,
        typeof code === 'object' || code === 'rateLimitExceeded' ? f.c.state.turnError.observedAt + 30000 : undefined
      );
      await assert.rejects(f.c.prepareContinuation({turnId: 'transfer-turn', mode: 'fresh'}), /正常結束/);
      await assert.rejects(f.c.prepareContinuation({turnId: 'transfer-turn'}), /正常結束/);
      f.history[0].error = {message: 'different failure', codexErrorInfo: code};
      await assert.rejects(f.prepare(), /來源不符/);
    } finally {
      await f.c.close();
    }
  });

test('accepted fresh 429 cannot bypass known official zero or quota proof in native details', async () => {
  const f = await failedNativeFixture();
  try {
    const rate = {
      message: 'exceeded retry limit, last status: 429 Too Many Requests',
      codexErrorInfo: {responseTooManyFailedAttempts: {httpStatusCode: 429}}
    };
    for (const details of ['You have exceeded your weekly usage limit', {error: {code: 'insufficient_quota'}}]) {
      f.finish('failed', {...rate, additionalDetails: details});
      await assert.rejects(f.prepare(), /正常結束/);
    }
    f.finish('failed', rate);
    f.c.state.usage.codex = {
      status: 'ready',
      windows: [{remainingPercent: 0, resetsAt: Math.floor(Date.now() / 1000) + 3600}]
    };
    await assert.rejects(f.prepare(), /官方額度確認為零/);
  } finally {
    await f.c.close();
  }
});

for (const code of [
  'usageLimitExceeded',
  'unauthorized',
  'sandboxError',
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'cyberPolicy'
])
  test(`native fresh preparation refuses hard limit ${code}`, async () => {
    const f = await failedNativeFixture();
    try {
      f.finish('failed', {message: 'hard native failure', codexErrorInfo: code});
      await assert.rejects(f.prepare(), /正常結束/);
    } finally {
      await f.c.close();
    }
  });

test('native fresh failed preparation rejects unknown terminal, missing error and live or unknown background command', async () => {
  const f = await failedNativeFixture();
  try {
    f.finish('failed', {message: 'native stream', codexErrorInfo: {httpConnectionFailed: {httpStatusCode: 503}}});
    f.history[0].status = 'completed';
    await assert.rejects(f.prepare(), /來源不符/);
    f.history[0].status = 'inProgress';
    await assert.rejects(f.prepare(), /來源不符/);
    f.history[0].status = 'failed';
    delete f.history[0].error;
    await assert.rejects(f.prepare(), /來源不符/);
    f.history[0].error = f.c.state.turnError.error;
    f.setTerminals([{id: 'command'}]);
    await assert.rejects(f.prepare(), /未確認結束/);
    f.setTerminals(null);
    await assert.rejects(f.prepare(), /無法確認背景命令/);
    f.setTerminals([]);
    f.finish('interrupted', null);
    await assert.rejects(f.prepare(), /正常結束/);
  } finally {
    f.setTerminals([]);
    await f.c.close();
  }
});

for (const action of ['stop', 'newHuman', 'goal', 'worker', 'command'])
  test(`fresh handoff cancels ${action} during child opening and preserves a known child without sending`, async () => {
    const f = await fixture();
    let entered, release;
    const opening = new Promise(r => (entered = r)),
      gate = new Promise(r => (release = r));
    f.blockChildOpen({enter: entered, promise: gate});
    try {
      await f.request('fresh');
      f.source.state.busy = false;
      f.source.state.status = 'failed';
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'failed'});
      await opening;
      if (action === 'stop') assert.equal((await f.c.stop({threadId: f.opened.threadId})).continuationCancelled, true);
      if (action === 'newHuman') f.source.state.messages.push({role: 'user', turnId: 'new', text: 'cancel'});
      if (action === 'goal') f.source.state.goal = {status: 'paused', objective: 'different'};
      if (action === 'worker') f.source.state.workers = [{threadId: 'new', settled: true, status: 'completed'}];
      if (action === 'command') f.source.state.tools = [{id: 'new-command', status: 'completed'}];
      release();
      await wait(async () => (await f.receipt()).started === false);
      const receipt = await f.receipt();
      assert.equal(receipt.status, 'cancelled');
      assert.ok(receipt.newThreadId);
      assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
      assert.equal(f.calls.filter(c => c[0] === 'send').length, 0);
      assert.ok((await f.c.sessions()).sessions.some(s => s.threadId === receipt.newThreadId));
    } finally {
      release();
      await f.c.close();
    }
  });

for (const [mode, status] of [
  ['fresh', 'failed'],
  ['fresh', 'completed'],
  ['fork', 'completed']
])
  test(`real controllers retain ${mode} ${status} accepted before its own late stdout tool events`, async () => {
    await mkdir(base, {recursive: true});
    const root = await mkdtemp(path.join(base, 'accepted-native-integration-'));
    const native = [],
      calls = [];
    let sequence = 0;
    const c = createConversationController({
      root,
      sessionFactory: options => {
        const row = {id: null, hooks: null, gateway: null, turns: []};
        native.push(row);
        let ended;
        const host = {
          closed: new Promise(r => (ended = r)),
          notify() {},
          close: async () => ended(),
          async request(method, params) {
            calls.push([method, params]);
            if (method === 'model/list')
              return {
                data: [
                  {model, supportedReasoningEfforts: [{reasoningEffort: 'medium'}], defaultReasoningEffort: 'medium'}
                ]
              };
            if (method === 'account/read') return {account: {type: 'chatgpt'}};
            if (method === 'config/read') return {config: {}};
            if (method === 'thread/fork') {
              row.id = `native-${++sequence}`;
              return {
                thread: {
                  id: row.id,
                  turns: structuredClone(native.find(source => source.id === params.threadId)?.turns ?? [])
                }
              };
            }
            if (method === 'thread/start') {
              row.id = `native-${++sequence}`;
              return {thread: {id: row.id, turns: []}};
            }
            if (method === 'thread/goal/get') return {goal: null};
            if (method === 'thread/backgroundTerminals/list') return {data: []};
            if (method === 'thread/read') {
              const stored = native.find(source => source.id === params.threadId) ?? row;
              return {thread: {id: params.threadId, turns: stored.turns}};
            }
            if (method === 'turn/start') {
              const id = `turn-${row.id}`;
              row.hooks.onEvent({method: 'turn/started', params: {threadId: row.id, turn: {id, status: 'inProgress'}}});
              return {turn: {id}};
            }
            return {};
          }
        };
        const owner = createDesktopController({
          ...options,
          hostFactory: hooks => {
            if (!hooks.onEvent) return {...host, close: async () => {}};
            row.hooks = hooks;
            return host;
          },
          gatewayFactory: async gateway => {
            row.gateway = gateway;
            return {
              mcpConfig: {mcpServers: {k_gemini: {url: 'http://fake/mcp', headers: {Authorization: 'fake'}}}},
              close: async () => {}
            };
          }
        });
        owner.state.provider = 'codex';
        return owner;
      }
    });
    try {
      const opened = await c.open({model, workspace: root, effort: 'medium', accessMode: 'read-only'});
      await c.send({threadId: opened.threadId, text: 'new blank room with remaining work'});
      const source = native.find(row => row.id === opened.threadId),
        turnId = `turn-${source.id}`;
      const tool = {
        id: 'accepted-move',
        type: 'mcpToolCall',
        server: 'k_gemini',
        tool: mode === 'fresh' ? 'conversation_create' : 'conversation_continue',
        arguments: {nextInstruction: 'remaining only'}
      };
      const accepted = await source.gateway.continueConversation(
        {mode, nextInstruction: 'remaining only'},
        {'x-codex-turn-metadata': JSON.stringify({thread_id: source.id, turn_id: turnId})}
      );
      assert.equal(accepted.accepted, true);
      source.hooks.onEvent({method: 'item/started', params: {threadId: source.id, turnId, item: tool}});
      source.hooks.onEvent({
        method: 'item/completed',
        params: {threadId: source.id, turnId, item: {...tool, status: 'completed', result: accepted}}
      });
      const error = {message: 'stream failed after acceptance', codexErrorInfo: 'serverOverloaded'};
      source.turns.push({id: turnId, status, ...(status === 'failed' ? {error} : {}), items: []});
      source.hooks.onEvent({method: 'turn/completed', params: {threadId: source.id, turn: source.turns[0]}});
      const receipt = () =>
        readFile(path.join(root, '.runtime/chat-continuations', `${source.id}.json`), 'utf8').then(JSON.parse);
      await wait(async () => (await receipt()).status === 'sent');
      assert.equal(calls.filter(([method]) => method === 'thread/start').length, mode === 'fresh' ? 2 : 1);
      assert.equal(calls.filter(([method]) => method === 'thread/fork').length, mode === 'fork' ? 1 : 0);
      assert.equal(calls.filter(([method]) => method === 'turn/start').length, 2);
      source.hooks.onEvent({method: 'turn/completed', params: {threadId: source.id, turn: source.turns[0]}});
      await new Promise(r => setTimeout(r, 20));
      assert.equal(calls.filter(([method]) => ['thread/start', 'thread/fork'].includes(method)).length, 2);
    } finally {
      await c.close();
    }
  });

test('unchanged paused goal identity and reordered ended workers permit fresh handoff despite updated usage', async () => {
  const f = await fixture();
  try {
    f.source.state.goal = {
      threadId: f.opened.threadId,
      createdAt: 1,
      objective: 'remaining',
      status: 'paused',
      tokenBudget: null,
      tokensUsed: 10
    };
    f.source.state.workers = [
      {threadId: 'one', settled: true, status: 'completed'},
      {threadId: 'two', settled: true, status: 'completed'}
    ];
    await f.request('fresh');
    f.source.state.goal.tokensUsed = 20;
    f.source.state.workers.reverse();
    await f.finish('failed');
    assert.equal((await f.receipt()).status, 'sent');
    assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  } finally {
    await f.c.close();
  }
});

for (const action of ['stop', 'send', 'steer', 'queue'])
  for (const outcome of ['sent', 'uncertain'])
    test(`dispatch boundary refuses source ${action} without false cancellation when child send ends ${outcome}`, async () => {
      const f = await fixture();
      let enter, release;
      const entered = new Promise(r => (enter = r)),
        gate = new Promise(r => (release = r));
      f.blockChildSend({enter, promise: gate});
      if (outcome === 'uncertain') f.failSend(Error('native submission outcome unknown'));
      try {
        await f.request('fresh');
        f.source.state.busy = false;
        f.source.state.status = 'failed';
        f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'failed'});
        await entered;
        const before = await f.receipt();
        assert.ok(before.newThreadId);
        await assert.rejects(f.c[action]({threadId: f.opened.threadId, text: 'new human intent'}), error => {
          assert.match(error.message, /交接已送出或結果待查/);
          assert.match(error.message, new RegExp(before.newThreadId));
          return true;
        });
        assert.equal((await f.receipt()).status, 'created');
        release();
        await wait(async () => (await f.receipt()).status === outcome);
        assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
        assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
        assert.equal(
          f.calls.some(c => ['stop', 'steer', 'queue'].includes(c[0])),
          false
        );
      } finally {
        release();
        await f.c.close();
      }
    });

test('late unrelated tool names still cancel an accepted handoff without treating them as its own receipt', async () => {
  const f = await fixture();
  try {
    await f.request('fresh');
    f.source.state.tools = [{id: 'late-other', name: 'conversation_create_extra', status: 'completed'}];
    await f.finish('failed');
    assert.equal((await f.receipt()).status, 'cancelled');
    assert.equal(f.calls.length, 0);
  } finally {
    await f.c.close();
  }
});

for (const action of ['elapsed', 'stop', 'close', 'human-send', 'source-change'])
  test('accepted fresh rate cooldown ' + action + ' never replays or sends before its deadline', async () => {
    const f = await fixture();
    let notBefore,
      checks = 0;
    const prepare = f.source.prepareContinuation;
    f.source.prepareContinuation = async data => {
      checks++;
      return {...(await prepare(data)), notBefore};
    };
    try {
      await f.request('fresh');
      notBefore = Date.now() + (['elapsed', 'source-change'].includes(action) ? 250 : 30000);
      f.source.state.busy = false;
      f.source.state.status = 'failed';
      f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'failed'});
      await wait(() => checks === 1);
      await new Promise(r => setTimeout(r, 30));
      assert.equal(f.calls.filter(c => c[0] === 'start').length, 0, 'no empty room during local cooldown');
      assert.equal(f.calls.filter(c => c[0] === 'send').length, 0, 'no model generation while cooling down');
      if (action === 'elapsed') {
        await wait(() => f.calls.filter(c => c[0] === 'send').length === 1);
        assert.ok(Date.now() >= notBefore);
        assert.equal(checks, 2, 'fresh native proof again after waiting');
        await wait(async () => (await f.receipt()).status === 'sent');
      } else {
        if (action === 'source-change') {
          // A new worker invalidates the accepted snapshot while the local wait ends.
          f.source.state.workers = [{provider: 'codex', threadId: 'new-child', settled: false}];
          await wait(() => ['cancelled', 'uncertain'].includes(f.c.state.continuation?.status));
        } else if (action === 'close') await f.c.close();
        else if (action === 'stop') await f.c.stop({threadId: f.opened.threadId});
        else assert.equal((await f.c.send({threadId: f.opened.threadId, text: 'new instruction'})).sent, true);
        await new Promise(r => setTimeout(r, 30));
        assert.equal(f.calls.filter(c => c[0] === 'send' && c[1].source === 'continuation').length, 0);
        assert.equal(f.calls.filter(c => c[0] === 'start').length, 0, 'cancel before creating any child');
        assert.equal(
          (await f.receipt()).status,
          'cancelled',
          'known unsent cancellation does not permanently block future handoffs'
        );
      }
    } finally {
      await f.c.close();
    }
  });

for (const scenario of ['latest', 'earlier', 'origin'])
  test('trusted rate audit handoff human binding ' + scenario, async () => {
    const f = await fixture();
    try {
      if (scenario === 'earlier')
        f.source.state.messages.push({role: 'user', turnId: 'new-human', source: 'local', text: 'stop switching'});
      if (scenario === 'origin') {
        const dir = path.join(f.root, '.runtime/chat-continuations');
        await mkdir(dir, {recursive: true});
        await writeFile(
          path.join(dir, `${f.opened.threadId}.json`),
          JSON.stringify({kind: 'origin', sourceThreadId: f.opened.threadId, initialTurnId: 'transfer-turn'})
        );
      }
      const request = () =>
        f.source.hooks.onContinueConversation({
          mode: 'fresh',
          threadId: f.opened.threadId,
          turnId: 'audit-turn',
          authorizedHumanTurnId: 'transfer-turn',
          nextInstruction: 'read saved results, remaining only'
        });
      if (scenario !== 'latest') {
        await assert.rejects(request(), scenario === 'earlier' ? /最新真人訊息/ : /第一回合/);
        assert.equal(f.calls.length, 0);
      } else {
        await assert.rejects(
          f.source.hooks.onContinueConversation({
            mode: 'fresh',
            threadId: f.opened.threadId,
            turnId: 'audit-turn',
            nextInstruction: 'unbound background'
          }),
          /真人訊息/
        );
        assert.equal((await request()).accepted, true);
        assert.equal((await f.receipt()).turnId, 'audit-turn');
        f.source.state.busy = false;
        f.source.state.status = 'completed';
        f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'audit-turn', status: 'completed'});
        await wait(async () => (await f.receipt()).status === 'sent');
        assert.equal(f.calls.filter(x => x[0] === 'start').length, 1);
        assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
      }
    } finally {
      await f.c.close();
    }
  });

for (const route of ['accepted-before-failure', 'audit-handoff'])
  test('real controllers 429 ' + route + ' chooses one continuation route', async () => {
    await mkdir(base, {recursive: true});
    const root = await mkdtemp(path.join(base, 'rate-handoff-integration-'));
    const sourceURL = new URL('../src/desktop-controller.mjs', import.meta.url);
    let source = (await readFile(sourceURL, 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(source.split('const rateRecoveryDelay = 30000;').length - 1, 1);
    source = source
      .replace('const rateRecoveryDelay = 30000;', 'const rateRecoveryDelay = 120;')
      .replace(/from '(\.\/[^']+)'/g, (_m, r) => `from '${new URL(r, sourceURL).href}'`);
    const injected = path.join(root, 'short-cooldown.mjs');
    await writeFile(injected, source);
    const {createDesktopController: make} = await import((await import('node:url')).pathToFileURL(injected).href);
    const native = [],
      calls = [];
    let sequence = 0,
      turnSequence = 0;
    const c = createConversationController({
      root,
      sessionFactory: options => {
        const row = {id: null, hooks: null, gateway: null, turns: [], goal: null, status: 'idle'};
        native.push(row);
        let ended;
        const emit = (method, params) => row.hooks.onEvent({method, params: {threadId: row.id, ...params}});
        row.finish = (status, error) => {
          const t = row.turns.at(-1);
          Object.assign(t, {status, ...(error ? {error} : {})});
          row.status = 'idle';
          emit('turn/completed', {turn: structuredClone(t)});
        };
        const host = {
          closed: new Promise(r => (ended = r)),
          notify() {},
          waitForMcp: async () => {},
          close: async () => ended(),
          async request(method, p) {
            calls.push([method, structuredClone(p)]);
            if (method === 'model/list')
              return {
                data: [
                  {model, supportedReasoningEfforts: [{reasoningEffort: 'medium'}], defaultReasoningEffort: 'medium'}
                ]
              };
            if (method === 'account/read') return {account: {type: 'chatgpt'}};
            if (method === 'config/read') return {config: {}};
            if (method === 'thread/start') {
              row.id = `native-${++sequence}`;
              return {thread: {id: row.id, turns: []}};
            }
            if (method === 'thread/goal/get') return {goal: structuredClone(row.goal)};
            if (method === 'thread/goal/set') {
              row.goal = {threadId: row.id, createdAt: 101, tokenBudget: null, ...row.goal, ...p};
              emit('thread/goal/updated', {goal: structuredClone(row.goal)});
              return {goal: structuredClone(row.goal)};
            }
            if (method === 'thread/backgroundTerminals/list') return {data: []};
            if (method === 'thread/read')
              return {
                thread: {
                  id: row.id,
                  status: {type: row.status},
                  historyMode: 'paginated',
                  turns: structuredClone(row.turns)
                }
              };
            if (method === 'thread/turns/list') return {data: structuredClone(row.turns.slice(-1)), nextCursor: null};
            if (method === 'thread/loaded/list') return {data: native.map(x => x.id).filter(Boolean), nextCursor: null};
            if (method === 'turn/start') {
              const t = {id: `turn-${++turnSequence}`, status: 'inProgress', items: []};
              row.turns.push(t);
              row.status = 'active';
              emit('turn/started', {turn: structuredClone(t)});
              return {turn: {id: t.id}};
            }
            return {};
          }
        };
        const owner = make({
          ...options,
          hostFactory: hooks => {
            if (!hooks.onEvent) return {...host, close: async () => {}};
            row.hooks = hooks;
            return host;
          },
          gatewayFactory: async gateway => {
            row.gateway = gateway;
            return {
              mcpConfig: {mcpServers: {k_gemini: {url: 'http://fake/mcp', headers: {Authorization: 'fake'}}}},
              close: async () => {}
            };
          }
        });
        owner.state.provider = 'codex';
        return owner;
      }
    });
    try {
      const opened = await c.open({model, workspace: root, effort: 'medium', accessMode: 'read-only'});
      await c.goal({threadId: opened.threadId, objective: 'remaining fake work', status: 'blocked'});
      await c.send({threadId: opened.threadId, text: 'open a blank room and continue only remaining fake work'});
      const row = native.find(x => x.id === opened.threadId),
        failed = row.turns.at(-1).id;
      const move = () =>
        row.gateway.continueConversation(
          {mode: 'fresh', nextInstruction: 'Read saved fake results. Continue remaining only.'},
          {'x-codex-turn-metadata': {thread_id: row.id, turn_id: row.turns.at(-1).id}}
        );
      if (route === 'accepted-before-failure') assert.equal((await move()).accepted, true);
      row.finish('failed', {
        message: 'exceeded retry limit, last status: 429 Too Many Requests',
        codexErrorInfo: {responseTooManyFailedAttempts: {httpStatusCode: 429}}
      });
      if (route === 'audit-handoff') {
        await wait(() => calls.some(([m, p]) => m === 'turn/start' && p.toolOutput?.name === 'k_native_goal_recovery'));
        await wait(() => !c.state.completionPending);
        assert.equal((await move()).accepted, true);
        row.finish('completed');
      }
      const receipt = () =>
        readFile(path.join(root, '.runtime/chat-continuations', `${opened.threadId}.json`), 'utf8').then(JSON.parse);
      await wait(async () => {
        try {
          return (await receipt()).status === 'sent';
        } catch {
          return false;
        }
      });
      await new Promise(r => setTimeout(r, 250));
      assert.equal(calls.filter(([m]) => m === 'thread/start').length, 2);
      assert.equal(calls.filter(([m]) => m === 'thread/fork').length, 0);
      const audits = calls.filter(([m, p]) => m === 'turn/start' && p.toolOutput?.name === 'k_native_goal_recovery');
      assert.equal(audits.length, route === 'audit-handoff' ? 1 : 0);
      assert.equal(calls.filter(([m]) => m === 'turn/start').length, route === 'audit-handoff' ? 3 : 2);
      assert.equal((await receipt()).turnId, route === 'audit-handoff' ? row.turns.at(-1).id : failed);
    } finally {
      for (const row of native) if (row.status === 'active') row.finish('completed');
      await c.close();
    }
  });

test('a recovery turn cannot choose another core or export the conversation', async () => {
  const f = await fixture();
  try {
    const request = {mode: 'fresh', threadId: f.source.state.threadId, turnId: 'audit',
      authorizedHumanTurnId: 'transfer-turn', nextInstruction: '接續未完工作'};
    for (const selection of [{model: 'deepseek-v4-flash'}, {transcript: true}, {targetWorkspace: f.root}])
      await assert.rejects(f.source.hooks.onContinueConversation({...request, ...selection}), /本回合真人直接指定/);
    await assert.rejects(f.receipt(), {code: 'ENOENT'});
  } finally {
    await f.c.close();
  }
});

for (const [provider, event, expected] of [
  ['grok', {name: 'Use Tool', details: {tool_name: 'k_luna__conversation_create'}}, 'sent'],
  ['gemini', {name: 'call_mcp_tool', details: {ServerName: 'k_luna', ToolName: 'conversation_create'}}, 'sent'],
  ['gemini', {name: 'call_mcp_tool', details: {ServerName: 'other', ToolName: 'conversation_create'}}, 'cancelled'],
  ['grok', {name: 'another_conversation_create'}, 'cancelled']
]) test(`late ${provider} tool event ${JSON.stringify(event)}: ${expected}`, async () => {
  const f = await fixture();
  try {
    f.source.state.provider = provider;
    f.source.state.model = provider === 'grok' ? 'grok-4.7' : 'gemini-3.8-flash';
    assert.equal((await f.request('fresh')).accepted, true);
    f.source.state.tools = [{id: 'late', ...event}];
    await f.finish();
    assert.equal((await f.receipt()).status, expected);
  } finally {
    await f.c.close();
  }
});

test('a cross-core ACP room reports a selectable effort and accepts null for models without an effort', async () => {
  const f = await fixture();
  try {
    const row = {provider: 'grok', model: 'grok-4.7', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high'};
    f.source.models = async () => ({models: [row]});
    const request = {mode: 'fresh', threadId: f.source.state.threadId, turnId: 'transfer-turn',
      model: row.model, nextInstruction: '交接', effort: null};
    await assert.rejects(f.source.hooks.onContinueConversation(request), /推理程度/);
    row.supportedReasoningEfforts = [];
    row.defaultReasoningEffort = null;
    assert.equal((await f.source.hooks.onContinueConversation(request)).targetEffort, null);
  } finally {
    await f.c.close();
  }
});

test('a GPT room moves to a fresh Claude room from the cross-core catalog, mapped permission and transcript', async () => {
  const f = await fixture();
  try {
    f.source.state.accessMode = 'danger-full-access';
    f.source.state.title = 'GPT 來源房';
    f.source.state.messages.unshift({role: 'assistant', turnId: 'old', text: '舊回覆全文'});
    f.source.models = async () => ({
      models: [
        {
          model: 'claude-opus-5-5',
          provider: 'claude',
          supportedReasoningEfforts: [{reasoningEffort: 'high'}, {reasoningEffort: 'xhigh'}],
          defaultReasoningEffort: 'high'
        },
        {model: 'claude-hidden', provider: 'claude', hidden: true, supportedReasoningEfforts: []}
      ]
    });
    await assert.rejects(
      f.source.hooks.onContinueConversation({
        mode: 'fresh',
        threadId: f.source.state.threadId,
        turnId: 'transfer-turn',
        nextInstruction: 'x',
        model: 'claude-hidden'
      }),
      /不在目標核心目前可用的原生目錄/
    );
    const accepted = await f.source.hooks.onContinueConversation({
      mode: 'fresh',
      threadId: f.source.state.threadId,
      turnId: 'transfer-turn',
      nextInstruction: '交給 Opus 做剩下的審查',
      model: 'claude-opus-5-5',
      transcript: true
    });
    assert.deepEqual(
      [accepted.targetModel, accepted.targetEffort, accepted.targetAccessMode, accepted.transcript],
      ['claude-opus-5-5', 'high', 'claude-bypassPermissions', true]
    );
    await assert.rejects(
      f.source.hooks.onContinueConversation({
        mode: 'fresh',
        threadId: f.source.state.threadId,
        turnId: 'transfer-turn',
        nextInstruction: '交給 Opus 做剩下的審查',
        model: 'claude-opus-5-5'
      }),
      /參數衝突/
    );
    await f.finish();
    await wait(() => f.calls.filter(c => c[0] === 'send').length === 1);
    const child = f.owners.find(o => o.state.threadId === f.c.state.threadId);
    assert.equal(child.state.model, 'claude-opus-5-5');
    assert.equal(child.state.effort, 'high');
    assert.equal(child.state.accessMode, 'claude-bypassPermissions');
    const sent = f.calls.find(c => c[0] === 'send')[1];
    assert.match(sent.text, /跨核心換房：原聊天室是 codex（gpt-6\.1-sol），新聊天室是 claude（claude-opus-5-5）/);
    const index = await readFile(/索引：(.+?index\.md)/.exec(sent.text)[1], 'utf8');
    assert.match(index, /共 2 則訊息、1 頁/);
    const page = await readFile(index.split('\n').find(line => line.endsWith('page-001.md')).slice(2), 'utf8');
    assert.match(page, /舊回覆全文/);
    assert.match(page, /換一間接著做/);
    assert.equal((await f.receipt()).status, 'sent');
  } finally {
    await f.c.close();
  }
});

// ---- A fresh room in another registered project (targetWorkspace) ----

// Registered projects next to the source workspace: the target, an archived one, two with the same name, a
// link whose registered path now resolves elsewhere and one that was removed. A folder that only an old
// conversation used, and the state root, are never registrations.
async function projectFixture(f) {
  const make = async name => realpath(await mkdtemp(path.join(base, `${name}-`)));
  const social = await make('social'),
    archived = await make('archived'),
    dupA = await make('dup'),
    dupB = await make('dup'),
    away = await make('away'),
    loose = await make('loose'),
    missing = path.join(await make('gone'), 'removed'),
    link = path.join(await make('links'), 'linked');
  await symlink(away, link, process.platform === 'win32' ? 'junction' : 'dir');
  const projects = [
    {path: social, name: 'ExampleOps 社群'},
    {path: archived, name: '舊專案', archived: true},
    {path: dupA, name: '重複'},
    {path: dupB, name: '重複'},
    {path: link, name: '連結專案'},
    {path: missing, name: '已移除'}
  ];
  const save = rows => writeFile(path.join(f.root, '.runtime/projects.json'), JSON.stringify(rows, null, 2));
  await mkdir(path.join(f.root, '.runtime'), {recursive: true});
  await save(projects);
  await saveMainSession(f.root, {threadId: 'old-loose-room', provider: 'codex', model, workspace: loose, title: '舊房'});
  const ask = extra =>
    f.source.hooks.onContinueConversation({
      mode: 'fresh',
      threadId: f.source.state.threadId,
      turnId: 'transfer-turn',
      nextInstruction: '把社群貼文草稿做完',
      ...extra
    });
  return {social, archived, dupA, dupB, link, loose, missing, projects, save, ask};
}
const absent = file => assert.rejects(lstat(file), {code: 'ENOENT'});
const gptModels = async () => ({
  models: [
    {
      model: 'gpt-6.2-sol',
      provider: 'codex',
      supportedReasoningEfforts: [{reasoningEffort: 'medium'}, {reasoningEffort: 'high'}],
      defaultReasoningEffort: 'medium'
    }
  ]
});

test('a Claude room opens GPT-6.2 Sol high in another registered project; the source room stays and no files are copied', async () => {
  const f = await fixture();
  try {
    const p = await projectFixture(f);
    Object.assign(f.source.state, {provider: 'claude', model: 'claude-opus-5-5', effort: 'high', accessMode: 'claude-bypassPermissions'});
    f.source.state.workerPolicy = {model: 'auto', effort: 'auto'};
    f.source.models = gptModels;
    const selection = {model: 'gpt-6.2-sol', effort: 'high', targetWorkspace: 'exampleops 社群'};
    const accepted = await p.ask(selection);
    assert.deepEqual(
      [accepted.accepted, accepted.targetModel, accepted.targetEffort, accepted.targetAccessMode, accepted.targetWorkspace, accepted.targetWorkspaceName],
      [true, 'gpt-6.2-sol', 'high', 'danger-full-access', p.social, 'ExampleOps 社群']
    );
    // The same request again is the same receipt; another target, or none, is a conflict.
    assert.equal((await p.ask(selection)).targetWorkspace, p.social);
    for (const changed of [{...selection, targetWorkspace: p.social}, {model: 'gpt-6.2-sol', effort: 'high'}])
      await assert.rejects(p.ask(changed), /參數衝突/);
    const stored = await f.receipt();
    assert.deepEqual(
      [stored.requestedTargetWorkspace, stored.targetWorkspace, stored.targetWorkspaceName, stored.status],
      ['exampleops 社群', p.social, 'ExampleOps 社群', 'pending']
    );
    await f.finish();
    await wait(() => f.calls.filter(c => c[0] === 'send').length === 1);
    const child = f.owners.find(o => o.state.threadId === f.c.state.threadId);
    assert.notEqual(child, f.source);
    assert.deepEqual(
      [child.state.workspace, child.state.model, child.state.effort, child.state.accessMode],
      [p.social, 'gpt-6.2-sol', 'high', 'danger-full-access']
    );
    assert.deepEqual(child.state.workerPolicy, f.source.state.workerPolicy);
    assert.equal(f.source.state.workspace, f.root);
    const sessions = (await listMainSessions(f.root)).sessions;
    assert.equal(sessions.find(s => s.threadId === f.opened.threadId).workspace, f.root);
    assert.equal(sessions.find(s => s.threadId === child.state.threadId).workspace, p.social);
    const sent = f.calls.find(c => c[0] === 'send')[1];
    assert.match(sent.text, /在另一個已登記專案「ExampleOps 社群」/);
    assert.match(sent.text, /原聊天室留在原專案/);
    assert.match(sent.text, /原專案的檔案沒有複製過來/);
    assert.match(sent.text, /把社群貼文草稿做完/);
    assert.doesNotMatch(sent.text, /索引：|同專案新聊天室/);
    await absent(path.join(p.social, '.runtime'));
    await absent(path.join(f.root, '.runtime/handoffs'));
    assert.equal((await f.receipt()).status, 'sent');
    assert.equal((await f.receipt(child.state.threadId)).handoffFrom, f.opened.threadId);
  } finally {
    await f.c.close();
  }
});

test('a requested transcript for another project is written in the target project only', async () => {
  const f = await fixture();
  try {
    const p = await projectFixture(f);
    f.source.state.messages.unshift({role: 'assistant', turnId: 'old', text: '舊回覆全文'});
    const accepted = await p.ask({targetWorkspace: p.social, transcript: true});
    assert.deepEqual([accepted.targetWorkspace, accepted.transcript], [p.social, true]);
    await f.finish();
    await wait(() => f.calls.filter(c => c[0] === 'send').length === 1);
    const sent = f.calls.find(c => c[0] === 'send')[1];
    const indexPath = /索引：(.+?index\.md)/.exec(sent.text)[1];
    assert.ok(indexPath.startsWith(path.join(p.social, '.runtime', 'handoffs') + path.sep), indexPath);
    const index = await readFile(indexPath, 'utf8');
    const page = await readFile(index.split('\n').find(line => line.endsWith('page-001.md')).slice(2), 'utf8');
    assert.match(page, /舊回覆全文/);
    assert.match(page, /換一間接著做/);
    await absent(path.join(f.root, '.runtime/handoffs'));
    assert.equal(f.owners.find(o => o.state.threadId === f.c.state.threadId).state.workspace, p.social);
  } finally {
    await f.c.close();
  }
});

test('archived, unknown, ambiguous, unregistered, inferred, retargeted and removed projects are refused before acceptance', async () => {
  const f = await fixture();
  try {
    const p = await projectFixture(f);
    // listProjects treats the state root and an old room's folder as known; a target must be a registration.
    const known = (await listProjects(f.root, (await listMainSessions(f.root)).sessions)).projects.map(row => row.path);
    assert.ok(known.includes(p.loose) && known.includes(f.root));
    for (const [targetWorkspace, pattern] of [
      ['不存在的專案', /不是已登記的專案/],
      ['舊專案', /已封存/],
      [p.archived, /已封存/],
      ['重複', /對到不只一個/],
      [p.loose, /不是已登記的專案/],
      [f.root, /不是已登記的專案/],
      ['social', /不是已登記的專案/],
      [p.link, /經連結指向別處/],
      ['已移除', /目前無法使用/],
      [' ', /projects 名稱或絕對路徑/]
    ]) {
      await assert.rejects(p.ask({targetWorkspace}), pattern, String(targetWorkspace));
      await assert.rejects(f.receipt(), {code: 'ENOENT'});
    }
    // A path picks exactly one of the same-named projects.
    assert.equal((await p.ask({targetWorkspace: p.dupB})).targetWorkspace, p.dupB);
    await assert.rejects(f.request('fork'), /模式衝突/);
  } finally {
    await f.c.close();
  }
});

test('the only active project with a listed name wins even if archived projects share its name', async () => {
  const f = await fixture();
  try {
    const p = await projectFixture(f);
    const name = '社群編輯';
    const archived = [p.archived, p.dupA].map(path => ({path, name, archived: true}));
    await p.save(archived);
    await assert.rejects(p.ask({targetWorkspace: name}), /已封存/);
    await p.save([...archived, {path: p.social, name}]);
    const list = await f.source.hooks.roomTools.list(f.source.state.threadId);
    assert.deepEqual(list.projects, [{name, path: p.social}]);
    await assert.rejects(p.ask({targetWorkspace: p.archived}), /已封存/);
    assert.equal((await p.ask({targetWorkspace: name})).targetWorkspace, p.social);
  } finally {
    await f.c.close();
  }
});

test('a history branch cannot choose another project', async () => {
  const f = await fixture();
  try {
    const p = await projectFixture(f);
    await assert.rejects(p.ask({mode: 'fork', targetWorkspace: p.social}), /歷史分支不支援/);
    await assert.rejects(f.receipt(), {code: 'ENOENT'});
  } finally {
    await f.c.close();
  }
});

test('a target archived after acceptance cancels before any room is created', async () => {
  const f = await fixture();
  try {
    const p = await projectFixture(f);
    await p.ask({targetWorkspace: 'ExampleOps 社群'});
    await p.save(p.projects.map(row => (row.path === p.social ? {...row, archived: true} : row)));
    await f.finish();
    const receipt = await f.receipt();
    assert.equal(receipt.status, 'cancelled');
    assert.match(receipt.error, /尚未建立新聊天室；目標專案已無法核實：專案「ExampleOps 社群」已封存/);
    assert.equal(receipt.newThreadId, undefined);
    assert.equal(f.calls.filter(c => ['start', 'send'].includes(c[0])).length, 0);
    assert.equal(f.c.state.threadId, f.opened.threadId);
    await absent(path.join(p.social, '.runtime'));
  } finally {
    await f.c.close();
  }
});

test('a target unregistered while the new room opens keeps the known room and sends nothing', async () => {
  const f = await fixture();
  let entered, release;
  const opening = new Promise(r => (entered = r)),
    gate = new Promise(r => (release = r));
  f.blockChildOpen({enter: entered, promise: gate});
  try {
    const p = await projectFixture(f);
    await p.ask({targetWorkspace: 'ExampleOps 社群'});
    f.source.state.busy = false;
    f.source.state.status = 'completed';
    f.source.hooks.onConversationSettled({threadId: f.opened.threadId, turnId: 'transfer-turn', status: 'completed'});
    await opening;
    await p.save(p.projects.filter(row => row.path !== p.social));
    release();
    await wait(async () => (await f.receipt()).status === 'cancelled');
    const receipt = await f.receipt();
    assert.ok(receipt.newThreadId);
    assert.equal(receipt.started, false);
    assert.match(receipt.error, /已建立；目標專案已無法核實/);
    assert.equal(f.calls.filter(c => c[0] === 'send').length, 0);
  } finally {
    release();
    await f.c.close();
  }
});

test('room_list adds registered unarchived projects, including ones without a room, and nothing inferred', async () => {
  const f = await fixture();
  try {
    const p = await projectFixture(f);
    const listed = await f.source.hooks.roomTools.list(f.source.state.threadId);
    assert.deepEqual(listed.projects, [
      {name: 'ExampleOps 社群', path: p.social},
      {name: '重複', path: p.dupA},
      {name: '重複', path: p.dupB},
      {name: '連結專案', path: p.link},
      {name: '已移除', path: p.missing}
    ]);
    assert.ok(listed.rooms.some(row => row.threadId === 'old-loose-room'));
    await writeFile(path.join(f.root, '.runtime/projects.json'), '{broken');
    const broken = await f.source.hooks.roomTools.list(f.source.state.threadId);
    assert.deepEqual(broken.projects, []);
    assert.match(broken.projectsError, /專案清單無法讀取/);
    assert.ok(Array.isArray(broken.rooms));
  } finally {
    await f.c.close();
  }
});
