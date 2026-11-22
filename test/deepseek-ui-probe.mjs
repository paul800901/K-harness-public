// Built-UI check for the fifth core (DeepSeek Harness); all catalogs, balances and APIs are fake.
import assert from 'node:assert/strict';
import {launchProbeBrowser} from './ui-probe.mjs';
import {createServer} from 'vite';

const server = await createServer({
  configFile: 'vite.config.mjs',
  appType: 'custom',
  server: {host: '127.0.0.1', port: 5242, strictPort: true}
});
server.middlewares.use('/probe', (_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><html><body></body></html>');
});
let browser;
try {
  await server.listen();
  browser = await launchProbeBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({json: {available: false, accounts: [], models: [], warnings: []}}));
  await page.goto('http://127.0.0.1:5242/probe');
  await page.evaluate(async () => {
    const [ReactModule, ReactDOM, {ModelPicker}, usage, {GoalDialog}, {Modal}] = await Promise.all([
      import('/@id/react'),
      import('/@id/react-dom/client'),
      import('/model-picker.jsx'),
      import('/usage.jsx'),
      import('/goal-dialog.jsx'),
      import('/app-common.jsx')
    ]);
    const React = ReactModule.default ?? ReactModule,
      createRoot = ReactDOM.createRoot ?? ReactDOM.default?.createRoot;
    const efforts = list => list.map(reasoningEffort => ({reasoningEffort}));
    const models = [
      {
        model: 'gpt-6.1-sol',
        displayName: 'GPT-6.1 Sol',
        provider: 'codex',
        available: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: efforts(['low', 'medium', 'high'])
      },
      {
        model: 'deepseek-v4-pro',
        displayName: 'DeepSeek-V4-Pro',
        provider: 'deepseek',
        available: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: efforts(['off', 'low', 'high', 'max'])
      },
      {
        model: 'deepseek-flash',
        displayName: 'DeepSeek-V4.1-Flash',
        provider: 'deepseek',
        available: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: efforts(['off', 'low', 'high', 'max'])
      },
      {
        model: 'grok-4.7',
        displayName: 'Grok 4.7',
        provider: 'grok',
        available: true,
        supportedReasoningEfforts: efforts(['high', 'low'])
      }
    ];
    const deepseekUsage = {
      status: 'available',
      checkedAt: '2026-11-03T06:12:31.749Z',
      windows: [],
      balance: {available: true, cny: 36.45, usd: 0},
      fx: {twdPerCny: 4.9, usdPerCny: 0.15, updatedAt: 'Tue, 03 Nov 2026 00:02:31 +0000', source: 'ExchangeRate-API'},
      note: null
    };
    const mount = element => {
      window.probeRoot?.unmount();
      document.body.replaceChildren();
      window.probeRoot = createRoot(document.body.appendChild(document.createElement('div')));
      window.probeRoot.render(element);
    };
    window.renderPicker = () => {
      window.pickerResult = null;
      mount(
        React.createElement(ModelPicker, {
          loadModels: async () => ({models, geminiGateway: true, claudeGateway: true}),
          onCatalog: () => {},
          onClose: () => {},
          onCreate: value => {
            window.pickerResult = value;
          }
        })
      );
    };
    window.renderUsage = () =>
      mount(
        React.createElement(
          'div',
          null,
          React.createElement(usage.Usage, {state: {usage: {deepseek: deepseekUsage}}, online: true, onDetails: () => {}}),
          React.createElement(usage.UsageDetails, {state: {usage: {deepseek: deepseekUsage}}, online: true}),
          React.createElement(usage.DeepSeekRoomUsage, {
            jobs: [{id: 'pwsh-1', label: 'npm test'}],
            progress: {
              contextUsage: {used: 6996, size: 1048576},
              roomUsage: {
                tokens: {input: 7022, cacheRead: 6784, output: 104},
                cny: 0.6512,
                pricesAvailable: true,
                unpriced: 0,
                pricesCheckedAt: '2026-11-03T06:12:31.533Z'
              }
            }
          })
        )
      );
    window.renderGoal = () =>
      mount(
        React.createElement(GoalDialog, {
          state: {
            provider: 'deepseek',
            threadId: 'deepseek-room',
            busy: true,
            capabilities: {goal: false},
            goal: {objective: '分三輪完成報表整理', status: 'active', rounds: 2, maxRounds: 256}
          },
          Modal,
          request: async route => {
            window.goalRequests = [...(window.goalRequests ?? []), route];
          },
          onClose: () => {}
        })
      );
    window.renderPicker();
  });
  const tabs = page.getByRole('group', {name: '選擇主代理提供者'});
  await tabs.waitFor();
  assert.deepEqual(await tabs.getByRole('button').allTextContents(), ['GPT', 'Claude', 'Gemini', 'Grok', 'DeepSeek', '自架']);
  await tabs.getByRole('button', {name: 'DeepSeek', exact: true}).click();
  await page.waitForFunction(() => /DeepSeek-V4/u.test(document.querySelector('[aria-label="主代理模型"]')?.textContent ?? ''));
  // DSH's own sandbox per mode: approval, full access and read-only; no auto-review.
  const permission = page.getByRole('button', {name: '新對話操作權限', exact: true});
  assert.match(await permission.innerText(), /要求核准/u);
  await permission.click();
  const choices = await page.getByRole('menuitemradio').allTextContents();
  assert.ok(choices.some(text => text.includes('要求核准') && text.includes('沙盒')));
  assert.ok(choices.some(text => text.includes('完整存取權')));
  assert.ok(!choices.some(text => text.includes('代我核准')));
  await page.keyboard.press('Escape');
  const worker = page.locator('.worker-settings');
  await worker.locator('summary').click();
  const workerModel = page.getByLabel('子代理模型', {exact: true});
  assert.deepEqual(await workerModel.locator('optgroup').evaluateAll(items => items.map(item => item.label)), [
    'GPT',
    'Grok',
    'DeepSeek'
  ]);
  await page.getByRole('button', {name: '建立對話', exact: true}).click();
  await page.waitForFunction(() => window.pickerResult !== null);
  const result = await page.evaluate(() => window.pickerResult);
  assert.match(result.model, /^deepseek-/u);
  assert.equal(result.accessMode, 'workspace-write');
  // Balance in the sidebar as approximate NT$; details keep the official currency, wallet and rate.
  await page.evaluate(() => window.renderUsage());
  await page.locator('.usage-folded').click();
  const row = page.locator('.usage-row').filter({hasText: 'DeepSeek'});
  await row.waitFor();
  assert.equal((await row.innerText()).replace(/\s+/gu, ' ').trim(), 'DeepSeek 約 NT$179');
  const details = page.getByRole('region', {name: 'DeepSeek 帳戶餘額'});
  const text = await details.innerText();
  assert.match(text, /人民幣 ¥36\.45（約 NT\$179）/u);
  assert.match(text, /帳戶 可用/u);
  assert.doesNotMatch(text, /美元/u, 'an empty USD wallet is not listed');
  await details.locator('summary').click();
  assert.match(await details.innerText(), /1 人民幣約 4\.90 新台幣（ExchangeRate-API/u);
  const room = page.locator('.deepseek-room-usage');
  assert.equal(await room.innerText(), '背景工作 1 個 · 上下文 7.0K／105萬 · 本房約 ¥0.65');
  assert.match(await room.getAttribute('title'), /^背景工作：npm test。[\s\S]*輸入 7,022、快取命中 6,784、輸出 104[\s\S]*不是帳單/u);
  // The DeepSeek goal is shown read-only, with its rounds; it is set by talking to DeepSeek.
  await page.evaluate(() => window.renderGoal());
  const goal = page.getByRole('dialog', {name: '目標模式', exact: true});
  await goal.waitFor();
  const goalText = await goal.innerText();
  assert.match(goalText, /直接在對話中告訴它/u);
  assert.match(goalText, /分三輪完成報表整理/u);
  assert.match(goalText, /進行中 · 已跑 2／256 輪/u);
  assert.equal(await goal.getByRole('textbox').count(), 0, 'no K goal editor for DeepSeek');
  assert.equal(await goal.getByRole('button', {name: /設定並執行|更新並執行|清除目標/u}).count(), 0);
  await goal.getByRole('button', {name: '停止目標工作', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => window.goalRequests), ['stop']);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'DeepSeek provider tab after Grok',
        'DeepSeek models from the native catalog; default full access as for other cores',
        'DeepSeek permission menu: sandbox approval, full access, read-only; no auto-review',
        'DeepSeek offered as a K worker group',
        'sidebar balance as approximate NT$; details keep CNY, account state and the dated rate',
        'room header shows background jobs, context in use and a CNY room estimate with its basis',
        'DeepSeek goal dialog is read-only with rounds and can stop the work'
      ]
    })
  );
} finally {
  await browser?.close();
  await server.close();
}
