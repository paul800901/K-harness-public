import assert from 'node:assert/strict';
import test from 'node:test';
import {createOfficialGeminiAccount} from '../src/gemini-official-account.mjs';

test('an old quota read cannot survive an official account change', async () => {
  const oldRead = Promise.withResolvers();
  const oldQuota = {status: 'ready', windows: [{remainingPercent: 0, resetsAt: Date.now() / 1000 + 3600}]};
  let getStatus = () => oldRead.promise;
  const account = createOfficialGeminiAccount({status: () => getStatus()});
  const pending = account.usage(true);
  let loginStarted = false;
  const login = account.change('login', async () => { loginStarted = true; });
  assert.throws(() => account.assertStable(), /帳號/);
  assert.equal(loginStarted, false);
  oldRead.resolve({auth: {status: 'authenticated'}, quota: oldQuota});
  await Promise.all([login, pending]);
  assert.deepEqual(account.quota.windows, []);
  await assert.rejects(account.change('logout', async () => assert.fail()), /狀態/);
  await account.change('finish', async () => {});
  const newQuota = {status: 'ready', windows: [{remainingPercent: 70}]};
  getStatus = () => ({auth: {status: 'authenticated'}, quota: newQuota});
  assert.deepEqual(await account.usage(), newQuota);
  getStatus = () => ({auth: {status: 'signed-out'}, reason: '請登入'});
  assert.deepEqual((await account.usage(true)).windows, []);
  assert.equal(account.quota.checkedAt, null);
});
