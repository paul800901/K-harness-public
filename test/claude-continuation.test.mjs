import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createClaudeController} from '../src/claude-controller.mjs';
import {createClaudeWorker} from '../src/claude-worker.mjs';
import {createLunaGateway} from '../src/luna-gateway.mjs';
import {listMainSessions} from '../src/main-sessions.mjs';
import {scratchBase} from './scratch.mjs';

const CLAUDE_MODELS = [
  {
    model: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    provider: 'claude',
    inputModalities: ['text', 'image'],
    supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'medium'}, {reasoningEffort: 'high'}]
  },
  {
    model: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'claude',
    inputModalities: ['text', 'image'],
    supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'medium'}]
  },
  {
    model: 'claude-hidden-preview',
    displayName: 'Hidden Model',
    provider: 'claude',
    hidden: true,
    inputModalities: ['text', 'image'],
    supportedReasoningEfforts: [{reasoningEffort: 'high'}]
  }
];

async function post(url, token, message) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(message)
  });
}

async function body(response) {
  const text = await response.text();
  const data = text
    .split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n');
  return JSON.parse(data || text);
}

async function listGatewayTools(mcpServer) {
  const {url, headers} = mcpServer,
    token = headers.Authorization.slice(7);
  await body(
    await post(url, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test', version: '1'}}
    })
  );
  return (await body(await post(url, token, {jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}))).result.tools;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture({
  models = CLAUDE_MODELS,
  waitForHost,
  realGateway = false,
  bridgeFactory,
  gatewayFactory,
  onContinueConversation,
  onConversationSettled
} = {}) {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'claude-cont-'));
  await writeFile(path.join(root, 'README.md'), 'fixture');
  let hostOptions, bridgeOptions, gatewayOptions, host;
  const hostCalls = [];
  const makeHost = () => {
    let resolveClosed;
    return {
      startCalls: [],
      startOptions: [],
      closed: new Promise(resolve => {
        resolveClosed = resolve;
      }),
      async start(_content, options) {
        this.startOptions.push(options);
      },
      async interrupt() {},
      async close() {
        resolveClosed();
      }
    };
  };
  const bridge = {
    closed: false,
    workerPolicy: {model: 'auto', effort: 'auto'},
    records: [],
    async list() {
      return this.records;
    },
    async start(args) {
      return {...args, provider: 'claude'};
    },
    async cancel() {
      return {settled: true};
    },
    async wait() {
      return {settled: true};
    },
    async inspect() {
      return {settled: true};
    },
    async close() {
      this.closed = true;
    }
  };
  const fakeGateway = {
    mcpConfig: {
      mcpServers: {
        k_luna: {type: 'http', url: 'http://127.0.0.1:4567/mcp', headers: {Authorization: 'Bearer test-token'}}
      }
    },
    async close() {
      this.closed = true;
      await gatewayOptions.bridge.close();
    }
  };
  const controller = createClaudeController({
    root,
    executable: 'codex-test',
    commandSpec: {command: 'claude-test', argsPrefix: []},
    ...(onContinueConversation ? {onContinueConversation} : {}),
    ...(onConversationSettled ? {onConversationSettled} : {}),
    hostFactory: async options => {
      hostCalls.push(options);
      hostOptions = options;
      host = makeHost();
      host.models = models;
      await waitForHost?.(options, host);
      return host;
    },
    bridgeFactory: async options => {
      bridgeOptions = options;
      return bridgeFactory ? bridgeFactory(options) : bridge;
    },
    gatewayFactory: async options => {
      gatewayOptions = options;
      if (gatewayFactory) return gatewayFactory(options);
      return realGateway ? createLunaGateway(options) : fakeGateway;
    }
  });
  return {
    root,
    controller,
    bridge,
    hostCalls,
    get host() {
      return host;
    },
    get hostOptions() {
      return hostOptions;
    },
    get bridgeOptions() {
      return bridgeOptions;
    },
    get gatewayOptions() {
      return gatewayOptions;
    }
  };
}

test('Claude gateway exposes only conversation_create while K workers and nested workers get no continuation tools', async () => {
  const f = await fixture({
    realGateway: true,
    onContinueConversation: async () => ({accepted: true})
  });
  let nestedResult;
  try {
    await f.controller.open({model: 'claude-opus-4-6'});
    assert.equal(f.gatewayOptions.continueFreshOnly, true);
    const mainTools = await listGatewayTools(f.hostOptions.mcpConfig.mcpServers.k_luna);
    assert.ok(mainTools.find(t => t.name === 'conversation_create'));
    assert.equal(mainTools.find(t => t.name === 'conversation_continue'), undefined);

    // First-layer K worker receives strict empty MCP config with no k_luna gateway.
    let workerHostOptions;
    const worker = createClaudeWorker({
      root: f.root,
      workspace: f.root,
      accessMode: 'read-only',
      commandSpec: {command: 'claude-test', argsPrefix: []},
      hostFactory: async options => {
        workerHostOptions = options;
        let resolveClosed;
        return {
          models: CLAUDE_MODELS,
          closed: new Promise(r => (resolveClosed = r)),
          async start() {
            options.onMessage({type: 'result', is_error: false, result: 'done'});
          },
          async interrupt() {},
          async close() {
            resolveClosed();
          }
        };
      }
    });
    await worker.run({task: 'first layer', model: 'claude-opus-4-6', effort: 'low', sessionId: 'w-1'});
    assert.deepEqual(workerHostOptions.mcpConfig, {mcpServers: {}});
    assert.equal(workerHostOptions.nestedWorker, false);

    // Second-layer nestedWorker subGateway exposes no continuation tools.
    await f.gatewayOptions.bridge.start({requestId: 'upper-coord', task: 'coord'});
    nestedResult = await f.bridgeOptions.nested({
      requestId: 'upper-coord',
      accessMode: 'read-only',
      onChange: () => {}
    });
    const nestedTools = await listGatewayTools(nestedResult.mcpConfig.mcpServers.k_luna);
    assert.equal(nestedTools.find(t => t.name === 'conversation_create'), undefined);
    assert.equal(nestedTools.find(t => t.name === 'conversation_continue'), undefined);
  } finally {
    await nestedResult?.close().catch(() => {});
    await f.controller.close();
  }
});

test('Claude continuation caller guard blocks idle, missing turnId, stopping, stopUnconfirmed, running Agent/Task and unsettled native workers', async () => {
  const calls = [];
  const f = await fixture({
    onContinueConversation: async data => {
      calls.push(data);
      return {accepted: true};
    }
  });
  try {
    await f.controller.open({model: 'claude-opus-4-6'});
    const callCreate = (overrides = {}) =>
      f.gatewayOptions.continueConversation({nextInstruction: 'handoff', mode: 'fresh', ...overrides}, {});

    // Idle before send.
    await assert.rejects(callCreate(), /進行中回合/);
    assert.equal(calls.length, 0);

    // Compact has busy=true but currentTurnId=null.
    await f.controller.compact();
    assert.equal(f.controller.state.busy, true);
    await assert.rejects(callCreate(), /進行中回合/);
    f.hostOptions.onMessage({type: 'result', is_error: false});
    await tick();

    // Start a real user turn.
    await f.controller.send({text: 'do work'});
    const userTurnId = f.controller.state.messages.at(-1).id;

    // Running foreground Agent/Task tool blocks continuation.
    f.hostOptions.onMessage({
      type: 'assistant',
      uuid: 'a-agent',
      message: {content: [{type: 'tool_use', id: 'tu-agent', name: 'Agent', input: {description: 'sub'}}]}
    });
    await assert.rejects(callCreate(), /原生子代理仍在執行/);
    f.hostOptions.onMessage({
      type: 'user',
      message: {
        content: [{type: 'tool_result', tool_use_id: 'tu-agent', content: 'done'}],
        tool_use_result: {status: 'completed'}
      },
      tool_use_result: {status: 'completed'}
    });

    f.hostOptions.onMessage({
      type: 'assistant',
      uuid: 'a-task',
      message: {content: [{type: 'tool_use', id: 'tu-task', name: 'Task', input: {description: 'sub task'}}]}
    });
    await assert.rejects(callCreate(), /原生子代理仍在執行/);
    f.hostOptions.onMessage({
      type: 'user',
      message: {content: [{type: 'tool_result', tool_use_id: 'tu-task', content: 'ok'}]},
      tool_use_result: {status: 'completed'}
    });

    // Unsettled claude-native background subagent blocks continuation.
    f.hostOptions.onMessage({
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_agent',
      task_id: 'native-agent-1',
      tool_use_id: 'tu-bg-agent',
      description: 'bg agent'
    });
    await assert.rejects(callCreate(), /尚未結算/);
    f.hostOptions.onMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'native-agent-1',
      status: 'completed',
      summary: 'agent finished'
    });

    // Unsettled claude-native background command blocks continuation.
    f.hostOptions.onMessage({
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_bash',
      task_id: 'native-bash-1',
      tool_use_id: 'tu-bg-bash',
      description: 'bg bash'
    });
    await assert.rejects(callCreate(), /尚未結算/);
    f.hostOptions.onMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'native-bash-1',
      status: 'completed',
      summary: 'bash finished'
    });
    assert.equal(calls.length, 0);

    // With all native subagents/commands settled, caller guard succeeds and forwards Codex-compatible shape.
    const accepted = await callCreate();
    assert.deepEqual(accepted, {accepted: true});
    assert.equal(calls.length, 1);
    const payload = calls[0];
    assert.equal(payload.nextInstruction, 'handoff');
    assert.equal(payload.mode, 'fresh');
    assert.equal(payload.threadId, f.controller.state.threadId);
    assert.equal(payload.turnId, userTurnId);
    assert.equal(payload.authorizedHumanTurnId, undefined);
    assert.equal('authorizedHumanTurnId' in payload, true);
    assert.equal(typeof payload.resolveTarget, 'function');
    assert.equal(typeof payload.stillCurrent, 'function');
    assert.equal(typeof payload.afterTurnCurrent, 'function');
    payload.stillCurrent();

    // After normal completion, stillCurrent fails (not busy) while afterTurnCurrent passes.
    f.hostOptions.onMessage({type: 'result', is_error: false});
    await tick();
    assert.throws(() => payload.stillCurrent(), /進行中回合/);
    payload.afterTurnCurrent();

    // While stopping is in flight, guard blocks.
    await f.controller.send({text: 'turn 2'});
    let releaseInterrupt;
    f.host.interrupt = () =>
      new Promise(resolve => {
        releaseInterrupt = resolve;
      });
    const stopPromise = f.controller.stop();
    await waitFor(() => typeof releaseInterrupt === 'function');
    await assert.rejects(callCreate(), /進行中回合/);
    releaseInterrupt();
    await stopPromise;
    assert.throws(() => payload.afterTurnCurrent(), /來源已停止或變更/);

    // stopUnconfirmed blocks even if host remains attached.
    await f.controller.open({threadId: f.controller.state.threadId, model: 'claude-opus-4-6'});
    await f.controller.send({text: 'turn 3'});
    f.host.interrupt = async () => {
      throw new Error('interrupt failed');
    };
    await assert.rejects(f.controller.stop(), /interrupt failed/);
    assert.equal(f.controller.state.status, 'uncertain');
    await assert.rejects(callCreate(), /進行中回合/);
  } finally {
    await f.controller.close();
  }
});

test('Claude continuation resolveTarget validates catalog, hidden models, cross-provider IDs and effort defaults without mutating source', async () => {
  let latestPayload;
  const f = await fixture({
    onContinueConversation: async data => {
      latestPayload = data;
      return data.resolveTarget();
    }
  });
  try {
    await f.controller.open({model: 'claude-opus-4-6', effort: 'high'});
    await f.controller.send({text: 'choose target'});
    const callCreate = args =>
      f.gatewayOptions.continueConversation({nextInstruction: 'handoff', mode: 'fresh', ...args}, {});

    // Inherit source model and effort.
    assert.deepEqual(await callCreate({}), {targetModel: 'claude-opus-4-6', targetEffort: 'high'});

    // Same model, explicit effort override.
    assert.deepEqual(await callCreate({effort: 'low'}), {targetModel: 'claude-opus-4-6', targetEffort: 'low'});

    // Different model without effort -> native default (null).
    assert.deepEqual(await callCreate({model: 'claude-sonnet-4-6'}), {
      targetModel: 'claude-sonnet-4-6',
      targetEffort: null
    });

    // Different model with explicit supported effort.
    assert.deepEqual(await callCreate({model: 'claude-sonnet-4-6', effort: 'medium'}), {
      targetModel: 'claude-sonnet-4-6',
      targetEffort: 'medium'
    });

    // Different model with explicit null effort.
    assert.deepEqual(await callCreate({model: 'claude-sonnet-4-6', effort: null}), {
      targetModel: 'claude-sonnet-4-6',
      targetEffort: null
    });

    // Reject hidden model, cross-provider models, and unsupported effort.
    await assert.rejects(callCreate({model: 'claude-hidden-preview'}), /不在本供應商的原生目錄/);
    await assert.rejects(callCreate({model: 'gpt-6.1-sol'}), /不在本供應商的原生目錄/);
    await assert.rejects(callCreate({model: 'gemini-4-hydrogen'}), /不在本供應商的原生目錄/);
    await assert.rejects(callCreate({model: 'claude-sonnet-4-6', effort: 'high'}), /不在該模型的原生目錄/);

    // Source settings remain unchanged.
    assert.equal(f.controller.state.model, 'claude-opus-4-6');
    assert.equal(f.controller.state.effort, 'high');
    assert.ok(latestPayload);
  } finally {
    await f.controller.close();
  }
});

test('Claude continuationGoal and prepareContinuation validate goals, status, turnId and settled workers', async () => {
  let goalReply = 'No goal set';
  let goalErrorMode = false;
  let goalCalls = 0;
  let releaseGoal;
  const f = await fixture({
    waitForHost: async (options, host) => {
      host.nativeCapabilities = {commands: ['goal'], efforts: []};
      host.goal = async () => {
        goalCalls++;
        if (releaseGoal === 'block') {
          await new Promise(resolve => {
            releaseGoal = resolve;
          });
        }
        if (goalErrorMode) throw new Error('goal read failed');
        options.onMessage({type: 'result', is_error: false});
        return goalReply;
      };
    }
  });
  try {
    await f.controller.open({model: 'claude-opus-4-6', effort: 'medium', accessMode: 'claude-plan'});

    // continuationGoal succeeds without calling host.goal (no /goal injection).
    assert.deepEqual(await f.controller.continuationGoal(), {goal: null});
    assert.equal(goalCalls, 0);

    // Ended goal is allowed; active/unknown/tokenBudget/goalError/goalPending are rejected.
    f.controller.state.goal = {objective: 'old', status: 'ended'};
    assert.deepEqual(await f.controller.continuationGoal(), {goal: {objective: 'old', status: 'ended'}});

    f.controller.state.goal = {objective: 'live', status: 'active'};
    await assert.rejects(f.controller.continuationGoal(), /原生目標/);

    f.controller.state.goal = {objective: 'unknown', status: 'unknown'};
    await assert.rejects(f.controller.continuationGoal(), /原生目標/);

    f.controller.state.goal = {objective: 'budgeted', status: 'ended', tokenBudget: 1000};
    await assert.rejects(f.controller.continuationGoal(), /預算限制|原生目標/);

    f.controller.state.goal = null;
    f.controller.state.goalError = 'boom';
    await assert.rejects(f.controller.continuationGoal(), /原生目標/);

    f.controller.state.goalError = null;
    f.controller.state.goalPending = true;
    await assert.rejects(f.controller.continuationGoal(), /原生目標/);
    f.controller.state.goalPending = false;
    assert.equal(goalCalls, 0);

    // Failed turn rejected by prepareContinuation.
    await f.controller.send({text: 'turn failed'});
    const failedTurnId = f.controller.state.messages.at(-1).id;
    f.hostOptions.onMessage({type: 'result', is_error: true, result: 'native error'});
    await tick();
    await assert.rejects(
      f.controller.prepareContinuation({turnId: failedTurnId, mode: 'fresh'}),
      err => err.notCreated === true
    );

    // Completed turn checks.
    await f.controller.send({text: 'turn ok'});
    const okTurnId = f.controller.state.messages.at(-1).id;
    f.hostOptions.onMessage({type: 'result', is_error: false});
    await tick();

    // Non-fresh mode rejected.
    await assert.rejects(
      f.controller.prepareContinuation({turnId: okTurnId, mode: 'fork'}),
      err => err.notCreated === true && /全新聊天室/.test(err.message)
    );

    // Mismatched turnId rejected.
    await assert.rejects(
      f.controller.prepareContinuation({turnId: 'wrong-turn-id', mode: 'fresh'}),
      err => err.notCreated === true
    );

    // Unsafe goals rejected at prepare time.
    for (const mutate of [
      () => (f.controller.state.goal = {objective: 'live', status: 'active'}),
      () => (f.controller.state.goal = {objective: 'u', status: 'unknown'}),
      () => (f.controller.state.goal = {objective: 'b', status: 'ended', tokenBudget: 500}),
      () => {
        f.controller.state.goal = null;
        f.controller.state.goalError = 'read fail';
      }
    ]) {
      mutate();
      await assert.rejects(
        f.controller.prepareContinuation({turnId: okTurnId, mode: 'fresh'}),
        err => err.notCreated === true
      );
      f.controller.state.goal = null;
      f.controller.state.goalError = null;
    }

    // Unsettled claude-native worker -> rejected.
    const nativeWorker = {
      provider: 'claude-native',
      requestId: 'native-w-1',
      status: 'running',
      settled: false
    };
    f.controller.state.workers.push(nativeWorker);
    await assert.rejects(
      f.controller.prepareContinuation({turnId: okTurnId, mode: 'fresh'}),
      err => err.notCreated === true && /子代理/.test(err.message)
    );
    nativeWorker.settled = true;
    nativeWorker.status = 'completed';

    // sourceCurrent throwing marks notCreated=true.
    await assert.rejects(
      f.controller.prepareContinuation({
        turnId: okTurnId,
        mode: 'fresh',
        sourceCurrent: () => {
          throw new Error('source changed');
        }
      }),
      err => err.notCreated === true && /source changed/.test(err.message)
    );

    // Valid prepareContinuation returns Codex-aligned fresh snapshot (without serviceTier) and never sends /goal.
    const prepared = await f.controller.prepareContinuation({turnId: okTurnId, mode: 'fresh'});
    assert.deepEqual(prepared, {
      mode: 'fresh',
      model: 'claude-opus-4-6',
      workspace: f.root,
      effort: 'medium',
      accessMode: 'claude-plan',
      workerPolicy: f.controller.state.workerPolicy
    });
    assert.equal(goalCalls, 0);

    // Unsettled K worker (via bridge.list()) rejected. Checked last: once it settles, its completion notice is
    // delivered and makes the source busy, which is correct but would change the checks above.
    await f.gatewayOptions.bridge.start({requestId: 'k-w-1', task: 'bg'});
    f.bridge.records = [{parentId: f.controller.state.threadId, requestId: 'k-w-1', settled: false, status: 'running'}];
    await assert.rejects(
      f.controller.prepareContinuation({turnId: okTurnId, mode: 'fresh'}),
      err => err.notCreated === true && /子代理/.test(err.message)
    );
  } finally {
    if (typeof releaseGoal === 'function') releaseGoal();
    await f.controller.close();
  }
});

test('Claude open fresh creates blank titled room, fires onCreated after persisting, and keeps nativeStarted false until first send', async () => {
  const f = await fixture();
  const createdIds = [];
  let recordAtCreated, sessionAtCreated;
  try {
    // Reject invalid continuation inputs before starting host.
    await assert.rejects(
      f.controller.open({model: 'claude-opus-4-6'}, {continuation: {mode: 'fork'}}),
      err => err.notCreated === true
    );
    await assert.rejects(
      f.controller.open(
        {model: 'claude-opus-4-6', threadId: 'claude-123e4567-e89b-42d3-a456-426614174000'},
        {continuation: {mode: 'fresh'}}
      ),
      err => err.notCreated === true
    );
    assert.equal(f.hostCalls.length, 0);

    const longParentTitle = '來源標題'.repeat(40);
    const {threadId} = await f.controller.open(
      {model: 'claude-sonnet-4-6', effort: null, accessMode: 'claude-bypassPermissions', permissionConfirmed: true},
      {
        continuation: {mode: 'fresh', parentTitle: longParentTitle},
        onCreated: async created => {
          createdIds.push(created.threadId);
          recordAtCreated = JSON.parse(
            await readFile(path.join(f.root, '.runtime/claude-sessions', `${created.threadId}.json`), 'utf8')
          );
          sessionAtCreated = (await listMainSessions(f.root)).sessions.find(s => s.threadId === created.threadId);
        }
      }
    );

    assert.deepEqual(createdIds, [threadId]);
    assert.equal(f.hostCalls.length, 1);
    assert.equal(f.hostCalls[0].effort, null);
    assert.equal(f.hostCalls[0].resume, false);
    assert.equal(f.hostCalls[0].forkFrom, undefined);
    assert.equal(f.controller.state.title, `新對話 · ${longParentTitle}`.slice(0, 120));
    assert.equal(f.controller.state.title.length, 120);
    assert.equal(f.controller.state.parentThreadId, null);
    assert.equal(f.controller.state.parentTitle, null);
    assert.deepEqual(f.controller.state.messages, []);
    assert.deepEqual(f.controller.state.tools, []);
    assert.deepEqual(f.controller.state.artifacts, []);
    assert.deepEqual(f.controller.state.workers, []);
    assert.equal(f.controller.state.progress.compactions, 0);
    assert.equal(recordAtCreated.nativeStarted, false);
    assert.equal(recordAtCreated.title, f.controller.state.title);
    assert.equal(sessionAtCreated.title, f.controller.state.title);

    // Opening again with continuation while host/threadId already active must fail with notCreated=true.
    await assert.rejects(
      f.controller.open({model: 'claude-opus-4-6'}, {continuation: {mode: 'fresh'}}),
      err => err.notCreated === true
    );

    // First send flips nativeStarted=true and preserves fresh title.
    await f.controller.send({text: 'handoff payload', source: 'continuation'});
    const afterSendRecord = JSON.parse(
      await readFile(path.join(f.root, '.runtime/claude-sessions', `${threadId}.json`), 'utf8')
    );
    assert.equal(afterSendRecord.nativeStarted, true);
    assert.equal(afterSendRecord.title, f.controller.state.title);
    assert.equal(f.controller.state.messages.at(-1).source, 'continuation');
    assert.equal(f.controller.state.messages.at(-1).turnId, f.controller.state.messages.at(-1).id);
  } finally {
    await f.controller.close();
  }
});

test('Claude open fresh uses fallback title when parentTitle is empty and distinguishes pre-start vs post-onCreated failures', async () => {
  // 1. Pre-start failure (workspace validation) sets notCreated=true and no createdThreadId.
  const fPre = await fixture();
  try {
    await assert.rejects(
      fPre.controller.open(
        {model: 'claude-opus-4-6'},
        {
          continuation: {mode: 'fresh', parentTitle: ''},
          relocation: {workspace: path.join(fPre.root, 'does-not-exist')}
        }
      ),
      err => err.notCreated === true && err.createdThreadId === undefined
    );
    assert.equal(fPre.hostCalls.length, 0);
  } finally {
    await fPre.controller.close();
  }

  // 2. Pre-start abort via signal sets notCreated=true and restores previousState.
  const fPreAbort = await fixture();
  try {
    const abort = new AbortController();
    await assert.rejects(
      fPreAbort.controller.open(
        {model: 'claude-opus-4-6'},
        {
          signal: abort.signal,
          continuation: {mode: 'fresh', parentTitle: ''},
          onHistory: () => abort.abort(new DOMException('aborted before start', 'AbortError'))
        }
      ),
      err => err.notCreated === true && err.createdThreadId === undefined
    );
    assert.equal(fPreAbort.hostCalls.length, 0);
    assert.equal(fPreAbort.controller.state.threadId, null);
  } finally {
    await fPreAbort.controller.close();
  }

  // 3. Failure in hostFactory is past creation attempt -> notCreated is not true, no createdThreadId.
  const fHostFail = await fixture({
    waitForHost: async () => {
      throw new Error('spawn failed');
    }
  });
  try {
    await assert.rejects(
      fHostFail.controller.open({model: 'claude-opus-4-6'}, {continuation: {mode: 'fresh', parentTitle: ''}}),
      err => err.notCreated !== true && err.createdThreadId === undefined
    );
  } finally {
    await fHostFail.controller.close();
  }

  // 4. Abort after onCreated keeps createdThreadId, does NOT roll back to previousState, and preserves fallback title.
  const fPostAbort = await fixture();
  try {
    const abort = new AbortController();
    let observedId;
    await assert.rejects(
      fPostAbort.controller.open(
        {model: 'claude-opus-4-6'},
        {
          signal: abort.signal,
          continuation: {mode: 'fresh', parentTitle: ''},
          onCreated: async ({threadId}) => {
            observedId = threadId;
            abort.abort(new DOMException('aborted after create', 'AbortError'));
          }
        }
      ),
      err => err.createdThreadId === observedId && err.notCreated !== true
    );
    assert.ok(observedId);
    assert.equal(fPostAbort.controller.state.threadId, observedId);
    assert.equal(fPostAbort.controller.state.title, '新對話 · 接續工作');
    const saved = (await listMainSessions(fPostAbort.root)).sessions.find(s => s.threadId === observedId);
    assert.equal(saved.title, '新對話 · 接續工作');
  } finally {
    await fPostAbort.controller.close();
  }

  // 5. Error thrown by onCreated carries createdThreadId.
  const fCreatedErr = await fixture();
  try {
    let observedId;
    await assert.rejects(
      fCreatedErr.controller.open(
        {model: 'claude-opus-4-6'},
        {
          continuation: {mode: 'fresh', parentTitle: 'x'},
          onCreated: async ({threadId}) => {
            observedId = threadId;
            throw new Error('receipt write failed');
          }
        }
      ),
      err => err.createdThreadId === observedId && err.notCreated !== true && /receipt write failed/.test(err.message)
    );
  } finally {
    await fCreatedErr.controller.close();
  }

  // 6. Failure in configureGateway after threadId assignment and before hostFactory restores state.threadId to null and writes no session.
  const fGatewayErr = await fixture({
    gatewayFactory: async () => {
      throw new Error('gateway init failed');
    }
  });
  try {
    await assert.rejects(
      fGatewayErr.controller.open(
        {model: 'claude-opus-4-6'},
        {continuation: {mode: 'fresh', parentTitle: 'before-host'}}
      ),
      err => err.notCreated === true && err.createdThreadId === undefined && /gateway init failed/.test(err.message)
    );
    assert.equal(fGatewayErr.hostCalls.length, 0);
    assert.equal(fGatewayErr.controller.state.threadId, null);
    assert.deepEqual((await listMainSessions(fGatewayErr.root)).sessions, []);
  } finally {
    await fGatewayErr.controller.close();
  }
});

test('Claude prepareContinuation invalidates source and marks offline when host exits while awaiting workers', async () => {
  let payload;
  const f = await fixture({
    onContinueConversation: async data => {
      payload = data;
      return {accepted: true};
    }
  });
  try {
    await f.controller.open({model: 'claude-opus-4-6'});
    await f.controller.send({text: 'prepare while host exits'});
    const turnId = f.controller.state.messages.at(-1).id;
    await f.gatewayOptions.continueConversation({nextInstruction: 'handoff', mode: 'fresh'}, {});
    f.hostOptions.onMessage({type: 'result', is_error: false});
    await tick();

    // Start bridge lazily so prepareContinuation enters listWorkers() -> bridgeInstance.list().
    await f.gatewayOptions.bridge.start({requestId: 'k-w-settled', task: 'bg'});
    const originalList = f.bridge.list.bind(f.bridge);
    let listStarted = false;
    let releaseList;
    f.bridge.list = () => {
      f.bridge.list = originalList;
      listStarted = true;
      return new Promise(resolve => {
        releaseList = () => resolve([{parentId: f.controller.state.threadId, requestId: 'k-w-settled', settled: true}]);
      });
    };

    let prepTimer;
    try {
      const prepPromise = f.controller.prepareContinuation({
        turnId,
        mode: 'fresh',
        sourceCurrent: payload.afterTurnCurrent
      });
      await waitFor(() => listStarted);

      // Unexpected host exit while prepareContinuation is awaiting workers.
      await f.host.close();
      await waitFor(() => f.controller.state.status === 'offline');
      releaseList();

      await assert.rejects(
        Promise.race([
          prepPromise,
          new Promise((_, reject) => {
            prepTimer = setTimeout(() => reject(new Error('Timed out waiting for prepareContinuation.')), 5000);
          })
        ]),
        err => err.notCreated === true
      );
      assert.equal(f.controller.state.status, 'offline');
      assert.throws(() => payload.afterTurnCurrent(), /來源已停止或變更/);
    } finally {
      clearTimeout(prepTimer);
      f.bridge.list = originalList;
      releaseList?.();
    }
  } finally {
    await f.controller.close();
  }
});

test('Claude worker finishing while a handoff is prepared is still notified after the preparation fails', async () => {
  let payload;
  const f = await fixture({
    onContinueConversation: async data => {
      payload = data;
      return {accepted: true};
    }
  });
  try {
    await f.controller.open({model: 'claude-opus-4-6'});
    await f.controller.send({text: 'prepare while a worker finishes'});
    const turnId = f.controller.state.messages.at(-1).id;
    await f.gatewayOptions.continueConversation({nextInstruction: 'handoff', mode: 'fresh'}, {});
    await f.gatewayOptions.bridge.start({requestId: 'k-a', task: 'a'});
    await f.gatewayOptions.bridge.start({requestId: 'k-b', task: 'b'});
    f.hostOptions.onMessage({type: 'result', is_error: false});
    await tick();

    const threadId = f.controller.state.threadId;
    const originalList = f.bridge.list.bind(f.bridge);
    let listStarted = false;
    let releaseList;
    f.bridge.list = () => {
      f.bridge.list = originalList;
      listStarted = true;
      return new Promise(resolve => {
        releaseList = () =>
          resolve([
            {parentId: threadId, requestId: 'k-a', provider: 'claude', settled: true, status: 'completed'},
            {parentId: threadId, requestId: 'k-b', provider: 'claude', settled: false, status: 'running'}
          ]);
      });
    };
    try {
      const prepPromise = f.controller.prepareContinuation({
        turnId,
        mode: 'fresh',
        sourceCurrent: payload.afterTurnCurrent
      });
      await waitFor(() => listStarted);
      // Worker A finishes while the preparation is waiting for the worker list.
      f.bridgeOptions.onChange({
        parentId: threadId,
        requestId: 'k-a',
        provider: 'claude',
        settled: true,
        status: 'completed',
        output: 'A done'
      });
      releaseList();
      await assert.rejects(prepPromise, err => err.notCreated === true);
    } finally {
      f.bridge.list = originalList;
      releaseList?.();
    }
    await waitFor(() => f.controller.state.messages.at(-1)?.kind === 'worker-completion');
    assert.match(f.controller.state.messages.at(-1).summary, /k-a/);
  } finally {
    await f.controller.close();
  }
});
