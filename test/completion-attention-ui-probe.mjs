// Built UI with simulated native focus; no real accounts or provider calls.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';
const output = process.env.K_ATTENTION_PROBE_OUTPUT
  ? path.resolve(process.env.K_ATTENTION_PROBE_OUTPUT)
  : probeEvidenceDir('taskbar-attention-20261004/ui');
await mkdir(output, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 5197, strictPort: true}});
const workspace = process.cwd(),
  projectName = '音訊範例與很長的工作區名稱測試不應遮住左側未讀數字',
  errors = [],
  results = [];
let browser;
const preload = await readFile(
  process.env.K_ATTENTION_PRELOAD_SOURCE ?? new URL('../src/electron-owner-preload.cjs', import.meta.url), 'utf8'
);
try {
  browser = await launchProbeBrowser();
  for (const [width, height, scale, theme] of [
    [1920, 1080, 100, 'warm'],
    [1100, 760, 125, 'light'],
    [900, 700, 125, 'dark'],
    [1440, 900, 100, 'warm'],
    [393, 852, 100, 'light']
  ]) {
    let state = {
      threadId: 'a',
      workspace,
      status: 'completed',
      busy: false,
      title: '測試 A',
      model: 'gpt-6.1-sol',
      provider: 'codex',
      messages: [{id: 'answer', role: 'assistant', text: '測試完成。'}],
      tools: [],
      questions: [],
      artifacts: [],
      workers: [],
      workerActivity: {running: 0, uncertain: false},
      conversationActivity: [],
      accessMode: 'workspace-write',
      capabilities: {},
      completionAttention: {
        sequence: 3,
        unread: ['a', 'b', 'c'].map((threadId, i) => ({
          threadId,
          sequence: i + 1,
          ...(threadId === 'b' ? {kind: 'attention'} : {})
        }))
      }
    };
    const reads = [],
      page = await browser.newPage({viewport: {width, height}});
    page.setDefaultTimeout(7000);
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(
      ({state, scale, theme, preload}) => {
        localStorage.setItem('k-appearance', JSON.stringify({interfaceScale: scale, dialogueFontSize: 18}));
        localStorage.setItem('k-color-theme', theme);
        window.EventSource = class {
          constructor() {
            window.testStream = this;
            setTimeout(() => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state})}), 0);
          }
          close() {}
        };
        const nativeListeners = new Map();
        window.testNativeFocused = false;
        window.testFocus = data => {
          window.testNativeFocused = data.focused;
          nativeListeners.get('k-native-window-focus')?.({}, data);
        };
        // Execute the actual preload; the transport alone is fake. A native
        // sample can change without an event, matching the live stale-cache bug.
        new Function('require', preload)(() => ({
          contextBridge: {exposeInMainWorld: (name, value) => {window[name] = value;}},
          ipcRenderer: {
            on: (name, listener) => nativeListeners.set(name, listener),
            removeListener: name => nativeListeners.delete(name),
            send: name => {
              if (name === 'k-native-window-focus-request')
                nativeListeners.get('k-native-window-focus')?.({}, {focused: window.testNativeFocused});
            }
          }
        }));
        window.testFocus({focused: false});
      },
      {state, scale, theme, preload}
    );
    const update = async changes => {
      state = {...state, ...changes};
      await page.evaluate(
        changes => window.testStream.onmessage({data: JSON.stringify({type: 'patch', changes})}),
        changes
      );
    };
    await page.route('**/api/**', async route => {
      const endpoint = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST') {
        assert.equal(endpoint, '/api/attention/read');
        const data = route.request().postDataJSON();
        reads.push(data);
        state.completionAttention = {
          ...state.completionAttention,
          unread: state.completionAttention.unread.filter(
            x => !(x.threadId === data.threadId && x.sequence === data.sequence)
          )
        };
        await route.fulfill({json: {viewed: true}});
        await update({completionAttention: state.completionAttention});
        return;
      }
      const json =
        endpoint === '/api/state'
          ? state
          : endpoint === '/api/projects'
            ? {projects: [{path: workspace, name: projectName}]}
            : endpoint === '/api/sessions'
              ? {
                  sessions: ['a', 'b', 'c'].map(threadId => ({
                    threadId,
                    workspace,
                    title: '測試 ' + threadId.toUpperCase(),
                    model: state.model
                  }))
                }
              : endpoint === '/api/models'
                ? {
                    models: [
                      {
                        model: state.model,
                        displayName: 'GPT-6.1 Sol',
                        provider: 'codex',
                        supportedReasoningEfforts: [{reasoningEffort: 'high'}]
                      }
                    ]
                  }
                : {};
      await route.fulfill({json});
    });
    await page.goto('http://127.0.0.1:5197');
    await page.waitForFunction(() => document.querySelectorAll('.completed-unread').length === 3);
    assert.equal(reads.length, 0, 'selected room stays unread while native window is unfocused');
    assert.equal(await page.getByLabel('工作需注意', {exact: true}).count(), 1);
    if (width < 600) await page.getByRole('button', {name: '展開側欄', exact: true}).click();
    const badge = page.locator('.project-unread-badge');
    assert.equal(await badge.textContent(), '3');
    await page.getByRole('button', {name: `收合工作區 ${projectName}`, exact: false}).click();
    assert.equal(await page.locator('.session-open').count(), 0);
    assert.equal(await badge.textContent(), '3', 'collapsed project retains unread room count');
    assert.equal(reads.length, 0, 'collapsing a project never acknowledges its rooms');
    await page.mouse.move(width - 1, 1);
    const geometry = await badge.evaluate(node => {
      const badge = node.getBoundingClientRect(),
        folder = [...node.parentElement.querySelectorAll('.project-folder,.project-chevron')]
          .find(icon => icon.getBoundingClientRect().width > 0).getBoundingClientRect(),
        name = node.parentElement.lastElementChild.getBoundingClientRect(),
        row = node.closest('.project-row').getBoundingClientRect(),
        style = getComputedStyle(node);
      return {left: badge.left, right: badge.right, width: badge.width, folderLeft: folder.left, nameLeft: name.left,
        rowLeft: row.left, rowRight: row.right, background: style.backgroundColor, color: style.color};
    });
    assert.ok(geometry.width >= 20 && geometry.left >= geometry.rowLeft && geometry.right <= geometry.folderLeft,
      JSON.stringify(geometry));
    assert.ok(geometry.right <= geometry.rowRight, 'long project name cannot clip the badge');
    assert.ok(geometry.right <= geometry.nameLeft, 'badge stays to the left of the project name');
    assert.equal(geometry.background, 'rgb(211, 47, 47)');
    assert.equal(geometry.color, 'rgb(255, 255, 255)');
    await page.screenshot({path: path.join(output, `${width}-${scale}-${theme}-collapsed.png`)});
    await page.getByRole('button', {name: `展開工作區 ${projectName}`, exact: false}).click();
    assert.equal(reads.length, 0, 'expanding a project never acknowledges its rooms');
    if (width < 600) await page.getByRole('button', {name: '收合側欄', exact: true}).click();
    await page.evaluate(() => {window.testNativeFocused = true;});
    await page.getByText('測試完成。', {exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('.completed-unread').length === 2);
    assert.deepEqual(reads, [{threadId: 'a', sequence: 1}], 'clicking the visible chat repairs stale focus and reads only A');
    assert.equal(await badge.textContent(), '2', 'reading one room reduces the project count');
    await page.evaluate(() => window.testFocus({focused: false}));
    await update({
      threadId: 'b',
      title: '測試 B',
      status: 'failed',
      error: '假資料：原生 compact/stream 已最終失敗',
      messages: [{id: 'partial', role: 'assistant', text: '假資料：已保存的部分結果。', partial: true}]
    });
    if (width < 600) await page.getByRole('button', {name: '展開側欄', exact: true}).click();
    await page.getByRole('button', {name: '設定', exact: true}).click();
    await page.evaluate(() => window.testFocus({focused: true}));
    await page.waitForTimeout(150);
    assert.equal(reads.length, 1, 'settings covering the chat does not read it');
    await page.getByRole('dialog').getByRole('button', {name: '關閉', exact: true}).click();
    if (width < 600) await page.getByRole('button', {name: '收合側欄', exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('.completed-unread').length === 1);
    assert.deepEqual(reads.at(-1), {threadId: 'b', sequence: 2, kind: 'attention'});
    await page.evaluate(() => window.testFocus({focused: false}));
    await update({
      completionAttention: {
        sequence: 4,
        unread: [
          {threadId: 'b', sequence: 4, kind: 'attention'},
          {threadId: 'c', sequence: 3}
        ]
      }
    });
    await page.waitForFunction(() => document.querySelectorAll('.completed-unread').length === 2);
    assert.equal(reads.length, 2, 'new background completion stays unread');
    assert.ok(
      await page.getByText('假資料：原生 compact/stream 已最終失敗', {exact: false}).count(),
      'main failure remains visible'
    );
    await update({artifacts: ['result.txt']});
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.app.inspector-hidden').count(), 1, 'no forced panel, even for new results');
    await page.screenshot({path: path.join(output, width + '-' + scale + '-' + theme + '.png')});
    await page.evaluate(() => window.testStream.onerror());
    await page.evaluate(() => window.testFocus({focused: true}));
    await page.waitForTimeout(100);
    assert.equal(reads.length, 2, 'disconnection does not acknowledge stale content');
    await page.evaluate(state => window.testStream.onmessage({data: JSON.stringify({type: 'snapshot', state})}), state);
    await page.waitForFunction(() => document.querySelectorAll('.completed-unread').length === 1);
    assert.deepEqual(reads.at(-1), {threadId: 'b', sequence: 4, kind: 'attention'});
    results.push({width, height, scale, theme, reads, collapsedBadge: geometry});
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({results, errors}, null, 2));
  console.log(JSON.stringify({passed: results.length, errors}));
} finally {
  await browser?.close();
  await server.httpServer.close();
}
