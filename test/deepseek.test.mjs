import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {zstdCompressSync} from 'node:zlib';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {
  dshModelOptions,
  dshEfforts,
  dshEnvironment,
  ensureDshHome,
  dshPatch,
  openDshAgent,
  dshCli
} from '../src/dsh-acp.mjs';
import {
  parseDeepseekPrices,
  deepseekPeak,
  deepseekRoomCost,
  dshSessionUsage,
  deepseekBalance,
  dshSessionState
} from '../src/deepseek-billing.mjs';
import {createDeepSeekController, DEEPSEEK_PROFILE} from '../src/dsh-controller.mjs';
import {createAcpController} from '../src/acp-controller.mjs';
import {createDeepSeekWorker} from '../src/dsh-worker.mjs';
import {newer, officialCoreRelease, downloadCoreRelease, verifyAuthenticode} from '../src/core-updates.mjs';
import {modelProvider} from '../shared/model-provider.mjs';
import {availableWorkerModels, workerPolicyConfig} from '../src/worker-policy.mjs';
import {createLunaBridge} from '../src/luna-bridge.mjs';
import {scratchBase} from './scratch.mjs';

const value = model => JSON.stringify(['deepseek-official', model]);
// The session config DSH 0.2.1-rc.3 returned in the live ACP probe.
const CONFIG = [
  {
    id: 'model',
    category: 'model',
    currentValue: value('deepseek-v4-flash'),
    options: [
      {
        group: 'deepseek-official',
        name: 'DeepSeek',
        options: [
          {value: value('deepseek-v4-flash'), name: 'deepseek-v4-flash'},
          {value: value('deepseek-flash'), name: 'DeepSeek-V4.1-Flash'},
          {value: value('deepseek-v4-pro'), name: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding'}
        ]
      }
    ]
  },
  {
    id: 'reasoning_effort',
    category: 'thought_level',
    currentValue: 'high',
    options: ['off', 'low', 'high', 'max'].map(v => ({value: v, name: v}))
  }
];
const MODELS = dshModelOptions(CONFIG).map(row => ({
  ...row,
  provider: 'deepseek',
  available: true,
  inputModalities: ['text'],
  supportedReasoningEfforts: ['off', 'low', 'high', 'max'].map(reasoningEffort => ({reasoningEffort, description: ''})),
  defaultReasoningEffort: 'high',
  isDefault: row.model === 'deepseek-v4-flash'
}));
const scratch = async name => {
  await mkdir(scratchBase, {recursive: true});
  return mkdtemp(path.join(scratchBase, `${name}-`));
};

// A scripted stand-in for `dsh --profile acp`: no session metadata, model values are JSON strings.
function fakeDsh({scripts = []} = {}) {
  const calls = [],
    agents = [];
  const openAgent = async ({onNotification, onRequest, env, cwd, role}) => {
    let exited = false,
      live = null,
      ended;
    const closed = new Promise(resolve => (ended = resolve));
    const agent = {
      closed,
      exitNow: () => ((exited = true), ended({code: 1})),
      pid: 5151,
      // DSH's own work outside any prompt (goal rounds, background job wake-ups).
      emit: update => onNotification({method: 'session/update', params: {sessionId: live, update}}),
      env,
      cwd,
      role,
      initialize: {protocolVersion: 1},
      get exited() {
        return exited;
      },
      async request(method, params) {
        calls.push({method, params, agent: agents.indexOf(agent)});
        if (method === 'session/new') return {sessionId: (live = randomUUID()), configOptions: CONFIG};
        if (method === 'session/resume') return (live = params.sessionId), {configOptions: CONFIG};
        if (method === 'session/set_config_option') return {configOptions: CONFIG};
        if (method === 'session/prompt') {
          const step = scripts.shift() ?? (async () => ({stopReason: 'end_turn'}));
          const update = u => onNotification({method: 'session/update', params: {sessionId: params.sessionId, update: u}});
          const ask = toolCall =>
            onRequest({
              method: 'session/request_permission',
              params: {
                sessionId: params.sessionId,
                toolCall,
                options: [
                  {optionId: 'allow-once', kind: 'allow_once'},
                  {optionId: 'reject-once', kind: 'reject_once'}
                ]
              }
            });
          return step({update, ask, params});
        }
        throw Error(`unexpected ${method}`);
      },
      notify(method, params) {
        calls.push({method, params});
      },
      async close() {
        exited = true;
        calls.push({method: 'close'});
        ended({code: 0});
      }
    };
    agents.push(agent);
    return agent;
  };
  return {calls, agents, openAgent};
}
async function controllerFixture(scripts, extra = {}) {
  const root = await scratch('deepseek-controller');
  const fake = fakeDsh({scripts});
  const home = path.join(root, 'dsh-home');
  const controller = createDeepSeekController({
    root,
    env: {SystemRoot: process.env.SystemRoot, DEEPSEEK_API_KEY: 'must-not-inherit', K_DSH_HOME: home},
    dshExecutable: path.join(root, 'DeepSeek Harness.exe'),
    apiKey: async () => 'sk-test',
    openAgent: fake.openAgent,
    loginFactory: () => ({
      models: async () => MODELS,
      status: async () => ({available: true}),
      prices: async () => PRICES
    }),
    ...extra
  });
  return {root, home, fake, controller};
}
const settle = async controller => {
  for (let i = 0; i < 200 && controller.state.busy; i++) await new Promise(r => setTimeout(r, 5));
};

// A trimmed copy of the official price page table (2026-11-03).
const PRICE_HTML = `<table><tr><th>模型</th><th>deepseek-flash (1)</th><th>deepseek-v4-pro</th></tr>
<tr><td>BASE URL</td><td>https://api.deepseek.com</td></tr>
<tr><td rowspan="6">价格 (2)</td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr></table>
<table><tr><th>API</th><th>计费单位</th><th>价格</th></tr><tr><td>Search</td><td>每 1,000 次成功请求</td><td>5元</td></tr>
<tr><td>Fetch</td><td>每 1,000 次成功请求</td><td>5元</td></tr></table>
<p>(1) 模型名请使用 deepseek-flash 。旧模型名 deepseek-v4-flash 、 deepseek-v4-flash-vision-exp 仍可调用，但对应模型已下线，请求将由 DeepSeek-V4.1-Flash-1017 模型提供服务，并按 Flash 价格计费。</p>`;
const PRICES = parseDeepseekPrices(PRICE_HTML);
// Beijing Monday 2026-11-02 10:00 (peak) and 13:00 (off-peak).
const PEAK = Date.UTC(2026, 10, 2, 2, 0),
  OFF_PEAK = Date.UTC(2026, 10, 2, 5, 0);

test('DSH catalog: model IDs from opaque config values, reasoning levels, and the routing provider', () => {
  assert.deepEqual(
    dshModelOptions(CONFIG).map(row => [row.model, row.displayName, row.nativeValue]),
    [
      ['deepseek-v4-flash', 'deepseek-v4-flash', value('deepseek-v4-flash')],
      ['deepseek-flash', 'DeepSeek-V4.1-Flash', value('deepseek-flash')],
      ['deepseek-v4-pro', 'DeepSeek-V4-Pro', value('deepseek-v4-pro')]
    ]
  );
  assert.deepEqual(dshEfforts(CONFIG).levels.map(l => l.value), ['off', 'low', 'high', 'max']);
  assert.equal(dshEfforts(CONFIG).current, 'high');
  assert.equal(modelProvider('deepseek-v4-pro'), 'deepseek');
  assert.equal(modelProvider('api:ef41195d2390402dbaa13ab747f730b9/deepseek-v4-pro'), 'codex');
});

test('the DSH process gets only K values: its own key, home, permission mode and K overlay', async () => {
  const home = await scratch('deepseek-home');
  const env = dshEnvironment(
    {PATH: 'p', DEEPSEEK_API_KEY: 'inherited', DSH_HOME: 'elsewhere', DSH_PERMISSION_MODE: 'danger-full-access', K_DSH_HOME: 'x'},
    home,
    {accessMode: 'read-only', apiKey: 'sk-k'}
  );
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-k');
  assert.equal(env.DSH_HOME, home);
  assert.equal(env.DSH_PERMISSION_MODE, 'read-only');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.K_DSH_HOME, undefined);
  assert.equal(env.PATH, 'p');
  assert.throws(() => dshEnvironment({}, home, {accessMode: 'read-only'}), /DeepSeek API 金鑰/);
  await ensureDshHome(home);
  const main = await readFile(dshPatch(home, 'main'), 'utf8'),
    worker = await readFile(dshPatch(home, 'worker'), 'utf8');
  // The main agent keeps DSH's goal rounds and background jobs (K follows them); an empty overlay is `[]`,
  // since DSH refuses a patch file that is empty or only comments.
  assert.match(main, /\n\[\]\n$/u);
  for (const id of ['goal-round-driver', 'tool-goal', 'tool-jobs'])
    assert.match(worker, new RegExp(`- id: ${id}\\n  disabled: true`));
  // A worker's background execution is off where it runs, not only its management tools.
  assert.match(worker, /- id: tool-pwsh\n  config:\n    enableRunInBackground: false\n    promoteOnTimeout: false\n/u);
  for (const id of ['tool-subagent', 'tool-subagent-fork', 'tool-workflow'])
    assert.match(worker, new RegExp(`- id: ${id}\\n  disabled: true`));
  // The process is the official package's bundled CLI under Electron-as-Node, with the role's overlay.
  let spawned;
  const child = Object.assign(new EventEmitter(), {
    pid: 9,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  });
  child.stdin.on('data', chunk => {
    const message = JSON.parse(String(chunk));
    child.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {protocolVersion: 1}}) + '\n');
  });
  const exe = path.join(home, 'app', 'DeepSeek Harness.exe');
  const agent = await openDshAgent({
    executable: exe,
    env,
    role: 'worker',
    spawnImpl: (command, args) => {
      spawned = {command, args};
      return child;
    }
  });
  assert.equal(spawned.command, exe);
  assert.deepEqual(spawned.args, ['--expose-internals', dshCli(exe), '--profile', 'acp', '--patch', dshPatch(home, 'worker')]);
  child.emit('exit', 0, null);
  await agent.closed;
  await assert.rejects(openDshAgent({executable: null, env}), /找不到 DeepSeek Harness/);
});

test('room cost: official prices, peak and off-peak, officially listed retired names, unknown models and searches reported', async () => {
  assert.deepEqual(PRICES.models['deepseek-v4-pro'], {
    cacheHit: {offPeak: 0.15, peak: 0.3},
    cacheMiss: {offPeak: 4.5, peak: 9},
    output: {offPeak: 13.5, peak: 27}
  });
  assert.deepEqual(PRICES.aliases, {'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash'});
  assert.equal(deepseekPeak(PEAK), true);
  assert.equal(deepseekPeak(OFF_PEAK), false);
  assert.equal(deepseekPeak(Date.UTC(2026, 10, 7, 2, 0)), false, 'Saturday is off-peak');
  assert.throws(() => parseDeepseekPrices('<html>changed</html>'), /格式已改變/);
  const cost = deepseekRoomCost(
    {
      steps: [
        {time: PEAK, model: 'deepseek-v4-pro', input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000},
        {time: OFF_PEAK, model: 'deepseek-v4-flash', input: 1_000_000, cacheRead: 0, output: 0},
        {time: OFF_PEAK, model: 'deepseek-unknown-pro', input: 10, cacheRead: 0, output: 0}
      ],
      searches: 2
    },
    PRICES
  );
  // A name the page does not list is never priced by resemblance; searches are counted, not guessed.
  assert.equal(Math.round(cost.cny * 1000) / 1000, 9 + 0.3 + 27 + 1);
  assert.equal(cost.unpriced, 1);
  assert.equal(cost.searches, 2);
  assert.deepEqual(cost.tokens, {input: 2_000_010, cacheRead: 1_000_000, output: 1_000_000});
  assert.equal(deepseekRoomCost({steps: [], searches: 0}, null).cny, null, 'no price page means unknown, not zero');
  // Usage whose every step lacks an official price is unknown, not ¥0.
  const unknown = deepseekRoomCost({steps: [{time: PEAK, model: 'deepseek-unknown-pro', input: 5, cacheRead: 0, output: 0}], searches: 0}, PRICES);
  assert.equal(unknown.cny, null);
  assert.equal(unknown.pricesAvailable, true);
  assert.equal(unknown.unpriced, 1);
  // DSH's own log: zstd JSONL under sessions/<workspace>/<session>/; only usage numbers are read.
  const home = await scratch('deepseek-log'),
    id = randomUUID();
  await mkdir(path.join(home, 'sessions', '--C-ws--', id), {recursive: true});
  const lines = [
    {type: 'assistant/message', time: PEAK, data: {message: {content: [{type: 'text', text: 'secret'}], source: {model: 'deepseek-flash'}}, usage: {inputTokens: 5, cacheReadTokens: 7, outputTokens: 3}}},
    {type: 'tool/call', time: PEAK, data: {name: 'web_fetch'}},
    {type: 'tool/call', time: PEAK, data: {name: 'web_search'}},
    {type: 'tool/call', time: PEAK, data: {name: 'write'}}
  ];
  await writeFile(
    path.join(home, 'sessions', '--C-ws--', id, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n'))
  );
  assert.deepEqual(await dshSessionUsage(home, id), {
    steps: [{time: PEAK, model: 'deepseek-flash', input: 5, cacheRead: 7, output: 3}],
    searches: 1
  });
  assert.equal(await dshSessionUsage(home, randomUUID()), null);
  assert.equal(await dshSessionUsage(home, '../escape'), null);
});

test('the balance query uses the official endpoint and reports each wallet separately', async () => {
  const seen = [];
  const balance = await deepseekBalance('sk-b', {
    fetchImpl: async (url, init) => {
      seen.push([url, init.headers.Authorization]);
      return Response.json({
        is_available: true,
        balance_infos: [
          {currency: 'CNY', total_balance: '36.45'},
          {currency: 'USD', total_balance: '0.00'}
        ]
      });
    }
  });
  assert.deepEqual(seen, [['https://api.deepseek.com/user/balance', 'Bearer sk-b']]);
  assert.deepEqual(balance, {available: true, cny: 36.45, usd: 0});
  await assert.rejects(
    deepseekBalance('bad', {fetchImpl: async () => new Response('', {status: 401})}),
    /金鑰無效/
  );
});

test('a DeepSeek room: rules travel in the prompt once per process, the native model value is used, results and usage are recorded', async () => {
  const f = await controllerFixture([
    async ({update}) => {
      update({sessionUpdate: 'usage_update', used: 6996, size: 1048576});
      update({sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: '第一步思考'}});
      update({sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: '第二步思考'}});
      update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: '工具前。'}});
      update({sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'write', kind: 'other', status: 'in_progress', rawInput: {file_path: 'out.txt'}});
      update({sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'completed'});
      update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: '完成'}});
      return {stopReason: 'end_turn'};
    }
  ]);
  const {controller, fake, home} = f;
  await controller.open({model: 'deepseek-v4-pro', effort: 'low', accessMode: 'workspace-write'});
  assert.match(controller.state.threadId, /^deepseek-[0-9a-f-]{36}$/u);
  await controller.send({text: '寫檔'});
  await settle(controller);
  assert.equal(controller.state.status, 'completed');
  const agent = fake.agents[0];
  assert.equal(agent.env.DEEPSEEK_API_KEY, 'sk-test');
  assert.equal(agent.env.DSH_PERMISSION_MODE, 'workspace-write');
  assert.equal(agent.env.DSH_HOME, home);
  const created = fake.calls.find(c => c.method === 'session/new');
  assert.equal(created.params._meta, undefined, 'DSH ignores session metadata');
  const config = fake.calls.filter(c => c.method === 'session/set_config_option').map(c => [c.params.configId, c.params.value]);
  assert.deepEqual(config, [
    ['model', value('deepseek-v4-pro')],
    ['reasoning_effort', 'low']
  ]);
  const prompts = fake.calls.filter(c => c.method === 'session/prompt');
  assert.match(prompts[0].params.prompt[0].text, /^<k_rules>\n[\s\S]*目前權限：要求核准/u);
  assert.deepEqual(controller.state.artifacts, ['out.txt']);
  assert.deepEqual(controller.state.progress.contextUsage, {used: 6996, size: 1048576});
  const replies = controller.state.messages.filter(m => m.role === 'assistant');
  assert.deepEqual(replies.map(m => m.text), ['工具前。完成']);
  assert.ok(!replies[0].partial && !replies[0].streaming);
  assert.equal(controller.state.capabilities.steer, false);
  const groupId = controller.state.messages.at(-1).groupId;
  assert.equal(controller.state.capabilities.thoughts, true);
  assert.deepEqual(
    controller.state.reasoning.map(r => [r.groupId, r.text]),
    [[groupId, '第一步思考\n\n第二步思考']]
  );
  assert.equal(controller.state.tools[0].groupId, groupId);
  assert.ok(controller.state.tools[0].createdAt);
  // Same process: rules are not repeated. A new access mode needs a new DSH process (its sandbox is fixed per launch).
  await controller.send({text: '再一次'});
  await settle(controller);
  assert.equal(fake.calls.filter(c => c.method === 'session/prompt')[1].params.prompt.some(b => /<k_rules>/u.test(b.text)), false);
  await controller.send({text: '唯讀', accessMode: 'read-only'});
  await settle(controller);
  assert.equal(fake.agents.length, 2);
  assert.equal(fake.agents[1].env.DSH_PERMISSION_MODE, 'read-only');
  assert.ok(fake.calls.some(c => c.method === 'session/resume' && c.agent === 1));
  assert.match(fake.calls.filter(c => c.method === 'session/prompt')[2].params.prompt[0].text, /<k_rules>[\s\S]*唯讀/u);
  await controller.close();
});

test('DeepSeek escalations: read-only rejects, approval mode asks the human once, full access allows', async () => {
  const toolCall = {toolCallId: 't', title: 'pwsh', kind: 'other', rawInput: {command: 'Set-Content C:\\x.txt 1'}};
  const answers = [];
  const f = await controllerFixture([
    async ({ask}) => (answers.push(await ask(toolCall)), {stopReason: 'end_turn'}),
    async ({ask}) => (answers.push(await ask(toolCall)), {stopReason: 'end_turn'}),
    async ({ask}) => (answers.push(await ask(toolCall)), {stopReason: 'end_turn'})
  ]);
  const {controller} = f;
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'read-only'});
  await controller.send({text: 'a'});
  await settle(controller);
  await controller.send({text: 'b', accessMode: 'workspace-write'});
  for (let i = 0; i < 200 && !controller.state.questions.length; i++) await new Promise(r => setTimeout(r, 5));
  const question = controller.state.questions[0];
  assert.equal(question.provider, 'deepseek');
  assert.equal(question.title, 'DeepSeek 需要操作核准');
  assert.equal(question.details.command, toolCall.rawInput.command);
  await controller.answer({id: question.id, accept: true});
  await settle(controller);
  await controller.send({text: 'c', accessMode: 'danger-full-access', permissionConfirmed: true});
  await settle(controller);
  assert.deepEqual(
    answers.map(a => a.outcome.optionId),
    ['reject-once', 'allow-once', 'allow-once']
  );
  await controller.close();
});

test('stopping a DeepSeek turn also ends the DSH process, so its own subagents cannot keep working', async () => {
  let release;
  const f = await controllerFixture([
    () =>
      new Promise(resolve => {
        release = () => resolve({stopReason: 'cancelled'});
      })
  ]);
  const {controller, fake} = f;
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  await controller.send({text: 'long work'});
  for (let i = 0; i < 200 && !release; i++) await new Promise(r => setTimeout(r, 5));
  const stopping = controller.stopTurn();
  // DSH answers its cancel promptly; K still closes the process instead of trusting the cancel alone.
  release();
  await stopping;
  assert.ok(fake.calls.some(c => c.method === 'session/cancel'));
  assert.equal(fake.agents[0].exited, true);
  assert.equal(controller.state.status, 'interrupted');
  await controller.send({text: 'next'});
  await settle(controller);
  assert.equal(fake.agents.length, 2, 'the next send resumes the same native session in a new process');
  assert.ok(fake.calls.some(c => c.method === 'session/resume' && c.agent === 1));
  await controller.close();
});

test('a stop keeps new work out until the DSH process is confirmed closed', async () => {
  let release, closing;
  const f = await controllerFixture([
    () =>
      new Promise(resolve => {
        release = () => resolve({stopReason: 'cancelled'});
      })
  ]);
  const {controller, fake} = f;
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  await controller.send({text: 'long work'});
  for (let i = 0; i < 200 && !release; i++) await new Promise(r => setTimeout(r, 5));
  const agent = fake.agents[0],
    close = agent.close.bind(agent);
  agent.close = () => new Promise(resolve => (closing = () => resolve(close())));
  const stopping = controller.stopTurn();
  release();
  for (let i = 0; i < 200 && !closing; i++) await new Promise(r => setTimeout(r, 5));
  // The native cancel answered, the process is still closing: nothing new may start yet.
  await assert.rejects(controller.send({text: 'too early'}), /請先結束或查明目前 DeepSeek 工作/);
  assert.equal(fake.agents.length, 1);
  closing();
  await stopping;
  await controller.send({text: 'after stop'});
  await settle(controller);
  assert.equal(fake.agents.length, 2);
  await controller.close();
});

test('only the latest room estimate is shown, and none lands after the room closes', async () => {
  const root = await scratch('deepseek-usage-order'),
    fake = fakeDsh(),
    pending = [];
  const profile = {
    ...DEEPSEEK_PROFILE,
    environment: async (env, home, {accessMode}) => ({DSH_HOME: home, DSH_PERMISSION_MODE: accessMode}),
    loginFactory: () => ({models: async () => MODELS, status: async () => ({})}),
    refreshUsage: () => new Promise(resolve => pending.push(resolve))
  };
  const changes = [];
  const controller = createAcpController(profile, {
    root,
    env: {K_DSH_HOME: path.join(root, 'home')},
    executable: path.join(root, 'DeepSeek Harness.exe'),
    openAgent: fake.openAgent,
    onChange: state => changes.push(state.progress?.roomUsage?.cny)
  });
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  await controller.send({text: 'one'});
  await settle(controller);
  await controller.send({text: 'two'});
  await settle(controller);
  assert.equal(pending.length, 2, 'one refresh per finished turn');
  pending[1]({cny: 2});
  await new Promise(r => setTimeout(r, 5));
  pending[0]({cny: 1});
  await new Promise(r => setTimeout(r, 5));
  assert.equal(controller.state.progress.roomUsage.cny, 2, 'an older result never replaces a newer one');
  await controller.send({text: 'three'});
  await settle(controller);
  await controller.close();
  const before = changes.length;
  pending[2]({cny: 3});
  await new Promise(r => setTimeout(r, 5));
  assert.equal(controller.state.progress.roomUsage.cny, 2);
  assert.equal(changes.length, before, 'a closed room is not updated');
});

test('closing a room during a running turn: the turn’s own late estimate does not land afterwards', async () => {
  const root = await scratch('deepseek-usage-close'),
    pending = [];
  let release;
  const fake = fakeDsh({
    scripts: [
      () =>
        new Promise(resolve => {
          release = () => resolve({stopReason: 'cancelled'});
        })
    ]
  });
  const controller = createAcpController(
    {
      ...DEEPSEEK_PROFILE,
      environment: async (env, home, {accessMode}) => ({DSH_HOME: home, DSH_PERMISSION_MODE: accessMode}),
      loginFactory: () => ({models: async () => MODELS, status: async () => ({})}),
      refreshUsage: () => new Promise(resolve => pending.push(resolve))
    },
    {root, env: {K_DSH_HOME: path.join(root, 'home')}, executable: path.join(root, 'DeepSeek Harness.exe'), openAgent: fake.openAgent}
  );
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  await controller.send({text: 'long'});
  for (let i = 0; i < 200 && !release; i++) await new Promise(r => setTimeout(r, 5));
  const closing = controller.close();
  release();
  await closing;
  assert.equal(controller.state.status, 'offline');
  assert.equal(pending.length, 1, 'the finished turn asked for its estimate');
  pending[0]({cny: 123});
  await new Promise(r => setTimeout(r, 5));
  assert.equal(controller.state.progress.roomUsage, null);
});

test('opening and finishing a DeepSeek turn reads the room estimate from DSH’s own log', async () => {
  const f = await controllerFixture([async () => ({stopReason: 'end_turn'})]);
  const {controller, home} = f;
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  await controller.send({text: 'a'});
  await settle(controller);
  const id = f.fake.calls.find(c => c.method === 'session/new') && JSON.parse(await readFile(path.join(f.root, '.runtime', 'deepseek-sessions', `${controller.state.threadId}.json`), 'utf8')).nativeSessionId;
  await mkdir(path.join(home, 'sessions', '--ws--', id), {recursive: true});
  await writeFile(
    path.join(home, 'sessions', '--ws--', id, 'session.v4.jsonl.zstd'),
    zstdCompressSync(
      Buffer.from(
        JSON.stringify({type: 'assistant/message', time: OFF_PEAK, data: {message: {source: {model: 'deepseek-flash'}}, usage: {inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0}}}) + '\n'
      )
    )
  );
  const threadId = controller.state.threadId;
  await controller.close();
  const again = createDeepSeekController({
    root: f.root,
    env: {K_DSH_HOME: home},
    dshExecutable: path.join(f.root, 'DeepSeek Harness.exe'),
    apiKey: async () => 'sk-test',
    openAgent: f.fake.openAgent,
    loginFactory: () => ({models: async () => MODELS, status: async () => ({}), prices: async () => PRICES})
  });
  await again.open({threadId, model: 'deepseek-flash'});
  // Read in the background: opening the room does not wait for it.
  for (let i = 0; i < 200 && !again.state.progress.roomUsage; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(again.state.progress.roomUsage.cny, 1);
  assert.deepEqual(again.state.progress.roomUsage.tokens, {input: 1_000_000, cacheRead: 0, output: 0});
  await again.close();
});

test('a DeepSeek worker: worker overlay, rules in the prompt, native model value, escalations denied, writes reported', async () => {
  const root = await scratch('deepseek-worker'),
    fake = fakeDsh({
      scripts: [
        async ({update, ask}) => {
          update({sessionUpdate: 'tool_call', toolCallId: 'w', title: 'write', kind: 'other', status: 'in_progress', rawInput: {file_path: path.join(root, 'w.txt')}});
          update({sessionUpdate: 'tool_call_update', toolCallId: 'w', status: 'completed'});
          const answer = await ask({toolCallId: 'p', title: 'pwsh', kind: 'other', rawInput: {command: 'x'}});
          assert.equal(answer.outcome.optionId, 'reject-once');
          update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'ok'}});
          return {stopReason: 'end_turn'};
        }
      ]
    });
  const worker = createDeepSeekWorker({
    root,
    workspace: root,
    env: {K_DSH_HOME: path.join(root, 'home')},
    executable: path.join(root, 'DeepSeek Harness.exe'),
    apiKey: async () => 'sk-w',
    openAgent: fake.openAgent
  });
  const result = await worker.run({task: '寫 w.txt', model: 'deepseek-v4-pro', effort: 'max'});
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.outputFiles, ['w.txt']);
  assert.deepEqual(result.deniedTools, ['pwsh']);
  assert.equal(fake.agents[0].role, 'worker');
  assert.equal(fake.agents[0].env.DEEPSEEK_API_KEY, 'sk-w');
  assert.deepEqual(
    fake.calls.filter(c => c.method === 'session/set_config_option').map(c => c.params.value),
    [value('deepseek-v4-pro'), 'max']
  );
  const prompt = fake.calls.find(c => c.method === 'session/prompt').params.prompt;
  assert.match(prompt[0].text, /^<k_rules>\n你是 K HARNESS 的 DeepSeek 子代理。不再派工/u);
  // DSH runs sandboxed commands itself; the Grok wording ("commands are refused") must not reach it.
  assert.match(prompt[0].text, /命令只在原生沙盒內執行/u);
  assert.doesNotMatch(prompt[0].text, /命令與工作區外寫入會被 K 拒絕/u);
  assert.match(prompt.at(-1).text, /<DELEGATED_TASK>\n寫 w\.txt/u);
  const missing = await worker.run({task: 't', model: 'deepseek-none', effort: 'low'}).catch(e => e);
  assert.match(missing.message, /未提供指定模型；未派工/);
  const effort = await worker.run({task: 't', model: 'deepseek-flash', effort: 'xhigh'}).catch(e => e);
  assert.match(effort.message, /推理程度目前不可用；未派工/);
});

test('DeepSeek workers are routable from every main core and billed openly to the API balance', async () => {
  const catalog = [...MODELS, {model: 'gpt-6.1-sol', available: true}];
  assert.equal(availableWorkerModels(catalog).some(m => m.model.startsWith('deepseek-')), false);
  for (const provider of ['claude', 'gemini', 'grok', 'deepseek'])
    assert.ok(
      availableWorkerModels(catalog, {provider, claudeGateway: provider === 'claude'}).some(m => m.model === 'deepseek-flash'),
      provider
    );
  const config = workerPolicyConfig({model: 'auto', effort: 'auto'}, {models: catalog, provider: 'deepseek'});
  assert.match(config.developer_instructions, /k_luna \/ luna_start/);
  assert.match(config.developer_instructions, /DeepSeek 原生核心工人（deepseek- 開頭/);
  const root = await scratch('deepseek-bridge'),
    runs = [];
  const bridge = await createLunaBridge({
    root,
    workspace: root,
    parentId: 'deepseek-parent',
    geminiOnly: true,
    workerPolicy: {model: 'auto', effort: 'auto'},
    deepseekFactory: options => ({
      run: async args => {
        runs.push({options, args});
        return {status: 'completed', settled: true, output: 'ok', outputFiles: []};
      }
    })
  });
  try {
    await bridge.start({requestId: 'ds-job-1', task: 'do it', model: 'deepseek-flash', effort: 'low'});
    const done = await bridge.wait({requestId: 'ds-job-1', timeoutMs: 5000});
    assert.equal(done.provider, 'deepseek');
    assert.equal(done.status, 'completed');
    assert.equal(runs[0].args.model, 'deepseek-flash');
  } finally {
    await bridge.close();
  }
});

test('the DeepSeek core update: official feed, SHA-512, DeepSeek signature, unpacked by 7-Zip and never run', async () => {
  assert.equal(newer('0.2.1-rc.5', '0.2.1-rc.3'), true);
  assert.equal(newer('0.2.1', '0.2.1-rc.5'), true);
  assert.equal(newer('0.2.1-rc.5', '0.2.1'), false);
  assert.equal(newer('0.2.1-rc.10', '0.2.1-rc.9'), true);
  assert.equal(newer('1.0.70', '1.0.70'), false);
  const installer = Buffer.from('official installer bytes'),
    digest = createHash('sha512').update(installer).digest('base64');
  const feed = `version: 0.2.1-rc.5\nfiles:\n  - url: >-\n      https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.1-rc.5-win-x64.exe\n    sha512: >-\n      ${digest}\n    size: 24\npath: >-\n  https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.1-rc.5-win-x64.exe\nsha512: >-\n  ${digest}\nreleaseDate: '2026-10-29T14:04:01.198Z'\n`;
  const release = await officialCoreRelease('deepseek', {
    arch: 'x64',
    signal: AbortSignal.timeout(5000),
    request: async url => {
      assert.equal(url, 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml');
      return {text: async () => feed};
    }
  });
  assert.equal(release.version, '0.2.1-rc.5');
  assert.equal(release.digest, digest);
  assert.equal(release.signer, 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.');
  await assert.rejects(officialCoreRelease('deepseek', {arch: 'arm64', signal: AbortSignal.timeout(5000)}), /只提供 Windows x64/);
  const subject =
    'CN="Hangzhou DeepSeek Artificial Intelligence Co., Ltd.", O="Hangzhou DeepSeek Artificial Intelligence Co., Ltd.", L=Hangzhou, C=CN';
  const signedBy = subjectText => async () => ({stdout: JSON.stringify({status: 'Valid', subject: subjectText})});
  await verifyAuthenticode('x.exe', release.signer, {run: signedBy(subject)});
  await assert.rejects(verifyAuthenticode('x.exe', release.signer, {run: signedBy('CN=Someone Else')}), /簽章無效或發行者不符/);
  await verifyAuthenticode('x.exe', 'X Corp.', {run: signedBy('CN=X Corp., O=X Corp., C=US')});
  const dir = await scratch('deepseek-core'),
    commands = [];
  const run = async (command, args) => {
    if (command === '7z.exe') {
      commands.push(args);
      if (args[1].endsWith('app-64.7z')) {
        await mkdir(path.join(dir, 'app'), {recursive: true});
        await writeFile(path.join(dir, 'app', 'DeepSeek Harness.exe'), 'exe');
      }
      return {stdout: ''};
    }
    return {stdout: JSON.stringify({status: 'Valid', subject})};
  };
  const file = await downloadCoreRelease(release, dir, {
    request: async () => ({body: new Response(installer).body}),
    run,
    unpacker: () => '7z.exe'
  });
  assert.equal(path.basename(file), 'DeepSeek Harness.exe');
  assert.deepEqual(commands[0].slice(0, 3), ['x', path.join(dir, 'installer.exe'), '$PLUGINSDIR\\app-64.7z']);
  assert.equal(commands.length, 2);
  const tampered = await scratch('deepseek-core-bad');
  await assert.rejects(
    downloadCoreRelease(release, tampered, {request: async () => ({body: new Response('tampered').body}), run, unpacker: () => '7z.exe'}),
    /校驗失敗/
  );
});

test('DSH’s log tells K whether it still works on its own: open turn, queued round, running job, current goal', async () => {
  const home = await scratch('deepseek-state'),
    id = randomUUID();
  const folder = path.join(home, 'sessions', '--ws--', id);
  await mkdir(folder, {recursive: true});
  const write = lines =>
    writeFile(
      path.join(folder, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n'))
    );
  const goal = (operation, phase, rounds) => ({
    type: 'goal/change',
    data: {operation, goal: {objective: '三輪', phase, maxGoalRounds: 256}, roundsStarted: rounds}
  });
  const base = [{type: 'turn/start', data: {turn: 1}}, goal('create', 'active', 0), {type: 'turn/end', data: {turn: 1}}];
  // A goal round was queued right after the turn ended: still working.
  await write([...base, {type: 'agent/inbox/spliced', data: {target: 'next-turn', inserted: [{}]}}]);
  let state = await dshSessionState(home, id);
  assert.equal(state.running, true);
  assert.equal(state.queued, true);
  assert.deepEqual(state.goal, {objective: '三輪', status: 'active', rounds: 0, maxRounds: 256});
  // The round runs, then the goal completes and nothing is queued: done.
  await write([
    ...base,
    {type: 'agent/inbox/spliced', data: {target: 'next-turn', inserted: [{}]}},
    {type: 'turn/start', data: {turn: 2}},
    goal('complete', 'complete', 1),
    {type: 'turn/end', data: {turn: 2}}
  ]);
  state = await dshSessionState(home, id);
  assert.equal(state.running, false);
  assert.equal(state.goal.status, 'complete');
  // A background job still running keeps it working; settling it ends that.
  const job = {jobId: 'pwsh-1', label: 'Start-Sleep 8', kind: 'pwsh'};
  await write([...base, {type: 'job/registered', data: job}]);
  state = await dshSessionState(home, id);
  assert.equal(state.running, true);
  assert.deepEqual(state.jobs, [{id: 'pwsh-1', label: 'Start-Sleep 8'}]);
  await write([...base, {type: 'job/registered', data: job}, {type: 'job/settled', data: job}, goal('clear', 'active', 0)]);
  state = await dshSessionState(home, id);
  assert.equal(state.running, false);
  assert.equal(state.goal, null);
});

// A DeepSeek room whose log state the test controls; no file watch.
async function nativeFixture(scripts = [], {nativeState, nativeFolder, nativeLastSeq, onChange} = {}) {
  const root = await scratch('deepseek-native'),
    fake = fakeDsh({scripts}),
    native = {running: false, open: false, queued: false, jobs: [], goal: null};
  const controller = createAcpController(
    {
      ...DEEPSEEK_PROFILE,
      environment: async (env, home, {accessMode}) => ({DSH_HOME: home, DSH_PERMISSION_MODE: accessMode}),
      loginFactory: () => ({models: async () => MODELS, status: async () => ({})}),
      refreshUsage: async () => null,
      nativeState: nativeState ?? (async () => structuredClone(native)),
      nativeFolder: nativeFolder ?? (async () => null),
      nativeLastSeq: nativeLastSeq ?? (async () => -1),
      nativeSettleMs: 5
    },
    {
      root,
      env: {K_DSH_HOME: path.join(root, 'home')},
      executable: path.join(root, 'DeepSeek Harness.exe'),
      openAgent: fake.openAgent,
      ...(onChange ? {onChange} : {})
    }
  );
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  return {controller, fake, native, root};
}
const until = async (check, label) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(check(), label);
};

test('DSH continuing on its own after a turn shows as a turn in the room and ends when its log says so', async () => {
  const {controller, fake, native} = await nativeFixture();
  await controller.send({text: '建立三輪目標'});
  await settle(controller);
  // The goal round arrives as updates with no prompt from K.
  native.running = true;
  native.goal = {objective: '三輪', status: 'active', rounds: 1, maxRounds: 256};
  const agent = fake.agents[0];
  agent.emit({sessionUpdate: 'tool_call', toolCallId: 'r2', title: 'write', kind: 'other', status: 'in_progress', rawInput: {file_path: 'r2.txt'}});
  agent.emit({sessionUpdate: 'tool_call_update', toolCallId: 'r2', status: 'completed'});
  agent.emit({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: '第 2 輪完成'}});
  assert.equal(controller.state.busy, true);
  assert.equal(controller.state.status, 'working');
  const event = controller.state.messages.findLast(m => m.kind === 'native-autonomous');
  assert.match(event.summary, /DeepSeek 自主繼續/u);
  assert.deepEqual(controller.state.artifacts, ['r2.txt']);
  assert.equal(controller.state.messages.at(-1).text, '第 2 輪完成');
  await until(() => controller.state.goal?.rounds === 1, 'the goal is shown from the log');
  // Not done while the log still reports work.
  await new Promise(r => setTimeout(r, 30));
  assert.equal(controller.state.busy, true);
  native.running = false;
  native.goal = {...native.goal, status: 'complete', rounds: 2};
  agent.emit({sessionUpdate: 'usage_update', used: 7000, size: 1048576});
  await until(() => !controller.state.busy, 'the native turn ends when the log says DSH stopped');
  assert.equal(controller.state.status, 'completed');
  assert.equal(controller.state.goal.status, 'complete');
  assert.equal(controller.state.messages.at(-1).streaming, undefined);
  assert.equal(fake.calls.filter(c => c.method === 'session/prompt').length, 1, 'K never prompted for the round');
  await controller.close();
});

test('background jobs still running after a turn keep the room working; stopping cancels and ends the process', async () => {
  const {controller, fake, native} = await nativeFixture();
  await controller.send({text: '背景跑測試'});
  native.running = true;
  native.jobs = [{id: 'pwsh-1', label: 'npm test'}];
  await settle(controller);
  await until(() => controller.state.busy, 'a running background job keeps the room working');
  assert.match(controller.state.messages.findLast(m => m.kind === 'native-autonomous').summary, /背景工作執行中（1 個）/u);
  assert.deepEqual(controller.state.nativeJobs, [{id: 'pwsh-1', label: 'npm test'}]);
  await assert.rejects(controller.send({text: 'too early'}), /請先結束或查明目前 DeepSeek 工作/);
  await controller.stopTurn();
  assert.ok(fake.calls.some(c => c.method === 'session/cancel'));
  assert.equal(fake.agents[0].exited, true, 'closing the process ends DSH’s jobs and rounds with it');
  assert.equal(controller.state.busy, false);
  assert.equal(controller.state.status, 'interrupted');
  await controller.close();
});

test('the DeepSeek goal is read from DSH and set by talking to DeepSeek, not by a K command', async () => {
  const {controller, native} = await nativeFixture();
  await controller.send({text: 'a'});
  await settle(controller);
  native.goal = {objective: '三輪', status: 'blocked', rounds: 3, maxRounds: 256};
  assert.deepEqual((await controller.goal({refresh: true})).goal, native.goal);
  await assert.rejects(controller.goal({objective: 'x', status: 'active'}), /請直接在對話中告訴它/u);
  await controller.close();
});

test('a turn that leaves background jobs running hands over without ever releasing the room', async () => {
  const busy = [];
  const {controller, native} = await nativeFixture([], {onChange: state => busy.push(state.busy)});
  native.running = true;
  native.jobs = [{id: 'pwsh-1', label: 'npm test'}];
  busy.length = 0;
  await controller.send({text: '背景跑測試'});
  await until(() => controller.state.messages.some(m => m.kind === 'native-autonomous'), 'handed over');
  assert.equal(busy.includes(false), false, 'no moment where a queued message or setting change could start');
  assert.equal(controller.state.busy, true);
  await controller.stopTurn();
  await controller.close();
});

test('jobs and turns left open by an ended DSH process are not live work', async () => {
  const home = await scratch('deepseek-orphan'),
    id = randomUUID(),
    folder = path.join(home, 'sessions', '--ws--', id);
  await mkdir(folder, {recursive: true});
  await writeFile(
    path.join(folder, 'session.v4.jsonl.zstd'),
    zstdCompressSync(
      Buffer.from(
        [
          {type: 'job/registered', seq: 10, time: 9000, data: {jobId: 'pwsh-old', label: 'killed with its process'}},
          {type: 'turn/start', seq: 11, time: 9500, data: {turn: 1}}
        ]
          .map(l => JSON.stringify(l))
          .join('\n') + '\n'
      )
    )
  );
  const all = await dshSessionState(home, id);
  assert.equal(all.running, true);
  assert.equal(all.lastSeq, 11);
  // A new process took the session after seq 11; the wall clock plays no part (times here run backwards).
  const later = await dshSessionState(home, id, {afterSeq: 11});
  assert.equal(later.running, false);
  assert.deepEqual(later.jobs, []);
});

test('a stale log read never turns an unknown result into completed', async () => {
  let release;
  const reads = [];
  const {controller, fake, native} = await nativeFixture([], {
    nativeState: () =>
      new Promise(resolve => {
        reads.push(resolve);
        release = () => resolve({...native, running: false});
      })
  });
  await controller.send({text: 'a'});
  // Answer every read until the K turn has settled.
  await until(() => {
    for (const resolve of reads.splice(0)) resolve({...native});
    return !controller.state.busy;
  }, 'the K turn settles');
  native.running = true;
  fake.agents[0].emit({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: '自主中'}});
  await until(() => reads.length > 0, 'a read is pending');
  fake.agents[0].exitNow();
  await until(() => controller.state.status === 'uncertain', 'the process ended during DSH’s own work');
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(controller.state.status, 'uncertain');
  assert.match(controller.state.error, /結果未知/u);
  for (const resolve of reads.splice(0)) resolve({...native, running: false});
});

test('closing a room during DSH’s own work leaves no log watch behind', async () => {
  const folder = await scratch('deepseek-watch');
  let reads = 0;
  const {controller, fake, native} = await nativeFixture([], {
    nativeFolder: async () => folder,
    nativeState: async () => (reads++, structuredClone(native))
  });
  await controller.send({text: 'a'});
  await settle(controller);
  native.running = true;
  fake.agents[0].emit({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: '自主中'}});
  await until(() => controller.state.busy, 'DSH works on its own');
  await new Promise(r => setTimeout(r, 30));
  const attached = reads;
  await writeFile(path.join(folder, 'session.v4.jsonl.zstd'), 'before close');
  await until(() => reads > attached, 'the log watch is attached and reads on a change');
  await controller.close();
  const before = reads;
  await writeFile(path.join(folder, 'session.v4.jsonl.zstd'), 'changed');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(reads, before, 'nothing reads the log after the room closed');
});

test('a next round that already started also keeps the room working through the handover', async () => {
  const busy = [];
  const {controller, native} = await nativeFixture([], {onChange: state => busy.push(state.busy)});
  native.running = true;
  native.open = true;
  busy.length = 0;
  await controller.send({text: '目標'});
  await until(() => controller.state.messages.some(m => m.kind === 'native-autonomous'), 'handed over');
  assert.equal(busy.includes(false), false);
  await assert.rejects(controller.send({text: 'too early'}), /請先結束或查明目前 DeepSeek 工作/);
  await controller.stopTurn();
  await controller.close();
});

test('a stop while the turn is reading DSH’s log settles the room instead of leaving it busy', async () => {
  const reads = [];
  const {controller, fake, native} = await nativeFixture([], {
    nativeState: () => new Promise(resolve => reads.push(resolve))
  });
  await controller.send({text: '背景'});
  await until(() => reads.length > 0, 'the settling turn reads the log');
  const stopping = controller.stopTurn();
  await new Promise(r => setTimeout(r, 10));
  for (const resolve of reads.splice(0)) resolve({...native, running: true, jobs: [{id: 'pwsh-1', label: 'x'}]});
  await stopping;
  await until(() => !controller.state.busy, 'the room is free after the stop');
  assert.equal(fake.agents[0].exited, true);
  assert.equal(controller.state.messages.some(m => m.kind === 'native-autonomous'), false, 'no handover after a stop');
  const pending = setInterval(() => {
    for (const resolve of reads.splice(0)) resolve({...native});
  }, 5);
  await controller.close();
  clearInterval(pending);
});

test('a slow read for one room never fills another room’s goal', async () => {
  const reads = [];
  const {controller, native} = await nativeFixture([], {
    nativeState: () => new Promise(resolve => reads.push(resolve))
  });
  const answer = setInterval(() => {
    for (const resolve of reads.splice(0)) resolve({...native});
  }, 5);
  await controller.send({text: 'a'});
  await settle(controller);
  clearInterval(answer);
  const refresh = controller.goal({refresh: true});
  await until(() => reads.length > 0, 'room A reads its log');
  const late = reads.splice(0);
  const answerB = setInterval(() => {
    for (const resolve of reads.splice(0)) resolve({...native});
  }, 5);
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  for (const resolve of late) resolve({...native, goal: {objective: 'A 房目標', status: 'active', rounds: 1, maxRounds: 256}});
  await refresh.catch(() => {});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(controller.state.goal, null, 'room B shows no goal from room A');
  clearInterval(answerB);
  await controller.close();
});

test('an older read while a turn settles never releases a room a newer read found working', async () => {
  const reads = [],
    busy = [];
  const {controller, fake, native} = await nativeFixture([], {
    nativeState: () => new Promise(resolve => reads.push(resolve)),
    onChange: state => busy.push(state.busy)
  });
  await controller.send({text: 'a'});
  await until(() => reads.length === 1, 'the settling turn reads the log');
  busy.length = 0;
  // A newer read (an update from DSH) finds a background job.
  fake.agents[0].emit({sessionUpdate: 'usage_update', used: 1, size: 2});
  await until(() => reads.length === 2, 'a newer read starts');
  const working = {...native, running: true, jobs: [{id: 'pwsh-1', label: 'x'}]};
  reads[1](working);
  await new Promise(r => setTimeout(r, 10));
  // The older read answers 'not working'; the turn reads again rather than trusting it.
  reads[0]({...native});
  await until(() => reads.length === 3, 'the settling turn reads again');
  reads[2](working);
  await until(() => controller.state.messages.some(m => m.kind === 'native-autonomous'), 'handed over');
  assert.equal(busy.includes(false), false);
  const answer = setInterval(() => {
    for (const resolve of reads.splice(3)) resolve({...native});
  }, 5);
  await controller.stopTurn();
  await controller.close();
  clearInterval(answer);
});

test('a new room needs no log boundary; an unreadable one on resume stops the send instead of counting old work as live', async () => {
  let reads = 0;
  const {controller, fake} = await nativeFixture([], {
    nativeLastSeq: async () => {
      reads++;
      throw Error('DeepSeek 原生紀錄的最後一筆無法讀取；未使用這個程序，未送出。');
    }
  });
  // A brand-new session has no earlier process, so its log (header only at first) is never read for a boundary.
  await controller.send({text: 'a'});
  await settle(controller);
  assert.equal(reads, 0);
  assert.equal(fake.calls.filter(c => c.method === 'session/prompt').length, 1);
  // A new process resuming the session reads the boundary; unreadable stops the send.
  await assert.rejects(controller.send({text: 'b', accessMode: 'read-only'}), /最後一筆無法讀取/u);
  assert.equal(reads, 1);
  assert.equal(fake.agents[1].exited, true, 'the process is not used');
  assert.equal(controller.state.busy, false);
  assert.equal(fake.calls.filter(c => c.method === 'session/prompt').length, 1);
  await controller.close();
});

test('the log boundary: none for an empty or header-only log, an error for an unreadable last record', async () => {
  const {dshLastSeq} = await import('../src/deepseek-billing.mjs');
  const home = await scratch('deepseek-lastseq'),
    id = randomUUID(),
    folder = path.join(home, 'sessions', '--ws--', id);
  assert.equal(await dshLastSeq(home, id), -1, 'no log yet');
  await mkdir(folder, {recursive: true});
  const file = path.join(folder, 'session.v4.jsonl.zstd');
  // Right after session/new the log holds only DSH's header, which has no sequence: no events yet.
  const header = `{"type":"session","version":4,"id":"${id}","cwd":"D:\\\\ws"}\n`;
  await writeFile(file, zstdCompressSync(Buffer.from(header)));
  assert.equal(await dshLastSeq(home, id), -1, 'header only');
  await writeFile(file, zstdCompressSync(Buffer.from(`${header}{"type":"turn/end"}\n`)));
  await assert.rejects(dshLastSeq(home, id), /最後一筆無法讀取/u, 'an event without a sequence is still unknown');
  await writeFile(file, zstdCompressSync(Buffer.from('{"seq":7,"type":"turn/end"}\n')));
  assert.equal(await dshLastSeq(home, id), 7);
  await writeFile(file, zstdCompressSync(Buffer.from('{"seq":7,"type":"turn/end"}\n{"seq":8,"ty')));
  await assert.rejects(dshLastSeq(home, id), /最後一筆無法讀取/u);
});

test('reads overtaken every time while a turn settles keep the room working instead of trusting a stale idle', async () => {
  const busy = [];
  let overtake = false,
    agentRef = null;
  const {controller, fake, native} = await nativeFixture([], {
    // Each read is overtaken by a newer one (DSH keeps writing), and answers 'idle'.
    nativeState: async () => {
      if (overtake) agentRef?.emit({sessionUpdate: 'usage_update', used: 1, size: 2});
      return {...native};
    },
    onChange: state => busy.push(state.busy)
  });
  agentRef = null;
  overtake = true;
  busy.length = 0;
  const sending = controller.send({text: 'a'});
  await until(() => fake.agents.length > 0, 'process started');
  agentRef = fake.agents[0];
  await sending;
  await until(() => controller.state.messages.some(m => m.kind === 'native-autonomous'), 'handed over');
  assert.equal(busy.includes(false), false, 'a stale idle never released the room');
  overtake = false;
  await until(() => !controller.state.busy, 'the log watch ends DSH’s turn once reads settle');
  await controller.close();
});

test('the owner’s DeepSeek extra rules go once, in the first turn of a new chat room', async () => {
  const f = await controllerFixture([]);
  const {controller, fake, home, root} = f;
  await mkdir(home, {recursive: true});
  await writeFile(path.join(home, 'DeepSeek額外規則.md'), '﻿\n回答一律先列重點。\n');
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  await controller.send({text: '第一句'});
  await settle(controller);
  await controller.send({text: '第二句'});
  await settle(controller);
  const prompts = () => fake.calls.filter(c => c.method === 'session/prompt').map(c => c.params.prompt.map(b => b.text).join('\n'));
  assert.match(prompts()[0], /<owner_extra_rules source="DeepSeek額外規則\.md">\n[^\n]*\n回答一律先列重點。\n<\/owner_extra_rules>/u);
  assert.doesNotMatch(prompts()[1], /owner_extra_rules/u, 'not repeated in the same room');
  // Reopening the room (a new process) does not send it again: the native history already holds it.
  const threadId = controller.state.threadId;
  await controller.close();
  await writeFile(path.join(home, 'DeepSeek額外規則.md'), '改過的規則');
  const again = createDeepSeekController({
    root,
    env: {K_DSH_HOME: home},
    dshExecutable: path.join(root, 'DeepSeek Harness.exe'),
    apiKey: async () => 'sk-test',
    openAgent: fake.openAgent,
    loginFactory: () => ({models: async () => MODELS, status: async () => ({}), prices: async () => PRICES})
  });
  await again.open({threadId, model: 'deepseek-flash'});
  await again.send({text: '重開後'});
  await settle(again);
  assert.doesNotMatch(prompts().at(-1), /owner_extra_rules/u);
  // A new room reads the current file.
  await again.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  await again.send({text: '新房'});
  await settle(again);
  assert.match(prompts().at(-1), /改過的規則/u);
  await again.close();
  // No file, or an empty one: nothing is sent.
  const {readDeepSeekExtraRules} = await import('../src/dsh-controller.mjs');
  assert.equal(await readDeepSeekExtraRules(path.join(root, 'missing')), null);
  await writeFile(path.join(home, 'DeepSeek額外規則.md'), '  \n');
  assert.equal(await readDeepSeekExtraRules(home), null);
});

test('a DeepSeek step with only thoughts and a tool call still has a reply to show them under', async () => {
  const f = await controllerFixture([
    async ({update}) => {
      update({sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: '先讀檔'}});
      update({sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read', kind: 'read', status: 'in_progress', rawInput: {file_path: 'a.txt'}});
      update({sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed'});
      return {stopReason: 'end_turn'};
    }
  ]);
  const {controller} = f;
  await controller.open({model: 'deepseek-v4-pro', effort: 'low', accessMode: 'workspace-write'});
  await controller.send({text: '讀檔'});
  await settle(controller);
  const reply = controller.state.messages.at(-1);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.groupId, controller.state.reasoning[0].groupId);
  assert.equal(controller.state.tools[0].groupId, reply.groupId);
  await controller.close();
});

test('the permission DSH pinned in a session log: its K mode, custom for another combination, none before it is pinned', async () => {
  const {dshSessionAccess} = await import('../src/deepseek-billing.mjs');
  const home = await scratch('deepseek-access'),
    id = randomUUID(),
    folder = path.join(home, 'sessions', '--ws--', id),
    file = path.join(folder, 'session.v4.jsonl.zstd');
  const write = lines => writeFile(file, zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n')));
  assert.equal(await dshSessionAccess(home, id), null, 'no log yet');
  await mkdir(folder, {recursive: true});
  await write([{type: 'session', id}]);
  assert.equal(await dshSessionAccess(home, id), null, 'header only: the process setting applies');
  const pin = (seq, mode, policy) => [
    {seq, type: 'sandbox/mode', data: {mode}},
    {seq: seq + 1, type: 'approval/policy', data: {policy}}
  ];
  await write([{type: 'session', id}, ...pin(1, 'danger-full-access', 'never')]);
  assert.equal(await dshSessionAccess(home, id), 'danger-full-access');
  await write([{type: 'session', id}, ...pin(1, 'danger-full-access', 'never'), ...pin(3, 'read-only', 'ask')]);
  assert.equal(await dshSessionAccess(home, id), 'read-only', 'the latest record wins');
  await write([{type: 'session', id}, ...pin(1, 'workspace-write', 'never')]);
  assert.equal(await dshSessionAccess(home, id), 'custom');
});

test('a resumed DeepSeek session is never sent under a permission other than the one DSH pinned', async () => {
  const f = await controllerFixture([]);
  const {controller, fake, home} = f;
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'danger-full-access', permissionConfirmed: true});
  await controller.send({text: 'a'});
  await settle(controller);
  const prompts = () => fake.calls.filter(c => c.method === 'session/prompt');
  const id = prompts()[0].params.sessionId,
    folder = path.join(home, 'sessions', '--ws--', id);
  await mkdir(folder, {recursive: true});
  await writeFile(
    path.join(folder, 'session.v4.jsonl.zstd'),
    zstdCompressSync(
      Buffer.from(
        [
          {type: 'session', id},
          {seq: 0, type: 'permission/preset', data: {preset: 'danger-full-access'}},
          {seq: 1, type: 'sandbox/mode', data: {mode: 'danger-full-access'}},
          {seq: 2, type: 'approval/policy', data: {policy: 'never'}}
        ]
          .map(l => JSON.stringify(l))
          .join('\n') + '\n'
      )
    )
  );
  // DSH would keep full access whatever the new process says: K refuses rather than show read-only.
  await assert.rejects(controller.send({text: 'b', accessMode: 'read-only'}), /固定為「完整存取權」.*未送出/u);
  assert.equal(prompts().length, 1);
  assert.equal(controller.state.busy, false);
  assert.equal(controller.state.accessMode, 'danger-full-access', 'the room keeps the permission it really has');
  await controller.send({text: 'c'});
  await settle(controller);
  assert.equal(prompts().length, 2);
  await controller.close();
});

test('a DSH escalation names only the call id: K shows the call it already received, and rejects one it never saw', async () => {
  const answers = [];
  const f = await controllerFixture([
    async ({update, ask}) => {
      update({sessionUpdate: 'tool_call', toolCallId: 't1', title: 'pwsh', kind: 'other', status: 'pending', rawInput: {command: 'Set-Content C:/x.txt 1'}});
      answers.push(await ask({toolCallId: 't1'}));
      answers.push(await ask({toolCallId: 'never-seen'}));
      // Only a completion notice arrived: no name, no input, nothing to show.
      update({sessionUpdate: 'tool_call_update', toolCallId: 'u1', status: 'completed'});
      answers.push(await ask({toolCallId: 'u1'}));
      return {stopReason: 'end_turn'};
    },
    async ({update, ask}) => {
      // `t1` belongs to the previous turn, and `x-t1` only ends like it: neither is this call.
      update({sessionUpdate: 'tool_call', toolCallId: 'x-t1', title: 'pwsh', kind: 'other', status: 'pending', rawInput: {command: 'other'}});
      answers.push(await ask({toolCallId: 't1'}));
      return {stopReason: 'end_turn'};
    }
  ]);
  const {controller} = f;
  await controller.open({model: 'deepseek-flash', effort: 'low', accessMode: 'workspace-write'});
  await controller.send({text: 'a'});
  for (let i = 0; i < 200 && !controller.state.questions.length; i++) await new Promise(r => setTimeout(r, 5));
  const question = controller.state.questions[0];
  assert.equal(question.details.toolName, 'pwsh');
  assert.equal(question.details.command, 'Set-Content C:/x.txt 1');
  await controller.answer({id: question.id, accept: true});
  await settle(controller);
  await controller.send({text: 'b'});
  await settle(controller);
  assert.deepEqual(answers.map(a => a.outcome.optionId), ['allow-once', 'reject-once', 'reject-once', 'reject-once']);
  assert.equal(controller.state.questions.length, 0);
  await controller.close();
});
