// Emma's notes in the secretary room (2026-11-07): the header "筆記" button, the dialog listing each note with edit
// and delete buttons that look like buttons at rest, delete asking once more, and the note events K writes in the
// room's timeline; at 1280, 412 and 360 px. Each edit or delete carries the text it was decided on, and one K refuses
// because the note changed meanwhile (review 2026-11-07) closes the form, says so and reads the notes again.
// Built UI with a fake K; nothing leaves this machine.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';

const output = probeEvidenceDir('voice-emma-notes-20261107');
await mkdir(output, {recursive: true});
const root = path.resolve(import.meta.dirname, '..');
const server = await preview({configFile: path.join(root, 'vite.config.mjs'), preview: {host: '127.0.0.1', port: 0}});
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');

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
  voiceRevision: 1
};
const long = '每週三下午固定處理範例的社群排程，路徑 D:\\ExampleWorkspace_社群\\docs\\OPS_RULES_CURRENT.md 要先讀，'.repeat(2);
let notes = [
  {id: 'nabc234', text: '本人習慣用完整存取權', createdAt: '2026-11-07T02:00:00Z', updatedAt: '2026-11-07T02:00:00Z', source: 'emma'},
  {id: 'ndef567', text: long, createdAt: '2026-11-07T02:05:00Z', updatedAt: '2026-11-07T03:10:00Z', source: 'owner'},
  {id: 'nghk789', text: '開會前十分鐘提醒我喝水', createdAt: '2026-11-07T02:20:00Z', updatedAt: '2026-11-07T02:20:00Z', source: 'emma'}
];
const entries = [
  {kind: 'transcript', at: '2026-11-07T02:00:00Z', role: 'owner', text: '記住，我習慣用完整存取權。'},
  {kind: 'transcript', at: '2026-11-07T02:00:04Z', role: 'secretary', text: '要記下「本人習慣用完整存取權」，這樣記對嗎？'},
  {kind: 'transcript', at: '2026-11-07T02:00:07Z', role: 'owner', text: '對。'},
  {kind: 'note', at: '2026-11-07T02:00:08Z', op: 'add', id: 'nabc234', text: '本人習慣用完整存取權', source: 'emma'},
  {kind: 'note', at: '2026-11-07T03:10:00Z', op: 'edit', id: 'ndef567', previous: '每週三下午處理社群', text: long, source: 'owner'},
  {kind: 'note', at: '2026-11-07T03:12:00Z', op: 'remove', id: 'nzzz222', text: '暫時的事', source: 'emma'}
];
const posts = [];
const STALE = '這條筆記已在別處修改，這次沒有改動；請看最新內容再決定。';
let logReads = 0;

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
  // K's side: the page only asks; K changes the note, records it and bumps the revision so the page reads again.
  const bump = () => {
    state.voiceRevision++;
    return page.evaluate(s => window.fixtureEvents.onmessage({data: JSON.stringify({type: 'snapshot', state: s})}), state);
  };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()),
      method = route.request().method();
    if (method === 'POST' && url.pathname.startsWith('/api/voice/notes/')) {
      const body = route.request().postDataJSON();
      posts.push([url.pathname, body, route.request().headers()['x-k-request']]);
      const note = notes.find(n => n.id === body.id);
      // Like K: a page that decided on another text changes nothing and gets the current note back.
      if (note.text !== body.expected) {
        await route.fulfill({json: {saved: false, removed: false, stale: true, note, message: STALE}});
        return;
      }
      if (url.pathname.endsWith('/update')) {
        entries.push({kind: 'note', at: new Date().toISOString(), op: 'edit', id: note.id, previous: note.text, text: body.text, source: 'owner'});
        Object.assign(note, {text: body.text, updatedAt: new Date().toISOString(), source: 'owner'});
      } else {
        entries.push({kind: 'note', at: new Date().toISOString(), op: 'remove', id: note.id, text: note.text, source: 'owner'});
        notes = notes.filter(n => n !== note);
      }
      await route.fulfill({json: {saved: true}});
      setTimeout(() => void bump(), 0);
      return;
    }
    if (url.pathname === '/api/voice/log') logReads++;
    const body =
      url.pathname === '/api/state'
        ? state
        : url.pathname === '/api/voice/log'
          ? {entries, truncated: false, notes, noteLimit: 50, noteMaxLength: 200}
          : url.pathname === '/api/sessions'
            ? {sessions: [{threadId: 'room-main', title: state.title, workspace: process.cwd(), model: state.model, archived: false}]}
            : url.pathname === '/api/projects'
              ? {projects: [{path: process.cwd(), name: '主要工作區'}]}
              : url.pathname === '/api/models'
                ? {models: []}
                : {};
    await route.fulfill({json: body});
  });
  const looksLikeButton = el => {
    const s = getComputedStyle(el);
    return parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
  };
  const room = page.locator('main .secretary-page'),
    notesButton = room.locator('.secretary-notes-button'),
    dialog = page.locator('dialog.secretary-notes-dialog');
  const openRoom = async () => {
    if (await room.isVisible()) return;
    const links = page.locator('.sidebar .sidebar-page-links');
    if (!(await links.isVisible())) await page.locator('button[title="展開側欄"]:visible').first().click();
    await page.locator('.sidebar button', {hasText: '秘書室'}).click();
    await room.waitFor();
  };
  // Nothing in the header, the dialog or a note spills sideways; every note button looks like a button.
  const fits = async (label, width) => {
    const header = await room.locator('.schedule-page-header').evaluate(h => ({scroll: h.scrollWidth, client: h.clientWidth}));
    assert(header.scroll <= header.client + 1, `${label}: header fits (${JSON.stringify(header)})`);
    const box = await dialog.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1, `${label}: dialog inside the screen`);
    const over = await dialog.locator('.secretary-note').evaluateAll(els => els.filter(el => el.scrollWidth > el.clientWidth + 1).length);
    assert.equal(over, 0, `${label}: no note overflows`);
    const body = await dialog.locator('.modal-body').evaluate(el => el.scrollWidth - el.clientWidth);
    assert(body <= 1, `${label}: no sideways scroll in the dialog (${body})`);
    const buttons = dialog.locator('.secretary-note-actions > button');
    assert((await buttons.count()) > 0);
    for (const ok of await buttons.evaluateAll((els, fn) => els.map(new Function('el', fn)), `const s = getComputedStyle(el); return parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';`))
      assert(ok, `${label}: note buttons look like buttons`);
  };

  await page.goto(origin);
  await openRoom();
  // The room's timeline: what Emma wrote down or removed and what the person changed, written by K.
  await room.getByText('艾瑪記下了 · ', {exact: false}).waitFor();
  await room.getByText('本人修改了筆記 · ', {exact: false}).waitFor();
  await room.getByText('原本：每週三下午處理社群').waitFor();
  await room.getByText('艾瑪刪除了筆記 · ', {exact: false}).waitFor();
  await room.getByText('暫時的事').waitFor();
  assert.equal((await notesButton.innerText()).trim(), '筆記 3');
  assert(await notesButton.evaluate(looksLikeButton), 'the notes button looks like a button');
  await page.screenshot({path: path.join(output, 'desktop-1280-room.png')});

  // The list: each note with its dates and source, edit and delete.
  await notesButton.click();
  await dialog.waitFor();
  await dialog.getByText('艾瑪的筆記').waitFor();
  assert.match(await dialog.locator('.secretary-notes-help').innerText(), /3／50 條.*不構成任何授權/su);
  const items = dialog.locator('.secretary-note');
  assert.equal(await items.count(), 3);
  assert.match(await items.nth(0).locator('small').innerText(), /^建立 11\/07 \d\d:00 · 艾瑪經口頭確認$/u);
  assert.match(await items.nth(1).locator('small').innerText(), /^建立 .* · 修改 .* · 本人在畫面修改$/u);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await items.nth(i).locator('.secretary-note-actions > button').allInnerTexts(), ['修改', '刪除']);
  await fits('1280px', 1280);
  await page.screenshot({path: path.join(output, 'desktop-1280-notes.png')});

  // Edit: the text is prefilled, saved through K, and the list shows K's new copy.
  await items.nth(0).getByRole('button', {name: '修改'}).click();
  const area = items.nth(0).locator('textarea');
  assert.equal(await area.inputValue(), '本人習慣用完整存取權');
  assert.equal(await area.getAttribute('maxlength'), '200');
  await area.fill('');
  assert(await items.nth(0).getByRole('button', {name: '儲存'}).isDisabled(), 'an empty note cannot be saved');
  await area.fill('本人習慣用完整存取權，但開新房仍要問');
  await page.screenshot({path: path.join(output, 'desktop-1280-notes-edit.png')});
  await items.nth(0).getByRole('button', {name: '儲存'}).click();
  await dialog.getByText('本人習慣用完整存取權，但開新房仍要問').waitFor();
  await items.nth(0).locator('textarea').waitFor({state: 'detached'});
  assert.deepEqual(posts.at(-1), ['/api/voice/notes/update', {id: 'nabc234', text: '本人習慣用完整存取權，但開新房仍要問', expected: '本人習慣用完整存取權'}, '1']);

  // Another device changes a note while this page is editing it: K refuses the stale edit, the form closes with the
  // reason, and the page reads the notes again and shows what the note says now.
  await items.nth(0).getByRole('button', {name: '修改'}).click();
  await items.nth(0).locator('textarea').fill('舊畫面上的修改');
  notes[0].text = '另一台裝置改的內容';
  const reads = logReads;
  await items.nth(0).getByRole('button', {name: '儲存'}).click();
  await dialog.getByRole('alert').getByText(STALE).waitFor();
  await items.nth(0).locator('textarea').waitFor({state: 'detached'});
  await dialog.getByText('另一台裝置改的內容').waitFor();
  assert(logReads > reads, 'the page read the notes again');
  assert.deepEqual(posts.at(-1)[1], {id: 'nabc234', text: '舊畫面上的修改', expected: '本人習慣用完整存取權，但開新房仍要問'});
  assert.equal(notes[0].text, '另一台裝置改的內容', 'the newer text was not overwritten');
  await page.screenshot({path: path.join(output, 'desktop-1280-notes-stale.png')});
  // Likewise a delete confirmed on a text that changed meanwhile removes nothing.
  await items.nth(0).getByRole('button', {name: '刪除'}).click();
  notes[0].text = '又被改過一次';
  await items.nth(0).getByRole('button', {name: '確認刪除'}).click();
  await dialog.getByText('又被改過一次').waitFor();
  assert.deepEqual(posts.at(-1)[1], {id: 'nabc234', expected: '另一台裝置改的內容'});
  assert.equal(notes.length, 3, 'the stale delete removed nothing');
  await items.nth(0).getByText('確定刪除這條筆記？').waitFor({state: 'detached'});

  // Delete asks once more; cancelling sends nothing.
  const before = posts.length;
  await items.nth(2).getByRole('button', {name: '刪除'}).click();
  await items.nth(2).getByText('確定刪除這條筆記？').waitFor();
  assert.equal(posts.length, before, 'the first tap removes nothing');
  await items.nth(2).getByRole('button', {name: '取消'}).click();
  await items.nth(2).getByText('確定刪除這條筆記？').waitFor({state: 'detached'});
  assert.equal(posts.length, before);
  await items.nth(2).getByRole('button', {name: '刪除'}).click();
  const confirm = items.nth(2).getByRole('button', {name: '確認刪除'});
  assert(await confirm.evaluate(looksLikeButton), 'confirm delete looks like a button');
  await page.screenshot({path: path.join(output, 'desktop-1280-notes-confirm.png')});
  await confirm.click();
  await dialog.getByText('開會前十分鐘提醒我喝水').waitFor({state: 'detached'});
  assert.deepEqual(posts.at(-1), ['/api/voice/notes/remove', {id: 'nghk789', expected: '開會前十分鐘提醒我喝水'}, '1']);
  assert.equal(await items.count(), 2);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'detached'});
  assert.equal((await notesButton.innerText()).trim(), '筆記 2');
  await room.getByText('本人刪除了筆記 · ', {exact: false}).waitFor();

  for (const width of [412, 360]) {
    await page.setViewportSize({width, height: width === 360 ? 780 : 915});
    await page.waitForTimeout(200);
    // The sidebar left open at 1280 covers the page on a phone.
    const collapse = page.locator('.sidebar button[title="收合側欄"]:visible').first();
    if (await collapse.count()) await collapse.click();
    await openRoom();
    assert(await notesButton.isVisible(), `${width}px: notes button shown`);
    const head = await room.locator('.schedule-page-header').evaluate(h => ({scroll: h.scrollWidth, client: h.clientWidth}));
    assert(head.scroll <= head.client + 1, `${width}px: header fits`);
    await page.screenshot({path: path.join(output, `phone-${width}-room.png`)});
    await notesButton.click();
    await dialog.waitFor();
    await fits(`${width}px`, width);
    await page.screenshot({path: path.join(output, `phone-${width}-notes.png`)});
    await items.nth(1).getByRole('button', {name: '修改'}).click();
    await items.nth(1).locator('textarea').waitFor();
    await fits(`${width}px edit`, width);
    await page.screenshot({path: path.join(output, `phone-${width}-notes-edit.png`)});
    await items.nth(1).getByRole('button', {name: '取消'}).click();
    await items.nth(1).getByRole('button', {name: '刪除'}).click();
    await items.nth(1).getByRole('button', {name: '確認刪除'}).waitFor();
    await fits(`${width}px confirm`, width);
    await page.screenshot({path: path.join(output, `phone-${width}-notes-confirm.png`)});
    await items.nth(1).getByRole('button', {name: '取消'}).click();
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'detached'});
  }
  assert.equal(posts.length, 4, 'only the confirmed changes were sent: two applied, two refused as stale');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed: true, output}));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
