// Emma's monthly cost estimate (docs/voice-secretary-design-20261106.md, 2026-11-07): the page sends each call's
// running estimate, K keeps the highest per call and sums the calls whose first estimate falls in this local month.
process.env.TZ = 'Asia/Taipei';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import path from 'node:path';
import {createVoiceSecretary, MAX_CALL_COST_USD, VOICE_HOST} from '../src/voice-secretary.mjs';
import {createConversationController} from '../src/conversation-controller.mjs';
import {emmaMonthText, emmaMonthParts} from '../frontend/quota-display.mjs';
import {scratchBase} from './scratch.mjs';

const tempRoot = name => mkdtemp(path.join(scratchBase, `emma-cost-${name}-`));
const costRows = async root =>
  (await readFile(path.join(root, '.runtime/voice-secretary.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(row => row.type === 'cost');
const rooms = {list: async () => [], session: async () => null, peek: () => null, note: async () => {}};
const voiceConnection = {
  list: async () => ({connections: [{id: 'g', baseUrl: `https://${VOICE_HOST}/v1beta/openai`, keyConfigured: true}]})
};
const noConnection = {list: async () => ({connections: []})};
const fixedRates = {twdPerCny: 4.5, usdPerCny: 0.14, updatedAt: 'Sat, 07 Nov 2026 00:02:31 +0000', source: 'test'};
// The rate is looked up beside the estimate and shown from the next refresh.
const settled = async voice => {
  await voice.monthCost();
  await new Promise(resolve => setTimeout(resolve, 0));
  return voice.monthCost();
};
const clock = iso => {
  const c = {at: new Date(iso)};
  c.now = () => new Date(c.at);
  return c;
};

test('a cost estimate must be a non-negative finite number within the cap, with no other fields', async () => {
  const root = await tempRoot('validate');
  const voice = createVoiceSecretary({root, rooms, rates: async () => fixedRates});
  const call = 'call-aaaa-0001';
  for (const bad of [
    {callId: call, cost: -0.01},
    {callId: call, cost: Number.NaN},
    {callId: call, cost: Number.POSITIVE_INFINITY},
    {callId: call, cost: '1.5'},
    {callId: call, cost: null},
    {callId: call, cost: MAX_CALL_COST_USD + 0.01},
    {callId: 'short', cost: 1},
    {callId: '../../x-y-z', cost: 1},
    {cost: 1},
    // Any other field rides on a cost write: refused, so the page cannot write a K event this way.
    {callId: call, cost: 1, type: 'send'},
    {callId: call, cost: 1, status: 'sent'},
    {callId: call, cost: 1, text: 'x'},
    {callId: call, cost: 1, seq: 0, role: 'owner', text: 'x'},
    {callId: call, cost: 1, at: '2020-01-01T00:00:00Z'},
    {callId: call, cost: 1, usd: 1}
  ])
    await assert.rejects(voice.log(bad), /通話費用估算格式無效/u, JSON.stringify(bad));
  // The other kinds of event still cannot come from the page, with or without a cost.
  await assert.rejects(voice.log({type: 'cost', callId: call, usd: 1}), /逐字稿格式無效/u);
  await assert.rejects(voice.log({type: 'send', code: 'abc', status: 'sent'}), /逐字稿格式無效/u);
  assert.equal((await costRows(root)).length, 0);
  assert.deepEqual(await voice.log({callId: call, cost: MAX_CALL_COST_USD}), {saved: true});
  assert.equal((await costRows(root)).length, 1);
  // The cost is not shown in the secretary room and adds no history line.
  const {entries} = await voice.entries();
  assert.equal(entries.length, 0);
  await voice.close();
});

test('a call only ever goes up; the month counts each call at its highest value', async () => {
  const root = await tempRoot('max');
  const time = clock('2026-11-07T03:00:00Z');
  let voice = createVoiceSecretary({root, rooms, now: time.now, rates: async () => fixedRates});
  const a = 'call-aaaa-0001',
    b = 'call-bbbb-0002';
  assert.deepEqual(await voice.log({callId: a, cost: 0}), {saved: false}, 'zero is not an increase');
  assert.deepEqual(await voice.log({callId: a, cost: 0.5}), {saved: true});
  assert.deepEqual(await voice.log({callId: a, cost: 0.3}), {saved: false}, 'lower is ignored');
  assert.deepEqual(await voice.log({callId: a, cost: 0.5}), {saved: false}, 'equal is ignored');
  // Same call after a reconnect: same ID, the running total keeps growing.
  assert.deepEqual(await voice.log({callId: a, cost: 0.8}), {saved: true});
  // Two identical requests arriving together are written once.
  const both = await Promise.all([voice.log({callId: b, cost: 0.2}), voice.log({callId: b, cost: 0.2})]);
  assert.deepEqual(both.map(r => r.saved).sort(), [false, true]);
  assert.deepEqual(
    (await costRows(root)).map(r => [r.callId, r.usd]),
    [
      [a, 0.5],
      [a, 0.8],
      [b, 0.2]
    ]
  );
  const month = await voice.monthCost();
  assert.equal(month.usd, 1);
  assert.equal(month.calls, 2);
  assert.equal(month.month, '2026-11');
  await voice.close();
  // Rebuilt from the file after a restart; a lower value after restart is still ignored.
  voice = createVoiceSecretary({root, rooms, now: time.now, rates: async () => fixedRates});
  assert.equal((await voice.monthCost()).usd, 1);
  assert.deepEqual(await voice.log({callId: a, cost: 0.6}), {saved: false});
  await voice.close();
});

test('a call belongs to the local month of its first cost event', async () => {
  const root = await tempRoot('month');
  const time = clock('2026-10-31T14:00:00Z'); // 22:00 on 10/31 in Taipei
  let voice = createVoiceSecretary({root, rooms, now: time.now, rates: async () => fixedRates});
  const october = 'call-oct-00001',
    november = 'call-nov-00002';
  await voice.log({callId: october, cost: 0.3});
  time.at = new Date('2026-10-31T16:30:00Z'); // 00:30 on 11/1 in Taipei, though still 10/31 in UTC
  await voice.log({callId: october, cost: 0.6}); // the same call carried on past midnight
  await voice.log({callId: november, cost: 0.2});
  time.at = new Date('2026-11-07T03:00:00Z');
  assert.deepEqual(
    {usd: (await voice.monthCost()).usd, calls: (await voice.monthCost()).calls},
    {usd: 0.2, calls: 1},
    'November holds only the call that started in November (local time)'
  );
  time.at = new Date('2026-10-31T15:00:00Z'); // 23:00 on 10/31 in Taipei
  const oct = await voice.monthCost();
  assert.equal(oct.month, '2026-10');
  assert.equal(oct.usd, 0.6, 'October holds the whole call that started there, at its highest value');
  await voice.close();
  // A new month with nothing spent and no voice connection: no row.
  time.at = new Date('2026-12-02T03:00:00Z');
  voice = createVoiceSecretary({root, rooms, connections: noConnection, now: time.now, rates: async () => fixedRates});
  assert.equal(await voice.monthCost(), null);
  await voice.close();
});

test('the row is hidden only with no voice connection and nothing this month', async () => {
  const time = clock('2026-11-07T03:00:00Z');
  const none = createVoiceSecretary({root: await tempRoot('hidden'), rooms, now: time.now, rates: async () => fixedRates});
  assert.equal(await none.monthCost(), null, 'connections not wired');
  await none.close();
  const empty = createVoiceSecretary({
    root: await tempRoot('empty'),
    rooms,
    connections: noConnection,
    now: time.now,
    rates: async () => fixedRates
  });
  assert.equal(await empty.monthCost(), null);
  await empty.close();
  const set = createVoiceSecretary({
    root: await tempRoot('set'),
    rooms,
    connections: voiceConnection,
    now: time.now,
    rates: async () => fixedRates
  });
  const zero = await settled(set);
  assert.equal(zero.usd, 0);
  assert.equal(zero.calls, 0);
  assert.equal(emmaMonthText(zero), '本月約 US$0.00 · 約 NT$0');
  await set.close();
  const spent = createVoiceSecretary({
    root: await tempRoot('spent'),
    rooms,
    connections: noConnection,
    now: time.now,
    rates: async () => fixedRates
  });
  await spent.log({callId: 'call-aaaa-0001', cost: 0.4});
  assert.equal((await spent.monthCost()).usd, 0.4, 'spent this month still shows after the connection is removed');
  await spent.close();
});

test('NT$ uses the daily CNY rates; without a rate only US$ is shown', async () => {
  const time = clock('2026-11-07T03:00:00Z');
  const fetched = [];
  // The default rate source is the same public daily rate DeepSeek uses, kept for 12 hours.
  const fetchImpl = async url => {
    fetched.push(String(url));
    return new Response(
      JSON.stringify({result: 'success', time_last_update_utc: fixedRates.updatedAt, rates: {TWD: 4.5, USD: 0.14}}),
      {status: 200}
    );
  };
  const voice = createVoiceSecretary({root: await tempRoot('fx'), rooms, connections: voiceConnection, now: time.now, fetchImpl});
  await voice.log({callId: 'call-aaaa-0001', cost: 1.25});
  const month = await settled(voice);
  assert.equal(month.usdToTwd, 4.5 / 0.14);
  assert.equal(month.fxUpdatedAt, fixedRates.updatedAt);
  await voice.monthCost();
  assert.deepEqual(fetched, ['https://open.er-api.com/v6/latest/CNY'], 'one lookup per 12 hours');
  assert.equal(emmaMonthText(month), '本月約 US$1.25 · 約 NT$40');
  assert.deepEqual(emmaMonthParts(month), ['本月約 US$1.25', '約 NT$40'], 'the sidebar wraps only between the two amounts');
  await voice.close();

  const offline = createVoiceSecretary({
    root: await tempRoot('fx-fail'),
    rooms,
    connections: voiceConnection,
    now: time.now,
    fetchImpl: async () => new Response('{}', {status: 503})
  });
  await offline.log({callId: 'call-aaaa-0001', cost: 1.25});
  const plain = await settled(offline);
  assert.equal(plain.usdToTwd, null);
  assert.equal(emmaMonthText(plain), '本月約 US$1.25');
  await offline.close();
  assert.equal(emmaMonthText({usd: 12.345, usdToTwd: 0}), '本月約 US$12.35');
  assert.equal(emmaMonthText({usd: 100, usdToTwd: 32.1}), '本月約 US$100.00 · 約 NT$3,210');
  assert.equal(emmaMonthText(null), '—');
});

test('a damaged cost line in the file is not counted', async () => {
  const root = await tempRoot('damaged');
  const time = clock('2026-11-07T03:00:00Z');
  const {mkdir, writeFile} = await import('node:fs/promises');
  await mkdir(path.join(root, '.runtime'), {recursive: true});
  const at = '2026-11-05T03:00:00.000Z';
  await writeFile(
    path.join(root, '.runtime/voice-secretary.jsonl'),
    [
      {type: 'cost', callId: 'call-ok-000001', usd: 0.5, at},
      {type: 'cost', callId: 'call-neg-00002', usd: -3, at},
      {type: 'cost', callId: 'call-big-00003', usd: 1e9, at},
      {type: 'cost', callId: 'call-str-00004', usd: '2', at},
      {type: 'cost', callId: 'call-time-0005', usd: 1, at: 'yesterday'}
    ]
      .map(row => JSON.stringify(row))
      .join('\n') + '\n',
    'utf8'
  );
  const voice = createVoiceSecretary({root, rooms, now: time.now, rates: async () => fixedRates});
  const month = await voice.monthCost();
  assert.equal(month.usd, 0.5);
  assert.equal(month.calls, 1);
  await voice.close();
});

test('the conversation controller adds the monthly estimate to the shared usage', async () => {
  const root = await tempRoot('controller');
  const realFetch = globalThis.fetch;
  // The rate lookup must not leave the machine during tests.
  globalThis.fetch = async () => new Response('{}', {status: 503});
  const cc = createConversationController({
    root,
    sessionFactory: () => ({
      state: {provider: 'codex', status: 'ready', workspace: root, threadId: null, title: '', busy: false, messages: [], usage: {}},
      async models() {
        return {models: []};
      },
      async usage() {
        return {codex: {status: 'ready', windows: []}};
      },
      async workers() {
        return [];
      },
      async close() {}
    })
  });
  try {
    assert.equal((await cc.usage()).emma, null, 'no connection and nothing spent: no row');
    await cc.voice.log({callId: 'call-ctrl-00001', cost: 0.75});
    const usage = await cc.usage();
    assert.deepEqual(usage.codex, {status: 'ready', windows: []});
    assert.equal(usage.emma.usd, 0.75);
    assert.equal(usage.emma.usdToTwd, null);
    assert.equal(cc.state.usage.emma.usd, 0.75, 'the sidebar state carries it too');
  } finally {
    await cc.close();
    globalThis.fetch = realFetch;
  }
});

test('re-review: the rate never holds up the estimate, and a failed refresh shows no old rate', async () => {
  const time = clock('2026-11-07T03:00:00Z');
  // A rate site that does not answer: the US$ estimate still comes back at once.
  const hanging = createVoiceSecretary({
    root: await tempRoot('fx-hang'),
    rooms,
    connections: voiceConnection,
    now: time.now,
    rates: () => new Promise(() => {})
  });
  await hanging.log({callId: 'call-aaaa-0001', cost: 0.5});
  const first = await Promise.race([hanging.monthCost(), new Promise(resolve => setTimeout(() => resolve('blocked'), 200))]);
  assert.notEqual(first, 'blocked', 'the estimate did not wait for the rate');
  assert.equal(first.usd, 0.5);
  assert.equal(first.usdToTwd, null);
  await hanging.close();

  // A good rate, then 13 hours later the site fails: US$ only, and no new lookup for 10 minutes.
  let calls = 0,
    fail = false;
  const voice = createVoiceSecretary({
    root: await tempRoot('fx-stale'),
    rooms,
    connections: voiceConnection,
    now: time.now,
    rates: async () => {
      calls++;
      if (fail) throw Error('offline');
      return fixedRates;
    }
  });
  await voice.log({callId: 'call-aaaa-0001', cost: 0.5});
  assert.equal((await settled(voice)).usdToTwd, 4.5 / 0.14);
  time.at = new Date(time.at.getTime() + 13 * 60 * 60 * 1000);
  fail = true;
  assert.equal((await settled(voice)).usdToTwd, null, 'no old rate after a failed refresh');
  const tried = calls;
  time.at = new Date(time.at.getTime() + 5 * 60 * 1000);
  await settled(voice);
  assert.equal(calls, tried, 'not tried again within 10 minutes');
  time.at = new Date(time.at.getTime() + 6 * 60 * 1000);
  fail = false;
  assert.equal((await settled(voice)).usdToTwd, 4.5 / 0.14, 'tried again after 10 minutes');
  await voice.close();
});
