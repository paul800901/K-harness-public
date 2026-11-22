import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createConversationController} from '../src/conversation-controller.mjs';
import {createUnifiedController} from '../src/unified-controller.mjs';
import {createClaudeController} from '../src/claude-controller.mjs';
import {createLunaGateway} from '../src/luna-gateway.mjs';
import {saveMainSession} from '../src/main-sessions.mjs';
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
  }
];

const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(predicate, label = 'condition') {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

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

async function callGatewayTool(mcpServer, name, args) {
  const {url, headers} = mcpServer;
  const token = headers.Authorization.slice(7);
  await body(
    await post(url, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test', version: '1'}}
    })
  );
  const res = await body(
    await post(url, token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {name, arguments: args}
    })
  );
  if (res.error) return {isError: true, text: res.error.message ?? JSON.stringify(res.error), json: null};
  const text = res.result?.content?.[0]?.text ?? '';
  return {isError: res.result?.isError === true, text, json: res.result?.isError ? null : JSON.parse(text)};
}

function makeFakeCodexFactory() {
  return () => {
    const state = {
      provider: 'codex',
      threadId: null,
      model: 'gpt-6.1-sol',
      workspace: null,
      accessMode: 'read-only',
      effort: 'medium',
      busy: false,
      status: 'ready',
      questions: [],
      queuedMessages: [],
      messages: [],
      workers: [],
      tools: [],
      goal: null
    };
    return {
      state,
      async models() {
        return {models: [], geminiGateway: false};
      },
      async usage() {
        return {};
      },
      async selectWorkspace({path: dir}) {
        state.workspace = dir;
      },
      async workers() {
        return [];
      },
      async close() {
        state.status = 'offline';
      }
    };
  };
}

async function createOrchestrationFixture({
  root: existingRoot,
  realGateway = false,
  inspectResult = {available: true, accountType: 'firstParty'},
  onHostFactory,
  onClaudeController,
  onConversationSettledSpy
} = {}) {
  await mkdir(scratchBase, {recursive: true});
  const root = existingRoot ?? (await mkdtemp(path.join(scratchBase, 'claude-orch-')));
  await writeFile(path.join(root, 'README.md'), 'orchestration fixture');

  const hostInstances = [];
  const claudeControllers = [];
  const openCalls = [];

  const createController = () =>
    createConversationController({
      root,
      sessionFactory: opts =>
        createUnifiedController({
          ...opts,
          codexFactory: makeFakeCodexFactory(),
          inspect: async () => (typeof inspectResult === 'function' ? inspectResult() : inspectResult),
          claudeFactory: claudeOpts => {
            const wrappedOpts = {
              ...claudeOpts,
              ...(onConversationSettledSpy
                ? {
                    onConversationSettled: event => {
                      onConversationSettledSpy(event);
                      return claudeOpts.onConversationSettled?.(event);
                    }
                  }
                : {}),
              commandSpec: {command: 'claude-test', argsPrefix: []},
              hostFactory: async hostOpts => {
                let resolveClosed;
                const closed = new Promise(resolve => {
                  resolveClosed = resolve;
                });
                const host = {
                  options: hostOpts,
                  models: CLAUDE_MODELS,
                  nativeCapabilities: {commands: ['goal'], efforts: []},
                  startCalls: [],
                  goalCalls: [],
                  closed,
                  async start(content, startOptions) {
                    this.startCalls.push({content, options: startOptions});
                  },
                  async goal(arg) {
                    this.goalCalls.push(arg);
                    hostOpts.onMessage?.({type: 'result', is_error: false});
                    return 'No goal set. Usage: `/goal <condition>`';
                  },
                  async interrupt() {},
                  async close() {
                    resolveClosed();
                  },
                  crash() {
                    resolveClosed();
                  }
                };
                if (hostOpts.mcpConfig) hostInstances.push(host);
                await onHostFactory?.(host, hostOpts, hostInstances.length);
                return host;
              },
              bridgeFactory: async () => ({
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
                async close() {}
              }),
              gatewayFactory: async gwOpts => {
                if (realGateway) {
                  const real = await createLunaGateway(gwOpts);
                  hostInstances.latestGateway = real;
                  return real;
                }
                const fakeGw = {
                  options: gwOpts,
                  mcpConfig: {
                    mcpServers: {
                      k_luna: {
                        type: 'http',
                        url: 'http://127.0.0.1:4599/mcp',
                        headers: {Authorization: 'Bearer test-token'}
                      }
                    }
                  },
                  async close() {
                    await gwOpts.bridge?.close?.();
                  }
                };
                hostInstances.latestGateway = fakeGw;
                return fakeGw;
              }
            };
            const ctrl = createClaudeController(wrappedOpts);
            const originalOpen = ctrl.open.bind(ctrl);
            ctrl.open = async (data, openOpts) => {
              openCalls.push({data, hasServiceTier: Object.hasOwn(data ?? {}, 'serviceTier'), continuation: openOpts?.continuation});
              return originalOpen(data, openOpts);
            };
            claudeControllers.push(ctrl);
            onClaudeController?.(ctrl);
            return ctrl;
          }
        })
    });

  const c = createController();
  const receipt = async id =>
    JSON.parse(await readFile(path.join(root, '.runtime/chat-continuations', `${id}.json`), 'utf8'));

  return {
    root,
    c,
    hostInstances,
    claudeControllers,
    openCalls,
    receipt,
    reopenController: createController
  };
}

test('Claude fresh continuation full lifecycle: accept, complete, create blank room, handoff with schedule hint, and block recursive move', async () => {
  const f = await createOrchestrationFixture({realGateway: true});
  try {
    const opened = await f.c.open({model: 'claude-opus-4-6', effort: 'high', accessMode: 'claude-bypassPermissions', permissionConfirmed: true});
    const sourceId = opened.threadId;
    const sourceHost = f.hostInstances[0];
    const sourceGateway = sourceHost.options.mcpConfig.mcpServers.k_luna;

    // Leave a roomNote in the target room? No, leave one in source or check continuation doesn't carry unrelated notes.
    await f.c.send({threadId: sourceId, text: '請幫我搬到新聊天室繼續剩餘任務'});
    const sourceHumanMsg = f.c.state.messages.at(-1);
    assert.equal(sourceHumanMsg.source, 'local');

    // fork mode must be rejected for Claude (neither exposed in gateway nor accepted if requested).
    const gwTools = await callGatewayTool(sourceGateway, 'conversation_continue', {nextInstruction: 'fork'});
    assert.equal(gwTools.isError, true);

    // Emit tool_use for mcp__k_luna__conversation_create and call it via real HTTP MCP gateway.
    sourceHost.options.onMessage({
      type: 'assistant',
      uuid: 'asst-1',
      message: {
        role: 'assistant',
        content: [{type: 'tool_use', id: 'tu-create-1', name: 'mcp__k_luna__conversation_create', input: {}}]
      }
    });
    const callRes = await callGatewayTool(sourceGateway, 'conversation_create', {
      nextInstruction: '只做第二步驗證',
      model: 'claude-sonnet-4-6'
    });
    assert.equal(callRes.isError, false);
    assert.equal(callRes.json.accepted, true);
    assert.equal(callRes.json.mode, 'fresh');
    assert.equal(callRes.json.targetModel, 'claude-sonnet-4-6');
    assert.equal(callRes.json.targetEffort, null);

    sourceHost.options.onMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [{type: 'tool_result', tool_use_id: 'tu-create-1', content: callRes.text}]
      }
    });

    // Source turn completes normally.
    sourceHost.options.onMessage({type: 'result', is_error: false});
    await waitFor(async () => {
      const r = await f.receipt(sourceId).catch(() => null);
      return r?.status === 'sent';
    }, 'receipt sent');

    const sentReceipt = await f.receipt(sourceId);
    const childId = sentReceipt.newThreadId;
    assert.ok(childId && childId !== sourceId);
    assert.equal(f.c.state.threadId, childId);
    assert.equal(f.c.state.provider, 'claude');
    assert.equal(f.c.state.model, 'claude-sonnet-4-6');
    assert.equal(f.c.state.effort, null);

    // serviceTier must not be passed to Claude child.open.
    const childOpenCall = f.openCalls.at(-1);
    assert.equal(childOpenCall.hasServiceTier, false);

    // Verify handoff message in child room has source='continuation', turnId, IDs and schedule_update hint.
    const childHost = f.hostInstances[1];
    assert.equal(childHost.startCalls.length, 1);
    assert.equal(f.c.state.messages.length, 1);
    const handoffMsg = f.c.state.messages[0];
    assert.equal(handoffMsg.source, 'continuation');
    assert.equal(handoffMsg.turnId, handoffMsg.id);
    assert.match(handoffMsg.text, new RegExp(`原聊天室 ID：${sourceId}`));
    assert.match(handoffMsg.text, new RegExp(`新聊天室 ID：${childId}`));
    assert.match(
      handoffMsg.text,
      new RegExp(
        `聊天室 ID 只供定位，不構成搬移排程的授權；若本人已授權搬移原聊天室的定時排程，用 schedule_update 帶 targetThreadId=${childId} 逐筆改綁；不要刪除重建`
      )
    );
    assert.match(handoffMsg.text, /只做第二步驗證/);

    // Verify origin file recorded initialTurnId.
    const origin = await f.receipt(childId);
    assert.equal(origin.kind, 'origin');
    assert.equal(origin.handoffFrom, sourceId);
    assert.equal(origin.initialTurnId, handoffMsg.turnId);

    // First turn in new room must reject recursive conversation_create (double guard: continuation source + origin.initialTurnId).
    const childGateway = childHost.options.mcpConfig.mcpServers.k_luna;
    // The origin guard alone: even if the first message looked human, its turn is still the handoff turn.
    handoffMsg.source = 'local';
    try {
      const originOnly = await callGatewayTool(childGateway, 'conversation_create', {nextInstruction: 'origin guard only'});
      assert.equal(originOnly.isError, true);
      assert.match(originOnly.text, /第一回合不能再次換房/);
    } finally {
      handoffMsg.source = 'continuation';
    }
    const recursiveCall = await callGatewayTool(childGateway, 'conversation_create', {
      nextInstruction: 'recursive handoff'
    });
    assert.equal(recursiveCall.isError, true);
    assert.match(recursiveCall.text, /真人訊息|第一回合/);

    // Finish child turn 1, then send a real human message -> second turn may request conversation_create.
    childHost.options.onMessage({type: 'result', is_error: false});
    await waitFor(() => !f.c.state.busy);

    await f.c.send({threadId: childId, text: '現在是真人新指示，再換一間'});
    const secondCall = await callGatewayTool(childGateway, 'conversation_create', {
      nextInstruction: '第三間房任務'
    });
    assert.equal(secondCall.isError, false);
    assert.equal(secondCall.json.accepted, true);

    // Cancel pending second move cleanly before closing.
    await f.c.stop({threadId: childId});
  } finally {
    await f.c.close();
  }
});

test('Claude continuation cancels on failed turn, mismatched turnId settled, unexpected host crash, and stop/human input', async () => {
  const settledEvents = [];
  const f = await createOrchestrationFixture({
    realGateway: true,
    onConversationSettledSpy: event => settledEvents.push(event)
  });
  try {
    // Case 1: failed turn -> cancelled without creating room (unlike Codex fresh).
    const {threadId: id1} = await f.c.open({model: 'claude-opus-4-6'});
    const host1 = f.hostInstances[0];
    const gw1 = host1.options.mcpConfig.mcpServers.k_luna;

    await f.c.send({threadId: id1, text: '回合失敗測試'});
    const res1 = await callGatewayTool(gw1, 'conversation_create', {nextInstruction: 'should cancel on fail'});
    assert.equal(res1.isError, false);
    host1.options.onMessage({type: 'result', is_error: true, result: 'turn failed'});
    await waitFor(async () => (await f.receipt(id1).catch(() => null))?.status === 'cancelled');
    assert.equal(f.hostInstances.length, 1);

    // Case 2: host unexpected crash -> watchHost emits one interrupted settled event -> cancelled without creating room.
    await f.c.send({threadId: id1, text: 'host 中斷測試'});
    const res2 = await callGatewayTool(gw1, 'conversation_create', {nextInstruction: 'should cancel on crash'});
    assert.equal(res2.isError, false);
    const settledBeforeCrash = settledEvents.length;
    host1.crash();
    await waitFor(async () => (await f.receipt(id1).catch(() => null))?.status === 'cancelled');
    await tick();
    assert.equal(settledEvents.length, settledBeforeCrash + 1);
    assert.equal(settledEvents.at(-1).status, 'interrupted');
    assert.equal(f.hostInstances.length, 1);

    // Crashing while idle reports one interrupted event; with no pending handoff it creates and sends nothing.
    const {threadId: id2} = await f.c.open({model: 'claude-opus-4-6'});
    const host2 = f.hostInstances[1];
    const settledIdleBefore = settledEvents.length;
    host2.crash();
    await waitFor(() => f.c.state.status === 'offline');
    await tick();
    assert.equal(settledEvents.length, settledIdleBefore + 1);
    assert.equal(settledEvents.at(-1).status, 'interrupted');
    assert.equal(f.hostInstances.length, 2);
    assert.equal(await f.receipt(id2).catch(() => null), null);

    // Case 3: mismatched turnId settled event -> Claude cancels pending receipt immediately.
    const {threadId: id3} = await f.c.open({model: 'claude-opus-4-6'});
    const host3 = f.hostInstances[2];
    const gw3 = host3.options.mcpConfig.mcpServers.k_luna;
    await f.c.send({threadId: id3, text: 'turnId 不符測試'});
    const res3 = await callGatewayTool(gw3, 'conversation_create', {nextInstruction: 'should cancel on wrong turnId'});
    assert.equal(res3.isError, false);
    // Simulate a native turn overwrite or mismatched turnId settled before the human turn finishes.
    host3.options.onMessage({
      type: 'user',
      uuid: 'other-native-turn-uuid',
      message: {role: 'user', content: [{type: 'text', text: 'autonomous native echo'}]}
    });
    host3.options.onMessage({type: 'result', is_error: false});
    await waitFor(async () => (await f.receipt(id3).catch(() => null))?.status === 'cancelled');
    assert.equal(f.hostInstances.length, 3);

    // Case 4: human stop cancels pending continuation.
    await f.c.send({threadId: id3, text: 'stop 取消測試'});
    const res4 = await callGatewayTool(gw3, 'conversation_create', {nextInstruction: 'should cancel on stop'});
    assert.equal(res4.isError, false);
    await f.c.stop({threadId: id3});
    assert.equal((await f.receipt(id3)).status, 'cancelled');
    assert.equal(f.hostInstances.length, 3);

    // Case 5: new human message cancels pending continuation.
    await f.c.send({threadId: id3, text: '新真人訊息取消測試'});
    const gw3Reopened = f.hostInstances.at(-1).options.mcpConfig.mcpServers.k_luna;
    const res5 = await callGatewayTool(gw3Reopened, 'conversation_create', {nextInstruction: 'should cancel on new human'});
    assert.equal(res5.isError, false);
    await f.c.send({threadId: id3, text: '我改變心意了'});
    assert.equal((await f.receipt(id3)).status, 'cancelled');
    assert.equal(f.hostInstances.length, 4);
  } finally {
    await f.c.close();
  }
});

test('Claude creation failures: pre-create notCreated cancels without newThreadId; post-onCreated failure preserves uncertain room across restart', async () => {
  let inspectAvailable = true;
  let hostMode = 'normal';
  const f = await createOrchestrationFixture({
    realGateway: true,
    inspectResult: () =>
      inspectAvailable ? {available: true, accountType: 'firstParty'} : {available: false, reason: 'not logged in'},
    onHostFactory: async (host, opts, index) => {
      if (opts.mcpConfig && hostMode === 'closeDuringOpen' && index > 1) {
        // Trigger host close before open() finishes its final hostClosedDuringOpen check.
        await host.close();
      }
    }
  });
  let sourceId, uncertainChildId;
  try {
    const opened = await f.c.open({model: 'claude-opus-4-6'});
    sourceId = opened.threadId;
    const host1 = f.hostInstances[0];
    const gw1 = host1.options.mcpConfig.mcpServers.k_luna;

    // 1. notCreated: inspect fails before child host creation -> cancelled WITHOUT newThreadId.
    await f.c.send({threadId: sourceId, text: '未建房前失敗測試'});
    const req1 = await callGatewayTool(gw1, 'conversation_create', {nextInstruction: 'pre-create fail'});
    assert.equal(req1.isError, false);
    inspectAvailable = false;
    host1.options.onMessage({type: 'result', is_error: false});
    await waitFor(async () => (await f.receipt(sourceId).catch(() => null))?.status === 'cancelled');
    const cancelledReceipt = await f.receipt(sourceId);
    assert.equal(cancelledReceipt.status, 'cancelled');
    assert.equal(cancelledReceipt.newThreadId, undefined);

    // 2. onCreated succeeded, then host closed during open -> uncertain WITH newThreadId, persisted & no replay.
    inspectAvailable = true;
    hostMode = 'closeDuringOpen';
    await f.c.send({threadId: sourceId, text: '建房後失敗測試'});
    const req2 = await callGatewayTool(gw1, 'conversation_create', {nextInstruction: 'post-onCreated fail'});
    assert.equal(req2.isError, false);
    host1.options.onMessage({type: 'result', is_error: false});
    await waitFor(async () => (await f.receipt(sourceId).catch(() => null))?.status === 'uncertain');
    const uncertainReceipt = await f.receipt(sourceId);
    uncertainChildId = uncertainReceipt.newThreadId;
    assert.ok(uncertainChildId);
    assert.equal(f.hostInstances[1].startCalls.length, 0);

    // Even after reopening K, source room loads uncertain receipt and blocks duplicate creation; child room is readable.
  } finally {
    await f.c.close();
  }

  hostMode = 'normal';
  const f2 = await createOrchestrationFixture({root: f.root, realGateway: true});
  try {
    await f2.c.open({threadId: sourceId, model: 'claude-opus-4-6'});
    assert.equal(f2.c.state.continuation?.status, 'uncertain');
    assert.equal(f2.c.state.continuation?.newThreadId, uncertainChildId);

    const reopenedSourceHost = f2.hostInstances[0];
    const reopenedGw = reopenedSourceHost.options.mcpConfig.mcpServers.k_luna;
    await f2.c.send({threadId: sourceId, text: '重開後再試換房應該被擋'});
    const retryCall = await callGatewayTool(reopenedGw, 'conversation_create', {nextInstruction: 'should block'});
    assert.equal(retryCall.isError, true);
    assert.match(retryCall.text, /前次換房結果尚未確認/);
    reopenedSourceHost.options.onMessage({type: 'result', is_error: false});
    await waitFor(() => !f2.c.state.busy);

    await f2.c.open({threadId: uncertainChildId, model: 'claude-opus-4-6'});
    assert.equal(f2.c.state.threadId, uncertainChildId);
    assert.equal(f2.c.state.messages.length, 0);
  } finally {
    await f2.c.close();
  }
});

for (const extraTool of ['Bash', 'mcp__k_luna__luna_start', 'mcp__other__conversation_create', 'conversation_create'])
  test(`Claude tool exclusion list cancels when unexpected tool runs: ${extraTool}`, async () => {
    const f = await createOrchestrationFixture({realGateway: true});
    try {
      const {threadId} = await f.c.open({model: 'claude-opus-4-6'});
      const host = f.hostInstances[0];
      const gw = host.options.mcpConfig.mcpServers.k_luna;

      await f.c.send({threadId, text: `工具 ${extraTool} 測試`});
      host.options.onMessage({
        type: 'assistant',
        uuid: 'asst-own',
        message: {
          role: 'assistant',
          content: [{type: 'tool_use', id: 'tu-own', name: 'mcp__k_luna__conversation_create', input: {}}]
        }
      });
      const callRes = await callGatewayTool(gw, 'conversation_create', {nextInstruction: 'should cancel'});
      assert.equal(callRes.isError, false);
      host.options.onMessage({
        type: 'user',
        message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tu-own', content: callRes.text}]}
      });

      // Another tool runs after conversation_create was accepted.
      host.options.onMessage({
        type: 'assistant',
        uuid: 'asst-extra',
        message: {
          role: 'assistant',
          content: [{type: 'tool_use', id: 'tu-extra', name: extraTool, input: {}}]
        }
      });
      host.options.onMessage({
        type: 'user',
        message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tu-extra', content: 'done'}]}
      });
      host.options.onMessage({type: 'result', is_error: false});

      await waitFor(async () => (await f.receipt(threadId).catch(() => null))?.status === 'cancelled');
      assert.equal(f.hostInstances.length, 1);
    } finally {
      await f.c.close();
    }
  });

test('Claude loadRoom on restart recovers pending receipt as cancelled and blocks goalError/unknown goals', async () => {
  const f = await createOrchestrationFixture({realGateway: true});
  let id1, id2;
  try {
    ({threadId: id1} = await f.c.open({model: 'claude-opus-4-6'}));
    const host1 = f.hostInstances[0];
    const gw1 = host1.options.mcpConfig.mcpServers.k_luna;

    // Unknown goal blocks acceptance at continuationGoal().
    await f.c.send({threadId: id1, text: 'unknown goal 測試'});
    f.claudeControllers[0].state.goal = {status: 'unknown', objective: 'unclear'};
    const blockedRes = await callGatewayTool(gw1, 'conversation_create', {nextInstruction: 'blocked by unknown goal'});
    assert.equal(blockedRes.isError, true);
    assert.match(blockedRes.text, /目標/);
    host1.options.onMessage({type: 'result', is_error: false});
    await waitFor(() => !f.c.state.busy);

    ({threadId: id2} = await f.c.open({model: 'claude-opus-4-6'}));
  } finally {
    await f.c.close();
  }

  // Write a simulated leftover pending receipt for id2 before restarting K.
  await mkdir(path.join(f.root, '.runtime/chat-continuations'), {recursive: true});
  await writeFile(
    path.join(f.root, '.runtime/chat-continuations', `${id2}.json`),
    JSON.stringify({sourceThreadId: id2, turnId: 't-stale', mode: 'fresh', status: 'pending', nextInstruction: 'x'})
  );

  const f2 = await createOrchestrationFixture({root: f.root, realGateway: true});
  try {
    await f2.c.open({threadId: id2, model: 'claude-opus-4-6'});
    assert.equal(f2.c.state.continuation?.status, 'cancelled');
    assert.equal((await f2.receipt(id2)).status, 'cancelled');
  } finally {
    await f2.c.close();
  }

  // Also ensure a Codex room with mismatched turnId still ignores (does not cancel) unlike Claude.
  await mkdir(scratchBase, {recursive: true});
  const codexRoot = await mkdtemp(path.join(scratchBase, 'codex-mismatch-'));
  let codexOwner;
  const codexCtrl = createConversationController({
    root: codexRoot,
    sessionFactory: hooks => {
      const state = {
        provider: 'codex',
        threadId: null,
        model: 'gpt-6.1-sol',
        workspace: codexRoot,
        accessMode: 'read-only',
        effort: 'medium',
        serviceTier: 'default',
        busy: false,
        status: 'ready',
        questions: [],
        queuedMessages: [],
        messages: [],
        workers: [],
        tools: [],
        goal: null
      };
      codexOwner = {
        state,
        hooks,
        async models() {
          return {models: []};
        },
        async selectWorkspace({path: dir}) {
          state.workspace = dir;
        },
        async open(data) {
          Object.assign(state, data);
          state.threadId ??= 'codex-room-1';
          await saveMainSession(codexRoot, {...state});
          return {threadId: state.threadId};
        },
        async goal() {
          return {goal: state.goal};
        },
        async workers() {
          return [];
        },
        async close() {}
      };
      return codexOwner;
    }
  });
  try {
    await codexCtrl.open({model: 'gpt-6.1-sol'});
    codexOwner.state.busy = true;
    codexOwner.state.messages.push({id: 'm1', role: 'user', turnId: 'turn-1', text: 'move', source: 'local'});
    await codexOwner.hooks.onContinueConversation({
      mode: 'fresh',
      threadId: 'codex-room-1',
      turnId: 'turn-1',
      nextInstruction: 'do next'
    });
    // Mismatched turnId on Codex must NOT cancel the pending receipt.
    codexOwner.hooks.onConversationSettled({threadId: 'codex-room-1', turnId: 'unrelated-turn', status: 'completed'});
    await tick();
    assert.equal(codexCtrl.state.continuation?.status, 'pending');
  } finally {
    await codexCtrl.close();
  }
});

test('Claude host crash during pending goal read notifies interrupted once and goalError blocks acceptance', async () => {
  const settledEvents = [];
  let releaseGoal;
  let blockGoal = false;
  const f = await createOrchestrationFixture({
    realGateway: true,
    onConversationSettledSpy: event => settledEvents.push(event),
    onHostFactory: (host, opts) => {
      if (!opts.mcpConfig) return;
      host.goal = async arg => {
        host.goalCalls.push(arg);
        if (blockGoal) {
          await new Promise(resolve => {
            releaseGoal = resolve;
          });
        }
        opts.onMessage?.({type: 'result', is_error: false});
        return 'No goal set. Usage: `/goal <condition>`';
      };
    }
  });
  try {
    const {threadId} = await f.c.open({model: 'claude-opus-4-6'});
    const host = f.hostInstances[0];
    const gw = host.options.mcpConfig.mcpServers.k_luna;

    // goalError blocks acceptance.
    await f.c.send({threadId, text: 'goalError 測試'});
    f.claudeControllers[0].state.goalError = 'goal failed';
    const errRes = await callGatewayTool(gw, 'conversation_create', {nextInstruction: 'blocked by goalError'});
    assert.equal(errRes.isError, true);
    assert.match(errRes.text, /目標/);
    f.claudeControllers[0].state.goalError = null;

    // Crash while goalPending is true (after result arrived, waiting on goalCommand): must emit interrupted once only.
    f.claudeControllers[0].state.goal = {status: 'ended', objective: 'old'};
    const okRes = await callGatewayTool(gw, 'conversation_create', {nextInstruction: 'crash during goalPending'});
    assert.equal(okRes.isError, false);

    blockGoal = true;
    f.claudeControllers[0].state.goal = {status: 'active', objective: 'active during turn'};
    host.options.onMessage({type: 'result', is_error: false});
    await waitFor(() => f.claudeControllers[0].state.goalPending === true);
    const beforeCrash = settledEvents.length;
    host.crash();
    await waitFor(async () => (await f.receipt(threadId).catch(() => null))?.status === 'cancelled');
    releaseGoal?.();
    await tick();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(settledEvents.length, beforeCrash + 1);
    assert.equal(settledEvents.at(-1).status, 'interrupted');
    assert.equal(f.hostInstances.length, 1);
  } finally {
    releaseGoal?.();
    await f.c.close();
  }
});
