// Built remote UI with synthetic accounts and intercepted HTTP/SSE only; no login or provider calls.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';

const output = probeEvidenceDir('mobile-gemini-switch-20261114');
await mkdir(output, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 5198, strictPort: true}});
const accounts = ['a', 'b', 'c', 'd'].map((id, i) => ({
  id,
  email: `account-${id}@example.test`,
  auth: {status: ['authenticated', 'authenticated', 'signed-out', 'unknown'][i]},
  quota: {
    status: 'ready',
    checkedAt: new Date().toISOString(),
    windows: [
      {key: 'seven_day', minutes: 10080, remainingPercent: 80 - i * 10},
      {key: 'five_hour', minutes: 300, remainingPercent: 90 - i * 10}
    ]
  }
}));
const state = {
  threadId: null,
  workspace: process.cwd(),
  status: 'idle',
  busy: false,
  messages: [],
  tools: [],
  questions: [],
  artifacts: [],
  capabilities: {},
  provider: 'codex',
  accessMode: 'workspace-write',
  conversationActivity: [],
  usage: {}
};
function selectAccount(id) {
  const active = accounts.find(a => a.id === id);
  state.usage.gemini = {...active.quota, accountId: id, accountEmail: active.email, accounts};
}
selectAccount('a');
let browser, page, heldActivation, heldRefresh, heldRefreshAll;
let mode = 'success',
  holdRefresh = false;
const requests = [],
  errors = [],
  receipt = {passed: false, checks: []};
const send = () =>
  page.evaluate(
    next =>
      window.fixtureEvents.onmessage({
        data: JSON.stringify({type: 'snapshot', state: next})
      }),
    state
  );
try {
  browser = await launchProbeBrowser();
  page = await browser.newPage({viewport: {width: 360, height: 844}, isMobile: true, hasTouch: true});
  page.setDefaultTimeout(5000);
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(initial => {
    localStorage.setItem('k-theme', 'warm');
    window.EventSource = class {
      constructor() {
        window.fixtureEvents = this;
        setTimeout(() => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: initial})}), 0);
      }
      close() {}
    };
  }, state);
  await page.route('http://127.0.0.1:5198/', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text()).replace('<html ', '<html data-k-remote="true" ')});
  });
  await page.route('**/api/**', async route => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() === 'POST') requests.push({path: url.pathname, body: req.postDataJSON(), headers: req.headers()});
    if (url.pathname === '/api/gemini/accounts/activate') {
      if (mode === 'busy')
        return route.fulfill({status: 400, json: {error: 'Gemini 正在工作；請等全部工作結束後再操作。'}});
      if (mode === 'lost') return route.abort('failed');
      const target = req.postDataJSON().accountId;
      selectAccount(target);
      await send();
      if (mode === 'partial') return route.fulfill({status: 400, json: {error: '切換後額度查詢未完成。'}});
      const result = structuredClone({accounts, activeAccountId: target});
      if (mode === 'held')
        await new Promise(resolve => {
          heldActivation = resolve;
        });
      return route.fulfill({json: result});
    }
    if (url.pathname === '/api/usage') {
      const result = structuredClone(state.usage);
      if (url.search === '?refresh=1' && holdRefresh)
        await new Promise(resolve => {
          heldRefresh = resolve;
        });
      return route.fulfill({json: result});
    }
    if (url.pathname === '/api/gemini/accounts/refresh-all') {
      const result = structuredClone({
        activeAccountId: state.usage.gemini.accountId,
        accounts,
        note: '已查詢全部帳號。'
      });
      if (holdRefresh)
        await new Promise(resolve => {
          heldRefreshAll = resolve;
        });
      return route.fulfill({json: result});
    }
    const result =
      url.pathname === '/api/state'
        ? state
        : url.pathname === '/api/projects'
          ? {projects: []}
          : url.pathname === '/api/sessions'
            ? {sessions: []}
            : url.pathname === '/api/models'
              ? {models: []}
              : {};
    return route.fulfill({json: result});
  });
  await page.goto('http://127.0.0.1:5198');
  await page.getByRole('button', {name: '展開側欄', exact: true}).click();
  await page.locator('.usage-folded').click();
  await page.getByRole('button', {name: '設定', exact: true}).click();
  await page.getByRole('button', {name: '查看／更新額度', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '額度與用量', exact: true});
  const row = id => dialog.locator(`[data-account-id="${id}"]`);
  const switchButton = id => row(id).getByRole('button', {name: '切換使用此帳號', exact: true});
  const refresh = dialog.getByRole('button', {name: '更新額度與用量', exact: true});
  const checkCurrent = async id => {
    await row(id).locator('.usage-current').waitFor();
    assert.equal(await dialog.locator('.usage-current').count(), 1);
    assert.equal(await page.locator('.usage-account-email').textContent(), `account-${id}@example.test`);
  };
  await checkCurrent('a');
  assert.equal(await row('a').locator('button').count(), 0);
  assert.equal(await row('c').locator('button').count(), 0);
  assert.equal(await row('d').locator('button').count(), 0);
  assert.equal(await switchButton('b').isVisible(), false);
  await row('b').locator('summary').tap();
  assert.equal(await switchButton('b').isVisible(), true);
  receipt.checks.push('手機設定可開啟額度詳情；只有非目前且已驗證帳號展開後顯示切換按鈕');
  for (const width of [360, 412]) {
    await page.setViewportSize({width, height: 844});
    await switchButton('b').scrollIntoViewIfNeeded();
    const box = await switchButton('b').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 844);
    assert.ok(box.height >= 44);
    assert.ok(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const style = await switchButton('b').evaluate(e => {
      const s = getComputedStyle(e);
      return {border: s.borderTopWidth, borderStyle: s.borderTopStyle, background: s.backgroundColor};
    });
    assert.ok(parseFloat(style.border) >= 1 && style.borderStyle !== 'none');
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
    await page.screenshot({path: path.join(output, `switch-${width}.png`)});
  }
  receipt.checks.push('360／412px 無水平溢出；按鈕在可視範圍、高至少 44px、有邊框及底色');
  mode = 'held';
  await switchButton('b').tap();
  await checkCurrent('b');
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/gemini/accounts/activate');
  assert.deepEqual(requests[0].body, {accountId: 'b'});
  assert.equal(requests[0].headers['x-k-request'], '1');
  assert.match(requests[0].headers['x-k-command'], /^[\da-f-]{36}$/u);
  // Another device switches back before this command's older HTTP reply arrives.
  selectAccount('a');
  await send();
  await checkCurrent('a');
  heldActivation();
  await dialog.getByRole('status').filter({hasText: '帳號切換已完成'}).waitFor();
  await checkCurrent('a');
  assert.equal(await refresh.isEnabled(), true);
  receipt.checks.push('切換送出正確 accountId 與唯一命令識別；側欄與徽章同步，晚到的切換回應不覆蓋新廣播');
  mode = 'success';
  await switchButton('b').tap();
  await checkCurrent('b');
  await row('a').locator('summary').tap();
  await switchButton('a').waitFor();
  receipt.checks.push('成功切換後目前帳號不再提供切換鈕，原帳號可供切回');
  mode = 'busy';
  const beforeBusy = requests.length;
  await switchButton('a').tap();
  await dialog.getByRole('alert').filter({hasText: 'Gemini 正在工作'}).waitFor();
  await checkCurrent('b');
  assert.equal(requests.length, beforeBusy + 1);
  mode = 'lost';
  const beforeLost = requests.length;
  await switchButton('a').tap();
  await dialog.getByRole('alert').filter({hasText: '未收到切換結果'}).waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /未自動重送/u);
  assert.equal(requests.length, beforeLost + 1);
  receipt.checks.push('工作中拒絕與斷線結果不明皆顯示中文，不自動重送');
  mode = 'partial';
  await switchButton('a').tap();
  await dialog.getByRole('alert').filter({hasText: '切換後額度查詢未完成'}).waitFor();
  await checkCurrent('a');
  receipt.checks.push('切換後查詢失敗仍以廣播顯示實際帳號，不宣稱切換未發生');
  holdRefresh = true;
  const refreshRequested = page.waitForRequest(r => r.url().includes('/api/usage?refresh=1'));
  await refresh.click();
  await refreshRequested;
  assert.equal(await switchButton('b').isDisabled(), true);
  selectAccount('b');
  await send();
  await checkCurrent('b');
  const allRequested = page.waitForRequest(r => r.url().includes('/api/gemini/accounts/refresh-all'));
  heldRefresh();
  await allRequested;
  // Assert while refresh-all is still pending, so a later reply cannot hide a stale intermediate badge.
  await checkCurrent('b');
  selectAccount('a');
  await send();
  await checkCurrent('a');
  heldRefreshAll();
  await dialog.getByRole('status').filter({hasText: '已查詢全部帳號'}).waitFor();
  await checkCurrent('a');
  receipt.checks.push('更新額度期間禁用切換；晚到的舊額度回應不覆蓋新帳號');
  state.usage.gemini.checking = {current: 1, total: 4};
  await send();
  await dialog.getByText('正在查詢 1／4').waitFor();
  assert.equal(await switchButton('b').isDisabled(), true);
  delete state.usage.gemini.checking;
  await send();
  await page.evaluate(() => window.fixtureEvents.onerror());
  await page.waitForFunction(() => document.querySelector('.usage-toolbar button').disabled);
  assert.equal(await switchButton('b').isDisabled(), true);
  receipt.checks.push('全部帳號查詢與離線時禁用切換');
  assert.equal(new Set(requests.map(r => r.headers['x-k-command'])).size, requests.length);
  assert.ok(
    requests.every(r => ['/api/gemini/accounts/activate', '/api/gemini/accounts/refresh-all'].includes(r.path))
  );
  assert.deepEqual(errors, []);
  receipt.passed = true;
} catch (error) {
  receipt.error = error.stack;
  throw error;
} finally {
  heldActivation?.();
  heldRefresh?.();
  heldRefreshAll?.();
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
  await writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
