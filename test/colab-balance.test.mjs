import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {createColabBalance} from '../src/colab-balance.mjs';
import {loadGemmaConnections} from '../src/gemma-main.mjs';
import {startDesktop} from '../src/desktop-server.mjs';
import {remoteRouteAllowed} from '../src/remote-access.mjs';

const account = 'owner@example.invalid';
const profileId = 'a'.repeat(32);

test('simultaneous callers share a fresh read, and failed follow-up never returns old units', async () => {
  const queue = ['196.01', null];
  let calls = 0;
  const b = createColabBalance({
    accounts: [{account, profileId}],
    async read(options) {
      assert.equal(options.account, account);
      assert.equal(options.profileId, profileId);
      calls++;
      return queue.shift();
    }
  });
  const states = [];
  b.subscribe(() => states.push(b.value.state));
  assert.deepEqual(b.value, {state: 'unchecked'});
  const a = b.refresh();
  assert.equal(b.refresh(), a);
  assert.deepEqual((await a).accounts, [{account, units: '196.01'}]);
  assert.equal(typeof b.value.checkedAt, 'string');
  assert.equal(calls, 1);
  assert.deepEqual(await b.refresh(), {state: 'unavailable'});
  assert.equal(calls, 2);
  assert.deepEqual(states, ['checking', 'fresh', 'checking', 'unavailable']);
  await b.close();
  await b.refresh();
  assert.equal(calls, 2);
});

test('normal status does not read Chrome and both Colab tools use the same bound balance', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'colab-balance-status-'));
  await mkdir(path.join(root, '.runtime'));
  await writeFile(
    path.join(root, '.runtime', 'gemma-main.json'),
    JSON.stringify({
      colab: {account, balanceProfileId: profileId},
      selfHosted: [
        {
          id: 'test-colab',
          label: 'Test Colab',
          location: 'colab',
          model: 'test-colab',
          source: {
            format: 'gguf',
            repository: 'org/model',
            revision: 'a'.repeat(40),
            quantization: 'Q4_K_M',
            files: [{path: 'model.gguf', bytes: 1, sha256: 'b'.repeat(64)}]
          }
        }
      ]
    })
  );
  let reads = 0;
  const connections = await loadGemmaConnections(root, {
    colabClientFactory: () => ({
      async describe({live}) {
        return {live};
      }
    }),
    readColabBalance: async options => {
      assert.equal(options.account, account);
      assert.equal(options.profileId, profileId);
      reads++;
      return '196.01';
    }
  });
  try {
    const room = connections.find(c => c.colabAdmin);
    assert.equal((await room.colabAdmin.status()).balance, undefined);
    assert.equal((await room.colabTools.status()).balance, undefined);
    assert.equal(reads, 0);
    const [admin, selfHosted] = await Promise.all([
      room.colabAdmin.status({balance: true}),
      room.colabTools.status({balance: true})
    ]);
    assert.deepEqual(admin.balance.accounts, [{account, units: '196.01'}]);
    assert.deepEqual(admin.balance, selfHosted.balance);
    assert.deepEqual(admin.balance, room.colabAdmin.balance.value);
    assert.equal(reads, 1);
  } finally {
    await connections.find(c => c.colabAdmin)?.colabAdmin.balance?.close();
    await Promise.all(connections.map(c => c.close()));
  }
});

test('Colab header POST needs the owner session and exact empty request, and publishes only safe fields', async () => {
  let reads = 0;
  const colabBalance = createColabBalance({accounts: [{account, profileId}], read: async () => (++reads, '0')});
  const app = await startDesktop({
    root: await mkdtemp(path.join(scratchBase, 'colab-balance-')),
    port: 0,
    colabBalance,
    controllerFactory: () => ({state: {threadId: 'fixture'}, async close() {}})
  });
  try {
    const boot = await fetch(app.createLaunchUrl(), {redirect: 'manual'});
    const cookie = boot.headers.get('set-cookie').split(';')[0];
    const state = async () => (await fetch(app.origin + '/api/state', {headers: {Cookie: cookie}})).json();
    const request = (body, headers = {}) =>
      fetch(app.origin + '/api/colab/balance', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-K-Request': '1', ...headers},
        body: JSON.stringify(body)
      });
    assert.equal(fromState(await state()).state, 'unchecked');
    assert.equal((await request({})).status, 403);
    assert.equal((await request({profileId}, {Cookie: cookie})).status, 400);
    assert.equal(reads, 0);
    assert.equal(remoteRouteAllowed('GET', '/api/colab/balance'), false);
    assert.equal(remoteRouteAllowed('POST', '/api/colab/balance'), false);
    assert.equal(remoteRouteAllowed('POST', '/api/colab/balance', {colabBalance: true}), true);
    for (const action of ['capture', 'refresh', 'refresh-all', 'activate'])
      assert.equal(remoteRouteAllowed('POST', '/api/gemini/accounts/' + action), false);
    const ok = await request({}, {Cookie: cookie});
    assert.equal(ok.status, 200);
    const result = await ok.json();
    assert.deepEqual(result.accounts, [{account, units: '0'}]);
    assert.deepEqual(Object.keys(result).sort(), ['accounts', 'checkedAt', 'state']);
    assert.deepEqual(fromState(await state()), result);
    assert.equal(reads, 1);
  } finally {
    await app.close();
  }
});

test('every subscribed account is read in turn; one failure keeps the other fresh', async () => {
  const second = 'second@example.invalid';
  const otherProfile = 'b'.repeat(32);
  const seen = [];
  let active = 0;
  const b = createColabBalance({
    accounts: [
      {account, profileId},
      {account: second, profileId: otherProfile}
    ],
    async read(options) {
      assert.equal(++active, 1);
      seen.push([options.account, options.profileId]);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      if (options.account === second) throw Error('page changed');
      return '195.37';
    }
  });
  const result = await b.refresh();
  assert.deepEqual(seen, [
    [account, profileId],
    [second, otherProfile]
  ]);
  assert.equal(result.state, 'fresh');
  assert.deepEqual(result.accounts, [
    {account, units: '195.37'},
    {account: second, units: null}
  ]);
  assert.equal(createColabBalance({read: async () => '1', accounts: [{account: 'bad', profileId}]}), undefined);
  assert.equal(createColabBalance({read: async () => '1', accounts: []}), undefined);
  await b.close();
});

test('balanceAccounts in private settings replaces the single bound account', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'colab-balance-accounts-'));
  await mkdir(path.join(root, '.runtime'));
  const second = 'second@example.invalid';
  await writeFile(
    path.join(root, '.runtime', 'gemma-main.json'),
    JSON.stringify({
      colab: {
        account,
        balanceProfileId: profileId,
        balanceAccounts: [
          {account, profileId},
          {account: second, profileId: 'c'.repeat(32)}
        ]
      },
      selfHosted: [
        {
          id: 'test-colab',
          label: 'Test Colab',
          location: 'colab',
          model: 'test-colab',
          source: {
            format: 'gguf',
            repository: 'org/model',
            revision: 'a'.repeat(40),
            quantization: 'Q4_K_M',
            files: [{path: 'model.gguf', bytes: 1, sha256: 'b'.repeat(64)}]
          }
        }
      ]
    })
  );
  const reads = [];
  const connections = await loadGemmaConnections(root, {
    colabClientFactory: () => ({async describe() {return {};}}),
    readColabBalance: async options => (reads.push(options.account), '200')
  });
  try {
    const room = connections.find(c => c.colabAdmin);
    const {balance} = await room.colabAdmin.status({balance: true});
    assert.deepEqual(reads, [account, second]);
    assert.deepEqual(balance.accounts.map(row => row.account), [account, second]);
  } finally {
    await connections.find(c => c.colabAdmin)?.colabAdmin.balance?.close();
    await Promise.all(connections.map(c => c.close()));
  }
});

const fromState = state => state.colabBalance;
