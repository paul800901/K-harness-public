// Self-host wiring for Colab rows with a mock Colab adapter and mock upstream:
// no Colab, OAuth, GPU, LM Studio, network or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {loadGemmaConnections} from '../src/gemma-main.mjs';

const CALLER = {thread: 'test-room', turn: 'test-turn'};
const source = {
  registryId: 'cloud-test',
  repository: 'publisher/model-GGUF',
  revision: 'c'.repeat(40),
  files: [
    {path: 'model-bf16.gguf', bytes: 10, sha256: 'd'.repeat(64), role: 'weight'},
    {path: 'sub/mmproj.gguf', bytes: 2, sha256: 'e'.repeat(64), role: 'weight'}
  ]
};
const colabEntry = {id: 'colab-test', label: 'Test BF16', location: 'colab', model: 'test-bf16', source};

async function rootWith(settings) {
  const root = await mkdtemp(path.join(scratchBase, 'colab-selfhost-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(path.join(root, '.runtime/gemma-main.json'), JSON.stringify(settings));
  return root;
}
const noNetwork = async url => {
  throw new Error(`unexpected network call ${url}`);
};
const post = async (connection, extra = {}, caller = CALLER) => {
  const config = connection.configOverrides().find(item => item.startsWith('model_providers.k_gemma='));
  return fetch(`${JSON.parse(config.match(/base_url=("[^"]+")/u)[1])}/responses`, {
    method: 'POST',
    headers: {
      Authorization: JSON.parse(config.match(/Authorization=("[^"]+")/u)[1]),
      'x-codex-turn-metadata': JSON.stringify({thread_id: caller.thread, turn_id: caller.turn})
    },
    body: JSON.stringify({model: connection.nativeModel(connection.model), input: [], tools: [], ...extra})
  });
};

test('unconfigured Colab rows are listed by location, not selectable, and never reach the network', async () => {
  const root = await rootWith({
    local: {},
    selfHosted: [{id: 'qwen', label: 'Qwen Q4', location: 'local', model: 'qwen'}, colabEntry]
  });
  const connections = await loadGemmaConnections(root, {fetchImpl: noNetwork});
  try {
    const rows = (await Promise.all(connections.map(c => c.models()))).flatMap(result => result.models);
    assert.deepEqual(
      rows.map(row => [row.model, row.location, row.displayName]),
      [
        ['gemma-local/gemma-4-12b-it-qat', 'local', 'Gemma 4 12B IT QAT · Q4_0 · 本機'],
        ['selfhost-qwen/qwen', 'local', 'Qwen Q4 · 本機'],
        ['selfhost-colab-test/test-bf16', 'colab', 'Test BF16 · Colab 雲端']
      ]
    );
    assert.deepEqual(
      connections.filter(c => c.retired).map(c => c.slot),
      ['cloud'],
      'the cancelled SSH route is never listed'
    );
    const colab = rows.at(-1);
    assert.equal(colab.runtimeStatus, 'unconfigured');
    assert.equal(colab.available, false);
    assert.match(colab.description, /Colab 未設定/);
    assert.match(colab.description, /publisher\/model-GGUF@ccccccc/);
    const connection = connections.find(c => c.slot === 'selfhost-colab-test');
    await connection.prepare(); // opening a room: local bridge only
    const response = await post(connection);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'k_selfhost_colab_unconfigured');
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});

test('a Colab entry needs a pinned publisher source and no endpoint of its own', async () => {
  for (const entry of [
    {...colabEntry, source: undefined},
    {...colabEntry, source: {...source, revision: 'main'}},
    {...colabEntry, source: {...source, repository: 'publisher/..'}},
    {...colabEntry, source: {...source, files: [{path: '../x.gguf', bytes: 1, sha256: 'd'.repeat(64)}]}},
    {...colabEntry, source: {...source, files: [{path: 'x.gguf', bytes: 1, sha256: 'short'}]}},
    {...colabEntry, baseUrl: 'http://127.0.0.1:18080/v1'}
  ]) {
    const connections = await loadGemmaConnections(await rootWith({selfHosted: [entry]}), {fetchImpl: noNetwork});
    const [row] = (await connections[0].models()).models;
    assert.equal(row.available, false);
    assert.match(row.description, /設定無效/);
    assert.deepEqual(
      connections.map(c => c.slot),
      ['local', 'cloud'],
      'only the invalid-setting placeholder and the retired SSH slot remain'
    );
  }
});

// A mock Colab adapter with the colab-runtime contract; the relay answers in one piece.
function mockClient(calls, relayed) {
  return {
    authState: () => 'signed-in',
    async ready() {
      calls.push('ready');
    },
    account: async () => 'owner@example.com',
    async createRuntime({runtimeId}) {
      calls.push('create');
      return {name: `runtimes/${runtimeId}`};
    },
    async getRuntime(name) {
      calls.push('get');
      return calls.includes('delete') ? null : {name};
    },
    async deleteRuntime() {
      calls.push('delete');
    },
    async serve({model, source: pinned, contextWindow}) {
      calls.push(`serve ${model} ${pinned.revision.slice(0, 3)} ${contextWindow}`);
      return {
        async respond(bodyText) {
          relayed.push(JSON.parse(bodyText));
          return Response.json({
            id: 'resp_1',
            status: 'completed',
            output: [{type: 'message', id: 'm1', role: 'assistant', content: [{type: 'output_text', text: '你好'}]}]
          });
        }
      };
    },
    async endpoint() {
      throw new Error('not reused in this test');
    },
    async describe() {
      calls.push('describe');
      return {auth: {state: 'signed-in', email: 'owner@example.com'}};
    }
  };
}
// The owner's separate approval to create runtimes, bound to the account.
const approvedColab = {account: 'owner@example.com', allowRuntimeCreation: true};
async function colabConnection(calls, relayed, colab = approvedColab) {
  const connections = await loadGemmaConnections(await rootWith({selfHosted: [colabEntry], colab}), {
    colabClientFactory: () => mockClient(calls, relayed),
    fetchImpl: noNetwork
  });
  return {connections, connection: connections.find(c => c.slot === 'selfhost-colab-test')};
}

test('listing and opening never touch Colab; a send creates and relays, K close releases only its own', async () => {
  const calls = [],
    relayed = [];
  const {connections, connection} = await colabConnection(calls, relayed);
  try {
    const [row] = (await connection.models()).models;
    assert.equal(row.runtimeStatus, 'idle');
    assert.equal(row.available, true);
    await connection.prepare();
    assert.deepEqual(calls, [], 'listing, selecting and opening a room start nothing');
    const response = await post(connection);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).output[0].content[0].text, '你好');
    assert.equal(relayed[0].model, 'test-bf16');
    assert.equal(relayed[0].stream, false, 'the runtime relay always answers in one piece');
    assert.equal((await connection.models()).models[0].runtimeStatus, 'ready');
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
  assert.deepEqual(calls, ['ready', 'create', 'serve test-bf16 ccc 32768', 'delete', 'get']);
});

test('a streaming native request gets SSE frames rebuilt from the relayed result', async () => {
  const calls = [],
    relayed = [];
  const {connections, connection} = await colabConnection(calls, relayed);
  try {
    await connection.prepare();
    const response = await post(connection, {stream: true});
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const text = await response.text();
    assert.match(text, /event: response.output_item.done/);
    assert.match(text, /event: response.completed\ndata: .*"status":"completed"/);
    assert.match(text, /你好/);
    assert.equal(relayed[0].stream, false);
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});

test('after colab_stop K answers the native continuation itself: no acquire, no new runtime', async () => {
  const calls = [],
    relayed = [];
  const {connections, connection} = await colabConnection(calls, relayed);
  try {
    await connection.prepare();
    await (await post(connection)).text();
    assert.equal((await connection.colabTools.status()).runtime.state, 'ready');
    const stopped = await connection.colabTools.stop(CALLER);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.readback, 'gone');
    const before = [...calls];
    const continuation = await post(connection, {
      stream: true,
      input: [
        {type: 'message', role: 'user', content: [{type: 'input_text', text: '結束'}]},
        {type: 'function_call', namespace: 'mcp__k_gemini', name: 'colab_stop', arguments: '{}', call_id: 'c1'},
        {type: 'function_call_output', call_id: 'c1', output: JSON.stringify(stopped)}
      ]
    });
    const text = await continuation.text();
    assert.match(text, /讀回確認已不存在/);
    assert.match(text, /event: response.completed/);
    assert.deepEqual(calls, before, 'the local reply never reaches Colab or the model');
    assert.equal(relayed.length, 1);
    assert.equal((await connection.models()).models[0].runtimeStatus, 'idle');
    // A new human message is a new real request: only then may Colab start again.
    await (
      await post(connection, {input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: '再開'}]}]})
    ).text();
    assert.equal(calls.filter(call => call === 'create').length, 2);
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});

test('colab_stop alongside another tool still ends the turn locally; a new human message does not', async () => {
  const calls = [],
    relayed = [];
  const {connections, connection} = await colabConnection(calls, relayed);
  try {
    await connection.prepare();
    const stopped = await connection.colabTools.stop(CALLER);
    const before = calls.length;
    const parallel = await post(connection, {
      input: [
        {type: 'message', role: 'user', content: [{type: 'input_text', text: '存檔後結束'}]},
        {type: 'function_call', namespace: 'mcp__k_gemini', name: 'colab_stop', arguments: '{}', call_id: 'a'},
        {type: 'function_call', name: 'shell', arguments: '{}', call_id: 'b'},
        {type: 'function_call_output', call_id: 'a', output: JSON.stringify(stopped)},
        {type: 'function_call_output', call_id: 'b', output: 'ok'}
      ]
    });
    assert.match((await parallel.json()).output[0].content[0].text, /沒有需要關閉的項目/);
    assert.equal(calls.length, before, 'no Colab call for the continuation');
    const later = await post(connection, {
      input: [
        {type: 'function_call', namespace: 'mcp__k_gemini', name: 'colab_stop', arguments: '{}', call_id: 'a'},
        {type: 'function_call_output', call_id: 'a', output: '{}'},
        {type: 'message', role: 'user', content: [{type: 'input_text', text: '新的問題'}]}
      ]
    });
    await later.text();
    assert.equal(relayed.length, 1, 'a new human message is a real request');
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});

test('colab_status is local by default and never starts anything', async () => {
  const calls = [];
  const {connections, connection} = await colabConnection(calls, []);
  try {
    const status = await connection.colabTools.status();
    assert.deepEqual(status.runtime, {state: 'idle', name: null});
    assert.equal(status.auth.email, 'owner@example.com');
    assert.deepEqual(calls, ['describe']);
    const manual = await connection.colabTools.status({balance: true});
    assert.equal(manual.balance.state, 'manual');
    assert.equal(manual.balance.officialUrl, 'https://colab.research.google.com/signup');
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});

test('a stop receipt is scoped to its native room, turn and tool call; stale receipt cannot claim success', async () => {
  const calls = [],
    relayed = [];
  const {connections, connection} = await colabConnection(calls, relayed);
  try {
    await connection.prepare();
    const stopped = await connection.colabTools.stop(CALLER);
    const input = call_id => [
      {type: 'function_call', namespace: 'mcp__k_gemini', name: 'colab_stop', arguments: '{}', call_id},
      {type: 'function_call_output', call_id, output: JSON.stringify(stopped)}
    ];
    for (const caller of [
      {...CALLER, thread: 'other'},
      {...CALLER, turn: 'other'}
    ]) {
      const body = await (await post(connection, {input: input('c1')}, caller)).text();
      assert.match(body, /沒有取得 K 的關閉收據/);
      assert.doesNotMatch(body, /沒有需要關閉的項目/);
    }
    assert.match(await (await post(connection, {input: input('c1')})).text(), /沒有需要關閉的項目/);
    assert.match(await (await post(connection, {input: input('different-call')})).text(), /沒有取得 K 的關閉收據/);
    await connection.colabTools.stop(CALLER);
    assert.match(await (await post(connection, {input: input('c1')})).text(), /沒有取得 K 的關閉收據/);
    assert.equal(relayed.length, 0);
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});
