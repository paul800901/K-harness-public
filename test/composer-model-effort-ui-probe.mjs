// Built UI with fake API/SSE data; never opens a native model or a real conversation.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await preview({preview: {host: '127.0.0.1', port: 0}});
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const output = probeEvidenceDir('composer-model-effort-20261028');
const models = [
  ['claude-fable-5-1', 'Claude Fable 5.1', 'claude', ['high', 'max']],
  ['gpt-6.1-sol', 'GPT-6.1-Sol', 'codex', ['high', 'xhigh', 'ultra']],
  ['gemini-3.8-flash', 'Gemini 3.8 Flash', 'gemini', ['low', 'high']],
  ['gemma-local/example', '本機模型', 'gemma', []]
].map(([model, displayName, provider, efforts]) => ({
  model, displayName, provider,
  supportedReasoningEfforts: efforts.map(reasoningEffort => ({reasoningEffort}))
}));
let state = {
  threadId: 'claude:effort-room', workspace: root, title: '模型資訊',
  provider: 'claude', model: 'claude-fable-5-1', modelDisplayName: 'Claude Fable 5.1',
  effort: 'max', efforts: ['high', 'max'], status: 'idle', busy: false,
  accessMode: 'claude-bypassPermissions',
  messages: [{id: 'user-1', role: 'user', text: '既有聊天室', turnId: 'turn-1'}],
  tools: [], questions: [], artifacts: [], capabilities: {}, conversationActivity: []
};
const writes = [], errors = [];
let browser, acknowledgeSend;
try {
  browser = await launchProbeBrowser();
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(initial => {
    window.EventSource = class {
      constructor() {
        window.testState = next => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: next})});
        setTimeout(() => window.testState(initial), 0);
      }
      close() {}
    };
  }, state);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST') writes.push({path: url.pathname, data: request.postDataJSON()});
    const body = url.pathname === '/api/state' ? state
      : url.pathname === '/api/projects' ? {projects: [{path: root, name: '測試工作區'}]}
      : url.pathname === '/api/sessions' ? {sessions: []}
      : url.pathname === '/api/models' ? {models}
      : url.pathname === '/api/send' ? {sent: true} : {};
    if (url.pathname === '/api/send') await new Promise(resolve => { acknowledgeSend = resolve; });
    await route.fulfill({json: body});
  });
  const update = async patch => {
    state = {...state, ...patch};
    await page.evaluate(next => window.testState(next), state);
  };
  const desktop = page.getByRole('button', {name: '選擇主代理模型', exact: true});
  const mobile = page.getByRole('button', {name: '對話設定', exact: true});
  const checkMobileLayout = async () => {
    const layout = await page.evaluate(() => {
      const effort = document.querySelector('.mobile-model-effort'),
        button = document.querySelector('.mobile-composer-options'),
        icon = button.querySelector(':scope > svg'),
        send = document.querySelector('.composer-send-actions'),
        e = effort.getBoundingClientRect(), b = button.getBoundingClientRect(), s = send.getBoundingClientRect();
      return {effortFits: effort.scrollWidth <= effort.clientWidth + 1,
        inside: e.left >= b.left && e.right <= icon.getBoundingClientRect().left && e.bottom <= b.bottom,
        noOverlap: b.right <= s.left, noOverflow: document.documentElement.scrollWidth <= innerWidth};
    });
    assert.deepEqual(layout, {effortFits: true, inside: true, noOverlap: true, noOverflow: true});
  };
  await page.goto(origin);
  await desktop.getByText('· 最高', {exact: true}).waitFor();
  assert.match(await desktop.innerText(), /Fable 5\.1/);
  assert.match(await desktop.getAttribute('title'), /推理程度：最高/);
  await desktop.click();
  assert.equal(await page.getByLabel('主代理推理程度', {exact: true}).inputValue(), 'max');
  await page.getByRole('button', {name: '取消', exact: true}).click();
  await update({busy: true, status: 'running'});
  await page.waitForFunction(() => document.querySelector('.composer-model')?.disabled);
  assert.equal(await desktop.isDisabled(), true);
  assert.match(await desktop.innerText(), /最高/);
  await update({busy: false, status: 'idle', effort: 'high'});
  await desktop.getByText('· 高', {exact: true}).waitFor();
  await update({effort: null});
  await desktop.getByText('· 原生預設', {exact: true}).waitFor();
  await update({efforts: []});
  await desktop.getByText('· 原生預設', {exact: true}).waitFor({state: 'detached'});
  await update({effort: 'max', efforts: ['high', 'max']});
  await mkdir(output, {recursive: true});
  await page.screenshot({path: path.join(output, 'desktop-claude.png')});

  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: '收合側欄', exact: true}).click();
  await mobile.getByText('推理：最高', {exact: true}).waitFor();
  assert.equal(await desktop.isVisible(), false);
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    await checkMobileLayout();
  }
  await page.screenshot({path: path.join(output, 'mobile-claude-320.png')});
  await mobile.click();
  await page.getByRole('button', {name: '完成', exact: true}).click();

  // A different room must replace both labels; pending effort follows the existing picker semantics.
  await update({threadId: 'gpt-room', provider: 'codex', model: 'gpt-6.1-sol', modelDisplayName: 'GPT-6.1-Sol',
    effort: 'xhigh', efforts: ['high', 'xhigh', 'ultra'], accessMode: 'danger-full-access',
    serviceTier: 'default', effectiveServiceTier: 'default'});
  await mobile.getByText('推理：極高', {exact: true}).waitFor();
  assert.match(await mobile.innerText(), /GPT-6\.1-Sol/);
  await mobile.click();
  await page.getByRole('dialog', {name: '對話設定', exact: true})
    .getByRole('button', {name: '推理程度與速度', exact: true}).click();
  await page.getByRole('dialog', {name: '推理程度與速度設定', exact: true})
    .getByLabel('推理程度', {exact: true}).selectOption('ultra');
  await page.getByRole('button', {name: '完成', exact: true}).click();
  await mobile.getByText('推理：超高（Ultra）', {exact: true}).waitFor();
  await checkMobileLayout();
  await page.screenshot({path: path.join(output, 'mobile-gpt-ultra-320.png')});
  await update({busy: true, status: 'running'});
  await mobile.getByText('推理：極高', {exact: true}).waitFor();
  await update({busy: false, status: 'idle'});
  await mobile.getByText('推理：超高（Ultra）', {exact: true}).waitFor();

  await update({threadId: 'gpt-default-room', effort: null});
  await mobile.getByText('推理：原生預設', {exact: true}).waitFor();
  await checkMobileLayout();
  await page.screenshot({path: path.join(output, 'mobile-native-default-320.png')});

  await update({threadId: 'gemini-room', provider: 'gemini', model: 'gemini-3.8-flash',
    modelDisplayName: 'Gemini 3.8 Flash', effort: 'low', efforts: ['low', 'high']});
  await mobile.getByText('推理：低', {exact: true}).waitFor();
  assert.match(await mobile.innerText(), /Gemini 3\.8 Flash/);
  await update({threadId: 'local-room', provider: 'gemma', model: 'gemma-local/example',
    modelDisplayName: '本機模型', effort: null, efforts: []});
  await mobile.getByText('本機模型', {exact: true}).waitFor();
  assert.equal(await mobile.locator('.mobile-model-effort').count(), 0);
  const colabLabel = 'Llama3.2 Dark Champion 24B-A3B II Heretic · i1-Q4_K_M · Colab 雲端';
  await update({threadId: 'colab-room', provider: 'gemma',
    model: 'selfhost-colab-dark-champion-24b-heretic-i1-q4-k-m/dark-champion-24b-heretic-i1-q4-k-m',
    modelDisplayName: colabLabel, accessMode: 'workspace-write', messages: []});
  await page.getByRole('textbox', {name: '工作訊息', exact: true}).fill('測試長模型名稱下的送出按鈕');
  for (const width of [390, 320, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({width, height: 900});
    const button = width < 600 ? mobile : desktop;
    await button.getByText(colabLabel, {exact: true}).waitFor();
    const layout = await button.evaluate(node => {
      const model = node.getBoundingClientRect();
      const actions = document.querySelector('.composer-send-actions').getBoundingClientRect();
      const controls = document.querySelector('.composer-controls').getBoundingClientRect();
      return {
        sameRow: model.top < actions.bottom && model.bottom > actions.top,
        rightAligned: Math.abs(controls.right - actions.right) <= 2,
        noOverlap: model.right <= actions.left,
        noOverflow: document.documentElement.scrollWidth <= innerWidth
      };
    });
    assert.deepEqual(layout, {sameRow: true, rightAligned: true, noOverlap: true, noOverflow: true});
    await page.screenshot({path: path.join(output, `colab-composer-${width}.png`)});
  }
  assert.equal(writes.length, 0, 'Viewing labels and changing a draft effort must not send work or persist settings');
  await update({threadId: 'neon-a', model: 'gemini-4-neon', provider: 'gemini', status: 'ready',
    effort: 'xhigh', efforts: ['high', 'xhigh']});
  const picker = page.getByRole('combobox', {name: '推理程度', exact: true});
  await picker.selectOption('high');
  // An incoming snapshot can refresh the saved setting before the person presses send.
  await update({effort: 'medium'});
  assert.equal(await picker.inputValue(), 'high');
  await update({threadId: 'neon-b', effort: 'low'});
  await page.waitForFunction(() => document.querySelector('.composer-effort select')?.value === '');
  await update({threadId: 'neon-a', effort: 'xhigh'});
  await page.waitForFunction(() => document.querySelector('.composer-effort select')?.value === 'high');
  const message = page.getByRole('textbox', {name: '工作訊息', exact: true});
  await message.fill('room effort');
  const request = page.waitForRequest(req => new URL(req.url()).pathname === '/api/send');
  await message.press('Enter');
  const submitted = (await request).postDataJSON();
  await update({threadId: 'neon-b', effort: 'low'});
  await page.waitForFunction(() => document.querySelector('.composer-effort select')?.selectedOptions[0]?.textContent.includes('低'));
  const acknowledged = page.waitForResponse(res => new URL(res.url()).pathname === '/api/send');
  acknowledgeSend();
  await acknowledged;
  await update({threadId: 'neon-a', effort: 'high'});
  await page.waitForFunction(() => document.querySelector('.composer-effort select')?.selectedOptions[0]?.textContent.includes('沿用設定（高）'));
  assert.equal(submitted.threadId, 'neon-a');
  assert.equal(submitted.effort, 'high');
  assert.equal(writes.filter(item => item.path === '/api/send').length, 1);
  assert.deepEqual(errors, []);
  const result = {passed: true, checks: [
    'Claude saved effort is visible and agrees with model settings',
    'busy state and updated settings remain visible',
    'native default is explicit; unsupported efforts are not fabricated',
    'mobile 390px and 320px show effort without overlap',
    'room changes replace model and effort',
    'mobile GPT draft effort yields to running effort',
    'Gemini and self-hosted labels follow state',
    'long Colab labels keep send controls aligned across phone, tablet and desktop widths',
    'selection alone sends nothing; immediate navigation preserves the source room and effort in one mocked send',
    'no page errors'
  ]};
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
