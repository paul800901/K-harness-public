// Voice secretary UI: the call button on desktop and phone widths, the call panel with a relayed message, the
// dictation button disabled during a call, and the secretary room page. Gemini is a fake socket in the page;
// nothing leaves this machine.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';

const output = probeEvidenceDir('voice-secretary-20261106');
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
  messages: [
    {id: 'm1', role: 'user', text: '測試訊息'},
    {id: 'm2', role: 'assistant', text: '測試回覆'}
  ],
  tools: [],
  questions: [],
  notices: [],
  artifacts: [],
  capabilities: {},
  conversationActivity: [],
  workerActivity: {running: 0},
  voiceRevision: 1
};
const entries = [
  {kind: 'transcript', at: '2026-11-06T10:00:00Z', role: 'owner', text: '幫我請測試房甲整理這週的報表。'},
  {kind: 'transcript', at: '2026-11-06T10:00:05Z', role: 'secretary', text: '要交給「測試房甲」：整理這週報表。可以送嗎？'},
  {kind: 'transcript', at: '2026-11-06T10:00:09Z', role: 'owner', text: '好。'},
  {kind: 'send', at: '2026-11-06T10:00:10Z', code: 'abcdef', threadId: 'room-main', title: '測試房甲', text: '整理這週的報表。', status: 'queued'},
  {kind: 'report', at: '2026-11-06T10:05:00Z', code: 'abcdef', threadId: 'room-main', title: '測試房甲', text: '報表整理好了，放在 reports/week45.md。', truncated: false},
  {kind: 'transcript', at: '2026-11-06T10:06:00Z', role: 'secretary', text: '剛才那段', incomplete: true},
  {kind: 'trackEnd', at: '2026-11-06T10:07:00Z', code: 'ghjkmn', title: '測試房乙', reason: 'archived'},
  // Emma opened a room: K's record of every setting, then the first sentence like any relay.
  {
    kind: 'create',
    at: '2026-11-06T10:08:00Z',
    code: 'pqrstu',
    status: 'created',
    workspace: process.cwd(),
    workspaceName: '主要工作區',
    model: 'gpt-6.1-sol',
    modelName: 'GPT-6.1 Sol',
    effort: 'high',
    permission: 'danger-full-access',
    permissionName: '完整存取權',
    threadId: 'room-main',
    title: '新聊天室（主要工作區）'
  },
  {kind: 'send', at: '2026-11-06T10:08:01Z', code: 'pqrstu', threadId: 'room-main', title: '新聊天室（主要工作區）', text: '幫我檢查這週的測試。', status: 'sent'}
];

let browser;
const errors = [];
try {
  browser = await launchProbeBrowser();
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => errors.push(e.message));
  const toolCalls = [];
  await page.addInitScript(
    ({state}) => {
      localStorage.setItem('k-appearance', JSON.stringify({interfaceScale: 100, dialogueFontSize: 16}));
      localStorage.setItem('k-color-theme', 'warm');
      window.EventSource = class {
        constructor() {
          setTimeout(() => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state})}), 0);
        }
        close() {}
      };
      // The desktop shell marks native dictation; the call itself only needs a microphone stream.
      window.kBrowser = {onWindowHidden: () => () => {}};
      window.microphoneRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.microphoneRequests++;
        return new AudioContext().createMediaStreamDestination().stream;
      };
      window.fakeSockets = [];
      window.WebSocket = class {
        constructor(url) {
          this.url = url;
          this.readyState = 0;
          window.fakeSockets.push(this);
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.();
          }, 10);
        }
        send(text) {
          const message = JSON.parse(text);
          if (message.setup) setTimeout(() => this.onmessage?.({data: JSON.stringify({setupComplete: {}})}), 10);
        }
        close() {
          this.readyState = 3;
          this.closed = true;
        }
        push(message) {
          this.onmessage?.({data: JSON.stringify(message)});
        }
      };
    },
    {state}
  );
  let voiceConfigured = false, tokenRequests = 0;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()),
      method = route.request().method();
    if (method === 'GET' && url.pathname === '/api/state') return route.fulfill({json: state});
    if (method === 'GET' && url.pathname === '/api/voice/status') return route.fulfill({json: {configured: voiceConfigured}});
    if (method === 'GET' && url.pathname === '/api/voice/log') return route.fulfill({json: {entries, truncated: false}});
    if (method === 'GET' && url.pathname === '/api/sessions')
      return route.fulfill({
        json: {sessions: [{threadId: 'room-main', title: state.title, workspace: process.cwd(), model: state.model, archived: false}]}
      });
    if (method === 'GET' && url.pathname === '/api/projects')
      return route.fulfill({json: {projects: [{path: process.cwd(), name: '主要工作區'}]}});
    if (method === 'GET' && url.pathname === '/api/models')
      return route.fulfill({json: {models: [{model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5'}]}});
    if (url.pathname === '/api/voice/token') {
      tokenRequests++;
      return route.fulfill({json: {token: 'auth_tokens/probe', model: 'models/gemini-3.8-live', expireTime: new Date(Date.now() + 30 * 60e3).toISOString()}});
    }
    if (url.pathname === '/api/voice/tool') {
      const call = route.request().postDataJSON();
      toolCalls.push(call);
      if (call.name === 'room_create')
        return route.fulfill({
          json: {
            created: 'created',
            status: 'sent',
            result: '已送出',
            code: 'pqrstu',
            threadId: 'room-new',
            title: '新聊天室（主要工作區）',
            sentText: '（K 語音秘書轉達 #pqrstu）\n幫我檢查這週的測試。'
          }
        });
      return route.fulfill({
        json: {
          status: 'sent',
          result: '已送出',
          code: 'abcdef',
          title: '測試房甲',
          sentText: '（K 語音秘書轉達 #abcdef）\n請整理這週的報表，整理完放在 reports 資料夾，並列出三個重點。'
        }
      });
    }
    return route.fulfill({json: {}});
  });
  await page.goto(origin);

  const callButton = page.locator('main > header .voice-call-button');
  await callButton.waitFor();
  assert.equal(await callButton.innerText(), '通話');
  await page.locator('.voice-call-button[title^="語音秘書尚未設定"]').first().waitFor();
  await callButton.click();
  await page.getByRole('button', {name: '完成', exact: true}).click();
  assert.equal(tokenRequests, 0);
  assert.equal(await page.evaluate(() => window.microphoneRequests), 0);
  voiceConfigured = true;
  await page.evaluate(() => window.dispatchEvent(new Event('k-discussion-api-refresh')));
  await page.locator('.voice-call-button[title^="打電話給艾瑪"]').first().waitFor();
  const looksLikeButton = el => {
    const s = getComputedStyle(el);
    return parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
  };
  assert(await callButton.evaluate(looksLikeButton), 'the call button has a border and a fill at rest');
  const mic = page.locator('button.voice-button');
  await mic.waitFor();
  assert.equal(await mic.isDisabled(), false);
  await page.screenshot({path: path.join(output, 'desktop-1280-idle.png')});
  // A narrow desktop window: the title keeps its room and the actions wrap instead.
  await page.setViewportSize({width: 900, height: 700});
  await page.waitForTimeout(100);
  assert((await page.locator('main > header h1').boundingBox()).width >= 100, 'title stays readable at 900px');
  await page.screenshot({path: path.join(output, 'desktop-900-idle.png')});
  await page.setViewportSize({width: 1280, height: 800});
  await page.waitForTimeout(100);

  // Start a call: it opens the secretary room, the panel appears with its controls, and a relayed message shows
  // its room and full text.
  await callButton.click();
  const panel = page.locator('.voice-call-panel');
  await panel.waitFor();
  await page.locator('main .secretary-page').waitFor();
  await panel.getByText('聆聽中').waitFor();
  assert.equal(await panel.locator('header strong').innerText(), '艾瑪 · K 語音秘書');
  assert.equal(await panel.getAttribute('aria-label'), '艾瑪 · K 語音秘書通話');
  assert.equal(await page.locator('.secretary-page .voice-call-button').innerText(), '掛斷');
  const controls = panel.locator('.voice-call-controls button');
  assert(await panel.getByRole('button', {name: '靜音'}).isVisible());
  for (const ok of await controls.evaluateAll(els =>
    els.map(el => {
      const s = getComputedStyle(el);
      return parseFloat(s.borderTopWidth) > 0 && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
    })
  ))
    assert(ok, 'call controls look like buttons');
  await panel.getByText('音量 100%').waitFor();
  await panel.getByTitle('大聲一點').click();
  await panel.getByText('音量 150%').waitFor();
  await panel.getByRole('button', {name: '靜音'}).click();
  await panel.getByRole('button', {name: '已靜音'}).waitFor();
  await panel.getByRole('button', {name: '已靜音'}).click();
  // Back in the chat the call goes on, and dictation stays off while it does.
  await page.locator('.sidebar .session-open').first().click();
  await callButton.waitFor();
  assert.equal(await callButton.innerText(), '掛斷');
  assert.equal(await mic.isDisabled(), true, 'dictation is off during a call');
  await page.evaluate(() =>
    window.fakeSockets.at(-1).push({toolCall: {functionCalls: [{id: 'c1', name: 'room_send', args: {threadId: 'room-main', text: '整理報表'}}]}})
  );
  await panel.getByText('最近送出：「測試房甲」· 已送出').waitFor();
  await panel.getByText('請整理這週的報表', {exact: false}).waitFor();
  // Each tool call carries this call's id and Gemini's tool call id, so K recognises one arriving again.
  const [{callId, ...firstCall}] = toolCalls;
  assert.match(callId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual([firstCall], [{name: 'room_send', args: {threadId: 'room-main', text: '整理報表'}, toolCallId: 'c1'}]);
  assert.equal(toolCalls.length, 1);
  await page.screenshot({path: path.join(output, 'desktop-1280-call.png')});
  // A new room from Emma shows as the latest send, with its first sentence.
  const createArgs = {workspace: '主要工作區', model: 'gpt-6.1-sol', effort: 'high', permission: 'danger-full-access', text: '幫我檢查這週的測試。'};
  await page.evaluate(
    args => window.fakeSockets.at(-1).push({toolCall: {functionCalls: [{id: 'c2', name: 'room_create', args}]}}),
    createArgs
  );
  await panel.getByText('最近送出：「新聊天室（主要工作區）」· 已開新聊天室，已送出').waitFor();
  await panel.getByText('幫我檢查這週的測試。', {exact: false}).waitFor();
  assert.deepEqual(toolCalls.at(-1), {name: 'room_create', args: createArgs, callId, toolCallId: 'c2'});
  await page.screenshot({path: path.join(output, 'desktop-1280-call-create.png')});

  for (const width of [360, 412]) {
    await page.setViewportSize({width, height: width === 360 ? 780 : 915});
    await page.waitForTimeout(150);
    // Coming from the desktop width the sidebar is still open; a phone starts with it closed.
    if (await page.locator('.mobile-backdrop').isVisible()) await page.locator('.mobile-backdrop').click({position: {x: 345, y: 400}});
    await page.locator('.mobile-backdrop').waitFor({state: 'detached'});
    const header = await page.locator('main > header').evaluate(h => ({scroll: h.scrollWidth, client: h.clientWidth}));
    assert(header.scroll <= header.client + 1, `${width}px header does not overflow`);
    const box = await callButton.boundingBox(),
      title = await page.locator('main > header h1').boundingBox(),
      toggle = await page.locator('main > header button[title="切換工具與成果面板"]').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width, `${width}px call button inside the screen`);
    assert(box.height >= 40, `${width}px call button is tall enough to tap`);
    assert(title.x + title.width <= box.x + 1, `${width}px title does not run under the call button`);
    assert(box.x + box.width <= toggle.x + 1, `${width}px call button does not cover the panel toggle`);
    const sheet = await panel.boundingBox();
    assert(sheet.x >= 0 && sheet.x + sheet.width <= width + 1, `${width}px call panel fits`);
    assert(await page.locator('.voice-call-hangup').isVisible());
    await page.screenshot({path: path.join(output, `phone-${width}-call.png`)});
  }

  // During a call on a phone the secretary room keeps its last line above the call panel.
  await page.locator('main > header .header-title button[title="展開側欄"]').click();
  await page.locator('.sidebar button', {hasText: '秘書室'}).click();
  const room = page.locator('main .secretary-page');
  await room.getByText('該房已封存，停止追蹤', {exact: false}).waitFor();
  // The room follows its newest line by itself, clear of the call panel; nothing scrolls it here.
  await page.waitForTimeout(300);
  const followed = await room
    .locator('.schedule-page-scroll')
    .evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert(followed <= 1, `the secretary room is at its end (${followed}px left)`);
  const lastBottom = await room.locator('.secretary-list > li').last().evaluate(el => el.getBoundingClientRect().bottom),
    panelTop = (await panel.boundingBox()).y;
  assert(lastBottom <= panelTop + 1, `the last line (${lastBottom}) stays above the call panel (${panelTop})`);
  await page.screenshot({path: path.join(output, 'phone-412-call-secretary.png')});
  await page.locator('main > header .header-title button[title="展開側欄"], .secretary-page button[title="展開側欄"]').first().click();
  await page.locator('.sidebar .session-open').first().click();
  await callButton.waitFor();

  // Hang up: the panel closes by itself (what was sent stays in the secretary room); nothing reconnects.
  await page.locator('.voice-call-hangup').click();
  await panel.waitFor({state: 'detached'});
  assert.equal(await callButton.innerText(), '通話');
  assert.equal(await page.evaluate(() => window.fakeSockets.length), 1);
  assert.equal(await page.evaluate(() => window.fakeSockets[0].closed), true);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.fakeSockets.length), 1, 'no reconnect after hanging up');
  assert.equal(await mic.isDisabled(), false, 'dictation is available again');

  for (const width of [360, 412]) {
    await page.setViewportSize({width, height: width === 360 ? 780 : 915});
    await page.waitForTimeout(100);
    await page.screenshot({path: path.join(output, `phone-${width}-idle.png`)});
  }

  // The secretary room page, from the sidebar on a phone.
  await page.setViewportSize({width: 360, height: 780});
  await page.locator('main > header .header-title button[title="展開側欄"]').click();
  // New chat, the secretary room and schedules share one row, left to right, and all look like buttons at rest.
  const sidebarLinks = async name => {
    const links = page.locator('.sidebar .sidebar-page-links button');
    assert.deepEqual((await links.allInnerTexts()).map(t => t.trim()), ['新對話', '秘書室', '排程']);
    const boxes = await links.evaluateAll(els =>
      els.map(el => ({...el.getBoundingClientRect().toJSON(), scroll: el.scrollWidth, client: el.clientWidth}))
    );
    await page.screenshot({path: path.join(output, `${name}-sidebar.png`)});
    assert(boxes.every(b => Math.abs(b.top - boxes[0].top) < 1 && Math.abs(b.height - boxes[0].height) < 1), 'one row, same height');
    assert(boxes[0].right <= boxes[1].left && boxes[1].right <= boxes[2].left, 'left to right');
    for (const b of boxes) assert(b.scroll <= b.client + 1, 'label not clipped');
    for (const ok of await links.evaluateAll((els, fn) => els.map(new Function('el', fn)), `const s = getComputedStyle(el); return parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';`))
      assert(ok, 'sidebar link looks like a button');
  };
  await sidebarLinks('phone-360');
  const roomButton = page.locator('.sidebar button', {hasText: '秘書室'});
  await roomButton.click();
  const secretary = page.locator('main .secretary-page');
  await secretary.waitFor();
  await secretary.getByText('幫我請測試房甲整理這週的報表。').waitFor();
  await secretary.getByText('送進「測試房甲」· 已排隊（尚未處理）', {exact: false}).waitFor();
  await secretary.getByText('「測試房甲」已回覆', {exact: false}).waitFor();
  await secretary.getByText('未完整', {exact: false}).waitFor();
  await secretary.getByText('該房已封存，停止追蹤', {exact: false}).waitFor();
  // Emma's side of the transcript carries her name; her new room shows every setting K recorded.
  assert.deepEqual(
    (await secretary.locator('.secretary-line.secretary small').allInnerTexts()).map(t => t.split(' · ')[0]),
    ['艾瑪', '艾瑪']
  );
  const made = secretary.locator('.secretary-card.create');
  await made.getByText('艾瑪開了新聊天室 · 已建立 · #pqrstu', {exact: false}).waitFor();
  assert.deepEqual(await made.locator('dt').allInnerTexts(), ['工作區', '模型', '推理程度', '權限']);
  assert.deepEqual(await made.locator('dd').allInnerTexts(), ['主要工作區', 'GPT-6.1 Sol', '高', '完整存取權']);
  assert(await made.getByRole('button', {name: '開啟聊天室'}).evaluate(looksLikeButton), 'open-room on the new room card is a button');
  const card = await made.evaluate(el => ({scroll: el.scrollWidth, client: el.clientWidth}));
  assert(card.scroll <= card.client + 1, 'the new room card does not overflow');
  const pageCall = secretary.locator('.voice-call-button');
  assert(await pageCall.isVisible());
  const pageHeader = await secretary.locator('.schedule-page-header').evaluate(h => ({scroll: h.scrollWidth, client: h.clientWidth}));
  assert(pageHeader.scroll <= pageHeader.client + 1);
  const open = secretary.getByRole('button', {name: '開啟聊天室'}).first();
  assert(await open.evaluate(looksLikeButton), 'open-room is a visible button');
  await page.screenshot({path: path.join(output, 'phone-360-secretary-room.png')});
  await page.setViewportSize({width: 412, height: 915});
  await page.waitForTimeout(100);
  await page.screenshot({path: path.join(output, 'phone-412-secretary-room.png')});
  await page.locator('.secretary-page button[title="展開側欄"], main > header .header-title button[title="展開側欄"]').first().click();
  await sidebarLinks('phone-412');
  await page.locator('.sidebar button[title="收合側欄"]').click();
  await page.setViewportSize({width: 1280, height: 800});
  await page.waitForTimeout(100);
  await page.screenshot({path: path.join(output, 'desktop-1280-secretary-room.png')});
  if (!(await page.locator('.sidebar .sidebar-page-links').isVisible()))
    await page.locator('button[title="展開側欄"]').first().click();
  await sidebarLinks('desktop-1280');
  console.log(`Voice secretary UI probe passed. Screenshots: ${output}`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
assert.equal(errors.length, 0, `Page errors: ${errors.join(', ')}`);
