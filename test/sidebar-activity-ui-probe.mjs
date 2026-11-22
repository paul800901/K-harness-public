// Built UI, synthetic rooms and state patches; no real conversations or native model work.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {preview} from 'vite';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {createStateStream} from '../shared/state-stream.mjs';

const output = probeEvidenceDir('sidebar-activity-20261112');
await mkdir(output, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 5199, strictPort: true}});
let browser;
const results = [],
  errors = [];
try {
  browser = await launchProbeBrowser();
  for (const theme of ['warm', 'light', 'dark'])
    for (const width of [1440, 390, 360]) {
      const projects = [
        {path: 'D:/A', name: '工作區甲'},
        {path: 'D:/B', name: '工作區乙：很長的工作區名稱也不擠掉聊天室標題'},
        {path: 'D:/C', name: '封存區', archived: true}
      ];
      const model = 'gpt-6.1-sol';
      const sessions = [
        {threadId: 'idle', title: '已讀閒置', workspace: 'D:/A', sortAt: '2026-11-12T12:00:00Z'},
        {
          threadId: 'running',
          title: '執行中的長標題聊天室，確認窄畫面顯示',
          workspace: 'D:/B',
          sortAt: '2026-11-12T10:00:00Z'
        },
        {threadId: 'approval', title: '等待本人確認', workspace: 'D:/A', sortAt: '2026-11-12T09:00:00Z'},
        {threadId: 'unread', title: '完成未讀成果', workspace: 'D:/B', sortAt: '2026-11-12T11:00:00Z'},
        {threadId: 'worker', title: '等待子代理', workspace: 'D:/A', sortAt: '2026-11-12T08:00:00Z', pinned: true},
        {threadId: 'archived', title: '封存對話', workspace: 'D:/A', archived: true},
        {threadId: 'hidden', title: '封存區內的工作', workspace: 'D:/C'},
        {threadId: 'child', title: '原生子對話', workspace: 'D:/A', parentThreadId: 'running'}
      ].map(s => ({...s, model}));
      const manualOrder = sessions.map(s => s.threadId);
      let state = {
        threadId: 'idle',
        title: '已讀閒置',
        workspace: 'D:/A',
        model,
        provider: 'codex',
        status: 'ready',
        busy: false,
        messages: [],
        tools: [],
        questions: [],
        workers: [],
        artifacts: [],
        queuedMessages: [],
        capabilities: {},
        sidebarPreferences: {layout: 'grouped', sort: 'manual', order: manualOrder, projectOrder: ['d:/b', 'd:/a']},
        conversationActivity: sessions.map(s => ({
          threadId: s.threadId,
          busy: ['running', 'archived', 'hidden', 'child'].includes(s.threadId),
          pendingQuestions: s.threadId === 'approval' ? 1 : 0,
          pendingWorkers: s.threadId === 'worker' ? 1 : 0
        })),
        completionAttention: {sequence: 1, unread: [{threadId: 'unread', sequence: 1}]}
      };
      const stream = createStateStream();
      const snapshot = stream.snapshot(state);
      const calls = [];
      const page = await browser.newPage({viewport: {width, height: 900}});
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(
        ({snapshot, theme}) => {
          localStorage.setItem('k-color-theme', theme);
          window.EventSource = class {
            constructor() {
              window.stream = this;
              setTimeout(() => this.onmessage?.({data: JSON.stringify(snapshot)}), 0);
            }
            close() {}
          };
        },
        {snapshot, theme}
      );
      const emit = async changes => {
        state = {...state, ...changes};
        const event = stream.update(state);
        if (event) await page.evaluate(event => window.stream.onmessage({data: JSON.stringify(event)}), event);
      };
      await page.route('**/api/**', async route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (route.request().method() === 'POST') {
          const data = route.request().postDataJSON();
          calls.push({endpoint, data});
          if (endpoint === '/api/sidebar/preferences') {
            state.sidebarPreferences = {...state.sidebarPreferences, ...data};
            await route.fulfill({json: state.sidebarPreferences});
            await emit({sidebarPreferences: state.sidebarPreferences});
            return;
          }
          if (endpoint === '/api/open') {
            const row = sessions.find(s => s.threadId === data.threadId);
            await route.fulfill({json: {threadId: row.threadId}});
            await emit({
              threadId: row.threadId,
              workspace: row.workspace,
              title: row.title,
              messages: [{id: 'answer', role: 'assistant', text: '可閱讀的完成成果'}]
            });
            return;
          }
          if (endpoint === '/api/attention/read') {
            await route.fulfill({json: {viewed: true}});
            await emit({
              completionAttention: {
                ...state.completionAttention,
                unread: state.completionAttention.unread.filter(item => item.threadId !== data.threadId)
              }
            });
            return;
          }
          throw Error(`Unexpected write: ${endpoint}`);
        }
        await route.fulfill({
          json:
            endpoint === '/api/sessions'
              ? {sessions}
              : endpoint === '/api/projects'
                ? {projects}
                : endpoint === '/api/state'
                  ? state
                  : {}
        });
      });
      await page.goto('http://127.0.0.1:5199');
      if (width < 600) await page.getByRole('button', {name: '展開側欄', exact: true}).click();
      const titles = () => page.locator('.session-title>span').allTextContents();
      await page.locator('.session-open').first().waitFor();
      const original = await titles();
      // Collapsed workspace preferences survive a complete activity round trip.
      await page.getByRole('button', {name: '收合工作區 工作區甲', exact: true}).click();
      const collapsed = await titles();
      const bell = page.getByRole('button', {name: '活動檢視', exact: true});
      await bell.click();
      await page.locator('.activity-list').waitFor();
      assert.deepEqual(await titles(), ['完成未讀成果', sessions[1].title, '等待本人確認', '等待子代理']);
      assert.equal(await page.locator('.project-row').count(), 0);
      assert.equal(await page.locator('.session-workspace').count(), 4);
      assert.equal(
        calls.filter(c => c.endpoint === '/api/attention/read').length,
        0,
        'view toggle is not a read receipt'
      );
      assert.deepEqual(state.sidebarPreferences.order, manualOrder);
      const geometry = await page.locator('.workspace-heading').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return [...node.children].map(item => {
          const r = item.getBoundingClientRect();
          return {left: r.left, right: r.right, boundLeft: bounds.left, boundRight: bounds.right};
        });
      });
      assert.ok(
        geometry.every(r => r.left >= r.boundLeft && r.right <= r.boundRight + 1),
        JSON.stringify(geometry)
      );
      const rowGeometry = await page.locator('.activity-list .session-open').evaluateAll(nodes =>
        nodes.map(node => {
          const title = node.querySelector('.session-title').getBoundingClientRect();
          const status = node.querySelector('.session-activity').getBoundingClientRect();
          const workspace = node.querySelector('.session-workspace').getBoundingClientRect();
          return {
            titleRight: title.right,
            statusLeft: status.left,
            titleBottom: title.bottom,
            workspaceTop: workspace.top,
            scrollWidth: node.scrollWidth,
            width: node.clientWidth
          };
        })
      );
      assert.ok(
        rowGeometry.every(
          r => r.titleRight <= r.statusLeft && r.titleBottom <= r.workspaceTop + 1 && r.scrollWidth <= r.width + 1
        )
      );
      await page.screenshot({path: path.join(output, `${theme}-${width}.png`)});
      // Background completion comes over SSE; it refreshes the activity timestamp without navigating.
      sessions.find(s => s.threadId === 'running').sortAt = '2026-11-12T13:00:00Z';
      await emit({
        conversationActivity: state.conversationActivity.map(a => (a.threadId === 'running' ? {...a, busy: false} : a)),
        completionAttention: {
          sequence: 2,
          unread: [...state.completionAttention.unread, {threadId: 'running', sequence: 2}]
        }
      });
      await page.waitForFunction(
        title => document.querySelector('.session-title>span')?.textContent === title,
        sessions[1].title
      );
      // Clear only the actual opened result; the other unread room remains.
      await page.locator('.session-open').filter({hasText: '完成未讀成果'}).click();
      await page.getByText('可閱讀的完成成果', {exact: true}).waitFor();
      await page.waitForFunction(
        () => ![...document.querySelectorAll('.session-title>span')].some(n => n.textContent === '完成未讀成果')
      );
      assert.ok(state.completionAttention.unread.some(item => item.threadId === 'running'));
      if (width < 600) await page.getByRole('button', {name: '展開側欄', exact: true}).click();
      await bell.click();
      await page.locator('nav[aria-label="工作區與對話"]').waitFor();
      assert.deepEqual(await titles(), collapsed);
      await page.getByRole('button', {name: '展開工作區 工作區甲', exact: true}).click();
      assert.deepEqual(await titles(), original);
      // Both menu choices and bell share the same view, without a second recent sorting mode.
      await page.getByRole('button', {name: '檢視選項：手動排序', exact: true}).click();
      await page.locator(':popover-open').getByRole('button', {name: '活動檢視', exact: true}).click();
      await page.locator('.activity-list').waitFor();
      await emit({
        conversationActivity: state.conversationActivity.map(a => ({
          ...a,
          busy: false,
          pendingQuestions: 0,
          pendingWorkers: 0
        })),
        completionAttention: {sequence: 2, unread: []}
      });
      await page.getByText('目前沒有執行中、待處理或完成未讀的聊天室', {exact: true}).waitFor();
      await bell.click();
      await page.locator('nav[aria-label="工作區與對話"]').waitFor();
      assert.deepEqual(await titles(), original);
      assert.deepEqual(state.sidebarPreferences.order, manualOrder);
      assert.ok(calls.filter(c => c.endpoint === '/api/sidebar/preferences').every(c => !('order' in c.data)));
      assert.equal(calls.filter(c => ['/api/send', '/api/stop', '/api/goal'].includes(c.endpoint)).length, 0);
      results.push({theme, width, geometry, rowGeometry, passed: true});
      await page.close();
    }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({results, errors}, null, 2));
  console.log(`Activity view: ${results.length} desktop/mobile/theme cases passed.`);
} finally {
  await browser?.close();
  await server.httpServer.close();
}
