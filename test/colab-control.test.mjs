// Colab control pieces with mocks only: no Google, OAuth, Colab, GPU, model or
// browser. Tokens are fixed sentinels that must never appear in errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {createColabMcp, ColabError} from '../src/colab-mcp.mjs';
import {createColabAuth} from '../src/colab-auth.mjs';
import {createColabAdapter, colabPlan, chooseSpec, LLAMA_CPP_COMMIT} from '../src/colab-adapter.mjs';
import {createLunaGateway} from '../src/luna-gateway.mjs';

const SECRET = 'ya29.MOCK_ACCESS_TOKEN_MUST_NOT_LEAK';
const PROXY = 'MOCK_PROXY_TOKEN_MUST_NOT_LEAK';
const leaks = error =>
  JSON.stringify({...error, message: error?.message, stack: error?.stack}).includes('MUST_NOT_LEAK');

// ---- MCP client ----------------------------------------------------------------
function mcpWith(handler) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({url, headers: init.headers, body, signal: init.signal});
    return handler(body, init);
  };
  return {mcp: createColabMcp({accessToken: async () => SECRET, fetchImpl}), requests};
}

test('MCP calls carry the 2025-11-25 headers and bearer, and return structured content', async () => {
  const {mcp, requests} = mcpWith(body =>
    Response.json({jsonrpc: '2.0', id: body.id, result: {structuredContent: {tier: 'SUBSCRIPTION_TIER_PRO'}}})
  );
  assert.deepEqual(await mcp.call('get_subscription'), {tier: 'SUBSCRIPTION_TIER_PRO'});
  const [{url, headers, body}] = requests;
  assert.equal(url, 'https://colaboratory.googleapis.com/mcp');
  assert.equal(headers.authorization, `Bearer ${SECRET}`);
  assert.equal(headers['mcp-protocol-version'], '2025-11-25');
  assert.equal(headers['mcp-method'], 'tools/call');
  assert.equal(headers['mcp-name'], 'get_subscription');
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'get_subscription');
});

test('MCP SSE answers skip progress notifications and return the matching result', async () => {
  const progress = [];
  const {mcp} = mcpWith(
    body =>
      new Response(
        `data: ${JSON.stringify({jsonrpc: '2.0', method: 'notifications/progress', params: {progressToken: body.params._meta.progressToken, progress: 1, message: 'out'}})}\n\n` +
          `data: ${JSON.stringify({jsonrpc: '2.0', id: body.id, result: {structuredContent: {stdout: 'K_DONE\n'}}})}\n\n`,
        {headers: {'content-type': 'text/event-stream'}}
      )
  );
  assert.deepEqual(await mcp.call('execute_code', {code: 'x'}, {onProgress: p => progress.push(p.message)}), {
    stdout: 'K_DONE\n'
  });
  assert.deepEqual(progress, ['out']);
});

test('MCP failures are classified without leaking the bearer token', async () => {
  const cases = [
    [() => new Response('', {status: 401}), {definitive: false, auth: true}],
    [() => new Response(`quota ${SECRET}`, {status: 429}), {definitive: false}],
    [() => new Response('', {status: 503}), {definitive: false}],
    [() => Promise.reject(new Error(`socket closed Bearer ${SECRET}`)), {definitive: false}],
    [
      b =>
        Response.json({
          jsonrpc: '2.0',
          id: b.id,
          result: {isError: true, content: [{type: 'text', text: 'RESOURCE_EXHAUSTED: rate'}]}
        }),
      // A tool error carries no structured status: its wording never classifies it.
      {definitive: false, auth: false, refused: undefined, retryable: undefined}
    ],
    [
      b =>
        Response.json({
          jsonrpc: '2.0',
          id: b.id,
          result: {isError: true, content: [{type: 'text', text: 'NOT_FOUND runtime'}]}
        }),
      // Error text never proves "gone": only a well-formed listing does.
      {definitive: false, refused: undefined, retryable: undefined}
    ],
    [
      b =>
        Response.json({
          jsonrpc: '2.0',
          id: b.id,
          result: {isError: true, content: [{type: 'text', text: 'DEADLINE_EXCEEDED'}]}
        }),
      {definitive: false, retryable: undefined}
    ],
    [
      b =>
        Response.json({jsonrpc: '2.0', id: b.id, result: {isError: true, content: [{type: 'text', text: 'internal'}]}}),
      {definitive: false}
    ],
    [b => Response.json({jsonrpc: '2.0', id: b.id, error: {code: -32602, message: 'bad params'}}), {definitive: true}],
    [
      b => Response.json({jsonrpc: '2.0', id: b.id, error: {code: -32000, message: 'ALREADY_EXISTS'}}),
      {definitive: false}
    ],
    // Envelopes that do not answer this request are unknown, never an empty success.
    [() => Response.json({jsonrpc: '2.0', id: 'wrong', result: {structuredContent: {}}}), {malformed: true}],
    [b => Response.json({jsonrpc: '2.0', id: b.id}), {malformed: true}],
    [b => Response.json({id: b.id, result: {structuredContent: {}}}), {malformed: true}],
    [b => Response.json({jsonrpc: '2.0', id: b.id, result: []}), {malformed: true}],
    [
      b => Response.json({jsonrpc: '2.0', id: b.id, result: {content: [{type: 'text', text: 'done'}]}}),
      {malformed: true}
    ],
    [b => Response.json({jsonrpc: '2.0', id: b.id, result: {content: []}}), {malformed: true}]
  ];
  for (const [handler, expected] of cases) {
    const {mcp} = mcpWith(handler);
    await assert.rejects(mcp.call('create_runtime', {}), error => {
      assert(error instanceof ColabError);
      for (const [key, value] of Object.entries(expected))
        assert.equal(error[key], value, `${key} for ${error.message}`);
      assert.equal(leaks(error), false);
      return true;
    });
  }
});

test('cancelling an MCP call sends notifications/cancelled for the same request id', async () => {
  const {mcp, requests} = mcpWith((body, init) =>
    body.method === 'notifications/cancelled'
      ? new Response(null, {status: 202})
      : new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true})
        )
  );
  const abort = new AbortController();
  const pending = mcp.call('execute_code', {code: 'x'}, {signal: abort.signal});
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  await new Promise(resolve => setImmediate(resolve));
  const cancel = requests.find(r => r.body.method === 'notifications/cancelled');
  assert.equal(cancel.body.params.requestId, requests[0].body.id);
});

// ---- OAuth (helper mocked) -----------------------------------------------------
async function authFixture({responses, account = null, client = true}) {
  const root = await mkdtemp(path.join(scratchBase, 'colab-auth-'));
  await mkdir(path.join(root, '.runtime'));
  if (client) await writeFile(path.join(root, '.runtime', 'colab-oauth-client.json'), '{"installed":{}}');
  const runs = [],
    opened = [];
  const execImpl = (file, args) => {
    const operation = args[args.indexOf('-Operation') + 1];
    const run = {operation, args, input: undefined};
    runs.push(run);
    const promise = Promise.resolve({stdout: JSON.stringify(responses[operation]?.(run) ?? {error: 'unknown'})});
    return Object.assign(promise, {child: {stdin: {end: text => (run.input = text ? JSON.parse(text) : undefined)}}});
  };
  let now = 1_000_000;
  const auth = createColabAuth({root, account, openUrl: async url => opened.push(url), execImpl, clock: () => now});
  return {auth, runs, opened, root, advance: ms => (now += ms)};
}

test('without the owner OAuth client file K reports no-client and never starts a helper', async () => {
  const {auth, runs} = await authFixture({responses: {}, client: false});
  assert.equal(auth.state(), 'no-client');
  assert.deepEqual(runs, []);
});

test('access tokens come only from the helper, are cached until near expiry, and a signed-out helper is reported', async () => {
  let signedOut = false;
  const {auth, runs, advance} = await authFixture({
    responses: {
      access: () =>
        signedOut ? {error: 'signed_out'} : {accessToken: SECRET, expiresIn: 3600, email: 'owner@example.com'}
    }
  });
  assert.equal(await auth.accessToken(), SECRET);
  assert.equal(await auth.accessToken(), SECRET);
  assert.equal(runs.length, 1, 'cached');
  assert.equal(auth.state(), 'signed-in');
  advance(3600 * 1000);
  signedOut = true;
  await assert.rejects(auth.accessToken(), error => error.code === 'k_selfhost_colab_signin' && !leaks(error));
  assert.equal(auth.state(), 'signed-out');
  assert(
    runs.every(run => run.args.includes('-ClientFile')),
    'the helper reads the client file; Node never does'
  );
});

test('an expected account mismatch from a saved login is refused before any Colab call', async () => {
  const {auth} = await authFixture({
    account: 'owner@example.com',
    responses: {access: () => ({accessToken: SECRET, expiresIn: 3600, email: 'other@example.com'})}
  });
  await assert.rejects(auth.accessToken(), /不是指定的 owner@example.com/);
});

test('consent opens only the official URL with PKCE and finishes through the loopback callback', async () => {
  const {auth, runs, opened} = await authFixture({
    account: 'owner@example.com',
    responses: {
      status: () => ({client: true, clientId: 'k.apps.googleusercontent.com', signedIn: false}),
      exchange: () => ({accessToken: SECRET, expiresIn: 3600, email: 'owner@example.com'})
    }
  });
  assert.deepEqual(await auth.beginLogin(), {opened: true, waiting: true});
  assert.deepEqual(await auth.beginLogin(), {opened: false, waiting: true}, 'one consent window at a time');
  const url = new URL(opened[0]);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = Object.fromEntries(url.searchParams);
  assert.equal(q.client_id, 'k.apps.googleusercontent.com');
  assert.equal(q.scope, 'https://www.googleapis.com/auth/colaboratory openid email');
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.login_hint, 'owner@example.com');
  assert.match(q.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
  assert.equal((await fetch(`${q.redirect_uri}?state=wrong&code=c`)).status, 404, 'a foreign state is ignored');
  const page = await fetch(`${q.redirect_uri}?state=${q.state}&code=the-code&iss=https://accounts.google.com`);
  assert.match(await page.text(), /已授權 owner@example.com/);
  const exchange = runs.find(run => run.operation === 'exchange');
  assert.equal(exchange.input.code, 'the-code');
  assert.equal(exchange.input.redirectUri, q.redirect_uri);
  assert.equal(exchange.input.expectedAccount, 'owner@example.com');
  assert.match(exchange.input.verifier, /^[\w-]{43}$/u);
  assert.equal(auth.state(), 'signed-in');
  assert.equal(await auth.accessToken(), SECRET);
  auth.close();
});

test('a consent by the wrong account is not saved', async () => {
  const {auth, opened} = await authFixture({
    account: 'owner@example.com',
    responses: {
      status: () => ({client: true, clientId: 'k.apps.googleusercontent.com', signedIn: false}),
      exchange: () => ({error: 'account_mismatch', email: 'other@example.com'})
    }
  });
  await auth.beginLogin();
  const q = Object.fromEntries(new URL(opened[0]).searchParams);
  const page = await (await fetch(`${q.redirect_uri}?state=${q.state}&code=c`)).text();
  assert.match(page, /other@example.com 不是指定的 Colab 帳號/);
  assert.equal(auth.state(), 'signed-out');
});

// ---- Adapter (MCP + runtime files mocked) --------------------------------------
const gguf = {
  repository: 'pub/model-GGUF',
  revision: 'c'.repeat(40),
  quantization: 'BF16',
  files: [
    {path: 'model-bf16-00001-of-00002.gguf', bytes: 20e9, sha256: 'd'.repeat(64)},
    {path: 'model-bf16-00002-of-00002.gguf', bytes: 20e9, sha256: 'e'.repeat(64)},
    {path: 'mmproj-bf16.gguf', bytes: 1e9, sha256: 'f'.repeat(64)}
  ]
};
const tensors = {
  repository: 'pub/model',
  revision: 'a'.repeat(40),
  quantization: 'BF16',
  files: [
    {path: 'config.json', bytes: 1000, sha256: '1'.repeat(64)},
    {path: 'model-00001-of-00002.safetensors', bytes: 9e9, sha256: '2'.repeat(64)},
    {path: 'model-00002-of-00002.safetensors', bytes: 9e9, sha256: '3'.repeat(64)}
  ]
};
const spec = (accelerator, shape = 'SHAPE_STANDARD', eligible = true, variant = 'VARIANT_GPU') => ({
  key: {variant, accelerator, shape},
  eligible
});

test('the engine plan is decided before any runtime exists and never lowers precision', () => {
  const plan = colabPlan(gguf);
  assert.equal(plan.kind, 'gguf');
  assert.equal(
    plan.main,
    'model-bf16-00001-of-00002.gguf',
    'split GGUF loads from the first part; mmproj is not the model'
  );
  assert.equal(colabPlan(tensors).outtype, 'bf16');
  for (const bad of [
    {
      ...gguf,
      files: [
        gguf.files[2],
        {path: 'a.gguf', bytes: 1, sha256: 'a'.repeat(64)},
        {path: 'b.gguf', bytes: 1, sha256: 'b'.repeat(64)}
      ]
    },
    {...tensors, quantization: 'Q8_0'},
    {...tensors, files: tensors.files.slice(1)},
    {...tensors, files: [...tensors.files, gguf.files[0]]}
  ])
    assert.throws(
      () => colabPlan(bad),
      error => error.definitive === true && /未建立 runtime/.test(error.message)
    );
});

test('runtime specs: smallest eligible GPU that fits, high-memory preferred, unknown or ineligible never chosen', () => {
  const specs = [
    spec('A100', 'SHAPE_HIGHMEM', false),
    spec('H100'),
    spec('H100', 'SHAPE_HIGHMEM'),
    spec('G4'),
    spec('X9'),
    spec('NONE', 'SHAPE_STANDARD', true, 'VARIANT_CPU')
  ];
  assert.deepEqual(chooseSpec(specs, 50), {variant: 'VARIANT_GPU', accelerator: 'H100', shape: 'SHAPE_HIGHMEM'});
  assert.equal(chooseSpec(specs, 90).accelerator, 'G4');
  assert.equal(chooseSpec(specs, 120), null);
});

// The invocation of a step K sends (its own line inside k_step(…, lambda: (…))).
const invocationOf = code => code.split('\n').at(-3);
// The executionId a read-only k_state probe asks about, or undefined.
const probeOf = code => code.match(/\nk_state\("([^"]+)"\)\n$/u)?.[1];
const stateAnswer = (value, id) => ({stdout: `K_STATE ${JSON.stringify({...value, id})}\n`});

test('GGUF downloads and installs CUDA once in detached jobs before starting the model', async () => {
  const jobs = new Map();
  const reads = new Map();
  const steps = [];
  const {adapter} = adapterFixture({
    files(url) {
      const id = url.match(/\/state\/([^/]+)\.json$/u)?.[1];
      assert.ok(jobs.has(id), 'read state for the launched job only');
      const read = (reads.get(id) ?? 0) + 1;
      reads.set(id, read);
      if (read === 5) return Response.json({id, state: 'running'});
      if (read < 10) return new Response(null, {status: 404});
      return Response.json({id, state: 'done', out: [jobs.get(id)]});
    },
    execute({code, executionId}) {
      assert.equal(probeOf(code), undefined, 'regular preparation reads do not execute code');
      const launch = code
        .split('\n')
        .at(-2)
        .match(/^k_launch\("([^"]+)", (".*")\)$/u);
      if (launch) {
        assert.equal(launch[1], executionId);
        assert.equal(jobs.has(executionId), false);
        const command = invocationOf(JSON.parse(launch[2]));
        const fetch = command.startsWith('k_fetch(');
        if (!fetch) assert.match(command, /^k_engine\("[0-9a-f]+", True\)$/u);
        steps.push(fetch ? 'fetch' : 'engine');
        jobs.set(executionId, fetch ? 'K_FETCHED d' : 'K_ENGINE b12532');
        return {stdout: ''};
      }
      const command = invocationOf(code);
      steps.push(command.replace(/\(.*$/u, ''));
      return {stdout: command.startsWith('k_start(') ? 'K_READY m\n' : ''};
    }
  });
  await adapter.serve({name: 'runtimes/k-1', model: 'm', source: gguf, contextWindow: 8192});
  assert.deepEqual(steps, ['k_prepare', 'fetch', 'engine', 'k_start']);
  assert.deepEqual([...reads.values()], [10, 10], 'a valid read breaks a sequence of unavailable reads');
});

test('pinned Venice 1.2 at 48K fits L4 using Q8 KV and sends that exact engine option', async () => {
  const source = {
    ...gguf,
    files: [{
      path: 'Dolphin-Mistral-24B-Venice-Edition-Q4_K_M.gguf',
      bytes: 14333923104,
      sha256: '1c76a921c568b5f652c2a5d87d5b051abb1cb8519ceec32b673b766a47b4e9f1'
    }]
  };
  const launches = [];
  const starts = [];
  const {adapter} = adapterFixture({
    specs: [spec('L4'), spec('A100')],
    files(url) {
      return Response.json({id: url.match(/\/state\/([^/]+)\.json$/u)[1], state: 'done', out: []});
    },
    execute({code}) {
      const command = invocationOf(code);
      if (command?.startsWith('k_start(')) {
        starts.push(command);
        return {stdout: 'K_READY m\n'};
      }
      if (code.split('\n').at(-2)?.startsWith('k_launch(')) launches.push(code);
      return {stdout: ''};
    }
  });
  const contextWindow = 49152;
  const plan = await adapter.planRuntime({source, contextWindow});
  assert.equal(plan.runtimeSpec.accelerator, 'L4');
  await adapter.serve({name: 'runtimes/k-1', model: 'm', source, contextWindow});
  const different = {...source, files: [{...source.files[0], sha256: '0'.repeat(64)}]};
  assert.equal((await adapter.planRuntime({source: different, contextWindow})).runtimeSpec.accelerator, 'A100');
  await adapter.serve({name: 'runtimes/k-2', model: 'm', source: different, contextWindow});
  assert.equal(launches.length, 4);
  assert.match(starts[0], /, "m", 49152, True\)$/u);
  assert.match(starts[1], /, "m", 49152\)$/u);
});

test('unverifiable detached process is bounded even when its last file says running', async t => {
  t.mock.timers.enable({apis: ['Date']});
  let checks = 0;
  const {adapter} = adapterFixture({
    sleep: async () => t.mock.timers.tick(180000),
    files(url) {
      return Response.json({id: url.match(/\/state\/([^/]+)\.json$/u)[1], state: 'running'});
    },
    execute({code}) {
      if (probeOf(code)) {
        checks++;
        throw new ColabError('HTTP 429');
      }
      assert(!code.includes('\nk_start('));
      return {stdout: ''};
    }
  });
  await assert.rejects(
    adapter.serve({name: 'runtimes/k-1', model: 'm', source: gguf, contextWindow: 8192}),
    /無法確認背景準備程序仍在執行/
  );
  assert.equal(checks, 2);
});

function adapterFixture({specs = [spec('H100', 'SHAPE_HIGHMEM')], execute, files, sleep = async () => {}} = {}) {
  const calls = [],
    transfers = [];
  let signedIn = true;
  const auth = {
    state: () => (signedIn ? 'signed-in' : 'signed-out'),
    async accessToken() {
      if (!signedIn) throw Object.assign(new Error('signed out'), {code: 'k_selfhost_colab_signin'});
      return SECRET;
    },
    invalidate() {},
    async beginLogin() {
      calls.push(['beginLogin']);
      return {opened: true};
    },
    async refreshStatus() {
      return {client: true, signedIn, email: 'owner@example.com'};
    },
    email: () => 'owner@example.com',
    clientFile: 'x'
  };
  const runtime = name => ({
    name,
    connectionInfo: {
      url: 'https://runtime.example/proxy',
      token: PROXY,
      expireTime: new Date(Date.now() + 3600e3).toISOString()
    }
  });
  const mcp = {
    async call(name, args, options) {
      calls.push([name, args, options?.signal]);
      if (name === 'list_runtime_specs') return {runtimeSpecs: specs};
      if (name === 'get_subscription') return {tier: 'SUBSCRIPTION_TIER_PRO'};
      if (name === 'create_runtime') return runtime(`runtimes/${args.runtimeId}`);
      if (name === 'get_runtime') return runtime(args.name);
      if (name === 'list_runtimes') return {runtimes: [runtime('runtimes/k-1'), runtime('runtimes/external')]};
      if (name === 'delete_runtime') return {};
      if (name === 'execute_code')
        return execute
          ? execute(args)
          : {
              stdout: /k_start|k_relay|k_health/.test(invocationOf(args.code)) ? 'K_READY m\nK_DONE\nK_HEALTH ok\n' : ''
            };
      throw new Error(`unexpected ${name}`);
    }
  };
  const fetchImpl = async (url, init) => {
    transfers.push({url, method: init.method, token: init.headers['X-Colab-Runtime-Proxy-Token'], body: init.body});
    if (files) return files(url, init);
    if (init.method === 'PUT') return new Response(null, {status: 201});
    return new Response(JSON.stringify({status: 200, body: JSON.stringify({output: []})}));
  };
  const adapter = createColabAdapter({mcp, auth, fetchImpl, sleep});
  return {adapter, calls, transfers, signOut: () => (signedIn = false)};
}

test('ready() opens the consent page when signed out and makes no Colab call', async () => {
  const {adapter, calls, signOut} = adapterFixture();
  signOut();
  await assert.rejects(
    adapter.ready(),
    error => error.code === 'k_selfhost_colab_signin' && /授權頁/.test(error.message)
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ['beginLogin']
  );
});

test('create refuses before create_runtime when no eligible GPU fits, otherwise sends K name, UUID4 requestId and spec', async () => {
  const small = adapterFixture({specs: [spec('L4')]});
  await assert.rejects(
    small.adapter.createRuntime({runtimeId: 'k-0123456789abcdef', source: gguf}),
    error => error.definitive === true && /不會自動降精度/.test(error.message)
  );
  assert.equal(
    small.calls.some(([name]) => name === 'create_runtime'),
    false
  );
  const {adapter, calls} = adapterFixture();
  assert.deepEqual(await adapter.createRuntime({runtimeId: 'k-0123456789abcdef', source: gguf}), {
    name: 'runtimes/k-0123456789abcdef'
  });
  const [, args] = calls.find(([name]) => name === 'create_runtime');
  assert.equal(args.runtimeId, 'k-0123456789abcdef');
  assert.match(args.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(args.runtime, {runtimeSpec: {variant: 'VARIANT_GPU', accelerator: 'H100', shape: 'SHAPE_HIGHMEM'}});
});

test('presence comes from a well-formed list_runtimes only; delete uses allowMissing', async () => {
  const {adapter, calls} = adapterFixture();
  const abort = new AbortController();
  assert.deepEqual(await adapter.getRuntime('runtimes/k-1', {signal: abort.signal}), {name: 'runtimes/k-1'});
  assert.deepEqual(calls.at(-1).slice(0, 2), ['list_runtimes', {}]);
  assert.equal(calls.at(-1)[2], abort.signal, 'the readback is cancellable');
  assert.equal(await adapter.getRuntime('runtimes/k-2'), null, 'a listing without the name is "gone"');
  await adapter.deleteRuntime('runtimes/k-1');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['delete_runtime', {name: 'runtimes/k-1', allowMissing: true}]);
  const auth = {state: () => 'signed-in', accessToken: async () => SECRET, invalidate() {}};
  const listing = value => createColabAdapter({mcp: {call: async () => value}, auth});
  assert.equal(await listing({runtimes: []}).getRuntime('runtimes/k-1'), null, 'an explicit empty list');
  // proto3 JSON omits an empty repeated field and the official schema does not require it.
  assert.equal(await listing({}).getRuntime('runtimes/k-1'), null, 'an omitted empty list');
  for (const bad of [
    {runtimes: 'x'},
    {runtimes: null},
    {runtimes: [{}]},
    {other: []},
    {name: 'runtimes/k-1'},
    {runtimes: [], name: 'runtimes/k-1'},
    {runtimes: [{name: 1}]}
  ])
    await assert.rejects(listing(bad).getRuntime('runtimes/k-1'), {malformed: true}, JSON.stringify(bad));
  for (const error of [
    new ColabError('Colab 回報錯誤：NOT_FOUND runtime'),
    new ColabError('無法連上 Colab'),
    new ColabError('Colab 回應格式不符', {malformed: true})
  ]) {
    const failing = createColabAdapter({
      mcp: {
        async call() {
          throw error;
        }
      },
      auth
    });
    await assert.rejects(failing.getRuntime('runtimes/k-1'), error, 'a failed readback is never treated as gone');
  }
});

test('serve sends each pinned step once in a named session; an unknown step outcome is read from its record, never resent', async () => {
  const seen = [],
    probes = [];
  let fetchId;
  const {adapter} = adapterFixture({
    execute(args) {
      const asked = probeOf(args.code);
      if (asked) {
        probes.push({...args, asked});
        // Still running at the first look, then terminal with the step's markers.
        return stateAnswer(
          probes.length === 1 ? {state: 'running', pid: 7} : {state: 'done', out: ['K_FETCHED d']},
          asked
        );
      }
      seen.push({...args, raw: args.code, code: invocationOf(args.code)});
      if (args.code.includes('\nk_fetch(')) {
        fetchId = args.executionId;
        throw new ColabError('Colab 回報錯誤：DEADLINE_EXCEEDED');
      }
      return {stdout: args.code.includes('\nk_start(') ? 'K_READY m\n' : ''};
    }
  });
  const transport = await adapter.serve({name: 'runtimes/k-1', model: 'm', source: tensors, contextWindow: 8192});
  assert.equal(typeof transport.respond, 'function');
  assert.deepEqual(
    seen.map(s => s.code.replace(/\(.*$/u, '')),
    ['k_prepare', 'k_fetch', 'k_engine', 'k_convert', 'k_start'],
    'the failed k_fetch is not sent again'
  );
  assert.equal(new Set(seen.map(s => s.executionId)).size, 5, 'each distinct step has its own executionId');
  assert(seen.every(s => s.session === 'runtimes/k-1/sessions/k-serve'));
  assert(
    seen.every(s => s.raw.includes(`\nk_step(${JSON.stringify(s.executionId)}, lambda: (\n`)),
    'recorded per executionId'
  );
  assert.equal(probes.length, 2);
  assert(probes.every(p => p.asked === fetchId && p.session === 'runtimes/k-1/sessions/k-state'));
  assert(
    probes.every(p => p.executionId !== fetchId),
    'a probe is its own execution, not a reattach'
  );
  assert.match(seen[2].code, new RegExp(LLAMA_CPP_COMMIT));
  assert.match(seen[1].code, /huggingface|json\.loads/);
  assert.match(seen[3].code, /"bf16"/);
  assert.match(seen[4].code, /\.bf16\.gguf", "m", 8192\)/);
});

test('respond uploads the request, relays once, downloads the result; the proxy token stays in headers', async () => {
  const {adapter, transfers, calls} = adapterFixture();
  const transport = await adapter.endpoint({name: 'runtimes/k-1'});
  const response = await transport.respond('{"model":"m","stream":false}');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {output: []});
  assert.deepEqual(
    transfers.map(t => [t.method, t.url.replace(/[0-9a-f-]{36}/u, 'ID')]),
    [
      ['PUT', 'https://runtime.example/proxy/api/contents/content/k/req/ID.json'],
      ['GET', 'https://runtime.example/proxy/files/content/k/res/ID.json']
    ]
  );
  assert(transfers.every(t => t.token === PROXY));
  assert.deepEqual(JSON.parse(transfers[0].body), {
    type: 'file',
    format: 'text',
    content: '{"model":"m","stream":false}'
  });
  const relay = calls.filter(([name]) => name === 'execute_code').at(-1)[1];
  assert.equal(relay.session, 'runtimes/k-1/sessions/k-relay');
  assert.match(relay.code, /k_relay\("[0-9a-f-]{36}"\)/u);
});

test('no error wording, 5xx or lost answer resends a step: only its terminal record settles it, else it stays unknown', async () => {
  // Every non-definitive failure of the step call is unknown, whatever it says.
  const failures = [
    new ColabError('Colab 回報錯誤：UNAVAILABLE'),
    new ColabError('Colab 回報錯誤：INTERNAL: diagnostic mentions UNAVAILABLE; final delivery is unknown'),
    new ColabError('Colab 回報錯誤：DEADLINE_EXCEEDED'),
    new ColabError('Colab 回應中斷（terminated）'),
    new ColabError('Colab 回應 HTTP 502'),
    new ColabError('Colab 回應格式不符（id 不符）；結果不明', {malformed: true})
  ];
  const outcomes = [
    [[{state: 'done', out: ['K_HEALTH ok']}], {ok: true}],
    [
      [{state: 'failed', name: 'RuntimeError', marker: 'K_SERVER_EXITED'}],
      {step: {name: 'RuntimeError', marker: 'K_SERVER_EXITED'}}
    ],
    [[{state: 'dead'}], /kernel 已結束/],
    [[{state: 'absent'}, {state: 'claimed'}, {state: 'absent'}], /沒有完成的步驟紀錄/],
    [[null, null, null, null, null], /無法讀取步驟紀錄/]
  ];
  for (const failure of failures)
    for (const [answers, expected] of outcomes) {
      let healthCalls = 0,
        probes = 0;
      const {adapter} = adapterFixture({
        execute(args) {
          if (probeOf(args.code)) {
            const answer = answers[Math.min(probes++, answers.length - 1)];
            return answer ? stateAnswer(answer, probeOf(args.code)) : {stdout: ''};
          }
          healthCalls++;
          throw failure;
        }
      });
      const result = adapter.endpoint({name: 'runtimes/k-1'});
      if (expected.ok) assert.equal(typeof (await result).respond, 'function');
      else await assert.rejects(result, expected);
      assert.equal(healthCalls, 1, `${failure.message}: the step is sent once`);
      assert.equal(probes, answers.length, `${failure.message}: probes`);
    }
  // A refusal before anything ran is thrown at once; a result for another
  // execution is malformed. Neither reads a record nor resends.
  for (const execute of [
    () => {
      throw new ColabError('Colab 拒絕請求（HTTP 403）', {definitive: true});
    },
    () => ({stdout: 'K_HEALTH ok\n', executionId: 'someone-else'})
  ]) {
    const failing = adapterFixture({execute});
    await assert.rejects(
      failing.adapter.endpoint({name: 'runtimes/k-1'}),
      error => error.definitive || error.malformed
    );
    assert.equal(failing.calls.filter(([name]) => name === 'execute_code').length, 1);
  }
});

test('a reused-runtime health check carries the caller signal into every execute_code, including record reads', async () => {
  let probes = 0;
  const {adapter, calls} = adapterFixture({
    execute(args) {
      if (probeOf(args.code))
        return stateAnswer(
          ++probes < 3 ? {state: 'running', pid: 1} : {state: 'done', out: ['K_HEALTH ok']},
          probeOf(args.code)
        );
      throw new ColabError('Colab 回報錯誤：DEADLINE_EXCEEDED');
    }
  });
  const abort = new AbortController();
  await adapter.endpoint({name: 'runtimes/k-1', signal: abort.signal});
  assert.equal(probes, 3);
  assert(calls.filter(([name]) => name === 'execute_code').every(([, , signal]) => signal === abort.signal));
  // A cancel during the back-off before a record read ends the wait at once.
  const slow = createColabAdapter({
    mcp: {
      async call() {
        throw new ColabError('Colab 回報錯誤：DEADLINE_EXCEEDED');
      }
    },
    auth: {state: () => 'signed-in', accessToken: async () => SECRET, invalidate() {}}
  });
  const controller = new AbortController();
  const waiting = slow.endpoint({name: 'runtimes/k-1', signal: controller.signal});
  setImmediate(() => controller.abort());
  const started = Date.now();
  await assert.rejects(waiting, {name: 'AbortError'});
  assert(Date.now() - started < 1500, 'did not sit out the 2 s back-off');
});

test('a runtime step error keeps only the exception class and K marker, never its value or traceback', async () => {
  const sentinels = [
    'ya29.ACCESS_MUST_NOT_LEAK',
    '1//REFRESH_TOKEN_MUST_NOT_LEAK',
    'GOCSPX-CLIENT_MUST_NOT_LEAK',
    PROXY
  ];
  const {adapter} = adapterFixture({
    execute: () => ({
      executionError: {
        name: 'RuntimeError',
        value: `K_VERIFY_FAILED model.gguf ${sentinels.join(' ')}`,
        traceback: sentinels
      }
    })
  });
  await assert.rejects(adapter.serve({name: 'runtimes/k-1', model: 'm', source: gguf}), error => {
    assert.equal(error.message, 'Colab runtime 步驟失敗（RuntimeError K_VERIFY_FAILED）');
    assert.equal(leaks(error), false);
    return true;
  });
});

test('an unsettled relay is reported as unconfirmed, never retried under a new execution', async () => {
  let relays = 0;
  const {adapter} = adapterFixture({
    execute: args => {
      if (args.code.includes('\nk_relay(')) relays++;
      return {stdout: args.code.includes('\nk_health(') ? 'K_HEALTH ok\n' : 'K_UNSETTLED\n'};
    }
  });
  const transport = await adapter.endpoint({name: 'runtimes/k-1'});
  await assert.rejects(transport.respond('{}'), /未確認/);
  assert.equal(relays, 1);
});

test('an expired proxy token (404) is refreshed once through get_runtime, and errors never carry it', async () => {
  let puts = 0;
  const {adapter, calls} = adapterFixture({
    files: (url, init) => {
      if (init.method === 'PUT') return new Response(null, {status: ++puts === 1 ? 404 : 201});
      return new Response('nope', {status: 500});
    }
  });
  const transport = await adapter.endpoint({name: 'runtimes/k-1'});
  await assert.rejects(transport.respond('{}'), error => /HTTP 500/.test(error.message) && !leaks(error));
  assert.equal(puts, 2);
  assert.equal(calls.filter(([name]) => name === 'get_runtime').length, 2);
});

// ---- Gateway tools ---------------------------------------------------------------
test('the gateway keeps status read-only and login separately approved, and passes caller metadata', async () => {
  const bridge = {
    workerPolicy: {model: 'auto'},
    start() {},
    wait() {},
    inspect() {},
    cancel() {},
    list: async () => []
  };
  const plain = await createLunaGateway({bridge, geminiOnly: true, allowCodex: true});
  const seen = [];
  const colab = await createLunaGateway({
    bridge,
    geminiOnly: true,
    allowCodex: true,
    colab: {
      status: async (args, meta) => (seen.push(['status', args, meta?.who]), {runtime: {state: 'idle'}}),
      login: async meta => (seen.push(['login', meta?.who]), {opened: true}),
      stop: async meta => (seen.push(['stop', meta?.who]), {stopped: true, readback: 'gone', message: 'ok'})
    }
  });
  const rpc = async (gateway, method, params) => {
    const {url, headers} = gateway.mcpConfig.mcpServers.k_gemini;
    const response = await fetch(url, {
      method: 'POST',
      headers: {...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})
    });
    const text = await response.text();
    return JSON.parse(
      text
        .split('\n')
        .find(line => line.startsWith('data:'))
        ?.slice(5) ?? text
    );
  };
  try {
    const names = async gateway => (await rpc(gateway, 'tools/list', {})).result.tools.map(tool => tool.name);
    assert.equal(
      (await names(plain)).some(name => name.startsWith('colab_')),
      false
    );
    const tools = (await rpc(colab, 'tools/list', {})).result.tools;
    const stop = tools.find(tool => tool.name === 'colab_stop');
    assert.match(stop.description, /Saying goodbye is NOT a shutdown/);
    assert.equal(stop.annotations.destructiveHint, true);
    assert.equal(tools.find(tool => tool.name === 'colab_status').annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'colab_login').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'colab_login').annotations.idempotentHint, false);
    const invalid = await rpc(colab, 'tools/call', {name: 'colab_status', arguments: {signIn: true}});
    assert(invalid.error || invalid.result?.isError);
    const status = await rpc(colab, 'tools/call', {
      name: 'colab_status',
      arguments: {live: true},
      _meta: {who: 'main'}
    });
    assert.equal(status.result.structuredContent.runtime.state, 'idle');
    const balance = await rpc(colab, 'tools/call', {
      name: 'colab_status',
      arguments: {balance: true},
      _meta: {who: 'main'}
    });
    assert.equal(balance.result.structuredContent.runtime.state, 'idle');

    const login = await rpc(colab, 'tools/call', {name: 'colab_login', arguments: {}, _meta: {who: 'main'}});
    assert.equal(login.result.structuredContent.opened, true);
    const stopped = await rpc(colab, 'tools/call', {name: 'colab_stop', arguments: {}, _meta: {who: 'main'}});
    assert.equal(stopped.result.structuredContent.readback, 'gone');
    assert.deepEqual(seen, [
      ['status', {live: true}, 'main'],
      ['status', {balance: true}, 'main'],
      ['login', 'main'],
      ['stop', 'main']
    ]);
  } finally {
    await plain.close();
    await colab.close();
  }
});

test('an MTP draft or vision projector beside one main GGUF is auxiliary, not a second model; real ambiguity is still refused', () => {
  const file = (path, bytes = 1e9) => ({path, bytes, sha256: 'a'.repeat(64)});
  const hauhau = {
    repository: 'pub/Qwen3.8-27B-MTP-GGUF',
    revision: 'b'.repeat(40),
    quantization: 'Q8_K_P',
    files: [
      file('Qwen3.8-27B-Aggressive-FastMTP-32K.gguf', 9e8),
      file('Qwen3.8-27B-Aggressive-Q8_K_P.gguf', 31e9),
      file('mmproj-Qwen3.8-27B-Aggressive-BF16.gguf', 9e8),
      file('HauhauCS-FastMTP-llama.cpp.patch', 2445)
    ]
  };
  const plan = colabPlan(hauhau);
  assert.equal(plan.main, 'Qwen3.8-27B-Aggressive-Q8_K_P.gguf');
  assert.deepEqual(plan.auxiliary, [
    {path: 'mmproj-Qwen3.8-27B-Aggressive-BF16.gguf', role: 'mmproj'},
    {path: 'Qwen3.8-27B-Aggressive-FastMTP-32K.gguf', role: 'mtp'}
  ]);
  assert(plan.needGb > 32.8 * 1.1, 'auxiliary bytes stay in the conservative estimate');
  for (const files of [
    [file('a-mtp.gguf'), file('b-mtp.gguf')],
    [file('model-Q8.gguf'), file('model-Q4.gguf'), file('draft-mtp.gguf')]
  ])
    assert.throws(() => colabPlan({...hauhau, files}), /多個主要 GGUF/);
  assert.equal(colabPlan({...hauhau, files: [file('Model-MTP-Q8_0.gguf')]}).main, 'Model-MTP-Q8_0.gguf');
});

test('after K closes the Colab auth, a late consent callback is never exchanged or saved', async () => {
  const {auth, runs, opened} = await authFixture({
    responses: {
      status: () => ({client: true, clientId: 'k.apps.googleusercontent.com', signedIn: false}),
      exchange: () => ({accessToken: SECRET, expiresIn: 3600, email: 'owner@example.com'})
    }
  });
  await auth.beginLogin();
  const q = Object.fromEntries(new URL(opened[0]).searchParams);
  auth.close();
  await fetch(`${q.redirect_uri}?state=${q.state}&code=late`).catch(() => {});
  assert.equal(
    runs.some(run => run.operation === 'exchange'),
    false
  );
  await assert.rejects(auth.beginLogin(), {code: 'k_selfhost_colab_signin'});
});
