import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {mkdtemp, readFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {createConversationController} from '../src/conversation-controller.mjs';
import {createClaudeController} from '../src/claude-controller.mjs';
import {createLunaGateway} from '../src/luna-gateway.mjs';
import {listMainSessions} from '../src/main-sessions.mjs';
import {scratchBase} from './scratch.mjs';

const model = 'claude-opus-5-5';
async function fixture(existingRoot) {
  const root = existingRoot ?? (await mkdtemp(path.join(scratchBase, 'room-rename-')));
  const natives = new Map();
  const controller = createConversationController({
    root,
    inspect: async () => ({available: true}),
    codexFactory: () => ({
      state: {workspace: root, messages: [], tools: [], workers: [], questions: []},
      selectWorkspace: async () => ({path: root}),
      workers: async () => [],
      close: async () => {}
    }),
    claudeFactory: options => {
      let native, hooks, gateway;
      native = createClaudeController({
        ...options,
        workerCatalog: async () => ({models: []}),
        commandSpec: {command: 'unused-fake-claude', argsPrefix: []},
        bridgeFactory: async () => ({list: async () => [], close: async () => {}}),
        gatewayFactory: async settings => {
          gateway = await createLunaGateway(settings);
          return gateway;
        },
        hostFactory: async settings => {
          hooks = settings;
          let resolveClosed;
          const host = {
            closed: new Promise(resolve => {
              resolveClosed = resolve;
            }),
            start: async () => {},
            interrupt: async () => {},
            close: async () => resolveClosed()
          };
          natives.set(native.state.threadId, {native, emit: hooks.onMessage, gateway});
          return host;
        }
      });
      return native;
    }
  });
  const open = async threadId => {
    const result = await controller.open({model, ...(threadId ? {threadId} : {}), accessMode: 'claude-manual'});
    return result.threadId;
  };
  const rename = async (threadId, args) => {
    const server = Object.values(natives.get(threadId).gateway.mcpConfig.mcpServers)[0];
    const response = await fetch(server.url, {
      method: 'POST',
      headers: {...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream'},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {name: 'luna_room_rename', arguments: args}
      })
    });
    const raw = await response.text();
    return JSON.parse(
      raw
        .split(/\r?\n/u)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n') || raw
    );
  };
  const row = async id => (await listMainSessions(root)).sessions.find(item => item.threadId === id);
  return {root, controller, natives, open, rename, row};
}

test('HTTP rename follows the running source room across navigation and survives Claude completion and reopen', async () => {
  const f = await fixture();
  try {
    const a = await f.open();
    const idle = await f.rename(a, {title: 'idle rejected'});
    assert.equal(idle.result.isError, true);
    await f.controller.send({threadId: a, text: 'original source title'});
    const b = await f.open();
    await f.controller.metadata({threadId: b, title: 'other room'});
    assert.equal(f.controller.state.threadId, b);
    for (const args of [
      {title: ''},
      {title: ' \t\n'},
      {title: 'x'.repeat(121)},
      {title: 'bad', targetThreadId: b},
      {}
    ]) {
      const result = await f.rename(a, args);
      assert.ok(result.error || result.result?.isError, JSON.stringify(result));
      assert.equal((await f.row(a)).title, 'original source title');
      assert.equal((await f.row(b)).title, 'other room');
    }
    const title = '社群排程(不能刪除)';
    const result = await f.rename(a, {title});
    assert.deepEqual(result.result.structuredContent, {threadId: a, title});
    assert.equal(f.controller.state.threadId, b);
    assert.equal(f.controller.state.title, 'other room');
    assert.equal((await f.row(a)).title, title);
    f.natives.get(a).emit({type: 'assistant', uuid: 'answer', message: {content: [{type: 'text', text: 'done'}]}});
    f.natives.get(a).emit({type: 'result', is_error: false});
    assert.equal((await f.rename(a, {title: 'completed rejected'})).result.isError, true);
    await f.controller.close();
    // A new native controller reads the actual projection and common session record.
    const reopened = await fixture(f.root);
    try {
      await reopened.open(a);
      assert.equal(reopened.controller.state.title, title);
      assert.equal((await reopened.row(a)).title, title);
      assert.equal((await reopened.row(b)).title, 'other room');
    } finally {
      await reopened.controller.close();
    }
  } finally {
    await f.controller.close();
  }
});

test('Claude rename refuses observed native agents until authoritative settlement', async () => {
  const f = await fixture();
  try {
    const id = await f.open();
    await f.controller.send({threadId: id, text: 'original'});
    const {emit} = f.natives.get(id);
    emit({
      type: 'assistant',
      uuid: 'agent-call',
      message: {
        content: [{type: 'tool_use', id: 'agent-1', name: 'Agent', input: {description: 'test', prompt: 'test'}}]
      }
    });
    let response = await f.rename(id, {title: 'child cannot rename'});
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /原生子代理/);
    emit({
      type: 'assistant',
      uuid: 'child-event',
      parent_tool_use_id: 'agent-1',
      message: {content: [{type: 'text', text: 'working'}]}
    });
    emit({
      type: 'user',
      uuid: 'ambiguous-result',
      message: {content: [{type: 'tool_result', tool_use_id: 'agent-1', content: 'done'}]}
    });
    response = await f.rename(id, {title: 'unsettled cannot rename'});
    assert.equal(response.result.isError, true);
    assert.equal((await f.row(id)).title, 'original');
    emit({
      type: 'user',
      uuid: 'settled-result',
      tool_use_result: {
        status: 'completed',
        agentId: 'native-agent',
        content: [],
        totalToolUseCount: 1,
        totalDurationMs: 1,
        totalTokens: 1,
        usage: {input_tokens: 1, output_tokens: 0}
      },
      message: {content: [{type: 'tool_result', tool_use_id: 'agent-1', content: 'done'}]}
    });
    response = await f.rename(id, {title: 'parent can rename'});
    assert.equal(response.result.isError, undefined);
    assert.equal((await f.row(id)).title, 'parent can rename');
    emit({type: 'result', is_error: false});
  } finally {
    await f.controller.close();
  }
});

test('Claude rename allows a native background shell command during the main turn', async () => {
  const f = await fixture();
  let emit;
  try {
    const id = await f.open();
    await f.controller.send({threadId: id, text: 'original'});
    ({emit} = f.natives.get(id));
    emit({
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_bash',
      task_id: 'background-command',
      tool_use_id: 'bash-1',
      description: 'simulated long command'
    });
    const command = () =>
      f.natives.get(id).native.state.workers.find(worker => worker.nativeTaskId === 'background-command');
    assert.equal(command().kind, 'command');
    assert.equal(command().settled, false);
    const response = await f.rename(id, {title: 'rename while command runs'});
    assert.deepEqual(response.result.structuredContent, {threadId: id, title: 'rename while command runs'});
    assert.equal((await f.row(id)).title, 'rename while command runs');
    assert.equal(command().settled, false, 'rename must not interrupt or settle the command');
  } finally {
    emit?.({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'background-command',
      tool_use_id: 'bash-1',
      status: 'completed',
      summary: 'done'
    });
    emit?.({type: 'result', is_error: false});
    await f.controller.close();
  }
});

test('partial rename persistence is reported as unconfirmed without a false not-written guarantee', async t => {
  const f = await fixture();
  let patched;
  try {
    const id = await f.open();
    await f.controller.send({threadId: id, text: 'original'});
    const destination = path.resolve(f.root, '.runtime/main-sessions', `${id}-current.json`);
    const original = fs.rename;
    patched = t.mock.method(fs, 'rename', async (from, to) => {
      if (path.resolve(to) === destination) throw Object.assign(Error('injected metadata disk failure'), {code: 'EIO'});
      return original(from, to);
    });
    syncBuiltinESMExports();
    const result = await f.rename(id, {title: 'partly saved'});
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent, undefined);
    assert.match(result.result.content[0].text, /Rename not confirmed; storage may have changed/);
    assert.doesNotMatch(result.result.content[0].text, /Not written/);
    assert.doesNotMatch(result.result.content[0].text, /Read back/i);
    assert.match(result.result.content[0].text, /Do not retry automatically; tell the human to check the title/);
    assert.equal((await f.row(id)).title, 'original');
    const projection = JSON.parse(await readFile(path.join(f.root, '.runtime/claude-sessions', `${id}.json`), 'utf8'));
    assert.equal(projection.title, 'partly saved', 'first storage write succeeded before the second failed');
  } finally {
    patched?.mock.restore();
    syncBuiltinESMExports();
    for (const {emit} of f.natives.values()) emit({type: 'result', is_error: false});
    await f.controller.close();
  }
});
