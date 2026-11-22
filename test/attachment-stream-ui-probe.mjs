// Browser File -> raw HTTP contract, errors/cancel/thread ownership. Fake backend only.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';
const out = probeEvidenceDir('menu-attachments-20261007/upload-ui');
await mkdir(out, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 5206, strictPort: true}}),
  results = [],
  errors = [];
let browser;
try {
  browser = await launchProbeBrowser();
  for (const [width, height, remote] of [
    [1280, 800, false],
    [360, 740, true]
  ]) {
    const page = await browser.newPage({viewport: {width, height}});
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    const state = {
      threadId: 'fake-upload-a',
      workspace: process.cwd(),
      title: '附件假資料驗收',
      model: 'gpt-6-luna',
      provider: 'codex',
      inputModalities: ['text', 'image'],
      status: 'ready',
      busy: false,
      messages: [],
      tools: [],
      questions: [],
      artifacts: [],
      accessMode: 'workspace-write',
      efforts: ['low'],
      effort: 'low',
      capabilities: {},
      conversationActivity: []
    };
    let held = null;
    const uploads = [];
    await page.addInitScript(state => {
      FileReader.prototype.readAsDataURL = () => {
        throw Error('Whole-file Base64 must not be used');
      };
      window.EventSource = class {
        constructor() {
          window.uploadTestState = s => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: s})});
          setTimeout(() => {
            this.onopen?.();
            window.uploadTestState(state);
          }, 0);
        }
        close() {}
      };
    }, state);
    if (remote)
      await page.route('http://127.0.0.1:5206/', async route => {
        const res = await route.fetch();
        await route.fulfill({response: res, body: (await res.text()).replace('<html', '<html data-k-remote="true"')});
      });
    await page.route('**/api/**', async route => {
      const request = route.request(),
        url = new URL(request.url());
      if (request.method() === 'POST') {
        assert.equal(url.pathname, '/api/upload');
        const headers = request.headers();
        assert.equal(headers['content-type'], 'application/octet-stream');
        assert.equal(headers['x-k-request'], '1');
        assert(headers['x-k-command']);
        const name = decodeURIComponent(headers['x-k-file-name']),
          threadId = headers['x-k-thread-id'],
          bytes = request.postDataBuffer();
        uploads.push({name, threadId, bytes: bytes.length});
        const record = {id: `fake-file-${uploads.length}`, threadId, name, kind: 'document', size: bytes.length};
        if (name === 'reject.LRF') return route.fulfill({status: 400, json: {error: '合成儲存失敗，非格式限制'}});
        if (name.startsWith('hold')) {
          held = {route, record};
          return;
        }
        assert.deepEqual(bytes, Buffer.from('SYNTHETIC ORIGINAL BYTES'));
        return route.fulfill({json: record});
      }
      await route.fulfill({
        json:
          url.pathname === '/api/state'
            ? state
            : url.pathname === '/api/models'
              ? {
                  models: [
                    {
                      model: state.model,
                      provider: 'codex',
                      displayName: 'GPT-6 Luna',
                      inputModalities: ['text', 'image']
                    }
                  ]
                }
              : url.pathname === '/api/projects'
                ? {projects: [{path: state.workspace, name: '假工作區'}]}
                : url.pathname === '/api/sessions'
                  ? {sessions: []}
                  : {}
      });
    });
    await page.goto('http://127.0.0.1:5206/');
    const fileInput = page.locator('input[type=file]'),
      composer = page.getByRole('textbox', {name: '工作訊息', exact: true}),
      chips = page.locator('.composer-card .attachment-chip');
    await composer.fill('保留此草稿；只驗證附件，不送出。');
    assert.equal(await fileInput.getAttribute('accept'), null);
    const file = name => ({
      name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('SYNTHETIC ORIGINAL BYTES')
    });
    await fileInput.setInputFiles([file('test.M4A'), file('test.MP4'), file('test.LRF')]);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.composer-card .attachment-chip').length === 3 &&
        !/正在上傳|電腦正在保存/.test(document.querySelector('.composer-card .attachment-row').textContent)
    );
    assert.equal(await composer.inputValue(), '保留此草稿；只驗證附件，不送出。');
    assert.equal(uploads.length, 3);
    await fileInput.setInputFiles([file('reject.LRF'), file('after-failure.m4a')]);
    await page.getByText('合成儲存失敗，非格式限制', {exact: true}).waitFor();
    // The failed file stays as a card with a manual retry; it is never retried automatically.
    const failedCard = chips.filter({hasText: 'reject.LRF'});
    await failedCard.locator('.attachment-retry').waitFor();
    assert.match(await failedCard.getAttribute('class'), /\bfailed\b/);
    assert.match(await failedCard.getAttribute('title'), /合成儲存失敗，非格式限制/);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.composer-card .attachment-chip').length === 5 &&
        !/正在上傳|電腦正在保存/.test(document.querySelector('.composer-card .attachment-row').textContent)
    );
    // Sending is refused while a failed card remains; the draft and its files stay.
    await page.getByRole('button', {name: '送出訊息', exact: true}).click();
    await page.getByText('有附件上傳失敗，請按「重試」或移除後再送出；草稿已保留。', {exact: true}).waitFor();
    assert.equal(await composer.inputValue(), '保留此草稿；只驗證附件，不送出。');
    // A manual retry sends exactly one new request and keeps one failed card in the same place.
    const order = () =>
      page.$$eval('.composer-card .attachment-chip', els => els.map(el => el.querySelector('.attachment-name')?.textContent));
    const beforeRetry = await order();
    await failedCard.locator('.attachment-retry').click();
    const retryDeadline = Date.now() + 10000;
    while (uploads.length < 6 && Date.now() < retryDeadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(uploads.length, 6);
    await failedCard.locator('.attachment-retry').waitFor();
    assert.deepEqual(await order(), beforeRetry);
    assert.equal(await page.locator('.composer-card .attachment-chip.failed').count(), 1);
    await fileInput.setInputFiles(file('hold-cancel.mp4'));
    await page.waitForFunction(() =>
      document.querySelector('.composer-card .attachment-row').textContent.includes('hold-cancel.mp4')
    );
    await page.getByRole('button', {name: '移除附件 hold-cancel.mp4', exact: true}).click();
    await chips.filter({hasText: 'hold-cancel.mp4'}).waitFor({state: 'hidden'});
    if (held) {
      await held.route.abort().catch(() => {});
      held = null;
    }
    await fileInput.setInputFiles(file('hold-thread.m4a'));
    const holdDeadline = Date.now() + 10000;
    while (!held && Date.now() < holdDeadline) await new Promise(r => setTimeout(r, 20));
    assert(held, 'held synthetic upload must arrive');
    await page.evaluate(s => window.uploadTestState({...s, threadId: 'fake-upload-b', title: '其他假對話'}), state);
    await page.waitForFunction(() => document.querySelectorAll('.composer-card .attachment-chip').length === 0);
    await held.route.fulfill({json: held.record});
    held = null;
    await page.evaluate(s => window.uploadTestState(s), state);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.composer-card .attachment-chip').length === 6 &&
        !/正在上傳|電腦正在保存/.test(document.querySelector('.composer-card .attachment-row').textContent)
    );
    assert(uploads.every(u => u.threadId === state.threadId));
    assert.equal(uploads.length, 8, 'only the one manual retry; no automatic retry');
    await page.screenshot({path: path.join(out, `${remote ? 'remote' : 'desktop'}.png`)});
    results.push({width, height, remote, uploads});
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({results, errors}, null, 2));
  console.log(JSON.stringify({passed: results.length, errors}));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
