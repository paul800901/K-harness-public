import test from 'node:test';
import assert from 'node:assert/strict';
import {extraQuotaLines, quotaGroupName, quotaIsHistorical, quotaPercent, quotaCountdown, quotaReset, weeklyQuotaNote} from '../frontend/quota-display.mjs';
test('quota display separates history and unknown from a current zero balance', () => {
  assert.equal(quotaIsHistorical({status: 'ready'}), false);
  assert.equal(quotaIsHistorical({status: 'available'}), false);
  assert.equal(quotaIsHistorical({status: 'stale'}), true);
  assert.equal(quotaIsHistorical({status: 'ready'}, false), true);
  assert.equal(quotaIsHistorical(), true);
  assert.equal(quotaPercent({remainingPercent: 0}), '0%');
  assert.equal(quotaPercent({remainingPercent: 100}), '100%');
  assert.equal(quotaPercent({remainingPercent: null}), '—');
});

test('fractional official quota is compact without rounding a positive balance to zero or mutating data', () => {
  for (const [remainingPercent, expected] of [
    [65.86091499999999, '65.9%'],
    [53.97934, '54%'],
    [3.9427582, '3.9%'],
    [85.88634, '85.9%'],
    [0.01, '<0.1%'],
    [0.1, '0.1%'],
    [0, '0%'],
    [100, '100%']
  ]) {
    const window = Object.freeze({remainingPercent});
    assert.equal(quotaPercent(window), expected);
    assert.equal(window.remainingPercent, remainingPercent);
  }
});
test('expired reset stays historical, never rolls forward or invents replenishment', () => {
  const w = {remainingPercent: 0, resetsAt: 1791237484},
    now = w.resetsAt * 1000 + 1;
  assert.match(quotaReset(w, now), /（已過）$/u);
  assert.doesNotMatch(quotaReset(w, now - 2), /已過/u);
  assert.equal(w.remainingPercent, 0);
  assert.equal(w.resetsAt, 1791237484);
  assert.equal(quotaReset({}), '官方未提供');
  // A fresh official quota remains usable even if its reported reset is in the past.
  assert.equal(
    quotaIsHistorical({status: 'ready', checkedAt: new Date(now).toISOString(), windows: [w]}, true, now),
    false
  );
});
test('display follows the official reset, not a 60-second or five-minute expiry', () => {
  const checked = Date.parse('2026-10-07T00:00:00Z'),
    reset = checked + 7 * 86400000;
  const quota = {
    status: 'ready',
    checkedAt: new Date(checked).toISOString(),
    windows: [{remainingPercent: 0, resetsAt: reset / 1000}]
  };
  for (const elapsed of [60000, 300000, 86400000])
    assert.equal(quotaIsHistorical(quota, true, checked + elapsed), false);
  assert.equal(quotaIsHistorical(quota, true, reset), true);
  assert.equal(quotaIsHistorical({...quota, checkedAt: new Date(reset + 1).toISOString()}, true, reset + 1), false);
  assert.equal(quota.windows[0].remainingPercent, 0, 'never infer replenishment');
});

test('weekly exhaustion is dated evidence and never rewrites the independent five-hour balance', () => {
  const now = Date.parse('2026-10-09T05:30:00+08:00'),
    quota = {
      status: 'ready',
      checkedAt: '2026-10-09T04:56:00+08:00',
      windows: [
        {key: 'seven_day', remainingPercent: 0, resetsAt: now / 1000 + 3600},
        {key: 'five_hour', remainingPercent: 100, resetsAt: null}
      ]
    };
  const original = structuredClone(quota);
  assert.equal(weeklyQuotaNote(quota, true, now), '上次實查：每週額度已用完');
  assert.equal(quotaPercent(quota.windows[1]), '100%');
  assert.equal(quotaReset(quota.windows[1]), '官方未提供');
  assert.deepEqual(quota, original);
  for (const status of ['stale', 'unavailable']) assert.equal(weeklyQuotaNote({...quota, status}, true, now), null);
  assert.equal(weeklyQuotaNote(quota, false, now), null);
  assert.equal(weeklyQuotaNote({...quota, checkedAt: null}, true, now), null);
  assert.equal(
    weeklyQuotaNote(
      {...quota, windows: [{key: 'seven_day', remainingPercent: 0, resetsAt: now / 1000 - 1}]},
      true,
      now
    ),
    null
  );
  assert.equal(weeklyQuotaNote({...quota, windows: [{key: 'seven_day', remainingPercent: 50}]}, true, now), null);
});

test('disabled quota is distinct from a missing percentage and never claims an unlimited or replenished balance', () => {
  const window = {key: 'five_hour', disabled: true, remainingPercent: null, resetsAt: null},
    before = structuredClone(window);
  assert.equal(quotaPercent(window), '未啟用');
  assert.equal(quotaReset(window), '不適用（官方未啟用）');
  assert.equal(quotaPercent(undefined), '—');
  assert.equal(quotaPercent({remainingPercent: 100}), '100%');
  assert.deepEqual(window, before);
  const quota = {
    status: 'ready',
    checkedAt: '2026-10-09T05:57:29Z',
    windows: [{key: 'seven_day', remainingPercent: 0, resetsAt: Date.parse('2026-10-11T13:01:05Z') / 1000}, window]
  };
  assert.equal(weeklyQuotaNote(quota, true, Date.parse('2026-10-09T06:00:00Z')), '上次實查：每週額度已用完');
});

test('reset countdown shows the time left and nothing once the reset is unknown or past', () => {
  const now = Date.parse('2026-11-06T12:02:00+08:00');
  const at = iso => ({resetsAt: Date.parse(iso) / 1000});
  assert.equal(quotaCountdown(at('2026-11-06T14:00:00+08:00'), now), '還有 1 小時 58 分');
  assert.equal(quotaCountdown(at('2026-11-10T11:00:00+08:00'), now), '還有 3 天 22 小時');
  assert.equal(quotaCountdown(at('2026-11-06T12:02:30+08:00'), now), '還有 1 分');
  assert.equal(quotaCountdown(at('2026-11-06T12:01:00+08:00'), now), null);
  assert.equal(quotaCountdown({resetsAt: null}, now), null);
  assert.equal(quotaCountdown({...at('2026-11-10T11:00:00+08:00'), disabled: true}, now), null);
});

test('extra official quota groups show translated names and their windows', () => {
  assert.equal(quotaGroupName('Claude and GPT models'), 'Claude／GPT 模型');
  assert.equal(quotaGroupName('Gemini 4 Argon'), 'Gemini 4 Argon');
  assert.deepEqual(extraQuotaLines({windows: []}), []);
  const [line] = extraQuotaLines({
    extra: [{name: 'Gemini 4 Argon', windows: [{key: 'seven_day', label: '每週', remainingPercent: 0.7489}]}]
  });
  assert.equal(line.name, 'Gemini 4 Argon');
  assert.equal(line.text, '每週 0.7%');
});

test('each extra group is historical by its own reset, not by the main windows', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const quota = {
    status: 'ready',
    checkedAt: '2026-11-10T10:00:00Z',
    windows: [{key: 'seven_day', remainingPercent: 50, resetsAt: Date.parse('2026-11-17T05:00:00Z') / 1000}],
    extra: [
      {name: 'Past', windows: [{key: 'seven_day', label: '每週', remainingPercent: 0, resetsAt: Date.parse('2026-11-16T16:00:00Z') / 1000}]},
      {name: 'Current', windows: [{key: 'seven_day', label: '每週', remainingPercent: 10, resetsAt: Date.parse('2026-11-18T00:00:00Z') / 1000}]}
    ]
  };
  assert.equal(quotaIsHistorical(quota, true, now), false);
  assert.deepEqual(extraQuotaLines(quota, true, now).map(g => g.historical), [true, false]);
  const mainPast = {...quota, windows: [{key: 'seven_day', remainingPercent: 50, resetsAt: Date.parse('2026-11-16T00:00:00Z') / 1000}]};
  assert.equal(quotaIsHistorical(mainPast, true, now), true);
  assert.equal(extraQuotaLines(mainPast, true, now)[1].historical, false);
  assert.deepEqual(extraQuotaLines({...quota, status: 'stale'}, true, now).map(g => g.historical), [true, true]);
  assert.deepEqual(extraQuotaLines(quota, false, now).map(g => g.historical), [true, true]);
});
