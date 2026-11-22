// Regression for the five counterexamples of the 2026-11-13 second GPT-6.1 Sol
// acceptance review (.runtime/archive/colab-control-20261113/fix/
// sol-second-review-probes.mjs): the same scenarios through the real MCP client,
// adapter and lifecycle owner, with runtime creation explicitly allowed for the
// consenting account so each path really reaches the operation. Mocks only: no
// OAuth, Google, Colab runtime, GPU, engine or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {createColabAuth} from '../src/colab-auth.mjs';
import {createColabMcp} from '../src/colab-mcp.mjs';
import {createColabAdapter} from '../src/colab-adapter.mjs';
import {createColabRuntime} from '../src/colab-runtime.mjs';
import {openGemmaResponses} from '../src/gemma-responses.mjs';

const ACCOUNT = 'o@example.com';
const source = {
  repository: 'pub/repo',
  revision: 'c'.repeat(40),
  quantization: 'BF16',
  files: [{path: 'm.gguf', bytes: 10, sha256: 'd'.repeat(64)}]
};
// An opaque proxy token: no documented format, nothing a pattern would catch.
const PROXY = 'SOL_OPAQUE_PROXY_SENTINEL_12345678';
const runtime = name => ({
  name,
  connectionInfo: {url: 'https://mock.invalid', token: PROXY, expireTime: new Date(Date.now() + 3600e3).toISOString()}
});
const auth = {state: () => 'signed-in', accessToken: async () => 'MOCK', email: () => ACCOUNT, invalidate() {}};
const SPECS = {
  runtimeSpecs: [{key: {variant: 'VARIANT_GPU', accelerator: 'H100', shape: 'SHAPE_HIGHMEM'}, eligible: true}]
};
const stateLine = (value, id) => ({stdout: `K_STATE ${JSON.stringify({...value, id})}\n`});

// A Colab MCP server mock behind the real JSON-RPC client. `tool(name, args)`
// returns a structured value, or {error: text} for an isError tool result, or
// {http: status} for a transport status.
function colab(tool, fetchImpl) {
  const trace = [];
  const mcp = createColabMcp({
    accessToken: async () => 'MOCK',
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body);
      const {name, arguments: args} = request.params;
      trace.push(name);
      const value = await tool(name, args);
      if (value?.http) return new Response('refused', {status: value.http});
      const result =
        typeof value?.error === 'string'
          ? {isError: true, content: [{type: 'text', text: value.error}]}
          : {structuredContent: value};
      return Response.json({jsonrpc: '2.0', id: request.id, result});
    }
  });
  return {trace, adapter: createColabAdapter({auth, mcp, fetchImpl, sleep: async () => {}})};
}
// Default answers for a GPU runtime that serves; `over` replaces single tools
// (returning undefined falls back to the default).
function server(over = {}) {
  let present = false;
  const preparationJobs = new Map();
  const state = {creates: 0, deletes: 0, starts: 0, name: null, present: () => present};
  const tool = async (name, args) => {
    if (name === 'execute_code') {
      if (args.code.includes('\nk_launch(')) {
        preparationJobs.set(
          args.executionId,
          args.code.includes('lambda: (\\nk_fetch(') ? 'K_FETCHED d' : 'K_ENGINE b12532'
        );
        return {stdout: ''};
      }
      const id = args.code.match(/\nk_state\("([^"]+)"\)\n$/u)?.[1];
      if (preparationJobs.has(id)) return stateLine({state: 'done', out: [preparationJobs.get(id)]}, id);
    }
    if (over[name]) {
      const value = await over[name](args, state);
      if (value !== undefined) return value;
    }
    if (name === 'get_subscription') return {tier: 'SUBSCRIPTION_TIER_PRO'};
    if (name === 'list_runtime_specs') return SPECS;
    if (name === 'create_runtime') {
      state.creates++;
      state.name = `runtimes/${args.runtimeId}`;
      present = true;
      return runtime(state.name);
    }
    if (name === 'delete_runtime') {
      state.deletes++;
      present = false;
      return {};
    }
    if (name === 'list_runtimes') return present ? {runtimes: [runtime(state.name)]} : {runtimes: []};
    if (name === 'get_runtime') return runtime(args.name);
    if (name === 'execute_code') {
      if (args.code.includes('\nk_start(')) state.starts++;
      return {stdout: args.code.includes('\nk_start(') ? 'K_READY m\n' : ''};
    }
    throw new Error(`unexpected ${name}`);
  };
  const fetchImpl = async url => {
    const id = url.match(/\/state\/([^/]+)\.json$/u)?.[1];
    return preparationJobs.has(id)
      ? Response.json({id, state: 'done', out: [preparationJobs.get(id)]})
      : new Response(null, {status: 404});
  };
  return {state, tool, fetchImpl};
}
async function stateFile(prefix) {
  return path.join(await mkdtemp(path.join(scratchBase, prefix)), 'colab-runtime.json');
}
const manager = (adapter, extra = {}) =>
  createColabRuntime({client: adapter, allowCreate: true, account: ACCOUNT, ...extra});

test('second review P1: a tool error whose text names a refusal status, plus an absent listing, never clears an unknown create', async () => {
  for (const text of [
    'UNKNOWN create result: diagnostic mentions RESOURCE_EXHAUSTED; assignment may still be pending',
    'RESOURCE_EXHAUSTED: quota',
    'TOO_MANY_ACTIVE_RUNTIMES',
    'PERMISSION_DENIED',
    'FAILED_PRECONDITION: retry later'
  ]) {
    const {state, tool, fetchImpl} = server({
      create_runtime: (args, s) => (s.creates === 0 ? (s.creates++, {error: text}) : undefined)
    });
    const {adapter, trace} = colab(tool, fetchImpl);
    const file = await stateFile('colab-second-p1-');
    const first = manager(adapter, {stateFile: file});
    await assert.rejects(first.acquire({model: 'm', source}), {code: 'k_selfhost_state_unknown'}, text);
    await assert.rejects(first.acquire({model: 'm', source}), /不能證明建立已終止/, text);
    assert.equal(state.creates, 1, `${text}: no replacement create`);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.phase, 'create-sent', `${text}: the record is kept`);
    // A restarted K reads the same record and still creates nothing.
    const restarted = manager(adapter, {stateFile: file, journal: {record: saved}});
    await assert.rejects(restarted.acquire({model: 'm', source}), /不能證明建立已終止/);
    assert.equal(state.creates, 1);
    assert.equal(trace.filter(name => name === 'create_runtime').length, 1);
  }
  // A transport error after POST is unknown, even a rate limit.
  const {state, tool, fetchImpl} = server({
    create_runtime: (args, s) => (s.creates === 0 ? (s.creates++, {http: 429}) : undefined)
  });
  const {adapter} = colab(tool, fetchImpl);
  const owner = manager(adapter, {stateFile: await stateFile('colab-second-p1-http-')});
  await assert.rejects(owner.acquire({model: 'm', source}), {code: 'k_selfhost_state_unknown'});
  assert(owner.runtimeName());
  await assert.rejects(owner.acquire({model: 'm', source}));
  assert.equal(state.creates, 1);
});

test('second review P2: a step error mentioning UNAVAILABLE never resends k_start; only its record settles it', async () => {
  const internal = {error: 'INTERNAL: diagnostic mentions UNAVAILABLE; final delivery is unknown'};
  // Exactly the reviewer's mock: the record reads are unanswered (no K_STATE), so
  // the start stays unknown and the runtime this request created is released.
  {
    const {state, tool, fetchImpl} = server({
      execute_code: (args, s) => (args.code.includes('\nk_start(') ? (s.starts++, internal) : undefined)
    });
    const {adapter} = colab(tool, fetchImpl);
    const owner = manager(adapter);
    await assert.rejects(owner.acquire({model: 'm', source}), /Colab 模型準備失敗/);
    assert.equal(state.starts, 1, 'k_start sent once');
    assert.equal(state.deletes, 1, 'the runtime created for this request is released');
  }
  // The same failure with the step's terminal record on the runtime.
  {
    let startId;
    const {state, tool, fetchImpl} = server({
      execute_code: (args, s) => {
        if (args.code.includes('\nk_start(')) {
          s.starts++;
          startId = args.executionId;
          return internal;
        }
        if (args.code.includes('\nk_state(')) {
          assert(args.code.includes(JSON.stringify(startId)));
          assert.match(args.session, /\/sessions\/k-state$/u);
          return stateLine({state: 'done', out: ['K_LOADING 30', 'K_READY m']}, startId);
        }
      }
    });
    const {adapter} = colab(tool, fetchImpl);
    const owner = manager(adapter);
    await (await owner.acquire({model: 'm', source})).finish();
    assert.equal(state.starts, 1);
    assert.equal(owner.status('m', source).state, 'ready');
  }
});

test('second review P2: a schema-valid empty listing {} after delete confirms the stop; other shapes stay unknown', async () => {
  // The official list_runtimes output schema (archive official/mcp-tools-list.json,
  // fix/sol-list-runtime-schema.json) has the single field `runtimes`, not required.
  for (const [after, expected] of [
    [{}, {stopped: true, readback: 'gone'}],
    [{runtimes: []}, {stopped: true, readback: 'gone'}],
    [{runtimes: null}, {stopped: false, readback: 'unknown'}],
    [{name: 'runtimes/k-0123456789abcdef'}, {stopped: false, readback: 'unknown'}],
    [{runtimes: [{}]}, {stopped: false, readback: 'unknown'}]
  ]) {
    const {state, tool, fetchImpl} = server({list_runtimes: (args, s) => (s.present() ? undefined : after)});
    const {adapter} = colab(tool, fetchImpl);
    const file = await stateFile('colab-second-empty-');
    const owner = manager(adapter, {stateFile: file});
    await (await owner.acquire({model: 'm', source})).finish();
    const result = await owner.stop();
    assert.deepEqual({stopped: result.stopped, readback: result.readback}, expected, JSON.stringify(after));
    assert.equal(state.deletes, 1, 'never a second delete');
    if (expected.stopped) await assert.rejects(readFile(file), {code: 'ENOENT'});
    else assert.equal(JSON.parse(await readFile(file, 'utf8')).phase, 'delete-sent');
  }
});

test('second review P2: close() during any await of beginLogin opens no consent page and leaves no listener', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'oauth-close-race-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(path.join(root, '.runtime/colab-oauth-client.json'), '{}');
  const status = JSON.stringify({client: true, clientId: 'fake.apps.googleusercontent.com', signedIn: false});
  // 1. Closed while the status helper is still running (the reviewer's mock).
  {
    let finish, started;
    const helperStarted = new Promise(resolve => (started = resolve));
    const opened = [];
    let helperCalls = 0;
    const a = createColabAuth({
      root,
      openUrl: async url => opened.push(url),
      execImpl: () => {
        helperCalls++;
        started();
        return new Promise(resolve => (finish = () => resolve({stdout: status})));
      }
    });
    const pending = a.beginLogin();
    await helperStarted;
    assert.deepEqual(await a.beginLogin(), {opened: false, waiting: true}, 'one login at a time, even while starting');
    a.close();
    finish();
    await assert.rejects(pending, {code: 'k_selfhost_colab_signin'});
    assert.equal(opened.length, 0);
    assert.equal(helperCalls, 1);
  }
  // 2. Closed while the default browser is opening: the listener is stopped.
  {
    let port;
    const a = createColabAuth({
      root,
      openUrl: async url => {
        port = Number(new URL(new URL(url).searchParams.get('redirect_uri')).port);
        a.close();
      },
      execImpl: async () => ({stdout: status})
    });
    await assert.rejects(a.beginLogin(), /不再等待回呼/);
    const refused = await new Promise(resolve => {
      const socket = createConnection({port, host: '127.0.0.1'});
      socket.once('connect', () => (socket.destroy(), resolve(false)));
      socket.once('error', () => resolve(true));
    });
    assert.equal(refused, true, 'no loopback listener remains');
  }
});

test('second review P2: a known opaque proxy token never leaves through executionError.name, tool error text or the final 400', async () => {
  // The reviewer's path: the adapter cached the token, then a step fails with it as the class name.
  {
    const mcp = {
      async call(tool, args) {
        if (tool === 'create_runtime') return runtime(`runtimes/${args.runtimeId}`);
        if (tool === 'execute_code') return {executionError: {name: PROXY, value: 'no sensitive value', traceback: []}};
        throw new Error(`unexpected ${tool}`);
      }
    };
    const a = createColabAdapter({auth, mcp, sleep: async () => {}});
    const owner = manager({
      authState: auth.state,
      ready: async () => {},
      account: async () => ACCOUNT,
      createRuntime: args =>
        a.createRuntime({
          ...args,
          plan: {runtimeSpec: {variant: 'VARIANT_GPU', accelerator: 'H100', shape: 'SHAPE_HIGHMEM'}}
        }),
      serve: args => a.serve(args),
      deleteRuntime: async () => {},
      getRuntime: async () => null
    });
    const bridge = await openGemmaResponses('http://unused.invalid', {
      expectedModel: 'm',
      acquireModel: ({signal}) => owner.acquire({model: 'm', source, signal})
    });
    try {
      const response = await fetch(`${bridge.baseUrl}/responses`, {
        method: 'POST',
        headers: bridge.headers,
        body: JSON.stringify({model: 'm', input: [], tools: []})
      });
      const body = await response.text();
      assert.equal(response.status, 400);
      assert.equal(body.includes(PROXY), false);
    } finally {
      await bridge.close();
    }
  }
  // Free tool error text cut at its 300-character limit leaves no part of the token.
  for (const pad of [0, 270, 280, 290, 299]) {
    const text = `${'x'.repeat(pad)}${PROXY} tail`;
    const {tool, fetchImpl} = server({list_runtimes: () => ({error: text})});
    const {adapter} = colab(tool, fetchImpl);
    await adapter.createRuntime({runtimeId: 'k-0123456789abcdef', source});
    await assert.rejects(adapter.getRuntime('runtimes/k-0123456789abcdef'), error => {
      const all = JSON.stringify({...error, message: error.message, stack: error.stack});
      assert.equal(all.includes(PROXY.slice(0, 8)), false, `pad ${pad}`);
      return true;
    });
  }
  // A failed step whose record names the token as its class is redacted too.
  {
    const {tool, fetchImpl} = server({
      execute_code: args =>
        args.code.includes('\nk_state(')
          ? stateLine(
              {state: 'failed', name: PROXY, marker: 'K_SERVER_EXITED'},
              args.code.match(/\nk_state\("([^"]+)"/u)[1]
            )
          : args.code.includes('\nk_start(')
            ? {error: 'lost'}
            : undefined
    });
    const {adapter} = colab(tool, fetchImpl);
    await adapter.createRuntime({runtimeId: 'k-0123456789abcdef', source});
    await assert.rejects(adapter.serve({name: 'runtimes/k-0123456789abcdef', model: 'm', source}), error => {
      assert.equal(JSON.stringify({...error, message: error.message, stack: error.stack}).includes(PROXY), false);
      assert.equal(error.step.marker, 'K_SERVER_EXITED');
      return true;
    });
  }
});
