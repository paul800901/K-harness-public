// Built UI, fake self-update API, disposable headless browser. Nothing is updated or restarted.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';
import path from 'node:path';

const output = probeEvidenceDir('self-update-probe');
await mkdir(output, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 5195, strictPort: true}});
const state = {
  threadId: null,
  workspace: process.cwd(),
  status: 'idle',
  busy: false,
  messages: [],
  tools: [],
  questions: [],
  artifacts: [],
  accessMode: 'workspace-write',
  provider: 'codex',
  capabilities: {},
  conversationActivity: []
};
let browser,
  update = {available: false, updating: false, failed: null},
  answer = {status: 409, json: {error: '還有工作在跑，等結束再按。', busy: ['聊天室：測試 / 第一房 agy 背景程序保留中', 'Gemini 帳號額度查詢中']}},
  failStatusReads = 0,
  holdNextRead;
const posts = [],
  errors = [];
async function open(viewport, {disconnected = false} = {}) {
  const page = await browser.newPage({viewport});
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(
    ([initial, disconnected]) => {
      // Counts page loads; the first load starts as if this device had just pressed update.
      const loads = Number(localStorage.getItem('probe-loads') || 0) + 1;
      localStorage.setItem('probe-loads', String(loads));
      if (disconnected && loads === 1) sessionStorage.setItem('k-self-update-at', String(Date.now()));
      window.EventSource = class {
        constructor() {
          setTimeout(
            () =>
              disconnected && loads === 1
                ? this.onerror?.()
                : this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: initial})}),
            0
          );
        }
        close() {}
      };
    },
    [state, disconnected]
  );
  await page.route('**/api/**', async route => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === '/api/self-update' && request.method() === 'POST') {
      posts.push(request.postDataJSON());
      return route.fulfill({status: answer.status, json: answer.json});
    }
    if (url.pathname === '/api/self-update' && holdNextRead) {
      const hold = holdNextRead;
      holdNextRead = null;
      return hold(route);
    }
    if (url.pathname === '/api/self-update' && failStatusReads > 0) {
      failStatusReads--;
      return route.fulfill({status: 503, json: {error: 'K 正在關閉，請稍後重試。'}});
    }
    let body = {};
    if (url.pathname === '/api/self-update') body = update;
    else if (url.pathname === '/api/state') body = state;
    else if (url.pathname === '/api/projects') body = {projects: [{path: process.cwd(), name: '假工作區'}]};
    else if (url.pathname === '/api/sessions') body = {sessions: []};
    else if (url.pathname === '/api/models') body = {models: []};
    await route.fulfill({json: body});
  });
  await page.goto('http://127.0.0.1:5195');
  if (disconnected) return page;
  // The phone keeps the sidebar folded until it is opened.
  await page.getByRole('button', {name: viewport.width < 700 ? '展開側欄' : '設定', exact: true}).waitFor();
  return page;
}
const updateButton = page => page.locator('.sidebar-settings-row').getByRole('button', {name: '更新', exact: true});
try {
  browser = await launchProbeBrowser();
  const page = await open({width: 1440, height: 1000});
  assert.equal(await updateButton(page).count(), 0, 'no button while nothing is ready');

  update = {available: true, updating: false, failed: null};
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await updateButton(page).waitFor();
  const settingsBox = await page.getByRole('button', {name: '設定', exact: true}).boundingBox(),
    updateBox = await updateButton(page).boundingBox();
  assert.ok(updateBox.x > settingsBox.x + settingsBox.width - 1, 'update sits to the right of settings');
  assert.ok(Math.abs(updateBox.y + updateBox.height / 2 - (settingsBox.y + settingsBox.height / 2)) < 4, 'same row');
  await page.screenshot({path: path.join(output, 'desktop-ready.png')});

  await updateButton(page).click();
  await page.locator('.self-update-notice').getByText('還有工作在跑，等結束再按。').waitFor();
  assert.equal(await page.locator('.self-update-notice').innerText(), [answer.json.error, ...answer.json.busy].join('\n'));
  await page.screenshot({path: path.join(output, 'desktop-busy.png')});
  assert.deepEqual(posts, [{}], 'one request with an empty body; the version is chosen by K');

  answer = {status: 200, json: {started: true}};
  update = {available: true, updating: true, failed: null};
  await updateButton(page).click();
  await page.locator('.self-update-notice').getByText('K 更新中…').waitFor();
  assert.equal(await updateButton(page).isDisabled(), true, 'no second press while updating');
  assert.ok(await page.evaluate(() => Number(sessionStorage.getItem('k-self-update-at')) > 0));
  // The owner can reject its close without dropping the existing SSE connection.
  update = {available: true, updating: false, failed: {reason: 'K 關閉未完成，更新尚未開始。請再按「更新」重試。'}};
  await page
    .locator('.self-update-failed')
    .getByText('上次更新沒成功：' + update.failed.reason)
    .waitFor({timeout: 12000});
  assert.equal(await updateButton(page).isDisabled(), false);
  assert.equal(await page.locator('.self-update-notice').count(), 0, 'failure replaces the stale updating notice');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('k-self-update-at')), null);
  assert.equal(posts.length, 2, 'status recovery does not send another update request');
  // An old failure response already in flight must not clear the person's newly accepted retry.
  const oldFailure = update;
  let releaseRead;
  const held = new Promise(resolve => {
    holdNextRead = route =>
      new Promise(done => {
        releaseRead = async () => {
          await route.fulfill({json: oldFailure});
          done();
        };
        resolve();
      });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await held;
  update = {available: true, updating: true, failed: null};
  await updateButton(page).click();
  await page.locator('.self-update-notice').getByText('K 更新中…').waitFor();
  await releaseRead();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await updateButton(page).isDisabled(), true, 'late failure cannot unlock an accepted retry');
  assert.ok(await page.evaluate(() => Number(sessionStorage.getItem('k-self-update-at')) > 0));
  assert.equal(posts.length, 3);
  await page.close();

  update = {available: true, updating: false, failed: {reason: '測試未通過', finishedAt: '2026-10-24T00:00:00.000Z'}};
  const phone = await open({width: 390, height: 844});
  await phone.getByRole('button', {name: '展開側欄', exact: true}).click();
  await updateButton(phone).waitFor();
  await phone.locator('.self-update-failed').getByText('上次更新沒成功：測試未通過').waitFor();
  await phone.screenshot({path: path.join(output, 'phone-failed.png')});
  answer = {status: 409, json: {error: '還有工作在跑，等結束再按。'}};
  await updateButton(phone).click();
  await phone.locator('.self-update-notice').getByText(answer.json.error).waitFor();
  const focusedRead = phone.waitForResponse(
    response => response.url().endsWith('/api/self-update') && response.request().method() === 'GET'
  );
  await phone.evaluate(() => window.dispatchEvent(new Event('focus')));
  await focusedRead;
  await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(
    await phone.locator('.self-update-notice').textContent(),
    answer.json.error,
    'old failure keeps the newer busy reason'
  );
  await phone.close();

  // While K restarts: a calm notice instead of the disconnect alarm, no reload while K still reports
  // updating, then exactly one reload once it is back and finished, with the marker cleared.
  update = {available: true, updating: true, failed: null};
  const waiting = await open({width: 390, height: 844}, {disconnected: true});
  await waiting
    .getByText('K 更新中，大概要 2～3 分鐘。這個畫面留著不用動，K 回來會自己重新整理；先離開也可以，等一下再開。')
    .waitFor();
  await waiting.waitForTimeout(6000);
  assert.equal(await waiting.evaluate(() => localStorage.getItem('probe-loads')), '1', 'no reload while updating');
  // K is finished, but the first status read after it answers again fails: the next one still reloads.
  update = {available: false, updating: false, failed: null};
  failStatusReads = 1;
  await waiting.waitForFunction(() => localStorage.getItem('probe-loads') === '2', null, {timeout: 20000});
  await waiting.getByRole('button', {name: '展開側欄', exact: true}).waitFor();
  await waiting.waitForTimeout(6000);
  assert.equal(await waiting.evaluate(() => localStorage.getItem('probe-loads')), '2', 'reloaded exactly once');
  assert.equal(await waiting.evaluate(() => sessionStorage.getItem('k-self-update-at')), null);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      hiddenWhenNotReady: true,
      besideSettings: true,
      busyRefusal: true,
      phone: true,
      output
    })
  );
} finally {
  await browser?.close();
  await server.httpServer.close();
}
