// Lifecycle/transport failure injections only; all remote and model actions mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {createColabRuntime} from '../src/colab-runtime.mjs';
import {createColabAdapter} from '../src/colab-adapter.mjs';
import {createColabMcp} from '../src/colab-mcp.mjs';
import {openGemmaResponses} from '../src/gemma-responses.mjs';

const source = {
  repository: 'pub/repo',
  revision: 'c'.repeat(40),
  quantization: 'BF16',
  files: [{path: 'm.gguf', bytes: 1, sha256: 'd'.repeat(64)}]
};
const A = {thread: 'A', turn: '1'},
  B = {thread: 'B', turn: '1'};
function fixture(options = {}) {
  const calls = [],
    runtimes = new Set();
  const client = {
    authState: () => 'signed-in',
    account: async () => 'o@example.com',
    ready: async () => {},
    async createRuntime({runtimeId}) {
      const name = `runtimes/${runtimeId}`;
      calls.push('create');
      runtimes.add(name);
      return {name};
    },
    async getRuntime(name) {
      calls.push('get');
      return runtimes.has(name) ? {name} : null;
    },
    async deleteRuntime(name) {
      calls.push('delete');
      runtimes.delete(name);
    },
    serve: async () => ({respond: async () => Response.json({status: 'completed', output: []})}),
    endpoint: async () => ({respond: async () => Response.json({status: 'completed', output: []})})
  };
  return {
    calls,
    runtimes,
    client,
    manager: createColabRuntime({client, allowCreate: true, account: 'o@example.com', ...options})
  };
}
test('unknown inference is write-ahead recorded; same turn and restart do not infer or create again', async () => {
  const file = path.join(await mkdtemp(path.join(scratchBase, 'unknown-turn-')), 'journal.json');
  const f = fixture({stateFile: file});
  const lease = await f.manager.acquire({model: 'm', source, caller: A});
  const sent = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(sent.run, 'unsettled');
  assert.deepEqual(sent.caller, A);
  await lease.finish({settled: false});
  await assert.rejects(f.manager.acquire({model: 'm', source, caller: A}), {code: 'k_selfhost_inference_unknown'});
  const restarted = createColabRuntime({
    client: f.client,
    stateFile: file,
    journal: {record: sent},
    allowCreate: true,
    account: 'o@example.com'
  });
  await assert.rejects(restarted.acquire({model: 'm', source, caller: A}), {code: 'k_selfhost_inference_unknown'});
  assert.deepEqual(f.calls, ['create']);
  const later = await restarted.acquire({model: 'm', source, caller: {...A, turn: '2'}});
  await later.finish();
  assert.deepEqual(f.calls, ['create', 'delete', 'get', 'create']);
  await restarted.close();
});
test('failed inference journal write refuses before inference', async () => {
  const file = path.join(await mkdtemp(path.join(scratchBase, 'inference-journal-')), 'journal.json');
  const f = fixture({stateFile: file});
  const first = await f.manager.acquire({model: 'm', source, caller: A});
  await first.finish();
  await rm(file);
  await mkdir(file);
  await assert.rejects(f.manager.acquire({model: 'm', source, caller: A}), /未送出推論/);
  assert.equal(f.calls.filter(x => x === 'create').length, 1);
});
test('another native turn holds the shared runtime through tools; stale release cannot remove a newer holder', async () => {
  const f = fixture();
  await (await f.manager.acquire({model: 'm', source, caller: A})).finish();
  assert.equal((await f.manager.stop(B)).readback, 'not-attempted');
  await assert.rejects(f.manager.acquire({model: 'other', source, caller: B}), {code: 'k_selfhost_busy'});
  f.manager.release({...A, turn: 'old'});
  assert.equal((await f.manager.stop(B)).busy, true);
  f.manager.release(A);
  assert.equal((await f.manager.stop(B)).readback, 'gone');
  assert.equal(f.calls.filter(x => x === 'delete').length, 1);
  await f.manager.close();
});
test('cancelling one room preserves another holder and blocks unknown inference replay', async () => {
  const f = fixture();
  await (await f.manager.acquire({model: 'm', source, caller: A})).finish();
  const b = await f.manager.acquire({model: 'm', source, caller: B});
  await b.finish({settled: false, cancelled: true});
  assert.equal(f.calls.includes('delete'), false);
  await assert.rejects(f.manager.acquire({model: 'm', source, caller: B}), {code: 'k_selfhost_inference_unknown'});
  f.manager.release(A);
  f.manager.release(B);
  await f.manager.close();
  assert.equal(f.calls.filter(x => x === 'delete').length, 1);
});
for (const mode of ['499', '429', '400', 'both'])
  test(`uncertain ${mode} reply cannot clear a create journal or authorize a replacement`, async () => {
    let creates = 0;
    const rpc = createColabMcp({
      accessToken: async () => 'MOCK',
      fetchImpl: async (url, init) => {
        const req = JSON.parse(init.body);
        creates++;
        return mode === 'both'
          ? Response.json({
              jsonrpc: '2.0',
              id: req.id,
              result: {structuredContent: {}},
              error: {code: -32602, message: 'contradictory'}
            })
          : new Response('unknown gateway outcome', {status: Number(mode)});
      }
    });
    const f = fixture();
    f.client.createRuntime = async args => rpc.call('create_runtime', args);
    await assert.rejects(f.manager.acquire({model: 'm', source, caller: A}), {code: 'k_selfhost_state_unknown'});
    await assert.rejects(f.manager.acquire({model: 'm', source, caller: A}), /不能證明建立已終止/);
    assert.equal(creates, 1);
  });
test('terminal query validates both probe execution and the step record, including echoed IDs', async () => {
  for (const kind of ['valid', 'wrong-probe', 'wrong-step', 'missing-step']) {
    let queries = 0;
    // Use the real MCP client so an unknown step error follows the production path.
    const rpc = createColabMcp({
      accessToken: async () => 'MOCK',
      fetchImpl: async (url, init) => {
        const req = JSON.parse(init.body),
          args = req.params.arguments,
          id = args.code.match(/\nk_state\("([^"]+)"\)/u)?.[1];
        if (!id)
          return Response.json({
            jsonrpc: '2.0',
            id: req.id,
            result: {isError: true, content: [{type: 'text', text: 'lost result'}]}
          });
        queries++;
        const record = {
          state: 'done',
          out: ['K_HEALTH ok'],
          ...(kind === 'missing-step' ? {} : {id: kind === 'wrong-step' ? 'other' : id})
        };
        return Response.json({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            structuredContent: {
              executionId: kind === 'wrong-probe' ? 'other' : args.executionId,
              stdout: `K_STATE ${JSON.stringify(record)}\n`
            }
          }
        });
      }
    });
    const a = createColabAdapter({auth: {state: () => 'signed-in'}, mcp: rpc, sleep: async () => {}});
    if (kind === 'valid') {
      assert.equal(typeof (await a.endpoint({name: 'runtimes/k-1'})).respond, 'function');
      assert.equal(queries, 1);
    } else {
      await assert.rejects(a.endpoint({name: 'runtimes/k-1'}), /結果不明/);
      assert.equal(queries, 5);
    }
  }
});
test('retryable upstream status and unknown relay are 400; diagnostics redact before truncation', async () => {
  for (const status of [409, 429, 502]) {
    const bridge = await openGemmaResponses('http://unused.invalid', {
      acquireModel: async () => ({
        model: 'm',
        upstream: {respond: async () => new Response('x'.repeat(285) + 'ya29.SENTINEL_MUST_NOT_LEAK', {status})},
        finish: async () => {}
      })
    });
    try {
      const response = await fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        headers: bridge.headers,
        body: JSON.stringify({model: 'm', input: [], tools: []})
      });
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /ya29|SENTINEL/);
    } finally {
      await bridge.close();
    }
  }
});

test('an opaque runtime token in an error body is removed before native diagnostic truncation', async () => {
  const token = 'OPAQUE_RUNTIME_SECRET_SENTINEL';
  const adapter = createColabAdapter({
    auth: {state: () => 'signed-in'},
    mcp: {
      async call(name, args) {
        if (name === 'get_runtime')
          return {
            name: args.name,
            connectionInfo: {
              url: 'https://runtime.example/proxy',
              token,
              expireTime: new Date(Date.now() + 3600000).toISOString()
            }
          };
        if (name === 'execute_code')
          return {stdout: args.code.includes('\nk_health(') ? 'K_HEALTH ok\n' : 'K_DONE ok\n'};
        throw new Error('unexpected ' + name);
      }
    },
    fetchImpl: async (url, init) =>
      init.method === 'PUT' ? Response.json({}) : Response.json({status: 502, body: 'x'.repeat(285) + token})
  });
  const upstream = await adapter.endpoint({name: 'runtimes/k-1'});
  const bridge = await openGemmaResponses('http://unused.invalid', {
    acquireModel: async () => ({model: 'm', upstream, finish: async () => {}})
  });
  try {
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: 'POST',
      headers: bridge.headers,
      body: JSON.stringify({model: 'm', input: [], tools: []})
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /OPAQUE|SENTINEL/);
  } finally {
    await bridge.close();
    adapter.close();
  }
});
