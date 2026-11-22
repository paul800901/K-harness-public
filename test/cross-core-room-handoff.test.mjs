// A main chat of any of the five cores may move its work to a fresh room on another core (or the same
// one) when the human asks in the current turn. Real conversation/unified/core controllers and the real
// MCP gateway; only the native processes are scripted stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {lstat, mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {zstdCompressSync} from 'node:zlib';
import {createConversationController} from '../src/conversation-controller.mjs';
import {createUnifiedController} from '../src/unified-controller.mjs';
import {createClaudeController} from '../src/claude-controller.mjs';
import {createGrokController} from '../src/grok-controller.mjs';
import {createDeepSeekController} from '../src/dsh-controller.mjs';
import {createGeminiController} from '../src/gemini-controller.mjs';
import {createLunaGateway} from '../src/luna-gateway.mjs';
import {grokModelsFrom} from '../src/grok-acp.mjs';
import {dshModelOptions} from '../src/dsh-acp.mjs';
import {handoffAccessMode, writeTranscriptHandoff} from '../src/conversation-handoff.mjs';
import {listMainSessions} from '../src/main-sessions.mjs';
import {identifyBrowserServer} from '../src/browser-mcp-config.mjs';
import {scratchBase} from './scratch.mjs';

const GROK_MODELS = grokModelsFrom({
  protocolVersion: 1,
  _meta: {
    modelState: {
      currentModelId: 'grok-4.7',
      availableModels: ['grok-4.7', 'grok-4.5'].map(modelId => ({
        modelId,
        name: modelId,
        _meta: {
          supportsReasoningEffort: true,
          reasoningEffort: 'high',
          reasoningEfforts: ['high', 'medium', 'low'].map(value => ({value, default: value === 'high'}))
        }
      }))
    }
  }
});
const dshValue = model => JSON.stringify(['deepseek-official', model]);
const DSH_CONFIG = [
  {
    id: 'model',
    category: 'model',
    currentValue: dshValue('deepseek-v4-flash'),
    options: [
      {
        group: 'deepseek-official',
        name: 'DeepSeek',
        options: [{value: dshValue('deepseek-v4-flash'), name: 'deepseek-v4-flash'}]
      }
    ]
  },
  {
    id: 'reasoning_effort',
    category: 'thought_level',
    currentValue: 'high',
    options: ['low', 'high'].map(v => ({value: v, name: v}))
  }
];
const DSH_MODELS = dshModelOptions(DSH_CONFIG).map(row => ({
  ...row,
  provider: 'deepseek',
  available: true,
  inputModalities: ['text'],
  supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({reasoningEffort, description: ''})),
  defaultReasoningEffort: 'high'
}));
const CLAUDE_MODELS = [
  {
    model: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'claude',
    inputModalities: ['text'],
    supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'medium'}],
    defaultReasoningEffort: 'medium'
  }
];

async function waitFor(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function callTool(server, name, args) {
  const token = server.headers.Authorization.slice(7);
  const post = message =>
    fetch(server.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify(message)
    }).then(async response => {
      const text = await response.text();
      const data = text
        .split(/\r?\n/u)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      return JSON.parse(data || text);
    });
  await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test', version: '1'}}
  });
  const res = await post({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name, arguments: args}});
  if (res.error) return {isError: true, text: res.error.message, json: null};
  const text = res.result?.content?.[0]?.text ?? '';
  return {isError: res.result?.isError === true, text, json: res.result?.isError ? null : JSON.parse(text)};
}

const fakeCodexFactory = () => () => {
  const state = {
    provider: 'codex',
    threadId: null,
    model: 'gpt-6.1-sol',
    busy: false,
    status: 'ready',
    questions: [],
    messages: [],
    workers: [],
    tools: []
  };
  return {
    state,
    models: async () => ({models: [], geminiGateway: false}),
    usage: async () => ({}),
    selectWorkspace: async ({path: dir}) => void (state.workspace = dir),
    workers: async () => [],
    close: async () => void (state.status = 'offline')
  };
};

const fakeBridge = async () => ({
  list: async () => [],
  start: async args => ({requestId: args.requestId, status: 'running', settled: false}),
  cancel: async () => ({}),
  wait: async () => ({settled: true}),
  inspect: async () => ({settled: true}),
  close: async () => {}
});

// One scripted native ACP process per open. A prompt runs the next script of its core: it may stream
// updates and call K's tools before returning a stop reason.
function acpAgents(kind, f) {
  return async ({onNotification}) => {
    let exited = false,
      session = null;
    return {
      pid: 7000,
      initialize: {protocolVersion: 1},
      closed: new Promise(() => {}),
      get exited() {
        return exited;
      },
      async request(method, params) {
        if (method === 'session/new')
          return {sessionId: (session = randomUUID()), ...(kind === 'deepseek' ? {configOptions: DSH_CONFIG} : {})};
        if (method === 'session/prompt') {
          const text = params.prompt.map(block => block.text ?? '').join('\n');
          f.prompts.push({kind, text});
          const logFolder = path.join(f.root, 'dsh-home', 'sessions', '--ws--', session);
          const writeLog = events => writeFile(path.join(logFolder, 'session.v4.jsonl.zstd'),
            zstdCompressSync(Buffer.from(events.map((type, seq) => JSON.stringify({type, seq})).join('\n') + '\n')));
          if (kind === 'deepseek') {
            await mkdir(logFolder, {recursive: true});
            await writeLog(['turn/start']);
          }
          const update = value => onNotification({method: 'session/update', params: {sessionId: session, update: value}});
          const step = f.scripts[kind].shift() ?? (async () => ({stopReason: 'end_turn'}));
          const result = await step({update, text, logFolder});
          if (kind === 'deepseek') await writeLog(['turn/start', 'turn/end']);
          if (!result.silent) update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: `${kind} 回覆`}});
          return {stopReason: result.stopReason ?? 'end_turn'};
        }
        if (['session/resume', 'session/load', 'session/set_config_option', 'session/set_model', 'session/set_mode'].includes(method))
          return session ? {} : ((session = params.sessionId), {});
        return {};
      },
      notify() {},
      async close() {
        exited = true;
      }
    };
  };
}

async function fixture() {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'cross-core-handoff-'));
  await writeFile(path.join(root, 'README.md'), 'fixture');
  const f = {
    root,
    prompts: [],
    scripts: {grok: [], deepseek: [], gemini: []},
    gateways: {},
    gatewayOptions: {},
    bridgeOptions: {},
    workerRows: [],
    claudeHosts: [],
    receipt: async id => JSON.parse(await readFile(path.join(root, '.runtime/chat-continuations', `${id}.json`), 'utf8'))
  };
  const gatewayFor = kind => async options => {
    const gateway = await createLunaGateway(options);
    f.gatewayOptions[kind] = options;
    f.gateways[kind] = gateway.mcpConfig.mcpServers.k_luna;
    return gateway;
  };
  // Records each core's worker callbacks; the listed rows are the test's K workers.
  const bridgeFor = kind => async options => {
    f.bridgeOptions[kind] = options;
    return {
      ...(await fakeBridge()),
      list: async () => {
        await f.onList?.();
        return structuredClone(f.workerRows);
      }
    };
  };
  f.c = createConversationController({
    root,
    sessionFactory: opts =>
      createUnifiedController({
        ...opts,
        codexFactory: fakeCodexFactory(),
        inspect: async () => {
          await f.onClaudeInspect?.();
          return {available: true};
        },
        claudeFactory: claudeOpts =>
          createClaudeController({
            ...claudeOpts,
            commandSpec: {command: 'claude-test', argsPrefix: []},
            bridgeFactory: fakeBridge,
            gatewayFactory: gatewayFor('claude'),
            hostFactory: async hostOpts => {
              const host = {
                options: hostOpts,
                models: CLAUDE_MODELS,
                nativeCapabilities: {commands: [], efforts: []},
                starts: [],
                closed: new Promise(() => {}),
                async start(content) {
                  this.starts.push(content);
                },
                async interrupt() {},
                async close() {}
              };
              if (hostOpts.mcpConfig) f.claudeHosts.push(host);
              return host;
            }
          }),
        grokFactory: grokOpts =>
          createGrokController({
            ...grokOpts,
            env: {SystemRoot: process.env.SystemRoot},
            grokExecutable: path.join(root, 'grok.exe'),
            openAgent: acpAgents('grok', f),
            loginFactory: () => ({models: async () => GROK_MODELS, status: async () => ({available: true})}),
            bridgeFactory: bridgeFor('grok'),
            gatewayFactory: gatewayFor('grok')
          }),
        deepseekFactory: dshOpts =>
          createDeepSeekController({
            ...dshOpts,
            env: {SystemRoot: process.env.SystemRoot, K_DSH_HOME: path.join(root, 'dsh-home')},
            dshExecutable: path.join(root, 'dsh.exe'),
            apiKey: async () => 'sk-test',
            openAgent: acpAgents('deepseek', f),
            loginFactory: () => ({
              models: async () => DSH_MODELS,
              status: async () => ({available: true}),
              prices: async () => null
            }),
            bridgeFactory: bridgeFor('deepseek'),
            gatewayFactory: gatewayFor('deepseek')
          }),
        geminiFactory: geminiOpts =>
          createGeminiController({
            ...geminiOpts,
            env: {
              LOCALAPPDATA: path.join(root, 'local'),
              SystemRoot: process.env.SystemRoot ?? root,
              TEMP: path.join(root, 'host-temp')
            },
            loginFactory: () => ({
              status: async () => ({available: true, models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-high']})
            }),
            stopGraceMs: 25,
            openAgent: acpAgents('gemini', f),
            bridgeFactory: bridgeFor('gemini'),
            gatewayFactory: gatewayFor('gemini')
          })
      })
  });
  return f;
}

// The source model asks K to move while its turn runs, then ends the turn.
const moveDuringTurn = (f, kind, args, toolName = 'conversation_create') => async ({update}) => {
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-move',
    title: toolName,
    kind: 'other',
    status: 'pending',
    _meta: {'x.ai/tool': {name: toolName}}
  });
  f.result = await callTool(f.gateways[kind], 'conversation_create', args);
  update({sessionUpdate: 'tool_call_update', toolCallId: 'tc-move', status: 'completed'});
  return {};
};

test('permission mapping keeps the same tier or a lower one, never higher', () => {
  assert.equal(handoffAccessMode('claude-auto', 'claude', 'claude'), 'claude-auto');
  assert.equal(handoffAccessMode('claude-bypassPermissions', 'claude', 'grok'), 'danger-full-access');
  assert.equal(handoffAccessMode('danger-full-access', 'gemini', 'claude'), 'claude-bypassPermissions');
  assert.equal(handoffAccessMode('claude-plan', 'claude', 'codex'), 'read-only');
  assert.equal(handoffAccessMode('claude-dontAsk', 'claude', 'deepseek'), 'read-only');
  assert.equal(handoffAccessMode('claude-acceptEdits', 'claude', 'gemini'), 'workspace-write');
  assert.equal(handoffAccessMode('claude-auto', 'claude', 'codex'), 'auto-review');
  assert.equal(handoffAccessMode('claude-auto', 'claude', 'grok'), 'workspace-write');
  assert.equal(handoffAccessMode('auto-review', 'codex', 'claude'), 'claude-auto');
  assert.equal(handoffAccessMode('auto-review', 'codex', 'deepseek'), 'workspace-write');
  assert.equal(handoffAccessMode('workspace-write', 'grok', 'claude'), 'claude-manual');
  assert.equal(handoffAccessMode('read-only', 'deepseek', 'claude'), 'claude-plan');
  assert.throws(() => handoffAccessMode('custom', 'deepseek', 'claude'), /無法對照/u);
  assert.throws(() => handoffAccessMode('read-only', 'codex', 'gemma'), /無法對照/u);
});

test('transcript page boundaries preserve original newlines, literal markers and Unicode', async () => {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'transcript-'));
  const long = '🙂甲'.repeat(6500) + '\r\n⏎原文\r\n';
  const messages = [
    {role: 'user', text: '第一則本人訊息', source: 'local', attachments: [{name: 'a.pdf'}]},
    {role: 'assistant', text: long},
    ...Array.from({length: 40}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', text: `第${i}段 ${'乙'.repeat(800)}`})),
    {role: 'user', kind: 'worker-completion', text: '工人完成'},
    {role: 'assistant', text: '還在寫', partial: true},
    {role: 'tool', text: '工具輸出不該出現'}
  ];
  const written = await writeTranscriptHandoff({
    root,
    source: {threadId: 'grok-abc', provider: 'grok', model: 'grok-4.7', title: '來源房', messages}
  });
  assert.equal(written.messages, messages.length - 1);
  assert.ok(written.pages > 1);
  const index = await readFile(written.index, 'utf8');
  const pages = index.split('\n').filter(line => line.startsWith('- ') && line.endsWith('.md')).map(line => line.slice(2));
  assert.equal(pages.length, written.pages);
  const bodies = await Promise.all(pages.map(file => readFile(file, 'utf8')));
  for (const body of bodies) assert.ok(Buffer.byteLength(body) <= 4096);
  const all = bodies.join('');
  for (const message of messages.slice(0, -1)) assert.ok(all.includes(message.text));
  assert.doesNotMatch(all, /工具輸出不該出現/u);
  assert.match(all, /附件：a\.pdf；附件內容未帶入/u);
  assert.match(all, /K 通知（worker-completion）/u);
  assert.match(all, /AI 回覆（未完成）/u);
});

test('an unreadable DeepSeek native log blocks the request before a room is created', async () => {
  const f = await fixture();
  try {
    const {threadId} = await f.c.open({model: 'deepseek-v4-flash', accessMode: 'workspace-write'});
    f.scripts.deepseek.push(async ({logFolder}) => {
      await writeFile(path.join(logFolder, 'session.v4.jsonl.zstd'), 'incomplete');
      f.result = await callTool(f.gateways.deepseek, 'conversation_create', {nextInstruction: '接手'});
      return {};
    });
    await f.c.send({threadId, text: '請換房'});
    await waitFor(() => !f.c.state.busy, 'source settled');
    assert.equal(f.result.isError, true);
    assert.match(f.result.text, /原生紀錄未確認/);
    await assert.rejects(f.receipt(threadId), {code: 'ENOENT'});
  } finally {
    await f.c.close();
  }
});

test('a notice arriving during target open waits on the source and preserves the known unsent room', async () => {
  const f = await fixture();
  try {
    const {threadId} = await f.c.open({model: 'grok-4.7', effort: 'high',
      accessMode: 'danger-full-access', permissionConfirmed: true});
    f.scripts.grok.push(async context => {
      await f.gatewayOptions.grok.bridge.list();
      await moveDuringTurn(f, 'grok', {nextInstruction: '接手', model: 'claude-sonnet-4-6'})(context);
      f.onClaudeInspect = async () => {
        await f.gatewayOptions.grok.bridge.start({requestId: 'late-open', task: 'x'});
        const row = {parentId: threadId, requestId: 'late-open', provider: 'codex',
          settled: true, status: 'completed', output: 'done'};
        f.workerRows = [row];
        f.bridgeOptions.grok.onChange(row);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(f.prompts.filter(p => p.kind === 'grok').length, 1);
      };
      return {};
    });
    await f.c.send({threadId, text: '換房'});
    await waitFor(async () => (await f.receipt(threadId).catch(() => null))?.started === false, 'known unsent');
    const receipt = await f.receipt(threadId);
    assert.equal(receipt.status, 'cancelled');
    assert.ok(receipt.newThreadId);
    assert.equal(f.claudeHosts.flatMap(h => h.starts).length, 0);
    await waitFor(() => !f.c.state.busy && f.c.state.messages.some(m => m.kind === 'worker-completion'), 'source notice');
    assert.equal(f.c.state.messages.filter(m => m.kind === 'worker-completion').length, 1);
  } finally {
    await f.c.close();
  }
});

test('a Grok main chat moves to a fresh Claude room with a lower-or-equal permission and the full transcript', async () => {
  const f = await fixture();
  try {
    const {threadId: sourceId} = await f.c.open({
      model: 'grok-4.7',
      effort: 'medium',
      accessMode: 'workspace-write'
    });
    const policy = structuredClone(f.c.state.workerPolicy);
    assert.ok(policy);
    f.scripts.grok.push(async () => ({}));
    await f.c.send({threadId: sourceId, text: '先讀 README'});
    await waitFor(() => !f.c.state.busy, 'first turn');
    f.scripts.grok.push(
      moveDuringTurn(f, 'grok', {nextInstruction: '只做剩下的第二步', model: 'claude-sonnet-4-6', transcript: true})
    );
    await f.c.send({threadId: sourceId, text: '換到 Claude Sonnet 新房，帶完整資料'});
    await waitFor(async () => (await f.receipt(sourceId).catch(() => null))?.status === 'sent', 'handoff sent');
    assert.equal(f.result.isError, false, f.result.text);
    assert.deepEqual(
      [f.result.json.accepted, f.result.json.targetModel, f.result.json.targetEffort, f.result.json.targetAccessMode],
      [true, 'claude-sonnet-4-6', 'medium', 'claude-manual']
    );
    const receipt = await f.receipt(sourceId);
    const childId = receipt.newThreadId;
    assert.match(childId, /^claude-/u);
    assert.equal(f.c.state.threadId, childId);
    assert.equal(f.c.state.provider, 'claude');
    assert.equal(f.c.state.model, 'claude-sonnet-4-6');
    assert.equal(f.c.state.effort, 'medium');
    assert.equal(f.c.state.accessMode, 'claude-manual');
    assert.deepEqual(f.c.state.workerPolicy, policy);
    const host = f.claudeHosts.at(-1);
    assert.equal(host.starts.length, 1);
    const first = JSON.stringify(host.starts[0]);
    assert.match(first, /跨核心換房：原聊天室是 grok（grok-4\.7），新聊天室是 claude（claude-sonnet-4-6）/u);
    assert.match(first, /只做剩下的第二步/u);
    const indexPath = /索引：(.+?index\.md)/u.exec(f.c.state.messages[0].text)[1];
    const index = await readFile(indexPath, 'utf8');
    const page = await readFile(index.split('\n').find(line => line.endsWith('page-001.md')).slice(2), 'utf8');
    assert.match(page, /先讀 README/u);
    assert.match(page, /grok 回覆/u);
    assert.match(page, /換到 Claude Sonnet 新房，帶完整資料/u);
    assert.equal(f.c.state.messages[0].source, 'continuation');
    const origin = await f.receipt(childId);
    assert.equal(origin.kind, 'origin');
    assert.equal(origin.handoffFrom, sourceId);
    assert.ok(origin.initialTurnId);
  } finally {
    await f.c.close();
  }
});

test('a Claude main chat moves to a fresh Grok room; plan mode becomes read-only', async () => {
  const f = await fixture();
  try {
    const {threadId: sourceId} = await f.c.open({model: 'claude-sonnet-4-6', effort: 'low', accessMode: 'claude-plan'});
    const host = f.claudeHosts.at(-1);
    await f.c.send({threadId: sourceId, text: '換到 Grok 4.5 新房做'});
    host.options.onMessage({
      type: 'assistant',
      uuid: 'a1',
      message: {role: 'assistant', content: [{type: 'tool_use', id: 'tu1', name: 'mcp__k_luna__conversation_create', input: {}}]}
    });
    const result = await callTool(f.gateways.claude, 'conversation_create', {nextInstruction: '接手', model: 'grok-4.5'});
    assert.equal(result.isError, false, result.text);
    host.options.onMessage({
      type: 'user',
      message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tu1', content: result.text}]}
    });
    host.options.onMessage({type: 'result', is_error: false});
    await waitFor(async () => (await f.receipt(sourceId).catch(() => null))?.status === 'sent', 'handoff sent');
    assert.equal(f.c.state.provider, 'grok');
    assert.equal(f.c.state.model, 'grok-4.5');
    assert.equal(f.c.state.effort, 'high');
    assert.equal(f.c.state.accessMode, 'read-only');
    assert.match(f.c.state.title, /^新對話 · /u);
    const sent = f.prompts.filter(p => p.kind === 'grok');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /跨核心換房：原聊天室是 claude/u);
    assert.doesNotMatch(sent[0].text, /索引：/u);
    const user = f.c.state.messages.find(m => m.role === 'user');
    assert.deepEqual([user.source, typeof user.turnId], ['continuation', 'string']);
  } finally {
    await f.c.close();
  }
});

test('Gemini and DeepSeek main chats can move too, and a new Gemini room is created as a target', async () => {
  const f = await fixture();
  try {
    const {threadId: geminiId} = await f.c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'danger-full-access', permissionConfirmed: true});
    f.scripts.gemini.push(moveDuringTurn(f, 'gemini', {nextInstruction: '交給 DeepSeek', model: 'deepseek-v4-flash'}));
    await f.c.send({threadId: geminiId, text: '換到 DeepSeek 新房'});
    await waitFor(async () => (await f.receipt(geminiId).catch(() => null))?.status === 'sent', 'gemini handoff sent');
    assert.equal(f.result.isError, false, f.result.text);
    const deepseekId = (await f.receipt(geminiId)).newThreadId;
    assert.match(deepseekId, /^deepseek-/u);
    assert.equal(f.c.state.accessMode, 'danger-full-access');
    assert.equal(f.c.state.effort, 'high');
    await waitFor(() => !f.c.state.busy, 'deepseek first turn');

    // The first turn of the new room cannot move again.
    assert.equal(f.prompts.filter(p => p.kind === 'deepseek').length, 1);
    f.scripts.deepseek.push(moveDuringTurn(f, 'deepseek', {nextInstruction: '回 Gemini', model: 'gemini-3.8-flash', effort: 'high'}));
    await f.c.send({threadId: deepseekId, text: '再換到 Gemini 高'});
    await waitFor(async () => (await f.receipt(deepseekId).catch(() => null))?.status === 'sent', 'deepseek handoff sent');
    assert.equal(f.result.isError, false, f.result.text);
    const geminiChild = (await f.receipt(deepseekId)).newThreadId;
    assert.match(geminiChild, /^gemini-/u);
    assert.equal(f.c.state.provider, 'gemini');
    assert.equal(f.c.state.effort, 'high');
    await waitFor(() => !f.c.state.busy, 'gemini first turn');
    const handoff = f.c.state.messages.find(m => m.role === 'user');
    assert.deepEqual([handoff.source, typeof handoff.turnId], ['continuation', 'string']);
    // Its own handoff turn is not a human turn and cannot move the room again.
    const origin = await f.receipt(geminiChild);
    assert.equal(origin.initialTurnId, handoff.turnId);
  } finally {
    await f.c.close();
  }
});

test('refusals: native subagent running, unknown or non-main target, ended turn, and a source turn that does not complete', async () => {
  const f = await fixture();
  try {
    const {threadId: sourceId} = await f.c.open({model: 'grok-4.7', accessMode: 'workspace-write'});
    // A native subagent-like tool still running: refused, nothing accepted.
    f.scripts.grok.push(async ({update}) => {
      update({sessionUpdate: 'tool_call', toolCallId: 'tc-sub', title: 'task', status: 'pending', _meta: {'x.ai/tool': {name: 'task'}}});
      f.result = await callTool(f.gateways.grok, 'conversation_create', {nextInstruction: 'x', model: 'claude-sonnet-4-6'});
      update({sessionUpdate: 'tool_call_update', toolCallId: 'tc-sub', status: 'completed'});
      return {};
    });
    await f.c.send({threadId: sourceId, text: '換房'});
    await waitFor(() => !f.c.state.busy && f.result, 'subagent refusal');
    assert.equal(f.result.isError, true);
    assert.match(f.result.text, /原生子代理/u);
    assert.equal(await f.receipt(sourceId).catch(() => null), null);

    for (const [model, pattern] of [
      ['claude-not-listed', /不在目標核心目前可用的原生目錄/u],
      ['gemma-local/qwen', /五家主核心/u],
      ['grok-9', /未提供指定模型/u]
    ]) {
      f.result = null;
      f.scripts.grok.push(moveDuringTurn(f, 'grok', {nextInstruction: 'x', model}));
      await f.c.send({threadId: sourceId, text: `換到 ${model}`});
      await waitFor(() => !f.c.state.busy && f.result, model);
      assert.equal(f.result.isError, true, model);
      assert.match(f.result.text, pattern);
      assert.equal(await f.receipt(sourceId).catch(() => null), null);
    }

    // Outside a running main turn: refused.
    const late = await callTool(f.gateways.grok, 'conversation_create', {nextInstruction: 'x'});
    assert.equal(late.isError, true);
    assert.match(late.text, /進行中回合/u);

    // Accepted, but the source turn fails: cancelled, no room created and nothing sent.
    const rooms = (await listMainSessions(f.root)).sessions.length;
    f.scripts.grok.push(async context => {
      await moveDuringTurn(f, 'grok', {nextInstruction: 'x', model: 'claude-sonnet-4-6'})(context);
      return {stopReason: 'refusal'};
    });
    await f.c.send({threadId: sourceId, text: '換到 Claude'});
    await waitFor(async () => (await f.receipt(sourceId).catch(() => null))?.status === 'cancelled', 'cancelled');
    assert.equal(f.result.json.accepted, true);
    assert.equal(f.c.state.threadId, sourceId);
    assert.equal((await listMainSessions(f.root)).sessions.length, rooms);
    assert.equal(f.claudeHosts.length, 0);
  } finally {
    await f.c.close();
  }
});

for (const [kind, model, effort] of [
  ['grok', 'grok-4.7', 'high'],
  ['gemini', 'gemini-3.8-flash', 'low'],
  ['deepseek', 'deepseek-v4-flash', 'high']
])
  test(`${kind}: a settled K worker whose notice is still queued refuses the move; the notice reaches the source room once`, async () => {
    const f = await fixture();
    try {
      const {threadId} = await f.c.open({model, effort, accessMode: 'danger-full-access', permissionConfirmed: true});
      f.scripts[kind].push(async () => {
        await f.gatewayOptions[kind].bridge.start({requestId: 'k-done', task: 'x'});
        const row = {parentId: threadId, requestId: 'k-done', provider: 'codex', settled: true, status: 'completed', output: 'done'};
        f.workerRows = [row];
        f.bridgeOptions[kind].onChange(row);
        f.result = await callTool(f.gateways[kind], 'conversation_create', {nextInstruction: '接手', model: 'claude-sonnet-4-6'});
        return {};
      });
      await f.c.send({threadId, text: '換到 Claude 新房'});
      await waitFor(
        () => !f.c.state.busy && f.c.state.messages.some(m => m.kind === 'worker-completion'),
        'worker notice in the source room'
      );
      assert.equal(f.result.isError, true, f.result.text);
      assert.match(f.result.text, /通知尚未送達/u);
      await assert.rejects(f.receipt(threadId), {code: 'ENOENT'});
      assert.equal(f.c.state.threadId, threadId);
      assert.equal(f.claudeHosts.length, 0);
      assert.equal(f.prompts.filter(p => p.kind === kind).length, 2);
      assert.equal(f.c.state.messages.filter(m => m.kind === 'worker-completion').length, 1);
    } finally {
      await f.c.close();
    }
  });

test('Grok: a running native subagent is refused even when its display label hides the native name', async () => {
  const f = await fixture();
  try {
    const {threadId} = await f.c.open({model: 'grok-4.7', accessMode: 'workspace-write'});
    f.scripts.grok.push(async ({update}) => {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-sub',
        title: 'task',
        status: 'pending',
        _meta: {'x.ai/tool': {name: 'task', label: 'Delegate'}}
      });
      f.result = await callTool(f.gateways.grok, 'conversation_create', {nextInstruction: 'x', model: 'claude-sonnet-4-6'});
      update({sessionUpdate: 'tool_call_update', toolCallId: 'tc-sub', status: 'completed'});
      return {};
    });
    await f.c.send({threadId, text: '換房'});
    await waitFor(() => !f.c.state.busy && f.result, 'labelled subagent refusal');
    assert.equal(f.c.state.tools.find(t => t.id.endsWith('-tc-sub'))?.name, 'Delegate');
    assert.equal(f.result.isError, true, f.result.text);
    assert.match(f.result.text, /原生子代理/u);
    assert.equal(await f.receipt(threadId).catch(() => null), null);
  } finally {
    await f.c.close();
  }
});

test('Gemini: native multi-agent tools and a running native command refuse the move before it is accepted', async () => {
  const f = await fixture();
  try {
    const {threadId} = await f.c.open({
      model: 'gemini-3.8-flash',
      effort: 'low',
      accessMode: 'danger-full-access',
      permissionConfirmed: true
    });
    for (const [title, kind] of [
      ['run_workflow', 'other'],
      ['swarm', 'other'],
      ['Shell', 'execute']
    ]) {
      f.result = null;
      f.scripts.gemini.push(async ({update}) => {
        update({sessionUpdate: 'tool_call', toolCallId: `tc-${title}`, title, kind, status: 'in_progress'});
        f.result = await callTool(f.gateways.gemini, 'conversation_create', {nextInstruction: 'x', model: 'claude-sonnet-4-6'});
        update({sessionUpdate: 'tool_call_update', toolCallId: `tc-${title}`, status: 'completed'});
        return {};
      });
      await f.c.send({threadId, text: `換房 ${title}`});
      await waitFor(() => !f.c.state.busy && f.result, title);
      assert.equal(f.result.isError, true, `${title}: ${f.result.text}`);
      assert.match(f.result.text, /原生子代理或背景命令/u, title);
      assert.equal(await f.receipt(threadId).catch(() => null), null, title);
    }
    assert.equal(f.c.state.threadId, threadId);
    assert.equal(f.claudeHosts.length, 0);
  } finally {
    await f.c.close();
  }
});

test('Gemini: a failed browser stop while a continuation open fails keeps the original error and its created room id', async () => {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'cross-core-gemini-open-'));
  const f = {root, prompts: [], scripts: {gemini: []}};
  let closes = 0;
  const controller = createGeminiController({
    root,
    env: {
      LOCALAPPDATA: path.join(root, 'local'),
      SystemRoot: process.env.SystemRoot ?? root,
      TEMP: path.join(root, 'host-temp')
    },
    loginFactory: () => ({
      status: async () => ({available: true, models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-high']})
    }),
    stopGraceMs: 25,
    openAgent: acpAgents('gemini', f),
    bridgeFactory: fakeBridge,
    browserConfig: async input =>
      identifyBrowserServer(
        {url: 'http://127.0.0.1:44444/mcp', headers: {Authorization: 'Bearer test-secret'}},
        input.conversationId
      ),
    // Only the stop during the failed open fails; teardown afterwards must still close the gateway.
    closeBrowser: async () => {
      if (++closes === 1) throw Error('browser stop failed');
    }
  });
  try {
    await assert.rejects(
      controller.open(
        {model: 'gemini-3.8-flash', effort: 'low', accessMode: 'workspace-write'},
        {
          continuation: {mode: 'fresh', parentTitle: '原房'},
          onCreated: async () => {
            throw Error('receipt write failed');
          }
        }
      ),
      error =>
        error.message === 'receipt write failed' &&
        typeof error.createdThreadId === 'string' &&
        error.createdThreadId.startsWith('gemini-') &&
        error.notCreated !== true
    );
    assert.equal(closes, 1);
    assert.equal(controller.state.status, 'uncertain');
  } finally {
    await controller.close().catch(() => {});
  }
});

for (const [kind, model, effort] of [
  ['grok', 'grok-4.7', 'high'],
  ['gemini', 'gemini-3.8-flash', 'low']
])
  test(`${kind}: a K notice arriving while the move is prepared cancels it before any room exists and is delivered once`, async () => {
    const f = await fixture();
    try {
      const {threadId} = await f.c.open({model, effort, accessMode: 'danger-full-access', permissionConfirmed: true});
      f.scripts[kind].push(async context => {
        await f.gatewayOptions[kind].bridge.list();
        await moveDuringTurn(f, kind, {nextInstruction: '接手', model: 'claude-sonnet-4-6'})(context);
        // After the turn: the first worker listing is the source's preparation.
        f.onList = async () => {
          f.onList = null;
          await f.gatewayOptions[kind].bridge.start({requestId: 'k-late', task: 'x'});
          const row = {parentId: threadId, requestId: 'k-late', provider: 'codex', settled: true, status: 'completed', output: 'late'};
          f.workerRows = [row];
          f.bridgeOptions[kind].onChange(row);
          await new Promise(resolve => setTimeout(resolve, 50));
          // The preparation holds K notices back: no source turn may start while the move is decided.
          f.promptsDuringPrepare = f.prompts.filter(p => p.kind === kind).length;
        };
        return {};
      });
      await f.c.send({threadId, text: '換到 Claude 新房'});
      await waitFor(async () => (await f.receipt(threadId).catch(() => null))?.status === 'cancelled', 'cancelled');
      await waitFor(
        () => !f.c.state.busy && f.c.state.messages.some(m => m.kind === 'worker-completion'),
        'late notice in the source room'
      );
      assert.equal(f.result.json?.accepted, true, f.result.text);
      assert.equal(f.promptsDuringPrepare, 1);
      const receipt = await f.receipt(threadId);
      assert.equal(receipt.newThreadId, undefined);
      assert.equal(f.c.state.threadId, threadId);
      assert.equal(f.claudeHosts.length, 0);
      assert.equal(f.c.state.messages.filter(m => m.kind === 'worker-completion').length, 1);
      assert.equal(f.prompts.filter(p => p.kind === kind).length, 2);
    } finally {
      await f.c.close();
    }
  });

test('a Grok main chat lists projects and opens a Claude room in another registered project through the real gateway', async () => {
  const f = await fixture();
  try {
    const social = await realpath(await mkdtemp(path.join(scratchBase, 'social-project-')));
    await writeFile(path.join(social, 'AGENTS.md'), '社群專案規則');
    await mkdir(path.join(f.root, '.runtime'), {recursive: true});
    await writeFile(
      path.join(f.root, '.runtime/projects.json'),
      JSON.stringify([{path: social, name: '社群專案'}, {path: f.root, name: '舊工作區', archived: true}])
    );
    const {threadId: sourceId} = await f.c.open({model: 'grok-4.7', effort: 'medium', accessMode: 'workspace-write'});
    let listed;
    f.scripts.grok.push(async context => {
      listed = await callTool(f.gateways.grok, 'luna_room_list', {});
      await moveDuringTurn(f, 'grok', {nextInstruction: '接手社群草稿', model: 'claude-sonnet-4-6', targetWorkspace: '社群專案'})(context);
      return {};
    });
    await f.c.send({threadId: sourceId, text: '在社群專案開 Claude Sonnet 新房接手'});
    await waitFor(async () => (await f.receipt(sourceId).catch(() => null))?.status === 'sent', 'handoff sent');
    assert.equal(listed.isError, false, listed.text);
    assert.deepEqual(listed.json.projects, [{name: '社群專案', path: social}]);
    assert.equal(f.result.isError, false, f.result.text);
    assert.deepEqual([f.result.json.targetWorkspace, f.result.json.targetWorkspaceName], [social, '社群專案']);
    const childId = (await f.receipt(sourceId)).newThreadId;
    assert.match(childId, /^claude-/u);
    assert.equal(f.c.state.workspace, social);
    const host = f.claudeHosts.at(-1);
    assert.equal(host.options.cwd, social);
    assert.match(JSON.stringify(host.starts[0]), /另一個已登記專案「社群專案」/u);
    const sessions = (await listMainSessions(f.root)).sessions;
    assert.equal(sessions.find(s => s.threadId === sourceId).workspace, f.root);
    assert.equal(sessions.find(s => s.threadId === childId).workspace, social);
    await assert.rejects(lstat(path.join(social, '.runtime')), {code: 'ENOENT'});
    // The tool tells every core that a fresh room is no longer tied to the same project.
    const tools = await (async () => {
      const token = f.gateways.grok.headers.Authorization.slice(7);
      const response = await fetch(f.gateways.grok.url, {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream'},
        body: JSON.stringify({jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}})
      });
      const text = await response.text();
      return JSON.parse(text.split(/\r?\n/u).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n') || text)
        .result.tools;
    })();
    const create = tools.find(tool => tool.name === 'conversation_create');
    assert.doesNotMatch(create.description, /SAME project/u);
    assert.match(create.description, /targetWorkspace/u);
    assert.match(create.description, /luna_room_list/u);
    assert.ok(create.inputSchema.properties.targetWorkspace);
  } finally {
    await f.c.close();
  }
});
