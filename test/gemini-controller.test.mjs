import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createGeminiController, geminiModelsFrom} from '../src/gemini-controller.mjs';
import {createOfficialGeminiAccount} from '../src/gemini-official-account.mjs';
import {createUnifiedController} from '../src/unified-controller.mjs';
import {listMainSessions} from '../src/main-sessions.mjs';
import {GEMINI_MEDIA_GUIDANCE, geminiToolGuidance} from '../src/gemini-worker.mjs';
import {MODEL_PROTOCOL_GUIDANCE} from '../src/worker-policy.mjs';
import {desktopControlMcp, DESKTOP_CONTROL_GUIDANCE} from '../src/desktop-control-mcp.mjs';
import {commonMemoryPath, globalRulesPath} from '../src/common-memory.mjs';
import {scratchBase} from './scratch.mjs';

const names = [
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-new-native'
];
const loginFactory = () => ({status: async () => ({available: true, models: names, version: 'fixture'})});
async function fixture(options = {}) {
  const base = scratchBase;
  await mkdir(base, {recursive: true});
  const root = await mkdtemp(path.join(base, 'gemini-controller-'));
  const calls = [];
  const openAgent = async opts => {
    const requests = [],
      notifications = [];
    let sessionId = null;
    const call = {binary: opts.executable, args: opts.args, params: opts, requests, notifications};
    calls.push(call);
    return {
      pid: 12345,
      exited: false,
      closed: Promise.resolve(),
      initialize: {protocolVersion: 1},
      async request(method, params) {
        requests.push({method, params: structuredClone(params)});
        if (method === 'session/new') {
          sessionId = randomUUID();
          return {sessionId};
        }
        if (method === 'session/resume') {
          sessionId = params.sessionId;
          return {};
        }
        if (method === 'session/prompt') {
          opts.onNotification?.({
            method: 'session/update',
            params: {
              sessionId,
              update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'native reply'}}
            }
          });
          return {stopReason: 'end_turn', usage: {totalTokens: 23, inputTokens: 10, outputTokens: 13}};
        }
        return {};
      },
      notify(method, params) {
        notifications.push({method, params});
      },
      async close() {
        this.exited = true;
      }
    };
  };
  const opts = {
    root,
    env: {
      LOCALAPPDATA: path.join(root, 'local-app-data'),
      SystemRoot: process.env.SystemRoot ?? root,
      TEMP: path.join(root, 'fake-temp'),
      API_KEY: 'must-not-inherit',
      GEMINI_API_KEY: 'must-not-inherit'
    },
    openAgent,
    stopGraceMs: 25,
    loginFactory,
    ...options
  };
  return {root, calls, opts, controller: createGeminiController(opts)};
}
const promptBlocksOf = call => call.requests.find(r => r.method === 'session/prompt')?.params?.prompt ?? [];
const promptTextOf = call => promptBlocksOf(call).map(b => b.text).join('');
const reqOf = (call, method) => call.requests.find(r => r.method === method);
const finish = async c => {
  for (let i = 0; c.state.busy && i < 200; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(c.state.busy, false);
};

test('an offline Gemini owner rejects explicit sends and repeated close does not submit work', async () => {
  const f = await fixture();
  try {
    const a = await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    await f.controller.close();
    await f.controller.close();
    for (let i = 0; i < 2; i++) await assert.rejects(f.controller.send({text: 'not submitted offline'}), /請先開啟/);
    assert.equal(f.controller.state.status, 'offline');
    assert.equal(f.calls.length, 0);
    await f.controller.open({...a, model: 'gemini-3.8-flash', effort: 'low'});
    assert.equal(f.controller.state.threadId, a.threadId);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.controller.close();
  }
});

test('ordinary Gemini main turns wait for native completion without duration or stdout-copy limits', async () => {
  const f = await fixture();
  try {
    await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    await f.controller.send({text: 'long task'});
    await finish(f.controller);
    assert.equal(f.calls.length, 1);
    const {args} = f.calls[0];
    assert.deepEqual(args.slice(0, 2), ['acp', '--stdio']);
    assert.equal(args.includes('--print-timeout'), false);
    assert.equal(f.controller.state.status, 'completed');
  } finally {
    await f.controller.close();
  }
});

test('Gemini work telemetry follows actual stream steps rather than process start or quota reads', async () => {
  let emit, done, started;
  const promptStarted = new Promise(r => (started = r));
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const f = await fixture({
    openAgent: async opts => {
      emit = update => opts.onNotification?.({method: 'session/update', params: {sessionId, update}});
      return {
        pid: 12345,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === 'session/new') return {sessionId};
          if (method === 'session/prompt') {
            return new Promise(resolve => {
              done = () => {
                emit({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'fake'}});
                resolve({stopReason: 'end_turn'});
              };
              started();
            });
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
        }
      };
    }
  });
  try {
    await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    await f.controller.send({text: 'fake'});
    await promptStarted;
    assert.equal(f.controller.state.activity.lastEventAt, null);
    emit({sessionUpdate: 'tool_call', toolCallId: 'tool-1', name: 'read_file', kind: 'read', status: 'in_progress'});
    assert.equal(f.controller.state.activity.phase, 'tool');
    const before = structuredClone(f.controller.state.activity);
    await f.controller.usage();
    assert.deepEqual(f.controller.state.activity, before);
    emit({sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed'});
    assert.equal(f.controller.state.activity.phase, 'active');
    done();
    await finish(f.controller);
  } finally {
    done?.();
    await f.controller.close();
  }
});

test('Gemini does not invent a zero compaction count when native telemetry is unavailable', async () => {
  const f = await fixture();
  try {
    await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    assert.equal(f.controller.state.progress.compactions, null);
    assert.equal(f.controller.state.progress.compactionsComplete, false);
  } finally {
    await f.controller.close();
  }
});

test('Gemini accepts more than eight attachments while keeping idle steering rejected safely', async () => {
  const f = await fixture();
  try {
    const {threadId} = await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'}),
      attachments = [];
    for (let n = 0; n < 12; n++)
      attachments.push(
        await f.controller.upload({
          threadId,
          name: `fake-${n}.txt`,
          base64: Buffer.from(`fake body ${n}`).toString('base64')
        })
      );
    await f.controller.send({text: 'twelve files', attachmentIds: attachments.map(a => a.id)});
    await finish(f.controller);
    assert.equal(f.calls.length, 1);
    assert.equal(f.controller.state.messages[0].text, 'twelve files');
    assert.equal(f.controller.state.messages[0].attachments.length, 12);
    assert.equal(f.controller.state.capabilities.steer, true);
    await assert.rejects(
      f.controller.steer({text: 'do not replay', attachmentIds: attachments.map(a => a.id)}),
      e => e.notSent === true && /執行中/.test(e.message)
    );
    assert.equal(f.calls.length, 1);
  } finally {
    await f.controller.close();
  }
});

test('Gemini native conversation persists its account binding and releases the lease after actual completion', async () => {
  const acquired = [],
    released = [],
    accountId = 'a'.repeat(32);
  const accounts = {
    inspect: fn => fn(),
    acquire: async data => {
      acquired.push(data);
      return {accountId, release: async result => released.push(result)};
    }
  };
  const f = await fixture({accounts});
  try {
    const {threadId} = await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    await f.controller.send({text: 'first'});
    await finish(f.controller);
    const saved = JSON.parse(await readFile(path.join(f.root, '.runtime/gemini-sessions', threadId + '.json'), 'utf8'));
    assert.equal(saved.accountId, accountId);
    await f.controller.send({text: 'second'});
    await finish(f.controller);
    assert.equal(acquired[1].accountId, accountId);
    assert.equal(acquired[1].unboundHistory, false);
    assert.equal(released.length, 2);
    assert.equal(released[0].settled, true);
  } finally {
    await f.controller.close();
  }
});

test('Gemini catalog preserves every native model and only supplied effort variants', () => {
  const catalog = geminiModelsFrom(names);
  assert.deepEqual(
    catalog.map(x => x.model),
    ['gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-new-native']
  );
  assert.deepEqual(
    catalog[1].supportedReasoningEfforts.map(e => e.reasoningEffort),
    ['high', 'low']
  );
  assert.equal(catalog[1].nativeModels.medium, undefined);
  assert.equal(catalog[2].nativeModels.default, 'gemini-new-native');
  assert.equal(
    catalog.some(x => /4-pro/u.test(x.model)),
    false
  );
  assert.deepEqual(catalog[0].inputModalities, ['text', 'image', 'pdf', 'audio', 'video']);
  assert.deepEqual(catalog[1].inputModalities, catalog[0].inputModalities);
  assert.deepEqual(catalog[2].inputModalities, ['text']);
});

test('Gemini quota polling coalesces and preserves dated stale values after a failed refresh', async () => {
  let calls = 0,
    complete;
  const native = {
    status: 'ready',
    checkedAt: '2026-10-03T05:00:00Z',
    windows: [{key: 'seven_day', minutes: 10080, remainingPercent: 97, resetsAt: 1791555046}]
  };
  const f = await fixture({
    loginFactory: () => ({
      status: () => {
        calls++;
        return new Promise(resolve => {
          complete = resolve;
        });
      }
    })
  });
  const first = f.controller.usage(),
    overlap = f.controller.usage();
  await Promise.resolve();
  assert.equal(calls, 1);
  complete({quota: native});
  assert.deepEqual((await first).gemini, native);
  await overlap;
  await f.controller.usage();
  assert.equal(calls, 1);
  const failed = f.controller.usage(true);
  await Promise.resolve();
  assert.equal(calls, 2);
  complete({reason: 'network unavailable'});
  const stale = (await failed).gemini;
  assert.equal(stale.status, 'stale');
  assert.equal(stale.checkedAt, native.checkedAt);
  assert.deepEqual(stale.windows, native.windows);
  assert.equal(stale.note, 'network unavailable');
  await f.controller.close();
});

test('the Gemini room refuses a new prompt or session while an official login is pending', async () => {
  const account = createOfficialGeminiAccount(loginFactory());
  const f = await fixture({officialGeminiAccount: account});
  try {
    await account.change('login', async () => {});
    await assert.rejects(f.controller.open({model: 'gemini-3.8-flash'}), /帳號正在變更/);
    await assert.rejects(f.controller.send({text: 'test'}), /帳號正在變更/);
    assert.equal(f.calls.length, 0);
    await account.change('cancel', async () => {});
    await f.controller.open({model: 'gemini-3.8-flash'});
    await f.controller.send({text: 'fixture prompt'});
    await finish(f.controller);
    assert.ok(f.calls.length > 0);
  } finally {
    await f.controller.close();
  }
});

test('Gemini reopens native history without replaying earlier user text and retains provider metadata', async () => {
  const f = await fixture();
  let c = f.controller;
  try {
    const {threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'medium'});
    await c.send({text: 'first private context'});
    await finish(c);
    const native = JSON.parse(
      await readFile(path.join(f.root, '.runtime/gemini-sessions', threadId + '.json'), 'utf8')
    ).nativeSessionId;
    assert.match(native, /^[0-9a-f-]{36}$/u);
    assert.equal(c.state.messages.at(-1).text, 'native reply');
    assert.equal(c.state.progress.tokenUsage.last.totalTokens, 23);
    await c.close();
    c = createGeminiController(f.opts);
    await c.open({threadId, model: 'gemini-3.8-flash'});
    await c.send({text: 'second input'});
    await finish(c);
    const last = f.calls.at(-1);
    assert.equal(reqOf(last, 'session/resume')?.params?.sessionId, native);
    assert.equal(reqOf(last, 'session/new'), undefined);
    const prompt = promptTextOf(last);
    assert.doesNotMatch(prompt, /first private context/);
    const rules = await readFile(path.join(last.params.env.HOME, '.gemini/config/rules/k-model-roles.md'), 'utf8'),
      shared = path.join(f.root, 'agent-home', 'gemini', 'shared', 'learned-rules.md');
    // Without a worker gateway the room still receives the shared role guidance, never a "cannot delegate" text.
    assert.ok(rules.startsWith(`---\ntrigger: always_on\n---\n${MODEL_PROTOCOL_GUIDANCE}\n`));
    assert.ok(rules.includes(`${geminiToolGuidance('workspace-write', null, {acp: true})}\n`));
    assert.ok(rules.includes(`${GEMINI_MEDIA_GUIDANCE}\n`));
    assert.doesNotMatch(rules, /不能派工|未開放斜線指令/);
    // One shared native rule file reaches every room through agy's @[label](path) include.
    const learned = await readFile(path.join(last.params.env.HOME, '.gemini/config/rules/k-learned-rules.md'), 'utf8');
    assert.ok(Buffer.byteLength(learned) < 24000);
    assert.ok(!rules.includes(shared));
    assert.match(learned, /長期記憶：本人糾正做法或要求記住時，先寫出要記的規則並取得本人同意再寫入/);
    assert.ok(learned.includes(`跨工作區都適用的寫進 ${shared}`));
    assert.ok(learned.endsWith(`@[K 共用學習規則](${shared})\n`));
    assert.match(await readFile(shared, 'utf8'), /^# K 共用學習規則/);
    const blocks = promptBlocksOf(last);
    assert.match(blocks[0].text, /^K 跨模型全域工作規則目前未啟用/u);
    assert.deepEqual(blocks.slice(1), [{type: 'text', text: 'second input'}]);
    assert.equal(c.state.messages.filter(m => m.role === 'user').at(-1).text, 'second input');
    assert.equal(reqOf(last, 'session/set_model')?.params?.modelId, 'gemini-3.8-flash-medium');
    assert.equal(last.params.env.GEMINI_API_KEY, undefined);
    assert.equal(last.params.env.API_KEY, undefined);
    assert.equal(last.params.env.HOME, last.params.env.USERPROFILE);
    assert.ok(last.params.env.HOME.startsWith(path.join(f.root, 'agent-home', 'gemini', 'main')));
    const saved = (await listMainSessions(f.root)).sessions[0];
    assert.equal(saved.provider, 'gemini');
    assert.equal(saved.model, 'gemini-3.8-flash');
    assert.equal(c.state.messages.length, 4);
  } finally {
    await c.close();
  }
});

test('an unsent Gemini room survives close and a new controller, with or without a rename', async () => {
  for (const title of ['', 'named before first message']) {
    const f = await fixture(),
      workspace = path.join(f.root, 'chosen-workspace');
    await mkdir(workspace);
    let c = f.controller;
    try {
      await c.selectWorkspace({path: workspace});
      const {threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'high', accessMode: 'read-only'});
      if (title) await c.metadata({threadId, title});
      assert.equal(c.state.messages.length, 0);
      assert.equal(f.calls.length, 0);
      const before = JSON.parse(
        await readFile(path.join(f.root, '.runtime/gemini-sessions', threadId + '.json'), 'utf8')
      );
      assert.equal(before.nativeSessionId, null);
      assert.equal(before.nativeStarted, false);
      await c.close();
      c = createGeminiController(f.opts);
      await c.open({threadId, model: 'gemini-3.8-flash'});
      assert.equal(c.state.title, title);
      assert.equal(c.state.model, 'gemini-3.8-flash');
      assert.equal(c.state.effort, 'high');
      assert.equal(c.state.accessMode, 'read-only');
      assert.equal(c.state.workspace, workspace);
      assert.deepEqual((await listMainSessions(f.root)).sessions[0].workerPolicy, {model: 'auto', effort: 'auto'});
      await c.send({text: 'first turn after reopen'});
      await finish(c);
      assert.equal(f.calls.length, 1);
      assert.ok(reqOf(f.calls[0], 'session/new'));
      assert.equal(reqOf(f.calls[0], 'session/resume'), undefined);
      assert.equal(promptTextOf(f.calls[0]), 'first turn after reopen');
    } finally {
      await c.close();
    }
  }
});

test('Gemini full access requires confirmation, never maps auto-review and uses isolated native settings', async () => {
  const f = await fixture(),
    c = f.controller;
  try {
    await assert.rejects(c.open({model: 'gemini-3.8-flash', accessMode: 'danger-full-access'}), /明確確認/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(c.open({model: 'gemini-3.8-flash', accessMode: 'auto-review'}), /未提供/);
    await c.open({model: 'gemini-3.8-flash'});
    await assert.rejects(c.send({text: 'work', accessMode: 'danger-full-access'}), /明確確認/);
    await c.send({text: 'work'});
    await finish(c);
    let call = f.calls.at(-1);
    assert.equal(call.args.includes('--dangerously-skip-permissions'), false);
    // Workspace commands run only inside agy's native sandbox; its AppContainer data stays in this HOME.
    assert.ok(call.args.includes('--sandbox'));
    assert.equal(reqOf(call, 'session/set_mode')?.params?.modeId, 'default');
    assert.equal(call.params.env.LOCALAPPDATA, path.join(call.params.env.HOME, 'AppData', 'Local'));
    assert.equal(call.params.env.TEMP, path.join(call.params.env.HOME, 'tmp'));
    let settings = JSON.parse(
      await readFile(path.join(call.params.env.HOME, '.gemini/antigravity-cli/settings.json'), 'utf8')
    );
    assert.deepEqual(settings.permissions.allow, [
      'read_url(*)',
      `write_file(${f.root})`,
      `write_file(${path.join(f.root, 'agent-home', 'gemini', 'shared', 'learned-rules.md')})`,
      'command(*)'
    ]);
    assert.equal(settings.toolPermission, undefined);
    assert.ok(!settings.permissions.deny.includes('unsandboxed(*)'));
    const rules = () => readFile(path.join(call.params.env.HOME, '.gemini/config/rules/k-model-roles.md'), 'utf8');
    assert.match(await rules(), /工作區寫入：可讀取資料、編輯指定工作區內檔案，並在沙盒內執行命令/);
    assert.match(await rules(), /保留同一程序與帳號/);
    assert.doesNotMatch(await rules(), /完整存取：|非完整存取模式/);
    await c.send({text: 'explicit full access', accessMode: 'danger-full-access', permissionConfirmed: true});
    await finish(c);
    call = f.calls.at(-1);
    assert.ok(call.args.includes('--dangerously-skip-permissions'));
    assert.equal(call.args.includes('--sandbox'), false);
    assert.equal(reqOf(call, 'session/set_mode')?.params?.modeId, 'default');
    assert.equal(call.params.env.TEMP, f.opts.env.TEMP);
    assert.match(await rules(), /完整存取：可在任務授權範圍內讀寫檔案、執行命令/);
    assert.match(await rules(), /不保證推送完成結果，也不保證自動喚醒/);
    assert.match(await rules(), /在本回合等待完成並讀回/);
    assert.doesNotMatch(await rules(), /唯讀：|工作區寫入：|非完整存取模式/);
    await c.send({text: 'read-only work', accessMode: 'read-only'});
    await finish(c);
    call = f.calls.at(-1);
    assert.equal(call.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(call.args.includes('--sandbox'), false);
    assert.equal(reqOf(call, 'session/set_mode')?.params?.modeId, 'default');
    assert.equal(call.params.env.TEMP, path.join(call.params.env.HOME, 'tmp'));
    settings = JSON.parse(
      await readFile(path.join(call.params.env.HOME, '.gemini/antigravity-cli/settings.json'), 'utf8')
    );
    assert.ok(settings.permissions.deny.includes('write_file(*)'));
    assert.ok(settings.permissions.deny.includes('command(*)'));
    assert.ok(!settings.permissions.allow.some(rule => rule.startsWith('write_file') || rule === 'command(*)'));
    assert.match(await rules(), /唯讀：可用原生檔案工具讀取資料、列目錄與搜尋/);
    assert.doesNotMatch(await rules(), /完整存取：|工作區寫入：|不保證會被自動取消/);
  } finally {
    await c.close();
  }
});

test('Gemini main conversation receives Desktop Control MCP in danger-full-access mode only and includes guidance', async () => {
  const f = await fixture();
  try {
    const exe = path.join(f.root, 'windows-mcp.exe');
    await writeFile(exe, 'fixture');
    await mkdir(path.join(f.root, '.runtime'), {recursive: true});
    await writeFile(path.join(f.root, '.runtime/desktop-control.json'), JSON.stringify({executable: exe}));

    await f.controller.open({model: 'gemini-3.8-flash', accessMode: 'danger-full-access', permissionConfirmed: true});
    const home = path.join(f.root, 'agent-home/gemini/main', f.controller.state.threadId, '.gemini');
    const mcpConfig = JSON.parse(await readFile(path.join(home, 'config/mcp_config.json'), 'utf8'));
    assert.deepEqual(mcpConfig.mcpServers.k_desktop, await desktopControlMcp({root: f.root, fullAccess: true}));
    const settings = JSON.parse(await readFile(path.join(home, 'antigravity-cli/settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('mcp(k_desktop/*)'));
    assert.ok(!settings.permissions.deny.includes('mcp(*)'));
    const rules = await readFile(path.join(home, 'config/rules/k-model-roles.md'), 'utf8');
    assert.ok(rules.includes(DESKTOP_CONTROL_GUIDANCE));
    await f.controller.close();

    const f2 = await fixture();
    await writeFile(path.join(f2.root, 'windows-mcp.exe'), 'fixture');
    await mkdir(path.join(f2.root, '.runtime'), {recursive: true});
    await writeFile(
      path.join(f2.root, '.runtime/desktop-control.json'),
      JSON.stringify({executable: path.join(f2.root, 'windows-mcp.exe')})
    );

    await f2.controller.open({model: 'gemini-3.8-flash', accessMode: 'workspace-write'});
    const home2 = path.join(f2.root, 'agent-home/gemini/main', f2.controller.state.threadId, '.gemini');
    const mcpConfig2 = JSON.parse(await readFile(path.join(home2, 'config/mcp_config.json'), 'utf8'));
    assert.equal(mcpConfig2.mcpServers.k_desktop, undefined);
    const settings2 = JSON.parse(await readFile(path.join(home2, 'antigravity-cli/settings.json'), 'utf8'));
    assert.ok(!settings2.permissions.allow.includes('mcp(k_desktop/*)'));
    const rules2 = await readFile(path.join(home2, 'config/rules/k-model-roles.md'), 'utf8');
    assert.ok(!rules2.includes(DESKTOP_CONTROL_GUIDANCE));
    await f2.controller.close();
  } finally {
    await f.controller.close().catch(() => {});
  }
});

test('Gemini model changes keep native history and reject unavailable models or efforts without fallback', async () => {
  const f = await fixture(),
    c = f.controller;
  try {
    const {threadId} = await c.open({model: 'gemini-3.8-flash'});
    await c.send({text: 'begin'});
    await finish(c);
    await assert.rejects(c.selectModel({threadId, model: 'gemini-4-pro'}), /未換模/);
    await assert.rejects(c.selectModel({threadId, model: 'gemini-3.1-pro', effort: 'medium'}), /未換模/);
    assert.equal(c.state.model, 'gemini-3.8-flash');
    await c.selectModel({threadId, model: 'gemini-3.1-pro', effort: 'low'});
    await c.send({text: 'continue'});
    await finish(c);
    assert.ok(reqOf(f.calls.at(-1), 'session/resume'));
    assert.equal(reqOf(f.calls.at(-1), 'session/set_model')?.params?.modelId, 'gemini-3.1-pro-low');
    assert.equal(c.state.modelChanges.length, 1);
  } finally {
    await c.close();
  }
});

test('Antigravity main models retain their core on save, reopen and exact native dispatch', async () => {
  const nativeNames = ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];
  for (const row of geminiModelsFrom(nativeNames)) {
    const f = await fixture({loginFactory: () => ({status: async () => ({available: true, models: nativeNames})})});
    try {
      const {threadId} = await f.controller.open({model: row.model, effort: row.defaultReasoningEffort});
      await f.controller.send({text: 'bounded fake task'});
      await finish(f.controller);
      assert.equal(
        reqOf(f.calls[0], 'session/set_model')?.params?.modelId,
        row.nativeModels[row.defaultReasoningEffort ?? 'default']
      );
      assert.equal(f.controller.state.model, row.model);
      const sessions = await listMainSessions(f.root);
      const saved = sessions.sessions.find(s => s.threadId === threadId);
      assert.equal(saved.provider, 'gemini');
      const header = JSON.parse(
        await readFile(path.join(f.root, '.runtime/main-sessions', `${threadId}-current.json`), 'utf8')
      );
      assert.equal(header.accountType, 'antigravity');
      await f.controller.close();
      await f.controller.open({threadId, model: row.model});
      assert.equal(f.controller.state.model, row.model);
      assert.equal(f.calls.length, 1);
    } finally {
      await f.controller.close();
    }
  }
});

test('Gemini cancellation waits for native termination and never replays the stopped message', async () => {
  let started, release;
  const seen = new Promise(r => {
    started = r;
  });
  let calls = 0;
  const notifications = [];
  const f = await fixture({
      openAgent: async opts => {
        calls++;
        const sid = randomUUID();
        return {
          pid: 1234,
          exited: false,
          closed: Promise.resolve(),
          initialize: {protocolVersion: 1},
          async request(method) {
            if (method === 'session/new') return {sessionId: sid};
            if (method === 'session/prompt') {
              started(opts);
              await new Promise(resolve => {
                release = resolve;
              });
              return {stopReason: 'cancelled'};
            }
            return {};
          },
          notify(method, params) {
            notifications.push({method, params});
          },
          async close() {
            this.exited = true;
          }
        };
      }
    }),
    c = f.controller;
  try {
    await c.open({model: 'gemini-3.8-flash'});
    await c.send({text: 'slow work'});
    const p = await seen;
    let stopped = false;
    const stopping = c.stop().then(() => {
      stopped = true;
    });
    assert.equal(p.signal.aborted, true);
    assert.ok(notifications.some(n => n.method === 'session/cancel'));
    await new Promise(r => setTimeout(r, 10));
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(c.state.status, 'interrupted');
    assert.equal(c.state.busy, false);
    assert.equal(calls, 1);
    assert.equal(c.state.messages.filter(m => m.role === 'user').length, 1);
  } finally {
    release?.();
    await c.close();
  }
});

test('Gemini login failure remains on Gemini and does not replay a turn with unknown native identity', async () => {
  let calls = 0;
  const f = await fixture({
      openAgent: async () => {
        calls++;
        return {
          pid: 1234,
          exited: false,
          closed: Promise.resolve(),
          initialize: {protocolVersion: 1},
          async request(method) {
            if (method === 'session/new') throw Error('Authentication required');
            return {};
          },
          notify() {},
          async close() {
            this.exited = true;
          }
        };
      }
    }),
    c = f.controller;
  try {
    await c.open({model: 'gemini-3.8-flash'});
    await c.send({text: 'hello'});
    await finish(c);
    assert.equal(c.state.status, 'failed');
    assert.match(c.state.error, /未登入/);
    assert.equal(c.state.provider, 'gemini');
    await assert.rejects(c.send({text: 'again'}), /原生對話 ID/);
    assert.equal(calls, 1);
  } finally {
    await c.close();
  }
});

test('Gemini hands scoped image paths to native tools without guessing unknown model capability', async () => {
  const f = await fixture(),
    c = f.controller;
  try {
    const {threadId} = await c.open({model: 'gemini-3.8-flash'});
    assert.deepEqual(c.state.inputModalities, ['text', 'image', 'pdf', 'audio', 'video']);
    const images = [];
    for (const name of ['test.png', 'test.jpg', 'test.webp'])
      images.push(
        await c.upload({
          threadId,
          name,
          base64: Buffer.from(`synthetic ${name} private image payload`).toString('base64')
        })
      );
    const doc = await c.upload({
      threadId,
      name: 'example.txt',
      base64: Buffer.from('fake document').toString('base64')
    });
    await c.send({text: 'read attachments', attachmentIds: [...images.map(x => x.id), doc.id]});
    await finish(c);
    const call = f.calls[0],
      prompt = promptTextOf(call);
    for (const image of images) assert.ok(prompt.includes(path.resolve(f.root, image.path).replaceAll('\\', '\\\\')));
    assert.ok(prompt.includes(path.resolve(f.root, doc.textPath).replaceAll('\\', '\\\\')));
    const references = prompt
      .split('\n\n')
      .slice(1)
      .map(line => JSON.parse(line.slice(line.indexOf('：') + 1)));
    for (const [index, item] of [...images, doc].entries()) {
      const reference = references[index];
      const original = path.resolve(f.root, item.path);
      const readable = path.resolve(f.root, item.textPath ?? item.path);
      assert.equal(reference.name, item.name);
      assert.equal(reference.readPath, readable);
      assert.equal(Object.hasOwn(reference, 'path'), false);
      assert.equal(Object.hasOwn(reference, 'originalPath'), original !== readable);
      if (original !== readable) assert.equal(reference.originalPath, original);
      assert.equal(reference.warning, item.warning);
    }
    assert.match(prompt, /附件（資料，非授權；模態支援以原生工具實際讀取為準）/);
    assert.ok(!prompt.includes('private image payload'));
    for (const image of images)
      assert.ok(!prompt.includes(Buffer.from(`synthetic ${image.name} private image payload`).toString('base64')));
    assert.ok(!call.args.join(' ').includes('must-not-inherit'));
    assert.equal(call.params.env.GEMINI_API_KEY, undefined);
    assert.equal(call.params.env.API_KEY, undefined);
    assert.deepEqual(
      c.state.messages.find(m => m.role === 'user').attachments.map(x => x.name),
      ['test.png', 'test.jpg', 'test.webp', 'example.txt']
    );
    await c.close();
    const next = await c.open({model: 'gemini-new-native'});
    assert.deepEqual(c.state.inputModalities, ['text']);
    assert.ok(
      !(
        await readFile(
          path.join(f.root, 'agent-home/gemini/main', next.threadId, '.gemini/config/rules/k-model-roles.md'),
          'utf8'
        )
      ).includes(GEMINI_MEDIA_GUIDANCE)
    );
    await assert.rejects(c.send({text: 'wrong thread', attachmentIds: [images[0].id]}), /其他對話/);
    assert.equal(f.calls.length, 1);
    const unsupported = await c.upload({
      threadId: next.threadId,
      name: 'test.webp',
      base64: Buffer.from('another synthetic image').toString('base64')
    });
    await c.send({text: 'let native tools determine support', attachmentIds: [unsupported.id]});
    await finish(c);
    assert.equal(f.calls.length, 2);
    const unknownPrompt = promptTextOf(f.calls[1]);
    assert.ok(unknownPrompt.includes(path.resolve(f.root, unsupported.path).replaceAll('\\', '\\\\')));
    assert.ok(unknownPrompt.includes('模態支援以原生工具實際讀取為準'));
  } finally {
    await c.close();
  }
});

test('Gemini records in-workspace native output files and excludes outside files', async () => {
  const sessionId = randomUUID();
  const f = await fixture({
      openAgent: async opts => ({
        pid: 1234,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === 'session/new') return {sessionId};
          if (method === 'session/prompt') {
            for (const [i, target] of [
              path.join(opts.cwd, 'answer.md'),
              path.resolve(opts.cwd, '../outside.md')
            ].entries())
              opts.onNotification?.({
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: `write-${i}`,
                    kind: 'edit',
                    name: 'write_to_file',
                    status: 'completed',
                    rawInput: {TargetFile: target}
                  }
                }
              });
            opts.onNotification?.({
              method: 'session/update',
              params: {sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'done'}}}
            });
            return {stopReason: 'end_turn'};
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
        }
      })
    }),
    c = f.controller;
  try {
    await c.open({model: 'gemini-3.8-flash'});
    await c.send({text: 'create output'});
    await finish(c);
    assert.deepEqual(c.state.artifacts, ['answer.md']);
    await assert.rejects(c.artifact('../outside.md'), /已記錄/);
  } finally {
    await c.close();
  }
});

test('Gemini absence does not remove GPT/Claude models or route a Gemini request to another core', async () => {
  const f = await fixture(),
    calls = [];
  const peer = provider => ({
    state: {provider, workspace: f.root, status: 'idle', busy: false, questions: [], messages: []},
    models: async () => ({models: [{model: provider === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5'}]}),
    usage: async () => ({}),
    workers: async () => [],
    selectWorkspace: async () => {},
    open: async data => {
      calls.push({provider, data});
      return {};
    },
    close: async () => {}
  });
  const c = createUnifiedController({
    root: f.root,
    codexFactory: () => peer('codex'),
    claudeFactory: () => peer('claude'),
    geminiFactory: options =>
      createGeminiController({
        ...options,
        loginFactory: () => ({
          status: async () => ({available: false, models: [], reason: '找不到 agy，請安裝 Antigravity CLI 並登入。'})
        })
      })
  });
  try {
    const catalog = await c.models();
    assert.deepEqual(
      catalog.models.map(m => m.provider),
      ['codex', 'claude']
    );
    assert.match(catalog.warnings[0], /找不到 agy/);
    await assert.rejects(c.open({model: 'gemini-3.8-flash'}), /找不到 agy/);
    assert.equal(c.state.provider, 'codex');
    assert.deepEqual(calls, []);
  } finally {
    await c.close();
  }
});

test('Gemini relocation keeps native identity and old attachments, and rebuilds workspace rules', async () => {
  const f = await fixture();
  try {
    const c = f.controller,
      {threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    const upload = await c.upload({threadId, name: 'before.txt', base64: Buffer.from('old upload').toString('base64')});
    await c.send({text: 'remember'});
    await finish(c);
    const file = path.join(f.root, '.runtime/gemini-sessions', threadId + '.json'),
      before = JSON.parse(await readFile(file, 'utf8'));
    const destination = path.join(f.root, 'destination');
    await mkdir(destination);
    await c.open(
      {threadId, model: 'gemini-3.8-flash'},
      {relocation: {workspace: destination, previousWorkspaces: [f.root], previousArtifacts: []}}
    );
    assert.equal(c.state.threadId, threadId);
    assert.equal((await c.attachmentFile(upload.id)).bytes.toString(), 'old upload');
    const rules = await readFile(
      path.join(f.root, 'agent-home/gemini/main', threadId, '.gemini/config/rules/k-model-roles.md'),
      'utf8'
    );
    assert.ok(rules.includes(JSON.stringify(destination)));
    await c.send({text: 'continue', attachmentIds: [upload.id]});
    await finish(c);
    const last = f.calls.at(-1);
    assert.equal(last.params.cwd, destination);
    assert.equal(reqOf(last, 'session/resume')?.params?.sessionId, before.nativeSessionId);
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(after.nativeSessionId, before.nativeSessionId);
    assert.equal(after.accountId, before.accountId);
    assert.equal(after.messages.length, 4);
    await c.close();
    await c.open({threadId, model: 'gemini-3.8-flash'});
    assert.equal(c.state.workspace, destination);
    assert.equal((await c.attachmentFile(upload.id)).bytes.toString(), 'old upload');
  } finally {
    await f.controller.close();
  }
});

test('failed Gemini workspace preparation cannot send at the uncommitted destination', async () => {
  let fail = false;
  const f = await fixture({
      browserConfig: async () => {
        if (fail) throw Error('fixture browser configuration failed');
        return null;
      }
    }),
    c = f.controller;
  try {
    const {threadId} = await c.open({model: 'gemini-3.8-flash'}),
      dest = path.join(f.root, 'B');
    await mkdir(dest);
    fail = true;
    await assert.rejects(
      c.open(
        {threadId, model: 'gemini-3.8-flash'},
        {relocation: {workspace: dest, previousWorkspaces: [f.root], previousArtifacts: []}}
      ),
      /fixture browser/
    );
    assert.equal(c.state.status, 'error');
    await assert.rejects(c.send({text: 'do not run at B'}), /先開啟/);
    assert.equal(f.calls.length, 0);
    await c.metadata({threadId, title: 'renamed after failed move', pinned: true});
    const saved = JSON.parse(
      await readFile(path.join(f.root, '.runtime/main-sessions', threadId + '-current.json'), 'utf8')
    );
    assert.equal(saved.workspace, f.root);
    assert.deepEqual(saved.previousWorkspaces, []);
    assert.deepEqual(saved.previousArtifacts, []);
    assert.equal(c.state.workspace, f.root);
    assert.deepEqual(c.state.artifacts, []);
    await c.selectModel({threadId, model: 'gemini-3.8-flash', effort: 'low'});
    const upload = await c.upload({
      threadId,
      name: 'after-failed-move.txt',
      base64: Buffer.from('still A').toString('base64')
    });
    assert.equal(await readFile(path.join(f.root, upload.path), 'utf8'), 'still A');
    fail = false;
    await c.open({threadId, model: 'gemini-3.8-flash'});
    assert.equal(c.state.workspace, f.root);
  } finally {
    await c.close();
  }
});

for (const confirmed of [true, false])
  test(`Gemini goal completion requires native expansion (${confirmed}) and keeps normal chat literal`, async () => {
    const calls = [];
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const f = await fixture({
      openAgent: async opts => {
        const requests = [];
        calls.push({args: opts.args, params: opts, requests});
        return {
          pid: 321,
          exited: false,
          closed: Promise.resolve(),
          initialize: {protocolVersion: 1},
          async request(method, params) {
            requests.push({method, params: structuredClone(params)});
            if (method === 'session/new') return {sessionId};
            if (method === 'session/prompt') {
              const promptText = params.prompt.map(b => b.text).join('');
              if (promptText.startsWith('/goal ')) {
                opts.onNotification?.({
                  method: 'session/update',
                  params: {
                    sessionId,
                    update: {
                      sessionUpdate: 'user_message_chunk',
                      content: {type: 'text', text: confirmed ? ' fake objective' : '/goal fake objective'}
                    }
                  }
                });
              }
              opts.onNotification?.({
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: {type: 'text', text: 'FAKE_DONE\n<!-- GOAL_COMPLETE -->'}
                  }
                }
              });
              return {stopReason: 'end_turn'};
            }
            return {};
          },
          notify() {},
          async close() {
            this.exited = true;
          }
        };
      }
    });
    try {
      const rules = globalRulesPath(f.root);
      await mkdir(path.dirname(rules), {recursive: true});
      await writeFile(rules, '- 合成規則保持有效');
      const {threadId} = await f.controller.open({model: 'gemini-3.8-flash'});
      await f.controller.goal({objective: 'fake objective'});
      await finish(f.controller);
      assert.equal(f.controller.state.goal.status, confirmed ? 'complete' : 'ended');
      assert.deepEqual(promptBlocksOf(calls[0]), [{type: 'text', text: '/goal fake objective'}]);
      await f.controller.close();
      await f.controller.open({model: 'gemini-3.8-flash', threadId});
      assert.equal(calls.length, 1);
      assert.equal(f.controller.state.goal.status, confirmed ? 'complete' : 'ended');
      await f.controller.goal({clear: true});
      assert.equal(f.controller.state.goal, null);
      await f.controller.send({text: '/goal not a control'});
      await finish(f.controller);
      assert.deepEqual(promptBlocksOf(calls[1]), [
        {type: 'text', text: '\n'},
        {type: 'text', text: '/goal not a control'}
      ]);
      assert.equal(f.controller.state.goal, null);
      // Only the owner's /learn reaches native expansion (proposal first, then the owner confirms).
      await f.controller.send({text: '/learn 中間產物一律刪除'});
      await finish(f.controller);
      assert.deepEqual(promptBlocksOf(calls[2]), [{type: 'text', text: '/learn 中間產物一律刪除'}]);
      assert.equal(f.controller.state.goal, null);
    } finally {
      await f.controller.close();
    }
  });

test('Gemini cannot silently turn an edit-only request into new work', async () => {
  const f = await fixture();
  try {
    await f.controller.open({model: 'gemini-3.8-flash'});
    await assert.rejects(f.controller.goal({objective: 'not a new run', editOnly: true}), /不支援只修改/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.controller.close();
  }
});

test('Gemini confirms pre-dispatch rejection without replaying an attempted native turn', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.controller.send({text: 'fake'}), e => e.notSent === true);
    await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    await assert.rejects(f.controller.send({text: ''}), e => e.notSent === true);
    await assert.rejects(f.controller.send({text: 'fake', attachmentIds: ['missing']}), e => e.notSent === true);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await f.controller.send({text: 'fake'}), {sent: true});
    await finish(f.controller);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.controller.close();
  }
});

test('cold Gemini history is exposed before prepare and open preserves activity order', async () => {
  const f = await fixture();
  try {
    await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    await f.controller.send({text: 'fake request'});
    await finish(f.controller);
    const id = f.controller.state.threadId;
    await f.controller.close();
    const before = (await listMainSessions(f.root)).sessions[0].sortAt;
    const reopened = createGeminiController(f.opts);
    let previews = 0;
    try {
      await reopened.open(
        {threadId: id, model: 'gemini-3.8-flash'},
        {
          onHistory: async state => {
            previews++;
            assert.ok(state.messages.some(m => m.text === 'native reply'));
            assert.equal(f.calls.length, 1);
          }
        }
      );
      assert.equal(previews, 1);
      assert.equal((await listMainSessions(f.root)).sessions[0].sortAt, before);
      assert.equal(f.calls.length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.controller.close();
  }
});

test('Gemini accepts attachment-only input through native file references', async () => {
  const f = await fixture();
  try {
    const {threadId} = await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    for (const input of [
      {text: ''},
      {text: '   '},
      {text: null, attachmentIds: ['fake']},
      {text: 'x'.repeat(32001), attachmentIds: ['fake']}
    ])
      await assert.rejects(f.controller.send(input), /訊息/);
    const image = await f.controller.upload({
      threadId,
      name: 'pixel.png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9kAAAAASUVORK5CYII='
    });
    await assert.rejects(f.controller.send({text: '', attachmentIds: ['missing']}));
    assert.equal(f.calls.length, 0);
    await f.controller.send({attachmentIds: [image.id]});
    await finish(f.controller);
    assert.equal(f.calls.length, 1);
    const prompt = promptTextOf(f.calls[0]);
    assert.ok(prompt.startsWith('\n\n附件'));
    assert.match(prompt, /pixel\.png/);
    const user = f.controller.state.messages.find(m => m.role === 'user');
    assert.equal(user.text, '');
    assert.equal(user.attachments.length, 1);
    assert.equal(f.controller.state.title, 'pixel.png');
  } finally {
    await f.controller.close();
  }
});

// A fake K worker bridge and gateway: records are emitted through onChange as the real bridge does.
function workerFixture() {
  const bridges = [],
    gateways = [];
  const bridgeFactory = async params => {
    const records = new Map(),
      calls = [];
    const emit = record => {
      records.set(record.requestId, record);
      params.onChange(structuredClone(record));
    };
    const bridge = {
      params,
      calls,
      records,
      emit,
      async start(args) {
        calls.push(['start', args]);
        const record = {
          requestId: args.requestId,
          parentId: params.parentId,
          provider: 'codex',
          model: args.model,
          status: 'running',
          settled: false,
          output: '',
          workspace: params.workspace
        };
        emit(record);
        return record;
      },
      async list() {
        return [...records.values()].map(r => structuredClone(r));
      },
      async inspect({requestId}) {
        return structuredClone(records.get(requestId));
      },
      async wait({requestId}) {
        return structuredClone(records.get(requestId));
      },
      async answer(args) {
        calls.push(['answer', args]);
        const record = structuredClone(records.get(args.requestId));
        assert.equal(record.pendingQuestion?.id, args.questionId);
        delete record.pendingQuestion;
        emit(record);
        return record;
      },
      async cancel({requestId}) {
        calls.push(['cancel', requestId]);
        emit({...records.get(requestId), status: 'cancelled', settled: true});
        return records.get(requestId);
      },
      async reconcile() {},
      async accounts() {
        return {};
      },
      async close() {
        calls.push(['close']);
      }
    };
    bridges.push(bridge);
    return bridge;
  };
  const gatewayFactory = async ({bridge}) => {
    const gateway = {
      bridge,
      closed: 0,
      mcpConfig: {
        mcpServers: {
          k_luna: {
            type: 'http',
            url: `http://127.0.0.1:4${gateways.length}000/mcp`,
            headers: {Authorization: 'Bearer fake'}
          }
        }
      },
      async close() {
        gateway.closed++;
      }
    };
    gateways.push(gateway);
    return gateway;
  };
  const workerCatalog = async () => ({
    models: [
      {model: 'gpt-6.1-sol', supportedReasoningEfforts: [{reasoningEffort: 'high'}]},
      {model: 'claude-opus-5-5', supportedReasoningEfforts: [{reasoningEffort: 'high'}]},
      {model: 'gemini-3.8-flash', supportedReasoningEfforts: [{reasoningEffort: 'low'}]}
    ]
  });
  return {bridges, gateways, options: {bridgeFactory, gatewayFactory, workerCatalog}};
}
const until = async (check, label) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`timed out: ${label}`);
};

test("room tools reach the Gemini main gateway and answer only during this room's running turn", async () => {
  let release, rooms;
  const gate = new Promise(resolve => (release = resolve)),
    calls = [],
    w = workerFixture();
  const f = await fixture({
    ...w.options,
    gatewayFactory: async options => {
      rooms = options.rooms;
      return w.options.gatewayFactory(options);
    },
    roomTools: {
      rename: async (id, args) => calls.push(['rename', id, args]) && {threadId: id, ...args},
      list: async id => calls.push(['list', id]) && {rooms: []},
      note: async (id, args) => calls.push(['note', id, args]) && {queued: true}
    },
    openAgent: async opts => {
      const sid = randomUUID();
      return {
        pid: 56,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === 'session/new') return {sessionId: sid};
          if (method === 'session/prompt') {
            await gate;
            opts.onNotification?.({
              method: 'session/update',
              params: {sessionId: sid, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'ok'}}}
            });
            return {stopReason: 'end_turn'};
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
        }
      };
    }
  });
  const c = f.controller;
  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    assert.throws(() => rooms.list(), /進行中回合/);
    assert.throws(() => rooms.rename({title: 'not running'}), /進行中回合/);
    const sent = c.send({text: 'keep working'});
    await until(() => c.state.busy && calls.length === 0 && rooms, 'turn running');
    await rooms.list();
    await rooms.note({targetThreadId: 'room-b', text: 'hi'});
    await rooms.rename({title: '改名測試'});
    const id = c.state.threadId;
    assert.deepEqual(calls, [
      ['list', id],
      ['note', id, {targetThreadId: 'room-b', text: 'hi'}],
      ['rename', id, {title: '改名測試'}]
    ]);
    release();
    await sent;
    await finish(c);
    assert.throws(() => rooms.list(), /進行中回合/);
    assert.throws(() => rooms.rename({title: 'finished'}), /進行中回合/);
  } finally {
    release();
    await c.close();
  }
});

test('Gemini main reaches K workers through k_luna and receives each completion once, only when idle', async () => {
  let release, f;
  const gate = new Promise(resolve => (release = resolve)),
    native = '44444444-4444-4444-4444-444444444444';
  const w = workerFixture();
  f = await fixture({
    ...w.options,
    openAgent: async opts => {
      const requests = [];
      f.calls.push({binary: opts.executable, args: opts.args, params: opts, requests});
      return {
        pid: 55,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method, params) {
          requests.push({method, params: structuredClone(params)});
          if (method === 'session/new' || method === 'session/resume') return {sessionId: native};
          if (method === 'session/prompt') {
            if (params.prompt.map(b => b.text).join('') === 'keep working') await gate;
            opts.onNotification?.({
              method: 'session/update',
              params: {
                sessionId: native,
                update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'ok'}}
              }
            });
            return {stopReason: 'end_turn'};
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
        }
      };
    }
  });
  const c = f.controller;
  try {
    const {threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    const home = path.join(f.root, 'agent-home/gemini/main', threadId);
    assert.deepEqual(JSON.parse(await readFile(path.join(home, '.gemini/config/mcp_config.json'), 'utf8')).mcpServers, {
      k_luna: {serverUrl: 'http://127.0.0.1:40000/mcp', headers: {Authorization: 'Bearer fake'}}
    });
    const settings = JSON.parse(await readFile(path.join(home, '.gemini/antigravity-cli/settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('mcp(k_luna/*)'));
    assert.ok(!settings.permissions.deny.includes('mcp(*)'));
    const rules = await readFile(path.join(home, '.gemini/config/rules/k-model-roles.md'), 'utf8');
    assert.ok(rules.includes(MODEL_PROTOCOL_GUIDANCE));
    assert.match(rules, /any provider use k_luna \/ luna_start/);
    assert.match(rules, /gpt-6\.1-sol: high; claude-opus-5-5: high; gemini-3\.8-flash: low/);
    // The model starts a worker through the gateway; the bridge is created lazily for this room only.
    await w.gateways[0].bridge.start({requestId: 'job-1', model: 'gpt-6.1-sol', effort: 'high', task: 'fake'});
    const bridge = w.bridges[0];
    assert.equal(bridge.params.parentId, threadId);
    assert.equal(bridge.params.accessMode, 'workspace-write');
    assert.equal(c.state.workers[0].requestId, 'job-1');
    // A busy main agent is never interrupted; the notice waits for the user turn to end.
    const original = f.calls.length;
    await c.send({text: 'keep working'});
    await until(() => f.calls.length === original + 1, 'user turn started');
    bridge.emit({...bridge.records.get('job-1'), status: 'completed', settled: true, output: 'worker done'});
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.calls.length, original + 1);
    assert.equal(c.state.busy, true);
    release();
    await until(() => f.calls.length === original + 2 && !c.state.busy, 'notice turn');
    assert.equal(promptTextOf(f.calls[original]), 'keep working');
    const notice = f.calls.at(-1);
    const blocks = promptBlocksOf(notice);
    assert.equal(blocks.length, 2);
    assert.match(blocks[0].text, /^K 跨模型全域工作規則目前未啟用/u);
    assert.match(blocks[1].text, /^K 工人完成通知（系統事件，不是使用者新指令）/);
    assert.match(blocks[1].text, /"requestId":"job-1"/);
    const event = c.state.messages.find(m => m.kind === 'worker-completion');
    assert.equal(event.summary, 'K 子代理工作完成：job-1');
    assert.equal(c.state.title, 'keep working');
    // A repeated record of the same settled job does not wake the main agent again.
    bridge.emit({...bridge.records.get('job-1')});
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.calls.length, original + 2);
  } finally {
    await c.close();
  }
});

test('Gemini main receives each clarification without displaying an approval and answers through the worker gateway', async () => {
  const w = workerFixture(),
    f = await fixture(w.options),
    c = f.controller;
  try {
    const {threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    const gatewayBridge = w.gateways[0].bridge;
    const early = {requestId: 'clarify-job', questionId: randomUUID(), answer: 'Use the first sample.'};
    await assert.rejects(gatewayBridge.answer(early), /沒有可回覆/);
    assert.equal(w.bridges.length, 0);
    await gatewayBridge.start({requestId: 'clarify-job', model: 'gpt-6.1-sol', effort: 'high', task: 'fake'});
    await gatewayBridge.start({requestId: 'finished-job', model: 'gpt-6.1-sol', effort: 'high', task: 'fake'});
    const bridge = w.bridges[0],
      running = bridge.records.get('clarify-job'),
      pendingQuestion = {id: randomUUID(), text: 'Use the first sample?'};
    const question = {...running, pendingQuestion};
    bridge.params.onGeminiHandoff({
      parentId: threadId,
      queryIds: ['ready-query'],
      requestIds: [],
      status: 'ready',
      accountId: 'a'.repeat(32),
      switched: false
    });
    bridge.emit({...bridge.records.get('finished-job'), settled: true, status: 'completed'});
    bridge.emit(question);
    await until(() => f.calls.length === 1 && !c.state.busy, 'clarification notice was sent');
    assert.match(promptTextOf(f.calls[0]), /^K 工人提問/);
    assert.ok(promptTextOf(f.calls[0]).includes(pendingQuestion.id));
    assert.ok(promptTextOf(f.calls[0]).includes(pendingQuestion.text));
    assert.doesNotMatch(promptTextOf(f.calls[0]), /ready-query|finished-job/);
    assert.deepEqual(c.state.questions, []);
    const receipts = (await listMainSessions(f.root, {threadId})).sessions[0].workerNotifications;
    assert.equal(Object.keys(receipts).filter(key => key.startsWith('question-')).length, 1);
    bridge.emit(question);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 1, 'repeated pending record does not wake the room again');
    const args = {requestId: 'clarify-job', questionId: pendingQuestion.id, answer: 'Use the first sample.'};
    const answered = await gatewayBridge.answer(args);
    assert.equal(answered.pendingQuestion, undefined);
    assert.deepEqual(bridge.calls.at(-1), ['answer', args]);

    const following = {id: randomUUID(), text: 'What label?'};
    bridge.emit({...running, pendingQuestion: following});
    await until(() => f.calls.length === 2 && !c.state.busy, 'second clarification notice was sent');
    assert.ok(promptTextOf(f.calls[1]).includes(following.id));
    await gatewayBridge.answer({...args, questionId: following.id, answer: 'Sample A'});

    const waitedQuestion = {id: randomUUID(), text: 'Should I format the sample?'};
    bridge.emit({...running, pendingQuestion: waitedQuestion});
    gatewayBridge.resultReady(args, {...running, pendingQuestion: waitedQuestion});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 2, 'the question seen by the parent wait needs no duplicate wake-up');
    await gatewayBridge.answer({...args, questionId: waitedQuestion.id, answer: 'Yes'});

    bridge.emit({...running, settled: true, status: 'completed', output: 'worker finished'});
    await until(() => f.calls.length === 3 && !c.state.busy, 'eventual completion notice was sent');
    assert.match(promptTextOf(f.calls[2]), /K 工人完成通知/);
    assert.match(promptTextOf(f.calls[2]), /ready-query/);
    assert.match(promptTextOf(f.calls[2]), /finished-job/);
    const stopping = c.stop();
    await assert.rejects(gatewayBridge.answer(args), /沒有可回覆/);
    await stopping;
    await assert.rejects(gatewayBridge.answer(args), /沒有可回覆/);
    assert.equal(w.bridges.length, 1);
  } finally {
    await c.close();
  }
});

test('Gemini main keeps worker settings while a worker runs, relays worker approvals and stops workers with the room', async () => {
  const w = workerFixture(),
    f = await fixture(w.options),
    c = f.controller;
  try {
    const {threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await w.gateways[0].bridge.start({requestId: 'job-2', model: 'claude-opus-5-5', effort: 'high', task: 'fake'});
    const bridge = w.bridges[0];
    // Settings that would rebuild the gateway are refused, never applied by cancelling the worker.
    await assert.rejects(
      c.open({threadId, model: 'gemini-3.8-flash', workerPolicy: {model: 'gpt-6.1-sol', effort: 'high'}}),
      /子代理尚未結束/
    );
    assert.equal(
      bridge.calls.some(([kind]) => kind === 'cancel'),
      false
    );
    // The refusal happens before the room changes: same policy, worker still listed, not failed.
    assert.deepEqual(c.state.workerPolicy, {model: 'auto', effort: 'auto'});
    assert.ok(c.state.workers.some(w => w.requestId === 'job-2'));
    assert.notEqual(c.state.status, 'failed');
    // A send that would change access is refused before anything is sent, and the room keeps its mode.
    await assert.rejects(c.send({text: 'now read only', accessMode: 'read-only'}), /子代理尚未結束/);
    assert.equal(c.state.accessMode, 'workspace-write');
    assert.equal(c.state.busy, false);
    assert.equal(f.calls.length, 0);
    // A worker approval appears in this room and the owner's answer reaches the bridge.
    const reply = bridge.params.onRequest({
      method: 'k/claude/requestApproval',
      params: {parentId: threadId, requestId: 'job-2', toolName: 'Bash', input: {command: 'echo fake'}}
    });
    assert.equal(c.state.questions.length, 1);
    assert.equal(c.state.questions[0].provider, 'codex-luna');
    await c.answer({id: c.state.questions[0].id, accept: false});
    assert.equal(c.state.questions.length, 0);
    assert.ok(await reply);
    await assert.rejects(c.answer({id: 'missing', accept: true}), /已失效/);
    // Opening another conversation is refused before the room changes.
    await assert.rejects(c.open({model: 'gemini-3.8-flash'}), /待工人完成後再切換對話/);
    assert.equal(c.state.threadId, threadId);
    assert.ok(c.state.workers.some(w => w.requestId === 'job-2'));
    // Stopping the room stops its K workers, as the Claude entry does; the cancelled job
    // is not announced back as a completion turn.
    await c.stop();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(f.calls.length, 0);
    assert.ok(bridge.calls.some(([kind, id]) => kind === 'cancel' && id === 'job-2'));
    assert.ok(bridge.calls.some(([kind]) => kind === 'close'));
    assert.equal(w.gateways[0].closed, 1);
  } finally {
    await c.close();
  }
});

test('a stop during notice preparation sends nothing afterwards', async () => {
  const w = workerFixture(),
    f = await fixture(w.options),
    c = f.controller;
  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await w.gateways[0].bridge.start({requestId: 'job-s', model: 'gpt-6.1-sol', effort: 'high', task: 'fake'});
    const bridge = w.bridges[0];
    bridge.emit({...bridge.records.get('job-s'), status: 'completed', settled: true, output: 'done'});
    await c.stop();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(f.calls.length, 0);
    assert.equal(
      c.state.messages.some(m => m.kind === 'worker-completion'),
      false
    );
  } finally {
    await c.close();
  }
});

test('an account-ready event for another account is shown, never sent into a room bound to its old account', async () => {
  const bound = 'a'.repeat(32),
    other = 'b'.repeat(32);
  const accounts = {
    acquire: async () => ({accountId: bound, release: async () => {}}),
    inspect: async read => read(),
    usage: async () => null
  };
  const w = workerFixture(),
    f = await fixture({...w.options, accounts}),
    c = f.controller;
  try {
    const {threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: 'bind the account'});
    await finish(c);
    await w.gateways[0].bridge.start({requestId: 'job-h', model: 'gemini-3.8-flash', effort: 'low', task: 'fake'});
    w.bridges[0].params.onGeminiHandoff({
      parentId: threadId,
      status: 'ready',
      accountId: other,
      switched: true,
      requestIds: ['job-h'],
      queryIds: []
    });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.calls.length, 1);
    const notice = c.state.notices.findLast(n => n.kind === 'gemini-handoff' && !n.resolved);
    assert.equal(notice.level, 'warning');
    assert.match(notice.message, /本聊天室的原生歷史綁定原帳號，不能在新帳號接續/);
  } finally {
    await c.close();
  }
});

test('stopping the room never announces the workers it cancels as a new completion turn', async () => {
  const w = workerFixture(),
    f = await fixture(w.options),
    c = f.controller;
  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    // The fake bridge reports the cancellation synchronously, like the real one.
    await w.gateways[0].bridge.start({requestId: 'job-c', model: 'gpt-6.1-sol', effort: 'high', task: 'fake'});
    await c.stop();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(f.calls.length, 0);
    assert.equal(w.gateways.length, 1);
    assert.equal(
      c.state.messages.some(m => m.kind === 'worker-completion'),
      false
    );
  } finally {
    await c.close();
  }
});

test('a discussion turn starting with /learn stays literal; only the owner expands /learn', async () => {
  const f = await fixture(),
    c = f.controller;
  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: '/learn fake participant rule', discussionTurn: {id: 'discussion-fake', bind: async () => {}}});
    await finish(c);
    assert.deepEqual(promptBlocksOf(f.calls[0]), [
      {type: 'text', text: '\n'},
      {type: 'text', text: '/learn fake participant rule'}
    ]);
  } finally {
    await c.close();
  }
});

test('a K notice turn stays well inside the Windows command-line limit', async () => {
  const f = await fixture(),
    c = f.controller;
  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: '"'.repeat(20000)}, null, {kind: 'worker-completion', summary: 'fake'});
    await finish(c);
    const prompt = promptTextOf(f.calls[0]);
    assert.ok(prompt.length < 14100);
    assert.match(prompt, /通知過長已截斷；完整結果請用 luna_inspect 查詢原 requestId/);
    assert.equal(c.state.messages[0].kind, 'worker-completion');
  } finally {
    await c.close();
  }
});

test('agy native subagents left unresolved end once the stop confirms the process tree ended', async () => {
  const sub = '55555555-5555-5555-5555-555555555555',
    killed = [];
  const f = await fixture({
    killTree: async pid => killed.push(pid),
    openAgent: async opts => {
      const sid = '66666666-6666-6666-6666-666666666666';
      return {
        pid: 88,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === 'session/new') return {sessionId: sid};
          if (method === 'session/prompt') {
            opts.onNotification?.({
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'sub-1',
                  name: 'invoke_subagent',
                  status: 'completed',
                  subagent_info: {subagents: [{type_name: 'helper', initial_prompt: 'fake', conversation_id: sub}]}
                }
              }
            });
            return {stopReason: 'end_turn'};
          }
          return {};
        },
        notify() {},
        async close() {
          throw Error('fake tree not confirmed');
        }
      };
    }
  });
  try {
    await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    await f.controller.send({text: 'start'});
    await finish(f.controller);
    assert.equal(f.controller.state.status, 'uncertain');
    assert.equal(f.controller.state.workers[0].status, 'unresolved');
    assert.equal(f.controller.state.workers[0].settled, false);
    await f.controller.stop();
    assert.deepEqual(killed, [88]);
    assert.equal(f.controller.state.workers[0].status, 'ended');
    assert.equal(f.controller.state.workers[0].settled, true);
  } finally {
    await f.controller.close();
  }
});

test('agy native subagents show as running in the turn and end, result unknown, with the agy process', async () => {
  const sub = '22222222-2222-2222-2222-222222222222';
  let observed, f;
  f = await fixture({
    openAgent: async opts => {
      const sid = '33333333-3333-3333-3333-333333333333';
      return {
        pid: 77,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === 'session/new') return {sessionId: sid};
          if (method === 'session/prompt') {
            opts.onNotification?.({
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'sub-2',
                  name: 'invoke_subagent',
                  status: 'completed',
                  subagent_info: {
                    subagents: [
                      {type_name: 'writer', role: 'File Writer', initial_prompt: 'write fake', conversation_id: sub}
                    ]
                  }
                }
              }
            });
            observed = structuredClone(f.controller.state.workers);
            opts.onNotification?.({
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'done'}}
              }
            });
            return {stopReason: 'end_turn'};
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
        }
      };
    }
  });
  try {
    await f.controller.open({model: 'gemini-3.8-flash', effort: 'low'});
    await f.controller.send({text: 'use a subagent'});
    await finish(f.controller);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].provider, 'gemini-native');
    assert.equal(observed[0].requestId, `gemini-native:${sub}`);
    assert.equal(observed[0].name, 'File Writer');
    assert.equal(observed[0].task, 'write fake');
    assert.equal(observed[0].status, 'running');
    const ended = f.controller.state.workers[0];
    assert.equal(ended.status, 'ended');
    assert.equal(ended.settled, true);
  } finally {
    await f.controller.close();
  }
});

test('Gemini room uses separate short native references for the private documents each turn', async () => {
  const f = await fixture();
  const c = f.controller;
  const file = commonMemoryPath(f.root);
  const rulesFile = globalRulesPath(f.root);
  try {
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, '- Gemini 假偏好甲');
    await writeFile(rulesFile, '- Gemini 假全域規則甲');
    await c.open({model: 'gemini-3.8-flash'});
    await c.send({text: '第一句'});
    await finish(c);
    const home = f.calls.at(-1).params.env.HOME;
    const rule = path.join(home, '.gemini/config/rules/k-common-memory.md');
    const globalRule = path.join(home, '.gemini/config/rules/k-global-rules.md');
    const roles = await readFile(path.join(home, '.gemini/config/rules/k-model-roles.md'), 'utf8');
    assert.ok((await readFile(rule, 'utf8')).includes(`@[K 共同記憶](${file})`));
    assert.ok((await readFile(globalRule, 'utf8')).includes(`@[K 跨模型全域工作規則](${rulesFile})`));
    assert.doesNotMatch(roles, /K 共同記憶\]|K 跨模型全域工作規則\]|Gemini 假偏好|Gemini 假全域規則/);
    assert.doesNotMatch(promptTextOf(f.calls.at(-1)), /Gemini 假偏好|Gemini 假全域規則/);
    await rm(file);
    await rm(rulesFile);
    await c.send({text: '第二句'});
    await finish(c);
    const missing = await readFile(rule, 'utf8');
    assert.match(missing, /K 共同記憶目前未啟用（檔案不存在/);
    assert.doesNotMatch(missing, /@\[/);
    await assert.rejects(readFile(globalRule), {code: 'ENOENT'});
    await assert.rejects(readFile(file), {code: 'ENOENT'});
  } finally {
    await c.close();
  }
});
