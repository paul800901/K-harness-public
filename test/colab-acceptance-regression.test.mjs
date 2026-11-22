// Regression for the nine counterexamples of the 2026-11-13 GPT-6.1 Sol acceptance
// review (.runtime/archive/colab-control-20261113/receipts/sol-review-counterexamples.mjs),
// same scenarios with the corrected expectations, plus the create-approval
// boundary. Mocks only: no OAuth, Google, Colab runtime, GPU, engine or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {createColabRuntime} from '../src/colab-runtime.mjs';
import {createColabAdapter} from '../src/colab-adapter.mjs';
import {createColabMcp} from '../src/colab-mcp.mjs';
import {openGemmaResponses} from '../src/gemma-responses.mjs';
import {loadGemmaConnections} from '../src/gemma-main.mjs';

const CALLER = {thread: 'test-room', turn: 'test-turn'};
const source = {
  repository: 'publisher/model-GGUF',
  revision: 'c'.repeat(40),
  quantization: 'BF16',
  files: [{path: 'model.gguf', bytes: 10, sha256: 'd'.repeat(64)}]
};
const auth = {state: () => 'signed-in', accessToken: async () => 'MOCK', invalidate() {}, email: () => 'o@example.com'};
const request = {model: 'm', source};
const approval = {account: 'o@example.com', allowRuntimeCreation: true};
const SENTINELS = [
  'ya29.SOL_REVIEW_FAKE_SECRET',
  '1//SOL_REVIEW_FAKE_REFRESH',
  'GOCSPX-SOL_REVIEW_FAKE_CLIENT',
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.SOL_FAKE_SIG'
];
const leaked = text => SENTINELS.some(secret => text.includes(secret));

function fakeClient(trace) {
  let present = false;
  return {
    authState: () => 'signed-in',
    ready: async () => {},
    account: async () => 'o@example.com',
    async createRuntime({runtimeId}) {
      trace.push('create');
      present = true;
      return {name: `runtimes/${runtimeId}`};
    },
    async getRuntime(name) {
      trace.push('get');
      return present ? {name} : null;
    },
    async deleteRuntime() {
      trace.push('delete');
      present = false;
    },
    serve: async () => ({respond: async () => Response.json({status: 'completed', output: []})}),
    endpoint: async () => ({respond: async () => Response.json({status: 'completed', output: []})}),
    describe: async () => ({auth: {state: 'signed-in'}})
  };
}
async function root(settings) {
  const dir = await mkdtemp(path.join(scratchBase, 'colab-acceptance-'));
  await mkdir(path.join(dir, '.runtime'));
  await writeFile(
    path.join(dir, '.runtime/gemma-main.json'),
    JSON.stringify({
      selfHosted: [{id: 'colab-test', label: 'Test BF16', location: 'colab', model: 'm', source}],
      ...settings
    })
  );
  return dir;
}
function endpointOf(connection) {
  const config = connection.configOverrides().find(item => item.startsWith('model_providers.k_gemma='));
  const url = `${JSON.parse(config.match(/base_url=("[^"]+")/u)[1])}/responses`;
  const headers = {
    Authorization: JSON.parse(config.match(/Authorization=("[^"]+")/u)[1]),
    'x-codex-turn-metadata': JSON.stringify({thread_id: CALLER.thread, turn_id: CALLER.turn})
  };
  return {
    config,
    post: body => fetch(url, {method: 'POST', headers, body: JSON.stringify({model: 'm', tools: [], ...body})})
  };
}
const unexpectedNetwork = async () => {
  throw new Error('unexpected network');
};

test('Sol 1: an unknown delete is never sent twice; stop, stop again and close only read back', async () => {
  const trace = [];
  const client = fakeClient(trace);
  client.getRuntime = async name => (trace.push('get'), {name});
  client.deleteRuntime = async () => {
    trace.push('delete');
    throw new Error('response lost');
  };
  const manager = createColabRuntime({client, allowCreate: true});
  await (await manager.acquire(request)).finish();
  assert.equal((await manager.stop()).readback, 'unknown');
  assert.equal((await manager.stop()).readback, 'unknown');
  await manager.close();
  assert.deepEqual(trace, ['create', 'delete', 'get', 'get', 'get']);
});

test('Sol 2: one not-found readback after an unknown create neither clears it nor submits a second create', async () => {
  const trace = [];
  let count = 0;
  const client = fakeClient(trace);
  client.createRuntime = async ({runtimeId}) => {
    trace.push(`create:${++count}`);
    if (count === 1) throw new Error('response lost while creation may still be pending');
    return {name: `runtimes/${runtimeId}`};
  };
  client.getRuntime = async () => (trace.push('get:null'), null);
  const manager = createColabRuntime({client, allowCreate: true});
  await assert.rejects(manager.acquire(request), /結果不明/);
  await assert.rejects(manager.acquire(request), /不能證明建立已終止/);
  assert.equal(count, 1);
  assert.deepEqual(trace, ['create:1', 'get:null']);
});

test('Sol 3: a malformed get/list success is unknown, never "gone"', async () => {
  // The reviewer's first probe was a get_runtime-shaped answer without a usable
  // name. A list answer is malformed when it is not the list schema; `{}` alone
  // is the legal proto3 empty list (second review, see the second-review file).
  for (const value of [{runtimes: [{}]}, {runtimes: null}, {name: 'runtimes/k-0123456789abcdef'}]) {
    const adapter = createColabAdapter({auth, mcp: {call: async () => value}});
    await assert.rejects(adapter.getRuntime('runtimes/k-0123456789abcdef'), {malformed: true});
  }
  // get_runtime itself (the connection refresh) still needs its own name: {} or a
  // different name there is malformed, and no transfer is attempted.
  for (const value of [{}, {name: 'runtimes/k-other'}]) {
    const adapter = createColabAdapter({
      auth,
      mcp: {call: async tool => (tool === 'get_runtime' ? value : {stdout: 'K_HEALTH ok\n'})},
      fetchImpl: unexpectedNetwork
    });
    const transport = await adapter.endpoint({name: 'runtimes/k-0123456789abcdef'});
    await assert.rejects(transport.respond('{}'), {malformed: true});
  }
});

test('Sol 4: an unmatched JSON-RPC id or an absent result is unknown, not an empty success', async () => {
  for (const reply of [
    {jsonrpc: '2.0', id: 'wrong'},
    {jsonrpc: '2.0', id: 'wrong', result: {structuredContent: {}}}
  ]) {
    const mcp = createColabMcp({
      accessToken: async () => 'MOCK',
      fetchImpl: async () => new Response(JSON.stringify(reply), {headers: {'content-type': 'application/json'}})
    });
    await assert.rejects(mcp.call('get_runtime', {name: 'runtimes/k-0123456789abcdef'}), {malformed: true});
  }
  const mcp = createColabMcp({
    accessToken: async () => 'MOCK',
    fetchImpl: async (url, init) => Response.json({jsonrpc: '2.0', id: JSON.parse(init.body).id})
  });
  await assert.rejects(mcp.call('get_runtime', {}), {malformed: true});
});

test('Sol 5: structured executionError secrets reach neither the adapter error, the diagnostic nor the Responses 400', async () => {
  const adapter = createColabAdapter({
    auth,
    mcp: {call: async () => ({executionError: {name: 'Exception', value: SENTINELS.join(' '), traceback: SENTINELS}})}
  });
  await assert.rejects(adapter.serve({name: 'runtimes/k-0123456789abcdef', model: 'm', source}), error => {
    assert.equal(leaked(JSON.stringify({...error, message: error.message, stack: error.stack})), false);
    return true;
  });
  // Even an error text that does carry token-shaped values is redacted at the boundary.
  const client = fakeClient([]);
  client.serve = async () => {
    throw new Error(`Colab runtime 執行失敗：${SENTINELS.join(' ')}`);
  };
  const manager = createColabRuntime({client, allowCreate: true});
  await assert.rejects(manager.acquire(request), error => !leaked(JSON.stringify(error.diagnostic) + error.message));
  const raw = createColabRuntime({
    client: {
      ...fakeClient([]),
      ready: async () => {
        throw new Error(`native failure ${SENTINELS.join(' ')}`);
      }
    },
    allowCreate: true
  });
  for (const acquireModel of [
    ({signal}) => manager.acquire({...request, signal}),
    ({signal}) => raw.acquire({...request, signal})
  ]) {
    const bridge = await openGemmaResponses('http://unused.invalid', {expectedModel: 'm', acquireModel});
    try {
      const response = await fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        headers: bridge.headers,
        body: JSON.stringify({model: 'm', input: [], tools: []})
      });
      assert.equal(response.status, 400);
      assert.equal(leaked(await response.text()), false);
    } finally {
      await bridge.close();
    }
  }
});

for (const [status, event, field] of [
  ['failed', 'response.failed', '"error":{"code":"server_error"}'],
  ['incomplete', 'response.incomplete', '"incomplete_details":{"reason":"max_output_tokens"}'],
  [undefined, 'response.failed', '"code":"k_selfhost_upstream_status"']
])
  test(`Sol 6: an upstream ${status ?? 'status-less'} result keeps its terminal event, never response.completed`, async () => {
    const result = {
      id: 'r',
      ...(status ? {status} : {}),
      ...(status === 'failed' ? {error: {code: 'server_error'}} : {}),
      ...(status === 'incomplete' ? {incomplete_details: {reason: 'max_output_tokens'}} : {}),
      output: []
    };
    let finished;
    const bridge = await openGemmaResponses('http://unused.invalid', {
      expectedModel: 'm',
      acquireModel: async () => ({
        model: 'm',
        upstream: {respond: async () => new Response(JSON.stringify(result))},
        finish: async options => (finished = options)
      })
    });
    try {
      const response = await fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        headers: bridge.headers,
        body: JSON.stringify({model: 'm', stream: true, input: [], tools: []})
      });
      const text = await response.text();
      assert.match(text, new RegExp(`event: ${event.replace('.', '\\.')}\\n`));
      assert.doesNotMatch(text, /event: response\.completed/);
      assert.doesNotMatch(text.split('event: ').at(-1), /"status":"completed"/);
      assert(text.includes(field), field);
      assert.equal(finished.settled, true, 'the upstream answered: nothing is left running');
    } finally {
      await bridge.close();
    }
  });

test('Sol 7: a corrupt journal is not "no record": a send is refused and nothing is created', async () => {
  const dir = await root({colab: approval});
  await writeFile(path.join(dir, '.runtime/colab-runtime.json'), '{malformed');
  const trace = [];
  const connections = await loadGemmaConnections(dir, {
    colabClientFactory: () => fakeClient(trace),
    fetchImpl: unexpectedNetwork
  });
  try {
    const connection = connections.find(c => c.slot === 'selfhost-colab-test');
    assert.equal((await connection.models()).models[0].runtimeStatus, 'unknown');
    await connection.prepare();
    const response = await endpointOf(connection).post({input: []});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'k_selfhost_state_unknown');
    assert.equal(trace.filter(x => x === 'create').length, 0);
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
  assert.equal(await readFile(path.join(dir, '.runtime/colab-runtime.json'), 'utf8'), '{malformed', 'evidence kept');
});

test('Sol 8: a denied or missing colab_stop result is reported as not closed, never with an old success', async () => {
  const dir = await root({colab: approval});
  const trace = [];
  const connections = await loadGemmaConnections(dir, {
    colabClientFactory: () => fakeClient(trace),
    fetchImpl: unexpectedNetwork
  });
  try {
    const connection = connections.find(c => c.slot === 'selfhost-colab-test');
    await connection.prepare();
    const {post} = endpointOf(connection);
    const old = await connection.colabTools.stop(CALLER);
    assert.equal(old.readback, 'none');
    await (await post({input: [{type: 'message', role: 'user', content: 'a new task'}]})).text();
    assert.deepEqual(trace, ['create']);
    const stopCall = id => ({
      type: 'function_call',
      name: 'colab_stop',
      namespace: 'mcp__k_gemini',
      call_id: id,
      arguments: '{}'
    });
    for (const output of [
      JSON.stringify({error: 'permission denied; tool callback did not execute'}),
      JSON.stringify(old) // a replayed receipt-less or stale-room output
    ]) {
      const response = await post({
        input: [
          {type: 'message', role: 'user', content: 'end now'},
          stopCall('denied-stop'),
          {type: 'function_call_output', call_id: 'denied-stop', output}
        ]
      });
      const answer = (await response.json()).output[0].content[0].text;
      // Denied (no receipt) and a stale receipt from before the new task alike.
      assert.match(answer, /沒有取得 K 的關閉收據/);
      assert.match(answer, /已就緒/);
      assert.doesNotMatch(answer, /目前沒有自己建立/);
    }
    // The stale receipt is K's real report for that earlier call, but only that call:
    // a call whose own output is missing gets no receipt at all.
    const missing = await post({
      input: [
        {type: 'message', role: 'user', content: 'end now'},
        stopCall('lost'),
        {type: 'function_call', name: 'shell', call_id: 'other', arguments: '{}'},
        {type: 'function_call_output', call_id: 'other', output: JSON.stringify(old)}
      ]
    });
    assert.match((await missing.json()).output[0].content[0].text, /沒有取得 K 的關閉收據/);
    const real = await connection.colabTools.stop(CALLER);
    assert.equal(real.readback, 'gone');
    const after = await post({
      input: [
        {type: 'message', role: 'user', content: 'end now'},
        stopCall('ok'),
        {
          type: 'function_call_output',
          call_id: 'ok',
          output: JSON.stringify({content: [{type: 'text', text: JSON.stringify(real)}]})
        }
      ]
    });
    assert.match((await after.json()).output[0].content[0].text, /讀回：gone.*讀回確認已不存在/su);
    const replayed = await post({
      input: [
        {type: 'message', role: 'user', content: 'end again'},
        stopCall('another'),
        {type: 'function_call_output', call_id: 'another', output: JSON.stringify(real)}
      ]
    });
    assert.match((await replayed.json()).output[0].content[0].text, /沒有取得 K 的關閉收據/, 'one receipt, one call');
    assert.deepEqual(trace, ['create', 'delete', 'get'], 'local replies never reach Colab');
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});

test('Sol 9: the reused-runtime health check receives the caller abort signal', async () => {
  let received;
  const adapter = createColabAdapter({
    auth,
    mcp: {
      async call(name, args, options) {
        assert.equal(name, 'execute_code');
        received = options?.signal;
        return {stdout: 'K_HEALTH ok\n'};
      }
    }
  });
  const controller = new AbortController();
  await adapter.endpoint({name: 'runtimes/k-0123456789abcdef', signal: controller.signal});
  assert.equal(received, controller.signal);
});

test('create boundary: after deployment and OAuth consent, an ordinary send creates nothing without the separate approval', async () => {
  for (const colab of [
    undefined,
    {account: 'o@example.com'},
    {account: 'o@example.com', allowRuntimeCreation: false}
  ]) {
    const trace = [];
    const connections = await loadGemmaConnections(await root(colab ? {colab} : {}), {
      colabClientFactory: () => fakeClient(trace),
      fetchImpl: unexpectedNetwork
    });
    try {
      const connection = connections.find(c => c.slot === 'selfhost-colab-test');
      const [row] = (await connection.models()).models;
      assert.match(row.description, /本人尚未允許開卡/);
      await connection.prepare();
      const response = await endpointOf(connection).post({input: [{type: 'message', role: 'user', content: 'hi'}]});
      assert.equal(response.status, 400);
      const {error} = await response.json();
      assert.equal(error.code, 'k_selfhost_colab_not_approved');
      assert.match(error.message, /不代表同意開卡/);
      const status = await connection.colabTools.status();
      assert.equal(status.createPolicy.createAllowed, false);
      assert.deepEqual(trace, []);
    } finally {
      await Promise.all(connections.map(c => c.close()));
    }
  }
  const invalid = await loadGemmaConnections(await root({colab: {allowRuntimeCreation: true}}), {
    colabClientFactory: () => fakeClient([]),
    fetchImpl: unexpectedNetwork
  });
  assert.equal(
    invalid.some(c => c.slot === 'selfhost-colab-test'),
    false,
    'approval without a bound account is an invalid setting'
  );
});

test('the Colab provider tells the native core to tolerate a long silent buffered answer', async () => {
  const connections = await loadGemmaConnections(await root({colab: approval}), {
    colabClientFactory: () => fakeClient([]),
    fetchImpl: unexpectedNetwork
  });
  try {
    const connection = connections.find(c => c.slot === 'selfhost-colab-test');
    await connection.prepare();
    assert.match(endpointOf(connection).config, /stream_idle_timeout_ms=1200000,/);
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});
