import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {resolve} from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';

// Isolated UI fixture only: no real backend, native model or user browser profile.
// 2026-11-03: the human asked for DSH-style attachments (thumbnails, an in-page viewer, file cards and a
// drop hint), replacing the 2026-09-25 text-only labels.
const root = resolve('.'),
  build = resolve(process.argv[2] ?? 'dist-ui');
const output = process.argv[3] ? resolve(process.argv[3]) : probeEvidenceDir('attachment-display-20261103/ui');
await mkdir(output, {recursive: true});
const origin = 'http://127.0.0.1:5186';
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--outDir',
    build,
    '--host',
    '127.0.0.1',
    '--port',
    '5186',
    '--strictPort'
  ],
  {cwd: root, stdio: 'ignore', windowsHide: true}
);
// A 320x200 gradient PNG, so thumbnails, the lone-image size and the viewer can be judged on screenshots.
function gradientPng(width, height) {
  const crcTable = Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = bytes => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]),
      out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rows.set([40 + (x * 180) / width, 90 + (y * 120) / height, 200 - (x * 120) / width], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ]).toString('base64');
}
const png = gradientPng(320, 200);
const filename = '畫面截圖-附件名稱很長時只顯示前段-完整名稱保留在滑鼠提示-20260925.png';
const docName = '假資料-文件名稱很長時卡片只顯示前段-完整名稱保留在滑鼠提示-20261103.txt';
const checks = [],
  errors = [];
let browser;
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await delay(100);
  }
  browser = await launchProbeBrowser();
  for (const provider of ['claude', 'codex']) {
    const context = await browser.newContext({viewport: {width: 1920, height: 1000}, reducedMotion: 'reduce'}),
      page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let state = {
      threadId: `fake-${provider}`,
      workspace: 'C:\\fake',
      title: '附件呈現驗收',
      provider,
      model: provider === 'claude' ? 'claude-opus-4-6' : 'gpt-6-sol',
      accessMode: provider === 'claude' ? 'claude-manual' : 'workspace-write',
      status: 'ready',
      busy: false,
      messages: [],
      questions: [],
      tools: [],
      artifacts: [],
      capabilities: {},
      conversationActivity: []
    };
    const image = {
      id: 'fake-image',
      threadId: state.threadId,
      name: filename,
      size: Buffer.from(png, 'base64').length,
      contentType: 'image/png',
      kind: 'image'
    };
    const doc = {
      id: 'fake-doc',
      threadId: state.threadId,
      name: docName,
      size: 2560,
      contentType: 'application/octet-stream',
      kind: 'document'
    };
    const uploads = [],
      sends = [],
      attachmentRequests = [];
    await page.addInitScript(state => {
      localStorage.setItem('k-color-theme', 'warm');
      localStorage.setItem('k-appearance', JSON.stringify({interfaceScale: 110, dialogueFontSize: 17}));
      window.__fixture = state;
      // The state stream starts each connection with a snapshot event.
      const snapshot = s => ({data: JSON.stringify({type: 'snapshot', revision: 0, state: s})});
      window.__emit = s => {
        window.__fixture = s;
        window.__es?.onmessage?.(snapshot(s));
      };
      window.EventSource = class {
        constructor() {
          window.__es = this;
          setTimeout(() => this.onmessage?.(snapshot(window.__fixture)), 0);
        }
        close() {}
      };
    }, state);
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      // Uploads stream the raw file; the room and name travel in headers.
      if (path === '/api/upload') {
        const request = route.request(),
          headers = request.headers(),
          name = decodeURIComponent(headers['x-k-file-name']);
        uploads.push({
          threadId: headers['x-k-thread-id'],
          name,
          base64: request.postDataBuffer().toString('base64')
        });
        return route.fulfill({json: name === filename ? image : doc});
      }
      if (path === '/api/send') {
        const body = route.request().postDataJSON();
        sends.push(body);
        const attachments = body.attachmentIds.map(id => (id === image.id ? image : doc));
        state = {
          ...state,
          messages: [
            ...state.messages,
            {id: `fake-user-${sends.length}`, role: 'user', text: body.text, attachments}
          ]
        };
        await page.evaluate(s => window.__emit(s), state);
        return route.fulfill({json: {sent: true}});
      }
      if (path === '/api/attachment') {
        attachmentRequests.push(url.href);
        const download = url.searchParams.get('download') === '1';
        // A saved file that is named like an image but cannot be decoded.
        if (url.searchParams.get('id') === 'broken-image' && !download)
          return route.fulfill({body: 'NOT AN IMAGE', headers: {'Content-Type': 'image/png'}});
        return route.fulfill({
          body: Buffer.from(png, 'base64'),
          headers: {
            'Content-Type': 'image/png',
            ...(download ? {'Content-Disposition': 'attachment; filename="fixture.png"'} : {})
          }
        });
      }
      return route.fulfill({
        json:
          path === '/api/sessions'
            ? {
                sessions: [
                  {threadId: state.threadId, title: state.title, workspace: state.workspace, model: state.model}
                ]
              }
            : path === '/api/projects'
              ? {projects: [{path: state.workspace, name: '假資料工作區'}]}
              : path === '/api/models'
                ? {models: []}
                : {ok: true}
      });
    });
    await page.goto(origin);
    await page.locator('.session-open').waitFor();
    const paste = (name, type, base64) =>
      page.locator('.composer-input').evaluate(
        (input, {name, type, base64}) => {
          const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)),
            data = new DataTransfer();
          data.items.add(new File([bytes], name, {type}));
          input.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data}));
        },
        {name, type, base64}
      );
    const pasteImage = () => paste(filename, 'image/png', png);
    const settled = () =>
      page.waitForFunction(() => !/正在上傳|電腦正在保存/.test(document.querySelector('.composer-card .attachment-row').textContent));

    // Draft image: a thumbnail of the saved original with a remove button.
    await pasteImage();
    const draftImage = page.locator('.composer-card .attachment-chip.attachment-image');
    await draftImage.locator('img').waitFor();
    await settled();
    assert.equal(await draftImage.getAttribute('title'), filename);
    assert.equal(await draftImage.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    const box = await draftImage.boundingBox();
    assert(Math.abs(box.width - box.height) < 2 && box.width >= 60, 'draft image is a square thumbnail');
    assert.deepEqual(uploads[0], {threadId: state.threadId, name: filename, base64: png});
    assert(attachmentRequests.every(u => !u.includes('download=1')), 'thumbnail never downloads');
    await page.screenshot({path: resolve(output, `${provider}-draft-image.png`)});
    // On a phone the remove button stays a corner target: tapping the thumbnail center opens the viewer.
    await page.setViewportSize({width: 390, height: 844});
    // Resizing from desktop may open the phone sidebar drawer over the chat (sometimes a moment later);
    // close it until the thumbnail center is what a tap would hit.
    const backdrop = page.locator('.mobile-backdrop');
    let phoneTile;
    for (let tries = 0; ; tries++) {
      if (await backdrop.isVisible()) await backdrop.click({position: {x: 370, y: 400}});
      phoneTile = await draftImage.boundingBox();
      const hit = await page.evaluate(
        ([x, y]) => !!document.elementFromPoint(x, y)?.closest('.attachment-image-open'),
        [phoneTile.x + phoneTile.width / 2, phoneTile.y + phoneTile.height / 2]
      );
      if (hit) break;
      assert(tries < 50, 'thumbnail center stays covered on a phone');
      await delay(100);
    }
    const phoneRemove = await draftImage.getByRole('button', {name: `移除附件 ${filename}`, exact: true}).boundingBox();
    assert(phoneRemove.width < phoneTile.width / 2 && phoneRemove.height < phoneTile.height / 2, 'remove stays in a corner');
    await page.mouse.click(phoneTile.x + phoneTile.width / 2, phoneTile.y + phoneTile.height / 2);
    await page.getByRole('dialog').locator('.image-viewer-picture').waitFor();
    assert.equal(await draftImage.count(), 1, 'tapping the center never removes the attachment');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({state: 'hidden'});
    await page.setViewportSize({width: 1920, height: 1000});
    await page.getByRole('button', {name: `移除附件 ${filename}`, exact: true}).click();
    await draftImage.waitFor({state: 'hidden'});

    // Draft file: a card with the file name, type and size; long names are truncated.
    await paste(docName, 'text/plain', Buffer.from('FAKE DOC').toString('base64'));
    const draftDoc = page.locator('.composer-card .file-chip.attachment-chip');
    await draftDoc.waitFor();
    await settled();
    assert.equal(await draftDoc.getAttribute('title'), docName);
    assert.equal(await draftDoc.locator('.attachment-type').innerText(), 'TXT · 2.5 KB');
    assert.equal(await draftDoc.locator('img').count(), 0);
    assert.equal(
      await draftDoc
        .locator('.attachment-name')
        .evaluate(el => getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth),
      true
    );

    // One image with a file: both are sent; the image shows as a small square beside the file card.
    await pasteImage();
    await draftImage.locator('img').waitFor();
    await settled();
    await page.getByRole('textbox', {name: '工作訊息', exact: true}).fill('兩個附件');
    await page.getByRole('button', {name: '送出訊息', exact: true}).click();
    const sentRow = page.locator('.user-message .attachment-row').first();
    await sentRow.locator('.attachment-chip').nth(1).waitFor();
    await page.waitForFunction(() => !document.querySelector('.composer-card .attachment-chip'));
    assert.deepEqual(sends[0].attachmentIds, [doc.id, image.id]);
    assert.equal(await sentRow.locator('.attachment-image.single').count(), 0);
    const sentDoc = sentRow.locator('a.file-chip.attachment-chip');
    assert.equal(await sentDoc.getAttribute('title'), docName);
    const docHref = await sentDoc.getAttribute('href');
    assert.ok(docHref.includes(`threadId=${state.threadId}`) && docHref.includes('download=1'));

    // A lone image is shown larger and opens an in-page viewer of the original.
    await pasteImage();
    await draftImage.locator('img').waitFor();
    await settled();
    await page.getByRole('textbox', {name: '工作訊息', exact: true}).fill('看看？');
    await page.getByRole('button', {name: '送出訊息', exact: true}).click();
    const single = page.locator('.user-message .attachment-image.single');
    await single.locator('img').waitFor();
    assert.equal(await single.getAttribute('title'), filename);
    assert.equal(await single.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    const lone = await single.locator('img').boundingBox();
    // The fixture runs at 110% interface scale: 240x150 CSS px appear as 264x165.
    assert(Math.abs(lone.width - 264) < 1 && Math.abs(lone.height - 165) < 1, 'lone image keeps its ratio at a 240px long edge');
    for (const theme of ['warm', 'light', 'dark'])
      for (const width of [1920, 1024]) {
        await page.setViewportSize({width, height: 1000});
        await page.evaluate(theme => (document.documentElement.dataset.theme = theme), theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({path: resolve(output, `${provider}-${theme}-${width}.png`)});
      }
    const opener = single.getByRole('button', {name: `檢視圖片 ${filename}`, exact: true});
    await opener.click();
    const viewer = page.getByRole('dialog');
    await viewer.locator('.image-viewer-picture').waitFor();
    assert.equal(await viewer.locator('.image-viewer-picture').evaluate(img => img.complete && img.naturalWidth > 0), true);
    await page.screenshot({path: resolve(output, `${provider}-viewer.png`)});
    const download = page.waitForEvent('download');
    await viewer.getByRole('link', {name: '下載原檔', exact: true}).click();
    assert.equal((await download).suggestedFilename(), 'fixture.png');
    await page.keyboard.press('Escape');
    await viewer.waitFor({state: 'hidden'});
    assert.equal(await opener.evaluate(el => el === document.activeElement), true, 'focus returns to the image');

    // An image that cannot be shown becomes a file card that still downloads the original and can reload.
    const broken = {...image, id: 'broken-image', name: '無法顯示.png'};
    state = {...state, messages: [...state.messages, {id: 'fake-broken', role: 'user', text: '壞圖', attachments: [broken]}]};
    await page.evaluate(s => window.__emit(s), state);
    const brokenCard = page.locator('.user-message .attachment-image-failed');
    await brokenCard.waitFor();
    const brokenHref = await brokenCard.getByRole('link', {name: `下載附件 ${broken.name}`, exact: true}).getAttribute('href');
    assert.ok(brokenHref.includes('id=broken-image') && brokenHref.includes(`threadId=${state.threadId}`) && brokenHref.includes('download=1'));
    const brokenRequests = attachmentRequests.filter(u => u.includes('broken-image')).length;
    await brokenCard.getByRole('button', {name: `重新載入圖片 ${broken.name}`, exact: true}).click();
    await page.locator('.user-message .attachment-image-failed').waitFor();
    assert(attachmentRequests.filter(u => u.includes('broken-image')).length > brokenRequests, 'reload asks again');

    // Dragging files over the conversation shows a drop hint; leaving hides it and dropping uploads.
    const files = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['FAKE DROP'], 'dropped.txt', {type: 'text/plain'}));
      return data;
    });
    await page.dispatchEvent('.thread', 'dragover', {dataTransfer: files});
    await page.locator('.file-drop-overlay').waitFor();
    assert.equal(await page.locator('.file-drop-overlay').innerText(), '放開即可加入附件\n可一次放入多個檔案');
    await page.dispatchEvent('.thread', 'dragleave', {dataTransfer: files});
    await page.locator('.file-drop-overlay').waitFor({state: 'hidden'});
    await page.dispatchEvent('.thread', 'dragover', {dataTransfer: files});
    await page.locator('.file-drop-overlay').waitFor();
    const before = uploads.length;
    await page.dispatchEvent('.thread', 'drop', {dataTransfer: files});
    await page.locator('.file-drop-overlay').waitFor({state: 'hidden'});
    await page.locator('.composer-card .attachment-chip').waitFor();
    assert.equal(uploads.length, before + 1);
    assert.equal(uploads.at(-1).name, 'dropped.txt');
    // A cancelled outside drag sends no dragend here; once dragover stops the hint clears by itself.
    await page.dispatchEvent('.thread', 'dragover', {dataTransfer: files});
    await page.locator('.file-drop-overlay').waitFor();
    await page.locator('.file-drop-overlay').waitFor({state: 'hidden', timeout: 3000});
    checks.push(
      `${provider}: draft image thumbnail + remove; draft file card with type/size and truncated name; mixed send keeps order and small image; lone image larger; phone center tap opens viewer, remove stays in corner; undecodable image downloads and reloads; viewer shows original, downloads, Esc closes and returns focus; drop hint shows/hides, clears after a cancelled drag, and drop uploads; three themes and two widths without overflow`
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ok: true, checks, errors}, null, 2));
  console.log(JSON.stringify({ok: true, checks}, null, 2));
} finally {
  await browser?.close();
  server.kill();
}
