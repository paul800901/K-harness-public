import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {loadGemmaConnections} from '../src/gemma-main.mjs';
import {modelProvider, gemmaConnection, usesCodexCore} from '../shared/model-provider.mjs';
import {availableWorkerModels} from '../src/worker-policy.mjs';

test('a disabled local model configuration never registers an active local route', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'disabled-model-'));
  await mkdir(path.join(root, '.runtime'));
  for (const local of [null, false]) {
    await writeFile(path.join(root, '.runtime/gemma-main.json'), JSON.stringify({local}));
    const connections = await loadGemmaConnections(root);
    assert.ok(connections.every(connection => connection.retired));
  }
});

test('only the installed local Dolphin route extends native and upstream idle waiting', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'dolphin-idle-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(
    path.join(root, '.runtime/gemma-main.json'),
    JSON.stringify({
      local: {},
      selfHosted: [
        {id: 'dolphin-mistral-24b-venice', label: 'Dolphin', location: 'local', model: 'dolphin'},
        {id: 'qwen', label: 'Qwen', location: 'local', model: 'qwen'},
        {id: 'other', label: 'Other', location: 'local', model: 'other'}
      ]
    })
  );
  const calls = [];
  const makeFetch = route => async () => {
    calls.push(route);
    return Response.json({output: []});
  };
  const connections = await loadGemmaConnections(root, {
    fetchImpl: makeFetch('normal'),
    dolphinFetchImpl: makeFetch('dolphin')
  });
  const live = connections.filter(c => !c.retired);
  try {
    await Promise.all(live.map(c => c.prepare()));
    for (const connection of live) {
      const config = connection.configOverrides().find(s => s.startsWith('model_providers.k_gemma='));
      const dolphin = connection.slot === 'selfhost-dolphin-mistral-24b-venice';
      assert.equal(config.includes('stream_idle_timeout_ms=1200000,'), dolphin);
      assert.doesNotMatch(config, /max_retries/);
      const response = await fetch(`${JSON.parse(config.match(/base_url=("[^"]+")/u)[1])}/responses`, {
        method: 'POST',
        headers: {Authorization: JSON.parse(config.match(/Authorization=("[^"]+")/u)[1])},
        body: JSON.stringify({model: connection.nativeModel(connection.model), input: [], tools: []})
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.deepEqual(calls, ['normal', 'dolphin', 'normal', 'normal']);
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
  // The same saved ID on the cancelled SSH cloud route is retired: not listed, never
  // prepared, and not redirected to the local Dolphin (or any other) route.
  await writeFile(
    path.join(root, '.runtime/gemma-main.json'),
    JSON.stringify({
      local: {},
      selfHosted: [{id: 'dolphin-mistral-24b-venice', label: 'Dolphin', location: 'cloud', model: 'dolphin'}]
    })
  );
  const retired = await loadGemmaConnections(root, {fetchImpl: async () => assert.fail('no request')});
  const old = retired.find(c => c.slot === 'selfhost-dolphin-mistral-24b-venice');
  assert.equal(old.retired, true);
  assert.equal(old.prepare, undefined);
  assert.deepEqual((await old.models()).models, []);
  assert.throws(() => old.nativeModel('selfhost-dolphin-mistral-24b-venice/dolphin'), /已取消.*不會啟動/u);
  assert.deepEqual(
    retired.map(c => [c.slot, c.retired === true]),
    [
      ['local', false],
      ['selfhost-dolphin-mistral-24b-venice', true],
      ['cloud', true]
    ]
  );
});

test('a fresh install lists no self-hosted model until the person adds one', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'gemma-fresh-'));
  const connections = await loadGemmaConnections(root, {fetchImpl: async () => assert.fail('no request')});
  try {
    const rows = (await Promise.all(connections.map(c => c.models()))).flatMap(result => result.models);
    assert.deepEqual(rows, []);
  } finally {
    await Promise.all(connections.map(c => c.close?.()));
  }
});

test('an offline LM Studio keeps the managed local model selectable without waking it', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'managed-offline-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(
    path.join(root, '.runtime/gemma-main.json'),
    JSON.stringify({
      localRuntime: {executable: path.resolve('lms-test.exe')},
      selfHosted: [{id: 'qwen', label: 'Qwen', location: 'local', model: 'qwen', contextWindow: 32768}]
    })
  );
  let acquired = 0;
  const connections = await loadGemmaConnections(root, {
    localRuntimeFactory: () => ({
      async close() {},
      async catalog() {
        return {models: [], offline: true};
      },
      async acquire() {
        acquired++;
      }
    })
  });
  try {
    const qwen = connections.find(c => c.slot === 'selfhost-qwen');
    const [entry] = (await qwen.models()).models;
    assert.equal(entry.available, true);
    assert.match(entry.description, /目前無法連上 LM Studio/u);
    assert.equal(acquired, 0);
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});

test('K manages local loading only on an inference request, shares one runtime, and keeps other loopback servers unmanaged', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'managed-local-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(
    path.join(root, '.runtime/gemma-main.json'),
    JSON.stringify({
      local: {},
      localRuntime: {executable: path.resolve('lms-test.exe')},
      selfHosted: [
        {id: 'qwen', label: 'Qwen', location: 'local', model: 'qwen', contextWindow: 32768},
        {
          id: 'other-port',
          label: 'Other',
          location: 'local',
          model: 'gemma-4-12b-qat-bf16',
          baseUrl: 'http://127.0.0.1:18080/v1'
        }
      ]
    })
  );
  const leases = [],
    calls = [];
  let factories = 0;
  const connections = await loadGemmaConnections(root, {
    localRuntimeFactory({executable}) {
      factories++;
      assert.equal(executable, path.resolve('lms-test.exe'));
      return {
        async close() {
          throw Error('synthetic local engine shutdown failure');
        },
        async catalog() {
          return {
            models: [
              {type: 'llm', key: 'gemma-4-12b-it-qat'},
              {type: 'llm', key: 'qwen'}
            ]
          };
        },
        async acquire(options) {
          const lease = {
            options,
            model: options.instanceId,
            finish(result) {
              lease.finished = result;
            }
          };
          leases.push(lease);
          return lease;
        }
      };
    },
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      if (url.endsWith('/models')) return Response.json({data: [{id: 'gemma-4-12b-qat-bf16'}]});
      return Response.json({output: [{type: 'message', content: []}]});
    }
  });
  const [local, qwen, other] = connections;
  assert.equal(factories, 1);
  assert.equal((await local.models()).models[0].available, true);
  assert.equal((await qwen.models()).models[0].available, true);
  assert.equal((await other.models()).models[0].available, true);
  await Promise.all([local, qwen, other].map(c => c.prepare()));
  assert.equal(leases.length, 0, 'listing and opening rooms must not load a model');
  const request = async (connection, model) => {
    const config = connection.configOverrides().find(value => value.startsWith('model_providers.k_gemma='));
    return fetch(`${JSON.parse(config.match(/base_url=("[^"]+")/u)[1])}/responses`, {
      method: 'POST',
      headers: {Authorization: JSON.parse(config.match(/Authorization=("[^"]+")/u)[1])},
      body: JSON.stringify({model, input: 'synthetic test', stream: false})
    });
  };
  try {
    const wrong = await request(qwen, 'other');
    assert.equal(wrong.status, 400);
    await wrong.text();
    assert.equal(leases.length, 0);
    for (const connection of [qwen, local, qwen, other]) {
      const model = connection.nativeModel(connection.model);
      const response = await request(connection, model);
      assert.equal(response.status, 200);
      await response.json();
    }
    assert.equal(leases.length, 3, 'each local response acquires the selected model, including an existing room');
    assert.deepEqual(
      leases.map(l => l.options.model),
      ['qwen', 'gemma-4-12b-it-qat', 'qwen']
    );
    assert(leases.every(l => l.options.contextWindow === 32768 && l.finished.settled === true));
    assert.equal(JSON.parse(calls.find(c => c.url.endsWith('/responses')).options.body).model, 'k-selfhost-qwen');
    assert.equal(JSON.parse(calls.at(-1).options.body).model, 'gemma-4-12b-qat-bf16');
  } finally {
    await Promise.all(connections.map(c => c.close()));
  }
});

test('two self-hosted endpoints have distinct native homes, honest availability and no fabricated GPT capabilities', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'gemma-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(
    path.join(root, '.runtime/gemma-main.json'),
    JSON.stringify({
      local: {},
      selfHosted: [
        {id: 'other', label: 'Other', location: 'local', model: 'other', baseUrl: 'http://127.0.0.1:18080/v1'}
      ]
    })
  );
  const urls = [];
  const connections = await loadGemmaConnections(root, {
    fetchImpl: async url => {
      urls.push(url);
      if (url.includes('18080')) throw new Error('server not running');
      return {ok: true, json: async () => ({data: [{id: 'gemma-4-12b-it-qat'}]})};
    }
  });
  const [local, other, sshSlot] = connections;
  assert.notEqual(local.home, other.home);
  const localRow = (await local.models()).models[0];
  assert.equal(localRow.available, true);
  assert.equal(localRow.displayName, 'Gemma 4 12B IT QAT · Q4_0 · 本機');
  assert.equal((await other.models()).models[0].available, false);
  assert.deepEqual(localRow.supportedReasoningEfforts, []);
  assert.deepEqual(localRow.serviceTiers, []);
  assert.equal(modelProvider(local.model), 'gemma');
  // A saved room of the cancelled SSH route keeps its self-hosted provider (never opened
  // as a GPT room) and is refused without starting anything.
  assert.equal(gemmaConnection('gemma-cloud/gemma-4-12b-qat-bf16'), 'cloud');
  assert.equal(modelProvider('gemma-cloud/gemma-4-12b-qat-bf16'), 'gemma');
  assert.equal(sshSlot.slot, 'cloud');
  assert.throws(() => sshSlot.nativeModel('gemma-cloud/gemma-4-12b-qat-bf16'), /自管 SSH 雲端路線已取消/u);
  assert.equal(usesCodexCore('gemma'), true);
  assert.equal(modelProvider('gemini-3.8-flash'), 'gemini');
  assert.throws(() => local.nativeModel(other.model), /不符/);
  assert.equal(availableWorkerModels([localRow]).length, 0);
  assert.throws(() => local.configOverrides(), /尚未準備完成/);
  await local.prepare();
  const entry = JSON.parse(await readFile(path.join(local.home, 'model-catalog.json'), 'utf8')).models[0];
  assert.equal(entry.slug, 'gemma-4-12b-it-qat');
  assert.equal(entry.context_window, 32768);
  assert.equal(entry.use_responses_lite, false);
  assert.equal(
    local.configOverrides().some(x => x.includes('requires_openai_auth=false')),
    true
  );
  assert.deepEqual(urls, ['http://127.0.0.1:1234/v1/models', 'http://127.0.0.1:18080/v1/models']);
  await local.close();
  assert.throws(() => local.configOverrides(), /尚未準備完成/);
  await local.prepare();
  assert(local.configOverrides().some(value => value.includes('http_headers={Authorization=')));
  await local.close();
});

test('Gemma missing model is unavailable; a local ID may include a namespace and cancellation is not swallowed', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'gemma-config-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(path.join(root, '.runtime/gemma-main.json'), JSON.stringify({local: {model: 'google/gemma-custom'}}));
  const connections = await loadGemmaConnections(root, {
    fetchImpl: async () => ({ok: true, json: async () => ({data: []})})
  });
  assert.equal(connections[0].nativeModel('gemma-local/google/gemma-custom'), 'google/gemma-custom');
  const [row] = (await connections[0].models()).models;
  assert.match(row.description, /未提供模型/);
  // The verified Q4_0 name is shown only for the registry-checked default key.
  assert.equal(row.displayName, 'Gemma 4 · google/gemma-custom · 本機');
  const cancelled = await loadGemmaConnections(root, {
    fetchImpl: async () => {
      throw new Error('aborted');
    }
  });
  await assert.rejects(cancelled[0].models({signal: AbortSignal.abort()}), /abort/i);
});

test('self-hosted community models get stable IDs, own homes and real names while Gemma defaults stay unchanged', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'selfhost-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(
    path.join(root, '.runtime/gemma-main.json'),
    JSON.stringify({
      local: {},
      selfHosted: [
        {id: 'qwen-a', label: 'Qwen3.8 27B Abliterated', location: 'local', model: 'qwen3.8-27b-abliterated'},
        {id: 'mistral-b', label: 'Dolphin Mistral 24B', location: 'local', model: 'dolphin', contextWindow: 16384}
      ]
    })
  );
  const connections = await loadGemmaConnections(root, {
    fetchImpl: async () => ({ok: true, json: async () => ({data: [{id: 'qwen3.8-27b-abliterated'}]})})
  });
  const [local, qwen, mistral, sshSlot] = connections;
  assert.equal(local.model, 'gemma-local/gemma-4-12b-it-qat');
  assert.equal(local.home, path.join(root, '.runtime', 'gemma-local-home'));
  assert.deepEqual([sshSlot.slot, sshSlot.retired, sshSlot.home], ['cloud', true, undefined]);
  assert.equal(qwen.model, 'selfhost-qwen-a/qwen3.8-27b-abliterated');
  assert.equal(qwen.home, path.join(root, '.runtime', 'selfhost-qwen-a-home'));
  const live = [local, qwen, mistral];
  assert.equal(new Set(live.map(c => c.home)).size, 3);
  assert.equal(new Set(connections.map(c => c.slot)).size, 4);
  assert.deepEqual(
    live.map(c => gemmaConnection(c.model)),
    live.map(c => c.slot)
  );
  assert.equal(modelProvider(qwen.model), 'gemma');
  assert.throws(() => qwen.nativeModel(mistral.model), /不符/);
  assert.equal(qwen.nativeModel(qwen.model), 'qwen3.8-27b-abliterated');
  const qwenRow = (await qwen.models()).models[0];
  assert.equal(qwenRow.displayName, 'Qwen3.8 27B Abliterated · 本機');
  assert.equal(qwenRow.available, true);
  assert.doesNotMatch(qwenRow.displayName, /Gemma/);
  assert.equal((await mistral.models()).models[0].available, false);
  assert.equal(availableWorkerModels([qwenRow]).length, 0);
  await Promise.all([qwen.prepare(), mistral.prepare()]);
  const entry = JSON.parse(await readFile(path.join(mistral.home, 'model-catalog.json'), 'utf8')).models[0];
  assert.equal(entry.slug, 'dolphin');
  assert.equal(entry.display_name, 'Dolphin Mistral 24B · 本機');
  assert.equal(entry.context_window, 16384);
  const route = c => c.configOverrides().find(x => x.startsWith('model_providers.k_gemma='));
  assert.notEqual(route(qwen), route(mistral));
  assert(qwen.configOverrides().includes('model="qwen3.8-27b-abliterated"'));
  await Promise.all([qwen.close(), mistral.close()]);
  for (const selfHosted of [
    [
      {id: 'dup', label: 'A', location: 'local', model: 'a'},
      {id: 'dup', label: 'B', location: 'local', model: 'b'}
    ],
    [{id: 'x', label: 'X', location: 'mars', model: 'x'}],
    [{id: 'Bad ID', label: 'X', location: 'local', model: 'x'}],
    [{id: 'x', label: 'X', location: 'local', model: 'x', baseUrl: 'https://example.com/v1'}],
    [{id: 'x', location: 'local', model: 'x'}],
    [{id: 'x'.repeat(64), label: 'X', location: 'local', model: 'm'.repeat(190)}]
  ]) {
    await writeFile(path.join(root, '.runtime/gemma-main.json'), JSON.stringify({selfHosted}));
    const fallback = await loadGemmaConnections(root, {fetchImpl: async () => assert.fail('no request')});
    assert.deepEqual(
      fallback.map(c => c.slot),
      ['local', 'cloud']
    );
    assert.equal((await fallback[0].models()).models[0].available, false);
  }
});
