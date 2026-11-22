// Mock Colab control adapter only: no Colab, OAuth, GPU, network or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {createColabRuntime} from '../src/colab-runtime.mjs';

const source = {
  repository: 'pub/model',
  revision: 'a'.repeat(40),
  files: [{path: 'm.gguf', bytes: 1, sha256: 'b'.repeat(64)}]
};
const NAME = /^runtimes\/k-[a-f0-9]{16}$/u;
const scratch = async prefix => mkdtemp(path.join(scratchBase, prefix));

// A fake Colab account that already holds one runtime K did not create. Calls are
// logged with K's generated names replaced by k-1, k-2… in creation order.
function mockColab({serve, auth = 'signed-in'} = {}) {
  const calls = [],
    runtimes = new Set(['runtimes/external']),
    alias = new Map();
  const short = name => alias.get(name) ?? name;
  const transport = label => ({
    label,
    async respond() {
      return Response.json({output: []});
    }
  });
  const signals = [];
  const client = {
    authState: () => auth,
    async ready() {
      calls.push('ready');
    },
    account: async () => 'owner@example.com',
    async createRuntime({runtimeId}) {
      const name = `runtimes/${runtimeId}`;
      alias.set(name, `runtimes/k-${alias.size + 1}`);
      calls.push(`create ${short(name)}`);
      runtimes.add(name);
      return {name};
    },
    async getRuntime(name, options) {
      signals.push(options?.signal);
      calls.push(`get ${short(name)}`);
      return runtimes.has(name) ? {name} : null;
    },
    async deleteRuntime(name) {
      calls.push(`delete ${short(name)}`);
      runtimes.delete(name);
    },
    async serve(options) {
      calls.push(`serve ${short(options.name)} ${options.model}`);
      if (serve) return serve(options);
      return transport('fresh-serve');
    },
    async endpoint({name}) {
      calls.push(`endpoint ${short(name)}`);
      return transport('reused');
    }
  };
  const mine = () => [...runtimes].filter(name => name !== 'runtimes/external');
  return {client, calls, runtimes, mine, short, signals};
}
// Tests that exercise a real request run with the owner's separate approval to
// create (the default is no create at all).
const approved = options => createColabRuntime({allowCreate: true, ...options});

test('without a Colab adapter or OAuth client nothing can start and no call is made', async () => {
  const colab = createColabRuntime();
  assert.deepEqual(colab.status('m'), {state: 'unconfigured'});
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_colab_unconfigured'});
  await colab.close();
  const {client, calls} = mockColab({auth: 'no-client'});
  const unconfigured = approved({client});
  assert.deepEqual(unconfigured.status('m'), {state: 'unconfigured'});
  await assert.rejects(unconfigured.acquire({model: 'm', source}), {code: 'k_selfhost_colab_unconfigured'});
  assert.deepEqual(calls, [], 'no sign-in page, record or Colab call without the owner OAuth client');
});

test('sign-in comes first: a refused ready() writes no record and creates nothing', async () => {
  const stateFile = path.join(await scratch('colab-signin-'), 'colab-runtime.json');
  const {client, calls} = mockColab({auth: 'signed-out'});
  client.ready = async () => {
    calls.push('ready');
    throw Object.assign(new Error('Colab 尚未授權：K 已用預設瀏覽器開啟 Google 授權頁'), {
      code: 'k_selfhost_colab_signin'
    });
  };
  const colab = approved({client, stateFile});
  assert.deepEqual(colab.status('m'), {state: 'signin-required'});
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_colab_signin'});
  assert.deepEqual(calls, ['ready']);
  assert.equal(existsSync(stateFile), false);
  await colab.close();
  assert.deepEqual(calls, ['ready'], 'close has nothing of its own to settle');
});

test('a request creates a K-named runtime, records it, reuses after readback and close releases only its own', async () => {
  const stateFile = path.join(await scratch('colab-ledger-'), 'colab-runtime.json');
  const {client, calls, runtimes, mine} = mockColab();
  let recorded;
  const serve = client.serve;
  client.serve = async options => {
    recorded = JSON.parse(await readFile(stateFile, 'utf8'));
    return serve(options);
  };
  const colab = approved({client, stateFile});
  assert.deepEqual(colab.status('m'), {state: 'idle'});
  assert.deepEqual(calls, [], 'status is local evidence only');
  const lease = await colab.acquire({model: 'm', source, contextWindow: 4096});
  assert.equal(lease.upstream.label, 'fresh-serve');
  assert.match(recorded.name, NAME);
  assert.equal(recorded.phase, 'owned');
  assert.equal(
    Object.keys(recorded).sort().join(),
    'account,at,name,phase,version',
    'the record holds no token or connection detail'
  );
  assert.equal(colab.runtimeName(), recorded.name);
  assert.deepEqual(colab.status('m'), {state: 'ready'});
  assert.deepEqual(colab.status('other'), {state: 'idle'});
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_busy'});
  await lease.finish();
  const again = await colab.acquire({model: 'm', source});
  assert.equal(again.upstream.label, 'reused');
  await again.finish();
  await colab.close();
  assert.deepEqual(calls, [
    'ready',
    'create runtimes/k-1',
    'serve runtimes/k-1 m',
    'ready',
    'get runtimes/k-1',
    'endpoint runtimes/k-1',
    'delete runtimes/k-1',
    'get runtimes/k-1'
  ]);
  assert.deepEqual([...runtimes], ['runtimes/external']);
  assert.deepEqual(mine(), []);
  assert.equal(existsSync(stateFile), false, 'confirmed gone: the record is removed');
});

test('cancelling while starting releases the runtime this request created and nothing else', async () => {
  const abort = new AbortController();
  const {client, calls, runtimes} = mockColab({
    serve: ({signal}) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}))
  });
  const colab = approved({client});
  const pending = colab.acquire({model: 'm', source, signal: abort.signal});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(colab.status('m'), {state: 'starting'});
  abort.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(calls, [
    'ready',
    'create runtimes/k-1',
    'serve runtimes/k-1 m',
    'delete runtimes/k-1',
    'get runtimes/k-1'
  ]);
  assert.deepEqual([...runtimes], ['runtimes/external']);
  assert.deepEqual(colab.status('m'), {state: 'idle'});
});

test('an unknown create is never re-sent, and one not-found readback does not clear it or allow a new create', async () => {
  const stateFile = path.join(await scratch('colab-create-unknown-'), 'colab-runtime.json');
  const {client, calls} = mockColab();
  let lost;
  client.createRuntime = async ({runtimeId}) => {
    lost = `runtimes/${runtimeId}`;
    calls.push('create (lost)');
    throw new Error('socket hang up');
  };
  const colab = approved({client, stateFile});
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_state_unknown'});
  assert.equal(colab.status('m').state, 'unknown');
  assert.equal(colab.runtimeName(), lost, 'K still knows the name it asked for');
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'create-sent');
  client.createRuntime = async () => {
    calls.push('create new');
    throw new Error('must not be called');
  };
  client.getRuntime = async name => {
    calls.push(name === lost ? 'get lost' : 'get other');
    return null;
  };
  const before = calls.length;
  await assert.rejects(colab.acquire({model: 'm', source}), error => {
    assert.equal(error.code, 'k_selfhost_state_unknown');
    assert.match(error.message, /不能證明建立已終止/);
    return true;
  });
  const stop = await colab.stop();
  assert.deepEqual([stop.stopped, stop.readback], [false, 'unknown']);
  assert.deepEqual(calls.slice(before), ['ready', 'get lost', 'get lost']);
  assert.equal(calls.filter(call => call.startsWith('create')).length, 1, 'neither the lost create nor a new one');
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).name, lost, 'the unknown create stays recorded');
  await colab.close();
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'create-sent');
});

test('an unknown create that did assign is deleted by name on settle, never served', async () => {
  const {client, calls, runtimes} = mockColab();
  const create = client.createRuntime;
  client.createRuntime = async args => {
    await create(args); // Colab assigned it, but the response was lost.
    throw new Error('response lost');
  };
  const colab = approved({client});
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_state_unknown'});
  const result = await colab.stop();
  assert.equal(result.stopped, true);
  assert.equal(result.readback, 'gone');
  assert.deepEqual(calls, [
    'ready',
    'create runtimes/k-1',
    'get runtimes/k-1',
    'delete runtimes/k-1',
    'get runtimes/k-1'
  ]);
  assert.deepEqual([...runtimes], ['runtimes/external']);
  assert.deepEqual(colab.status('m'), {state: 'idle'});
});

test('a definitive Colab refusal is an ordinary failure, not an unknown state, and leaves no record', async () => {
  const stateFile = path.join(await scratch('colab-refused-'), 'colab-runtime.json');
  const {client} = mockColab();
  client.createRuntime = async () => {
    throw Object.assign(new Error('TOO_MANY_ACTIVE_RUNTIMES'), {definitive: true});
  };
  const colab = approved({client, stateFile});
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_prepare_failed'});
  assert.deepEqual(colab.status('m'), {state: 'idle'});
  assert.equal(existsSync(stateFile), false);
});

test('an unconfirmed stop is not blindly repeated; K close leaves a diagnostic and the record for the next K', async () => {
  const dir = await scratch('colab-diag-');
  const diagnosticsFile = path.join(dir, 'colab-runtime.jsonl');
  const stateFile = path.join(dir, 'colab-runtime.json');
  const {client, calls} = mockColab();
  client.deleteRuntime = async name => {
    calls.push('delete (kept)'); // Colab keeps it: readback proves the stop failed.
  };
  const colab = approved({client, diagnosticsFile, stateFile});
  await (await colab.acquire({model: 'm', source})).finish();
  await assert.rejects(colab.acquire({model: 'other', source}), {code: 'k_selfhost_state_unknown'});
  assert.equal(colab.status('m').state, 'stop-unconfirmed');
  await colab.close();
  // close only reads back (still there): the delete already sent is never re-sent.
  assert.deepEqual(calls.slice(-3), ['delete (kept)', 'get runtimes/k-1', 'get runtimes/k-1']);
  assert.equal(calls.filter(call => call.startsWith('delete')).length, 1);
  const [record] = (await readFile(diagnosticsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.match(record.runtime, NAME);
  assert.match(record.reason, /仍存在/);
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.deepEqual([saved.name, saved.phase, saved.account], [record.runtime, 'delete-sent', 'owner@example.com']);
});

test('a record left by an earlier K blocks nothing silently: stop reads it back and removes only that runtime', async () => {
  const stateFile = path.join(await scratch('colab-residue-'), 'colab-runtime.json');
  const left = 'runtimes/k-0123456789abcdef';
  const saved = {name: left, phase: 'owned', account: 'owner@example.com'};
  await writeFile(stateFile, JSON.stringify(saved));
  const {client, calls, runtimes} = mockColab();
  runtimes.add(left);
  const colab = approved({client, stateFile, journal: {record: saved}});
  assert.equal(colab.status('m').state, 'stop-unconfirmed');
  assert.deepEqual(calls, [], 'a new K never calls Colab or revives work at startup');
  const result = await colab.stop();
  // A confirmed-owned record gets its first delete directly, then a readback.
  assert.deepEqual(calls, [`delete ${left}`, `get ${left}`]);
  assert.equal(result.stopped, true);
  assert.equal(result.runtime, left);
  assert.match(result.message, /讀回確認已不存在/);
  assert.deepEqual([...runtimes], ['runtimes/external']);
  assert.equal(existsSync(stateFile), false);
});

test('an unconfirmed inference is never re-sent: the next send deletes that runtime first', async () => {
  const {client, calls} = mockColab();
  const colab = approved({client});
  await (await colab.acquire({model: 'm', source, caller: {thread: 'room', turn: '1'}})).finish({settled: false});
  assert.equal(colab.status('m').state, 'unknown');
  await (await colab.acquire({model: 'm', source, caller: {thread: 'room', turn: '2'}})).finish();
  assert.deepEqual(calls.slice(3), [
    'ready',
    'delete runtimes/k-1',
    'get runtimes/k-1',
    'create runtimes/k-2',
    'serve runtimes/k-2 m'
  ]);
  await colab.close();
});

test('a cancel after the model is ready stops and reads back before another request can start', async () => {
  const {client, calls, runtimes} = mockColab();
  const colab = approved({client});
  await (await colab.acquire({model: 'm', source})).finish({settled: false, cancelled: true});
  assert.deepEqual(calls.slice(-2), ['delete runtimes/k-1', 'get runtimes/k-1']);
  assert.deepEqual([...runtimes], ['runtimes/external']);
  assert.deepEqual(colab.status('m'), {state: 'idle'});
});

test('close waits for late create, releases it without serving, and rejects late acquire', async () => {
  const {client, calls, runtimes} = mockColab();
  let assign;
  const create = client.createRuntime;
  client.createRuntime = args => new Promise(resolve => (assign = () => resolve(create(args))));
  const colab = approved({client});
  const pending = colab.acquire({model: 'm', source});
  const rejected = assert.rejects(pending);
  await new Promise(resolve => setImmediate(resolve));
  const closing = colab.close();
  assert.strictEqual(colab.close(), closing, 'concurrent connection closes share one operation');
  await assert.rejects(colab.acquire({model: 'other', source}), {code: 'k_selfhost_busy'});
  assign();
  await rejected;
  await closing;
  assert.deepEqual(calls, ['ready', 'create runtimes/k-1', 'delete runtimes/k-1', 'get runtimes/k-1']);
  assert.deepEqual([...runtimes], ['runtimes/external']);
});

test('close from another connection waits for the active lease instead of deleting its runtime', async () => {
  const {client, calls} = mockColab();
  const colab = approved({client});
  const lease = await colab.acquire({model: 'm', source});
  let closed = false;
  const closing = colab.close().then(() => (closed = true));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(
    calls.some(call => call.startsWith('delete')),
    false
  );
  await lease.finish();
  await closing;
  assert.deepEqual(calls.slice(-2), ['delete runtimes/k-1', 'get runtimes/k-1']);
});

test('stop never interrupts another request and reports exactly what K read back', async () => {
  const {client, calls} = mockColab();
  const colab = approved({client});
  const none = await colab.stop();
  assert.deepEqual([none.stopped, none.readback, none.runtime], [true, 'none', null]);
  assert.deepEqual(calls, [], 'nothing of K to close: no Colab call');
  const lease = await colab.acquire({model: 'm', source});
  const busy = await colab.stop();
  assert.deepEqual([busy.stopped, busy.busy, busy.readback], [false, true, 'not-attempted']);
  assert.equal(
    calls.some(call => call.startsWith('delete')),
    false,
    'an active request is never cut off by stop'
  );
  await lease.finish();
  const done = await colab.stop();
  assert.deepEqual([done.stopped, done.readback], [true, 'gone']);
  assert.deepEqual(calls.slice(-2), ['delete runtimes/k-1', 'get runtimes/k-1']);
  await (await colab.acquire({model: 'm', source})).finish();
  assert.equal(calls.filter(call => call.startsWith('create')).length, 2, 'only a new real request creates again');
  await colab.close();
});

test('a failed stop readback is reported as unknown, not as stopped', async () => {
  const {client} = mockColab();
  const colab = approved({client});
  await (await colab.acquire({model: 'm', source})).finish();
  client.getRuntime = async () => {
    throw new Error('network down');
  };
  const result = await colab.stop();
  assert.deepEqual([result.stopped, result.readback], [false, 'unknown']);
  assert.match(result.message, /讀回 Colab runtime .* 失敗/);
  assert.equal(colab.status('m').state, 'stop-unconfirmed');
});

test('the same model alias from a different pinned source never reuses the old runtime', async () => {
  const {client, calls} = mockColab();
  const colab = approved({client});
  await (await colab.acquire({model: 'm', source})).finish();
  assert.equal(colab.status('m', {...source, revision: 'c'.repeat(40)}).state, 'idle');
  await (await colab.acquire({model: 'm', source: {...source, revision: 'c'.repeat(40)}})).finish();
  assert.equal(calls.filter(call => call.startsWith('create')).length, 2);
  assert.deepEqual(calls.slice(4, 6), ['delete runtimes/k-1', 'get runtimes/k-1']);
  await colab.close();
});

for (const action of ['cancel', 'close']) {
  test(`${action} during old runtime deletion never creates the replacement runtime`, async () => {
    const {client, calls, runtimes} = mockColab();
    const colab = approved({client});
    await (await colab.acquire({model: 'm', source})).finish();
    let finishDelete, deleting;
    const deleteStarted = new Promise(resolve => (deleting = resolve));
    const remove = client.deleteRuntime;
    client.deleteRuntime = async name => {
      deleting();
      await new Promise(resolve => (finishDelete = resolve));
      await remove(name);
    };
    const abort = new AbortController();
    const pending = colab.acquire({model: 'm', source: {...source, revision: 'c'.repeat(40)}, signal: abort.signal});
    const rejected = assert.rejects(pending, action === 'cancel' ? {name: 'AbortError'} : {code: 'k_selfhost_busy'});
    await deleteStarted;
    let closing;
    if (action === 'cancel') abort.abort();
    else closing = colab.close();
    finishDelete();
    await rejected;
    await closing;
    await colab.close();
    assert.deepEqual(calls, [
      'ready',
      'create runtimes/k-1',
      'serve runtimes/k-1 m',
      'ready',
      'delete runtimes/k-1',
      'get runtimes/k-1'
    ]);
    assert.deepEqual([...runtimes], ['runtimes/external']);
  });
}

test('a mismatched create response never includes connection secrets in serialized errors', async () => {
  const {client, calls} = mockColab();
  const sentinel = 'MOCK_SECRET_MUST_NOT_LEAK';
  client.createRuntime = async () => {
    calls.push('create');
    return {connectionInfo: {token: sentinel}};
  };
  const colab = approved({client});
  await assert.rejects(colab.acquire({model: 'm', source}), error => {
    assert.equal(error.code, 'k_selfhost_state_unknown');
    assert.doesNotMatch(JSON.stringify({...error, message: error.message, stack: error.stack}), new RegExp(sentinel));
    return true;
  });
  assert.deepEqual(calls, ['ready', 'create']);
});

test('cancelling while reattaching to a serving runtime releases it before returning', async () => {
  const {client, calls} = mockColab();
  const abort = new AbortController();
  const colab = approved({client});
  await (await colab.acquire({model: 'm', source})).finish();
  client.endpoint = async () => {
    abort.abort();
    return {respond() {}};
  };
  await assert.rejects(colab.acquire({model: 'm', source, signal: abort.signal}), {name: 'AbortError'});
  assert.deepEqual(calls.slice(-2), ['delete runtimes/k-1', 'get runtimes/k-1']);
  assert.equal(colab.status('m').state, 'idle');
  await colab.close();
});

test('a runtime whose model server stopped is released and replaced within the same request', async () => {
  const {client, calls, mine} = mockColab();
  const colab = approved({client});
  await (await colab.acquire({model: 'm', source})).finish();
  client.endpoint = async () => {
    calls.push('endpoint down');
    throw new Error('K_HEALTH down');
  };
  await (await colab.acquire({model: 'm', source})).finish();
  assert.deepEqual(calls.slice(3), [
    'ready',
    'get runtimes/k-1',
    'endpoint down',
    'delete runtimes/k-1',
    'get runtimes/k-1',
    'create runtimes/k-2',
    'serve runtimes/k-2 m'
  ]);
  assert.equal(mine().length, 1);
  await colab.close();
});

test('a model service without a transport is refused and the newly created runtime is released', async () => {
  const {client, calls} = mockColab({serve: async () => ({baseUrl: 'https://colab.example/proxy/v1'})});
  const colab = approved({client});
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_prepare_failed'});
  assert.deepEqual(calls.slice(-2), ['delete runtimes/k-1', 'get runtimes/k-1']);
  await colab.close();
});

test('cancel with an unknown delete never re-sends it: later sends, stop and close only read back', async () => {
  const {client, calls, runtimes} = mockColab();
  const remove = client.deleteRuntime;
  client.deleteRuntime = async () => {
    calls.push('delete (lost)'); // Colab may or may not act on it; it is still listed.
    throw new Error('delete response lost');
  };
  const colab = approved({client});
  const lease = await colab.acquire({model: 'm', source});
  await assert.rejects(lease.finish({cancelled: true, settled: false}), {code: 'k_selfhost_state_unknown'});
  await lease.finish({cancelled: true});
  client.deleteRuntime = remove;
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_state_unknown'});
  assert.equal((await colab.stop()).readback, 'unknown');
  await colab.close();
  assert.deepEqual(calls.slice(3), [
    'delete (lost)',
    'get runtimes/k-1',
    'ready',
    'get runtimes/k-1',
    'get runtimes/k-1',
    'get runtimes/k-1'
  ]);
  assert.equal(calls.filter(call => call.startsWith('delete')).length, 1, 'the delete is sent exactly once');
  assert.equal(calls.filter(call => call.startsWith('create')).length, 1, 'no replacement while the delete is unknown');
  assert.equal(runtimes.size, 2);
});

test('once the unknown delete is confirmed by a listing, the record clears and a new request may create', async () => {
  const {client, calls, runtimes, mine} = mockColab();
  client.deleteRuntime = async () => {
    calls.push('delete (lost)');
    throw new Error('delete response lost');
  };
  const colab = approved({client});
  await (await colab.acquire({model: 'm', source})).finish({cancelled: true}).catch(() => {});
  runtimes.delete(mine()[0]); // Colab finished the deletion later.
  await (await colab.acquire({model: 'm', source})).finish();
  assert.deepEqual(calls.slice(-4), ['ready', 'get runtimes/k-1', 'create runtimes/k-2', 'serve runtimes/k-2 m']);
  assert.equal(calls.filter(call => call.startsWith('delete')).length, 1);
});

test('the status is starting while Colab is still assigning the runtime', async () => {
  const {client} = mockColab();
  let assign;
  const create = client.createRuntime;
  client.createRuntime = args => new Promise(resolve => (assign = () => resolve(create(args))));
  const colab = approved({client});
  const pending = colab.acquire({model: 'm', source});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(colab.status('m'), {state: 'starting'});
  assert.deepEqual(colab.status('other'), {state: 'idle'});
  assign();
  await (await pending).finish();
  assert.deepEqual(colab.status('m'), {state: 'ready'});
  await colab.close();
});

// ---- Acceptance fixes (2026-11-13 Sol review) ---------------------------------

test('OAuth consent alone never creates: without the owner create approval a send makes no create', async () => {
  const stateFile = path.join(await scratch('colab-not-approved-'), 'colab-runtime.json');
  const {client, calls} = mockColab();
  const colab = createColabRuntime({client, stateFile});
  assert.equal(colab.policy().createAllowed, false);
  await assert.rejects(colab.acquire({model: 'm', source}), error => {
    assert.equal(error.code, 'k_selfhost_colab_not_approved');
    assert.match(error.message, /不代表同意開卡/);
    return true;
  });
  assert.deepEqual(calls, ['ready'], 'signed in, but no plan, record or create');
  assert.equal(existsSync(stateFile), false);
  const other = createColabRuntime({client, allowCreate: true, account: 'someone@example.com'});
  await assert.rejects(other.acquire({model: 'm', source}), /不是本人允許開卡的帳號/);
  assert.equal(calls.filter(call => call.startsWith('create')).length, 0);
});

test('a journal written by another Google account is never read back, settled or replaced by this account', async () => {
  const left = 'runtimes/k-0123456789abcdef';
  const {client, calls, runtimes} = mockColab();
  runtimes.add(left);
  const colab = approved({client, journal: {record: {name: left, phase: 'owned', account: 'first@example.com'}}});
  await assert.rejects(colab.acquire({model: 'm', source}), /與目前授權帳號 owner@example.com 不同/);
  const stop = await colab.stop();
  assert.deepEqual([stop.stopped, stop.readback, stop.runtime], [false, 'unknown', left]);
  await colab.close();
  assert.deepEqual(calls, ['ready'], 'no listing, delete or create under the other account');
});

for (const [label, journal] of [
  ['unparsable', {error: '內容不是有效 JSON'}],
  ['unreadable', {error: '讀取失敗 EACCES'}],
  ['invalid', {record: {name: 'runtimes/someone-else', phase: 'owned'}}],
  ['unknown phase', {record: {name: 'runtimes/k-0123456789abcdef', phase: 'mystery'}}]
])
  test(`a ${label} journal blocks create, stop and close instead of meaning "no record"`, async () => {
    const {client, calls} = mockColab();
    const colab = approved({client, journal});
    assert.equal(colab.status('m').state, 'unknown');
    await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_state_unknown'});
    assert.equal((await colab.stop()).readback, 'unknown');
    await colab.close();
    assert.deepEqual(calls, ['ready']);
  });

test('a delete-sent record from an earlier K is only read back, never deleted again', async () => {
  const stateFile = path.join(await scratch('colab-delete-sent-'), 'colab-runtime.json');
  const left = 'runtimes/k-0123456789abcdef';
  const saved = {name: left, phase: 'delete-sent', account: 'owner@example.com'};
  await writeFile(stateFile, JSON.stringify(saved));
  const {client, calls, runtimes} = mockColab();
  runtimes.add(left);
  const colab = approved({client, stateFile, journal: {record: saved}});
  assert.equal(colab.status('m').state, 'stop-unconfirmed');
  assert.equal((await colab.stop()).readback, 'unknown');
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_state_unknown'});
  runtimes.delete(left);
  const done = await colab.stop();
  assert.deepEqual([done.stopped, done.readback], [true, 'gone']);
  assert.deepEqual(calls, [`get ${left}`, 'ready', `get ${left}`, `get ${left}`]);
  assert.equal(existsSync(stateFile), false);
});

test('a create-sent record that K now sees listed becomes owned and gets its first delete', async () => {
  const left = 'runtimes/k-0123456789abcdef';
  const {client, calls, runtimes} = mockColab();
  runtimes.add(left);
  const colab = approved({client, journal: {record: {name: left, phase: 'create-sent', account: 'owner@example.com'}}});
  assert.equal(colab.status('m').state, 'unknown');
  const stop = await colab.stop();
  assert.deepEqual([stop.stopped, stop.readback], [true, 'gone']);
  assert.deepEqual(calls, [`get ${left}`, `delete ${left}`, `get ${left}`]);
});

test('a create tool error, whatever its wording, stays create-sent; an absent listing never permits another create', async () => {
  const {client, calls} = mockColab();
  client.createRuntime = async () => {
    calls.push('create (tool error)');
    throw new Error('Colab 回報錯誤：RESOURCE_EXHAUSTED: rate');
  };
  const colab = approved({client});
  await assert.rejects(colab.acquire({model: 'm', source}), {code: 'k_selfhost_state_unknown', readback: 'unknown'});
  const name = colab.runtimeName();
  assert.match(name, /^runtimes\/k-[a-f0-9]{16}$/u);
  assert.equal(colab.status('m').state, 'unknown');
  assert.deepEqual(calls, ['ready', 'create (tool error)'], 'no readback is taken as proof of refusal');
  // The listing does not have it: still unknown, no second create.
  await assert.rejects(colab.acquire({model: 'm', source}), /不能證明建立已終止/);
  assert.equal(calls.filter(call => call.startsWith('create')).length, 1);
  assert.equal(colab.runtimeName(), name);
});

test('a delete is never sent when K cannot first record that it is about to send it', async () => {
  const dir = await scratch('colab-journal-fail-');
  const stateFile = path.join(dir, 'colab-runtime.json');
  const {client, calls} = mockColab();
  const colab = approved({client, stateFile});
  await (await colab.acquire({model: 'm', source})).finish();
  await rm(stateFile);
  await mkdir(stateFile); // atomic replacement of a directory fails
  const stop = await colab.stop();
  assert.deepEqual([stop.stopped, stop.readback], [false, 'not-attempted']);
  assert.match(stop.message, /未送出關閉命令/);
  assert.equal(
    calls.some(call => call.startsWith('delete')),
    false
  );
  assert.equal(colab.status('m').state, 'ready', 'still K-owned and serving');
});

test('reuse passes the request signal to the listing and health check; close cancels a stuck health check', async () => {
  const {client, calls, signals} = mockColab();
  const colab = approved({client});
  await (await colab.acquire({model: 'm', source})).finish();
  let healthSignal;
  client.endpoint = ({signal}) =>
    new Promise((_, reject) => {
      healthSignal = signal;
      calls.push('endpoint (stuck)');
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  const caller = new AbortController();
  const pending = colab.acquire({model: 'm', source, signal: caller.signal});
  const rejected = assert.rejects(pending);
  while (!healthSignal) await new Promise(resolve => setImmediate(resolve));
  assert.ok(signals.at(-1) instanceof AbortSignal, 'the reuse listing is cancellable');
  const closing = colab.close();
  await rejected;
  await closing;
  assert.deepEqual(calls.slice(-3), ['endpoint (stuck)', 'delete runtimes/k-1', 'get runtimes/k-1']);
  assert.equal(calls.filter(call => call.startsWith('delete')).length, 1);
});
