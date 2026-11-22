// Built-UI check for the fourth core (Grok Build); all catalogs and APIs are fake.
import assert from 'node:assert/strict';
import {launchProbeBrowser} from './ui-probe.mjs';
import {createServer} from 'vite';

const server = await createServer({
  configFile: 'vite.config.mjs',
  appType: 'custom',
  server: {host: '127.0.0.1', port: 5241, strictPort: true}
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
  const loginRequests = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/grok/auth')
      return route.fulfill({
        json: {
          available: true,
          plan: 'SuperGrok Lite',
          version: '1.0.70',
          auth: {status: 'authenticated', loggedIn: true}
        }
      });
    if (url.pathname === '/api/grok/login') {
      loginRequests.push(route.request().method());
      return route.fulfill({json: {login: {status: 'opened'}, reason: 'opened'}});
    }
    return route.fulfill({json: {available: false, accounts: [], models: [], warnings: []}});
  });
  await page.goto('http://127.0.0.1:5241/probe');
  await page.evaluate(async () => {
    const [ReactModule, ReactDOM, {ModelPicker}] = await Promise.all([
      import('/@id/react'),
      import('/@id/react-dom/client'),
      import('/model-picker.jsx')
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
        model: 'grok-4.7',
        displayName: 'Grok 4.7',
        provider: 'grok',
        available: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: efforts(['xhigh', 'high', 'medium', 'low'])
      },
      {
        model: 'grok-4.5',
        displayName: 'Grok 4.5',
        provider: 'grok',
        available: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: efforts(['high', 'medium', 'low'])
      },
      {
        model: 'gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        provider: 'gemini',
        available: true,
        supportedReasoningEfforts: efforts(['low', 'medium', 'high'])
      }
    ];
    window.renderPicker = (props = {}) => {
      window.pickerResult = null;
      window.pickerRoot?.unmount();
      document.body.replaceChildren();
      window.pickerRoot = createRoot(document.body.appendChild(document.createElement('div')));
      window.pickerRoot.render(
        React.createElement(ModelPicker, {
          ...props,
          loadModels: async () => ({models, geminiGateway: true, claudeGateway: true}),
          onCatalog: () => {},
          onClose: () => {},
          onCreate: value => {
            window.pickerResult = value;
          }
        })
      );
    };
    window.renderPicker();
  });
  const tabs = page.getByRole('group', {name: '選擇主代理提供者'});
  await tabs.waitFor();
  assert.deepEqual(await tabs.getByRole('button').allTextContents(), [
    'GPT',
    'Claude',
    'Gemini',
    'Grok',
    'DeepSeek',
    '自架'
  ]);
  await tabs.getByRole('button', {name: 'Grok', exact: true}).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="主代理模型"]')?.textContent.includes('Grok 4.7')
  );
  // Grok permission choices: K answers each native prompt; no auto-review.
  const permission = page.getByRole('button', {name: '新對話操作權限', exact: true});
  assert.match(await permission.innerText(), /要求核准/u);
  await permission.click();
  const choices = await page.getByRole('menuitemradio').allTextContents();
  assert.ok(choices.some(text => text.includes('要求核准')));
  assert.ok(choices.some(text => text.includes('完整存取權')));
  assert.ok(!choices.some(text => text.includes('代我核准')));
  await page.keyboard.press('Escape');
  // A Grok main room offers every connected provider's K workers, including Grok.
  const worker = page.locator('.worker-settings');
  await worker.locator('summary').click();
  const workerModel = page.getByLabel('子代理模型', {exact: true});
  assert.deepEqual(
    new Set(await workerModel.locator('option').evaluateAll(items => items.map(item => item.value))),
    new Set(['auto', 'gpt-6.1-sol', 'gemini-3.8-flash', 'grok-4.7', 'grok-4.5'])
  );
  assert.deepEqual(await workerModel.locator('optgroup').evaluateAll(items => items.map(item => item.label)), [
    'GPT',
    'Gemini',
    'Grok'
  ]);
  // Account connections show the Grok subscription row.
  const accounts = page.locator('.provider-auth-status');
  await page.waitForFunction(() =>
    document.querySelector('.provider-auth-status')?.textContent.includes('Grok 已登入')
  );
  if (!(await accounts.evaluate(element => element.open))) await accounts.locator('summary').click();
  assert.match(await accounts.innerText(), /已確認 Grok 訂閱（SuperGrok Lite） · Grok Build 1\.0\.70/u);
  assert.equal(await page.getByRole('button', {name: '登入 Grok', exact: true}).isDisabled(), true);
  assert.deepEqual(
    loginRequests.filter(method => method === 'POST'),
    [],
    'reading progress must never start a login'
  );
  assert.ok(loginRequests.includes('GET'), 'recover the pending native flow on reopening settings');
  await page.getByRole('button', {name: '建立對話', exact: true}).click();
  await page.waitForFunction(() => window.pickerResult !== null);
  const result = await page.evaluate(() => window.pickerResult);
  assert.equal(result.model, 'grok-4.7');
  assert.equal(result.accessMode, 'workspace-write');
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'Grok provider tab between Gemini and self-hosted',
        'Grok models from the native catalog',
        'Grok permission menu without auto-review; default full access as for other cores',
        'Grok main offers GPT / Gemini / Grok K workers',
        'account row shows plan and core version; signed-in login button disabled'
      ]
    })
  );
} finally {
  await browser?.close();
  await server.close();
}
