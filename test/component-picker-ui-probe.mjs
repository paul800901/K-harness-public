import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {startDesktop} from '../src/desktop-server.mjs';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {scratchBase} from './scratch.mjs';

const root = await mkdtemp(path.join(scratchBase, 'components-ui-'));
const evidence = probeEvidenceDir('component-picker');
await mkdir(evidence, {recursive: true});
const state = {
  messages: [],
  questions: [],
  tools: [],
  artifacts: [],
  conversationActivity: [],
  usage: {},
  status: 'idle',
  workspace: root,
  model: null,
  threadId: null,
  busy: false
};
const login = () => ({status: async () => ({installed: false, available: false}), close: async () => {}});
const start = () =>
  startDesktop({
    root,
    port: 0,
    claudeLoginFactory: login,
    codexLoginFactory: login,
    grokLoginFactory: login,
    geminiLoginFactory: login,
    controllerFactory: () => ({
      state,
      sessions: async () => ({sessions: []}),
      close: async () => {},
      usage: async () => ({}),
      models: async () => ({models: []})
    })
  });
let app = await start();
const browser = await launchProbeBrowser();
try {
  const page = await browser.newPage({viewport: {width: 360, height: 800}});
  const requests = [],
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => requests.push(new URL(req.url()).pathname));
  await page.goto(app.createLaunchUrl());
  const picker = page.getByRole('dialog', {name: '選擇要用的功能'});
  await picker.waitFor();
  assert.equal(await picker.getByRole('checkbox', {checked: true}).count(), 0);
  assert.equal(await picker.getByRole('checkbox', {name: /新對話|工作區|排程/}).count(), 0);
  for (const width of [360, 412]) {
    await page.setViewportSize({width, height: 800});
    assert.equal(await picker.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({path: path.join(evidence, width + '.png')});
  }
  await picker.getByRole('button', {name: '稍後再選'}).click();
  await picker.waitFor({state: 'hidden'});
  await page.reload();
  await picker.waitFor();
  await picker.getByRole('checkbox', {name: 'Android App', exact: true}).check();
  assert.equal(await picker.getByRole('checkbox', {name: '手機遠端'}).isChecked(), true);
  await picker.getByRole('checkbox', {name: '手機遠端'}).uncheck();
  assert.equal(await picker.getByRole('checkbox', {name: 'Android App', exact: true}).isChecked(), false);
  await picker.getByRole('checkbox', {name: 'Gemini（Antigravity）'}).check();
  await picker.getByRole('button', {name: '下一步'}).click();
  const next = page.getByRole('dialog', {name: '完成設定'});
  await next.getByText('Gemini（Antigravity）', {exact: true}).waitFor();
  await next.getByRole('button', {name: '開始使用'}).click();
  assert.equal(requests.includes('/api/core-update'), false);
  assert.equal(
    requests.some(route => /\/(login|transcribe|prepare)$/.test(route)),
    false
  );
  await page.close();
  await app.close();
  app = await start();
  const desk = await browser.newPage({viewport: {width: 1280, height: 960}});
  desk.on('pageerror', error => errors.push(error.message));
  desk.on('request', req => requests.push(new URL(req.url()).pathname));
  await desk.goto(app.createLaunchUrl());
  await desk.getByRole('button', {name: '設定', exact: true}).click();
  const settings = desk.getByRole('dialog', {name: '設定', exact: true});
  await settings.getByRole('button', {name: '更新 Antigravity'}).waitFor();
  assert.equal(await settings.locator('.core-updates button').count(), 1);
  assert.equal(await settings.locator('.provider-auth-row').count(), 1);
  await settings.getByRole('button', {name: '完成', exact: true}).click();
  assert.equal(await desk.getByRole('button', {name: '秘書室', exact: true}).count(), 0);
  assert.equal(await desk.getByRole('button', {name: '開始聽寫', exact: true}).count(), 0);
  await desk.getByRole('button', {name: '剩餘額度', exact: true}).click();
  await desk.getByRole('button', {name: '查看額度與用量詳情'}).click();
  const usage = desk.getByRole('dialog', {name: '額度與用量'});
  await usage.getByLabel('Gemini / Antigravity 訂閱剩餘額度').waitFor();
  assert.equal(await usage.locator('.usage-provider-section').count(), 1);
  await usage.getByRole('button', {name: '完成'}).click();
  await desk.getByRole('button', {name: '新對話', exact: true}).click();
  const create = desk.getByRole('dialog', {name: '新對話', exact: true});
  await create.locator('.model-provider-fixed').waitFor();
  assert.match(await create.locator('.model-provider-fixed').innerText(), /Gemini/);
  assert.equal(await create.locator('.model-provider-tabs').count(), 0);
  assert.equal(
    requests.some(p => /^\/api\/(codex|claude|grok|deepseek)\//.test(p)),
    false
  );
  await create.getByRole('button', {name: '關閉', exact: true}).first().click();
  await desk.getByRole('button', {name: '設定', exact: true}).click();
  await desk.getByRole('button', {name: '更改元件'}).click();
  const edit = desk.getByRole('dialog', {name: '元件', exact: true});
  await edit.getByRole('checkbox', {name: '聽寫', exact: true}).check();
  await edit.getByRole('button', {name: '儲存'}).click();
  await desk.getByRole('button', {name: '開始聽寫', exact: true}).waitFor({state: 'attached'});
  assert.deepEqual(errors, []);
  console.log('First run, phone layout, dependency, persistent Gemini-only settings, quota and model picker verified.');
} finally {
  await browser.close();
  await app.close();
}
