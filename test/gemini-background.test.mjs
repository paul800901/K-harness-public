import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createGeminiController} from '../src/gemini-controller.mjs';
import {geminiToolGuidance} from '../src/gemini-worker.mjs';
import {scratchBase} from './scratch.mjs';

const until = async check => {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('timed out');
};

async function fixture({prompt, setup, onClose, closeFails = false, killFails = false} = {}) {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'gemini-background-'));
  const sessionId = randomUUID(),
    requests = [],
    released = [],
    killed = [],
    agents = [];
  let options,
    acquisitions = 0,
    prompts = 0,
    closes = 0;
  const update = u => options.onNotification({method: 'session/update', params: {sessionId, update: u}});
  const text = value => update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: value}});
  const echo = value => update({sessionUpdate: 'user_message_chunk', content: {type: 'text', text: value}});
  const command = (id = 'slow') =>
    update({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress'
    });
  const complete = (id = 'slow', status = 'completed') =>
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status,
      content: [{type: 'content', content: {type: 'text', text: 'native result'}}]
    });
  const c = createGeminiController({
    root,
    stopGraceMs: 10,
    loginFactory: () => ({status: async () => ({available: true, models: ['gemini-3.8-flash-low']})}),
    accounts: {
      inspect: fn => fn(),
      acquire: async () => {
        acquisitions++;
        return {accountId: 'a'.repeat(32), release: async info => released.push(info)};
      }
    },
    killTree: async pid => {
      killed.push(pid);
      if (killFails) throw Error('kill unknown');
    },
    openAgent: async opts => {
      options = opts;
      let end;
      const agent = {
        pid: 3100 + agents.length,
        exited: false,
        closed: new Promise(resolve => {
          end = resolve;
        }),
        end() {
          this.exited = true;
          end({code: 0});
        },
        async request(method, params) {
          requests.push({method, params});
          if (method === 'session/new') return {sessionId};
          if (method === 'session/prompt') {
            prompts++;
            if (prompt) return prompt({number: prompts, text, echo, command, complete, params, update});
            echo('user');
            command();
            text('background');
            return {stopReason: 'end_turn'};
          }
          await setup?.({method, prompts});
          return {};
        },
        notify() {},
        async close() {
          closes++;
          await onClose?.();
          if (closeFails) throw Error('stop unknown');
          this.end();
        }
      };
      agents.push(agent);
      return agent;
    }
  });
  await c.open({model: 'gemini-3.8-flash', effort: 'low'});
  return {
    c,
    root,
    requests,
    released,
    killed,
    agents,
    update,
    complete,
    get closes() {
      return closes;
    },
    get acquisitions() {
      return acquisitions;
    },
    permission: params => options.onRequest({method: 'session/request_permission', params: {sessionId, ...params}}),
    async send(value = 'user') {
      await c.send({text: value});
      await until(() => !c.state.busy);
    },
    allowKill() {
      killFails = false;
    },
    async cleanup() {
      closeFails = false;
      killFails = false;
      await c.close();
    }
  };
}

test('reply before native command completion keeps process and lease; next prompt drains old result without resume or replay', async () => {
  const f = await fixture({
    prompt({number, text, echo, command, complete}) {
      if (number === 1) {
        echo('first');
        command();
        text('background');
      } else {
        complete();
        text('background finished');
        echo('second');
        text('second answer');
      }
      return {stopReason: 'end_turn'};
    }
  });
  try {
    await f.send('first');
    assert.equal(f.closes, 0);
    assert.equal(f.released.length, 0);
    assert.equal(f.c.state.status, 'completed');
    assert.equal(f.c.state.workers[0].kind, 'command');
    assert.equal(f.c.state.workers[0].settled, false);
    assert.equal(f.c.state.tools[0].status, 'running');
    await assert.rejects(f.c.open({model: 'gemini-3.8-flash'}), /背景命令/);
    await assert.rejects(f.c.selectWorkspace({path: f.root}), /背景命令/);
    await assert.rejects(
      f.c.send({text: 'new permission', accessMode: 'read-only'}),
      e => e.notSent && /權限/.test(e.message)
    );
    f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'Idle update. '}});
    const idleReply = f.c.state.messages.at(-1);
    assert.equal(idleReply.text, 'Idle update. ');
    assert.ok(idleReply.partial && !idleReply.completedAt);
    await f.send('second');
    assert.equal(f.agents.length, 1);
    assert.equal(f.acquisitions, 1);
    assert.equal(f.requests.filter(r => r.method === 'session/resume').length, 0);
    assert.equal(f.requests.filter(r => r.method === 'session/prompt').length, 2);
    assert.equal(f.closes, 1);
    assert.deepEqual(f.released, [{settled: true, refresh: true}]);
    assert.equal(f.c.state.workers[0].status, 'completed');
    assert.equal(f.c.state.tools[0].status, 'completed');
    assert.deepEqual(
      f.c.state.messages.map(m => m.text),
      ['first', 'background', 'Idle update. background finished', 'second', 'second answer']
    );
    assert.equal(f.c.state.messages[2].groupId, f.c.state.messages[0].groupId);
    for (const reply of f.c.state.messages.filter(m => m.role === 'assistant'))
      assert.ok(reply.completedAt && !reply.partial && !reply.streaming);
    const saved = JSON.parse(
      await readFile(path.join(f.root, '.runtime/gemini-sessions', `${f.c.state.threadId}.json`))
    );
    assert.equal(saved.tools[0].status, 'completed');
    assert.equal(saved.messages[2].completedAt, f.c.state.messages[2].completedAt);
  } finally {
    await f.cleanup();
  }
});

test('Gemini preserves text without reporting completion after cancellation or truncation', async () => {
  for (const [reason, status] of [['cancelled', 'interrupted'], ['max_tokens', 'failed']]) {
    const f = await fixture({
      prompt({text}) {
        text('unfinished');
        return {stopReason: reason};
      }
    });
    try {
      await f.send();
      const reply = f.c.state.messages.at(-1);
      assert.equal(f.c.state.status, status);
      assert.equal(reply.text, 'unfinished');
      assert.ok(reply.partial && !reply.completedAt && !reply.streaming);
    } finally {
      await f.cleanup();
    }
  }
});

test('another user turn while command runs uses same process; rejected preparation retains the original lease', async () => {
  const f = await fixture({
    prompt({number, echo, text, command}) {
      echo('user');
      if (number === 1) command();
      text(`answer ${number}`);
      return {stopReason: 'end_turn'};
    }
  });
  try {
    await f.send();
    await assert.rejects(f.c.send({text: 'bad attachment', attachmentIds: ['missing']}));
    assert.equal(f.released.length, 0);
    await f.send('another');
    assert.equal(f.agents.length, 1);
    assert.equal(f.closes, 0);
    assert.equal(f.c.state.workers.length, 1);
    await f.c.stop();
    assert.equal(f.closes, 1);
    assert.equal(f.c.state.workers[0].status, 'stopped');
    assert.match(f.c.state.workers[0].output, /已停止/);
    assert.equal(f.c.state.tools[0].status, 'interrupted');
    assert.equal(f.c.state.status, 'interrupted');
    assert.equal(f.released[0].settled, true);
  } finally {
    await f.cleanup();
  }
});

test('RPC failure on next prompt or setup does not terminate earlier background command or replay it', async () => {
  for (const failAt of ['setup', 'prompt']) {
    const f = await fixture({
      setup({method, prompts}) {
        if (failAt === 'setup' && prompts && method === 'session/set_model') throw Error('set_model failed');
      },
      prompt({number, command, text, echo}) {
        if (number > 1) {
          text('wake without prompt echo');
          throw Error('prompt failed');
        }
        echo('first');
        command();
        text('background');
        return {stopReason: 'end_turn'};
      }
    });
    try {
      await f.send();
      await f.send('second');
      assert.equal(f.c.state.status, 'failed');
      const wake = f.c.state.messages.find(row => row.text === 'wake without prompt echo');
      if (failAt === 'prompt') assert.ok(wake?.partial && !wake.streaming && !wake.completedAt);
      else assert.equal(wake, undefined);
      assert.equal(f.closes, 0);
      assert.equal(f.released.length, 0);
      assert.equal(f.c.state.workers[0].settled, false);
      assert.equal(f.agents.length, 1);
    } finally {
      await f.cleanup();
    }
  }
});

test('held process exit is unknown command result, releases lease once, never replays, and blocks new work', async () => {
  const f = await fixture();
  try {
    await f.send();
    f.agents[0].end();
    await until(() => f.released.length === 1);
    assert.equal(f.c.state.status, 'uncertain');
    assert.equal(f.c.state.workers[0].status, 'ended');
    assert.match(f.c.state.workers[0].output, /結果未知/);
    await assert.rejects(f.c.send({text: 'again'}));
    assert.equal(f.requests.filter(r => r.method === 'session/prompt').length, 1);
    assert.equal(f.released[0].settled, true);
  } finally {
    await f.cleanup();
  }
});

test('unconfirmed held stop remains unresolved and close cannot report offline; later verified stop settles workers', async () => {
  const f = await fixture({closeFails: true, killFails: true});
  try {
    await f.send();
    await f.c.stop();
    assert.equal(f.c.state.status, 'uncertain');
    assert.equal(f.c.state.workers[0].settled, false);
    assert.equal(f.c.state.workers[0].status, 'unresolved');
    assert.deepEqual(f.released, [{settled: false, refresh: true}]);
    await assert.rejects(f.c.send({text: 'again'}));
    await assert.rejects(f.c.close(), /kill unknown/);
    assert.equal(f.c.state.status, 'uncertain');
    f.allowKill();
    await f.c.stop();
    assert.deepEqual(f.killed, [3100, 3100]);
    assert.equal(f.c.state.workers[0].settled, true);
    assert.match(f.c.state.workers[0].output, /已停止/);
    assert.doesNotMatch(f.c.state.workers[0].output, /停止尚未確認/);
  } finally {
    await f.cleanup();
  }
});

test('held permission handler keeps native workspace restrictions; two room owners stay isolated', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    await a.send();
    await b.send();
    const options = [
      {optionId: 'yes', kind: 'allow_once'},
      {optionId: 'no', kind: 'reject_once'}
    ];
    const answer = await a.permission({
      toolCall: {name: 'run_command', rawInput: {CommandLine: 'echo hi', BypassSandbox: true}},
      options
    });
    assert.notEqual(answer.outcome.optionId, 'yes');
    await a.c.stop();
    assert.equal(b.closes, 0);
    assert.equal(b.c.state.workers[0].settled, false);
    assert.equal(b.released.length, 0);
    const late = await a.permission({toolCall: {name: 'run_command'}, options});
    assert.equal(late.outcome.outcome, 'cancelled');
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('stop awaiting process exit blocks another send or reconfiguration and concurrent stops share one close', async () => {
  let finishClose;
  const closing = new Promise(resolve => {
    finishClose = resolve;
  });
  const f = await fixture({onClose: () => closing});
  try {
    await f.send();
    const stop = f.c.stop();
    await until(() => f.closes === 1);
    const otherStop = f.c.stop();
    await assert.rejects(f.c.send({text: 'race'}), e => e.notSent === true);
    await assert.rejects(f.c.selectWorkspace({path: f.root}));
    finishClose();
    await Promise.all([stop, otherStop]);
    assert.equal(f.closes, 1);
    assert.equal(f.released.length, 1);
    assert.equal(f.requests.filter(r => r.method === 'session/prompt').length, 1);
  } finally {
    finishClose();
    await f.cleanup();
  }
});

test('native failed completion settles original command as failed and normal close stops a held command', async () => {
  const f = await fixture({
    prompt({number, text, echo, command, complete}) {
      if (number === 1) command();
      else complete('slow', 'failed');
      echo('user');
      text('reply');
      return {stopReason: 'end_turn'};
    }
  });
  try {
    await f.send();
    await f.send();
    assert.equal(f.c.state.tools[0].status, 'failed');
    assert.equal(f.c.state.workers[0].status, 'failed');
    assert.equal(f.c.state.workers[0].settled, true);
  } finally {
    await f.cleanup();
  }
  const held = await fixture();
  await held.send();
  await held.c.close();
  assert.equal(held.closes, 1);
  assert.equal(held.c.state.status, 'offline');
  assert.equal(held.c.state.workers[0].status, 'stopped');
  assert.equal(held.released[0].settled, true);
});

test('ACP guidance distinguishes retained main process from print workers', () => {
  assert.match(geminiToolGuidance('workspace-write', null, {acp: true}), /保留同一程序/);
  assert.match(geminiToolGuidance('workspace-write'), /print 程序/);
});
