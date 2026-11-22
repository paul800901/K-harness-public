// Emma's monthly cost estimate in the sidebar "remaining quota" block (2026-11-07): one row under DeepSeek, aligned
// with the other rows at desktop and phone widths; US$ only without a rate; no row when K sends none.
// Built UI with fake state; nothing leaves this machine.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';

const output = probeEvidenceDir('voice-emma-month-cost-20261107');
await mkdir(output, {recursive: true});
const root = path.resolve(import.meta.dirname, '..');
const server = await preview({configFile: path.join(root, 'vite.config.mjs'), preview: {host: '127.0.0.1', port: 0}});
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');

const checkedAt = new Date().toISOString();
const windows = (weekly, hourly) => [
  {key: 'seven_day', minutes: 10080, remainingPercent: weekly},
  {key: 'five_hour', minutes: 300, remainingPercent: hourly}
];
const usage = {
  codex: {status: 'ready', checkedAt, windows: windows(72, 95)},
  claude: {status: 'ready', checkedAt, windows: windows(61, 88)},
  gemini: {status: 'ready', checkedAt, windows: windows(97, 100), accountEmail: 'owner@example.test'},
  grok: {status: 'ready', checkedAt, windows: [{key: 'weekly', minutes: 10080, remainingPercent: 80}]},
  deepseek: {status: 'available', checkedAt, windows: [], balance: {available: true, cny: 36.45, usd: 0}, fx: {twdPerCny: 4.52, usdPerCny: 0.14}},
  emma: {month: '2026-11', usd: 1.25, calls: 3, usdToTwd: 4.5 / 0.14, fxUpdatedAt: null}
};
const state = {
  threadId: 'room-main',
  title: '範例官網與社群文案的長標題聊天室',
  workspace: process.cwd(),
  provider: 'claude',
  model: 'claude-opus-5-5',
  status: 'ready',
  busy: false,
  messages: [],
  tools: [],
  questions: [],
  notices: [],
  artifacts: [],
  capabilities: {},
  conversationActivity: [],
  workerActivity: {running: 0},
  usage
};

let browser;
const errors = [];
try {
  browser = await launchProbeBrowser();
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(initial => {
    localStorage.setItem('k-appearance', JSON.stringify({interfaceScale: 100, dialogueFontSize: 16}));
    localStorage.setItem('k-color-theme', 'warm');
    window.EventSource = class {
      constructor() {
        window.fixtureEvents = this;
        setTimeout(() => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: initial})}), 0);
      }
      close() {}
    };
  }, state);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const body =
      url.pathname === '/api/state'
        ? state
        : url.pathname === '/api/usage'
          ? usage
          : url.pathname === '/api/sessions'
            ? {sessions: [{threadId: 'room-main', title: state.title, workspace: process.cwd(), model: state.model, archived: false}]}
            : url.pathname === '/api/projects'
              ? {projects: [{path: process.cwd(), name: '主要工作區'}]}
              : url.pathname === '/api/models'
                ? {models: []}
                : {};
    await route.fulfill({json: body});
  });
  const snapshot = next => page.evaluate(s => window.fixtureEvents.onmessage({data: JSON.stringify({type: 'snapshot', state: s})}), next);
  await page.goto(origin);
  const summary = page.locator('.usage-summary');
  const emma = summary.locator('.usage-row').filter({hasText: '艾瑪'});
  const text = async () => (await emma.innerText()).replace(/\s+/gu, ' ').trim();

  // The quota card starts folded to its title; one click opens it and the chevron folds it again.
  const folded = page.locator('.usage-summary.usage-folded');
  await folded.waitFor();
  assert.equal(await emma.count(), 0, 'rows hidden while folded');
  await page.screenshot({path: path.join(output, 'desktop-1280-folded.png')});
  await folded.click();
  await page.locator('.usage-fold').click();
  await folded.waitFor();
  await folded.click();

  // Each row: the name column starts where the others do, values end at the same right edge, nothing clipped.
  const aligned = async label => {
    const rows = await summary.locator('.usage-row').evaluateAll(els =>
      els.map(el => {
        const name = el.querySelector('.usage-provider').getBoundingClientRect(),
          values = el.querySelector('.usage-values');
        const v = values.getBoundingClientRect();
        return {
          text: el.innerText.replace(/\s+/gu, ' ').trim(),
          nameLeft: name.left,
          valuesRight: v.right,
          rowRight: el.getBoundingClientRect().right,
          clipped: values.scrollWidth > values.clientWidth + 1 || el.scrollWidth > el.clientWidth + 1
        };
      })
    );
    const box = await summary.boundingBox();
    const last = rows.at(-1);
    assert.match(last.text, /^艾瑪 /u, `${label}: Emma is the last row`);
    for (const row of rows) {
      assert(Math.abs(row.nameLeft - rows[0].nameLeft) < 1, `${label}: ${row.text} name aligned`);
      assert(Math.abs(row.valuesRight - rows[0].valuesRight) < 1, `${label}: ${row.text} values aligned`);
      assert(!row.clipped, `${label}: ${row.text} not clipped`);
      assert(row.rowRight <= box.x + box.width + 1, `${label}: ${row.text} inside the block`);
    }
    const [emmaBox, deepseekBox] = await Promise.all([emma.boundingBox(), summary.locator('.usage-row').filter({hasText: 'DeepSeek'}).boundingBox()]);
    assert(emmaBox.height <= deepseekBox.height * 2 + 1, `${label}: Emma row at most two lines (${emmaBox.height}px)`);
    // A narrow sidebar may wrap between US$ and NT$, never inside either amount.
    const pieces = await emma.locator('.usage-nowrap').evaluateAll(els => els.map(el => el.getClientRects().length));
    assert(pieces.length >= 1 && pieces.every(n => n === 1), `${label}: each amount stays on one line (${pieces})`);
    return {emma: emmaBox, deepseek: deepseekBox};
  };

  await emma.waitFor();
  assert.equal(await text(), '艾瑪 本月約 US$1.25 · 約 NT$40');
  await aligned('1280px');
  await summary.screenshot({path: path.join(output, 'desktop-1280-usage.png')});
  await page.screenshot({path: path.join(output, 'desktop-1280.png')});

  // The quota dialog opened from the block: Emma's month comes first, above every subscription.
  await summary.click();
  const details = page.locator('.usage-details');
  await details.waitFor();
  const firstSection = details.locator('.usage-provider-section').first();
  assert.match(await firstSection.getAttribute('aria-label'), /^艾瑪/u, 'Emma is the first section');
  await firstSection.getByText('本月約 US$1.25 · 約 NT$40', {exact: true}).waitFor();
  await firstSection.getByText('通話', {exact: false}).waitFor();
  assert.match(await firstSection.innerText(), /通話\s*3\s*通/u);
  await page.screenshot({path: path.join(output, 'desktop-1280-quota-dialog.png')});
  await page.keyboard.press('Escape');
  await details.waitFor({state: 'detached'});

  for (const width of [360, 412]) {
    await page.setViewportSize({width, height: width === 360 ? 780 : 915});
    await page.waitForTimeout(200);
    const expand = page.locator('button[title="展開側欄"]:visible').first();
    if (await expand.count()) await expand.click();
    if (width === 360) {
      await page.locator('.usage-fold').click();
      await folded.waitFor();
      await page.screenshot({path: path.join(output, `phone-${width}-sidebar-folded.png`)});
    }
    if (await folded.count()) await folded.click();
    await summary.scrollIntoViewIfNeeded();
    await emma.waitFor();
    assert(await summary.isVisible(), `${width}px: the quota block is on screen`);
    const boxes = await aligned(`${width}px`);
    const viewportOk = boxes.emma.x >= 0 && boxes.emma.x + boxes.emma.width <= width + 1;
    assert(viewportOk, `${width}px: Emma row inside the screen`);
    await page.screenshot({path: path.join(output, `phone-${width}-sidebar.png`)});
    await summary.screenshot({path: path.join(output, `phone-${width}-usage.png`)});
    // The quota dialog on a phone: Emma's section, opened to its rate line, stays inside the screen.
    await summary.click();
    const sheet = page.locator('.usage-details');
    await sheet.waitFor();
    const emmaSection = sheet.locator('.usage-provider-section').first();
    await emmaSection.locator('summary').click();
    await emmaSection.getByText('匯率：1 美元約', {exact: false}).waitFor();
    const overflow = await emmaSection.evaluate(el => {
      const r = el.getBoundingClientRect();
      return {left: r.left, right: r.right, scroll: el.scrollWidth - el.clientWidth};
    });
    assert(overflow.left >= 0 && overflow.right <= width + 1 && overflow.scroll <= 1, `${width}px: Emma's section fits (${JSON.stringify(overflow)})`);
    await page.screenshot({path: path.join(output, `phone-${width}-quota-dialog.png`)});
    await page.keyboard.press('Escape');
    await sheet.waitFor({state: 'detached'});
    const collapse = page.locator('.sidebar button[title="收合側欄"]:visible').first();
    if (await collapse.count()) await collapse.click();
  }
  await page.setViewportSize({width: 1280, height: 800});
  await page.waitForTimeout(200);
  const reopen = page.locator('button[title="展開側欄"]:visible').first();
  if (await reopen.count()) await reopen.click();
  await summary.waitFor();

  // Without a rate: US$ only, nothing guessed.
  usage.emma = {...usage.emma, usdToTwd: null};
  await snapshot(state);
  // Wait for the NT$ part to go: the US$ part was already on screen before this update.
  await emma.getByText('約 NT$40', {exact: true}).waitFor({state: 'detached'});
  assert.equal(await text(), '艾瑪 本月約 US$1.25');
  await summary.screenshot({path: path.join(output, 'desktop-1280-usage-no-rate.png')});

  // K sends no estimate (no voice connection and nothing this month): no row.
  usage.emma = null;
  await snapshot(state);
  await emma.waitFor({state: 'detached'});
  assert.equal(await summary.locator('.usage-row').count(), 5);
  assert.doesNotMatch(await summary.innerText(), /艾瑪|undefined|NaN/u);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed: true, output}));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
