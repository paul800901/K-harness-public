// Built UI with fake API/snapshot data only: no formal K, LM Studio, model load,
// inference or provider call. Observes the self-hosted model-picker note,
// permission copy, Chinese failure notice with raw details, and the
// preparation wording of the work status.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';

const root = process.cwd(),
  origin = 'http://127.0.0.1:5237',
  out = probeEvidenceDir('selfhost-ui-probe');
await mkdir(out, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 5237, strictPort: true}});
const selfHostModel = 'selfhost-dolphin-mistral-24b/dolphin-mistral-24b-venice-edition';
const models = [
  {
    model: 'gpt-6.1-sol',
    displayName: 'GPT-6.1-Sol',
    provider: 'codex',
    supportedReasoningEfforts: [{reasoningEffort: 'high'}],
    defaultReasoningEffort: 'high',
    inputModalities: ['text']
  },
  {
    model: selfHostModel,
    displayName: 'Dolphin Mistral 24B Venice Edition Q4_K_M · 本機',
    provider: 'gemma',
    available: true,
    supportedReasoningEfforts: [],
    inputModalities: ['text']
  }
];
// Exact turn error observed from installed Codex 0.163.0 against a loopback HTTP 400
// (mock native endpoint; no model engine invoked): one call, no retry, turn failed.
const observed = {
  message:
    '{"error":{"message":"本機模型載入失敗；未送出推論。","code":"k_selfhost_load_failed","diagnostic":{"stderr":"Synthetic native load error; no model engine invoked."}}}',
  codexErrorInfo: 'other',
  additionalDetails: null
};
// Fake catalog rows shaped like K's self-host rows (location + Colab runtime
// status). The idle/stop-unconfirmed Colab states are synthetic UI data only;
// no Colab control is connected and nothing is started.
const placeModels = [
  models[0],
  {...models[1], location: 'local'},
  {
    model: 'selfhost-colab-qwen36/qwen36-bf16',
    displayName: 'Qwen3.6 35B-A3B Abliterated · BF16 · Colab 雲端',
    provider: 'gemma',
    location: 'colab',
    runtimeStatus: 'unconfigured',
    available: false,
    description: 'qwen36-bf16；Colab 未設定：K 尚未接通 Colab 管理入口與登入，目前無法送出。',
    supportedReasoningEfforts: [],
    inputModalities: ['text']
  },
  {
    model: 'selfhost-colab-gemma31/gemma31-bf16',
    displayName: 'Gemma 4 31B IT ARA-heretic · BF16 · Colab 雲端',
    provider: 'gemma',
    location: 'colab',
    runtimeStatus: 'idle',
    available: true,
    description: 'gemma31-bf16；未啟動。',
    supportedReasoningEfforts: [],
    inputModalities: ['text']
  },
  {
    model: 'selfhost-colab-mixtral/mixtral-q8',
    displayName: 'Dolphin 2.7 Mixtral 8x7B · Q8_0 · Colab 雲端',
    provider: 'gemma',
    location: 'colab',
    runtimeStatus: 'stop-unconfirmed',
    available: false,
    description: 'mixtral-q8；關閉待確認。',
    supportedReasoningEfforts: [],
    inputModalities: ['text']
  }
];
// Optional: rows produced by K's real loader from an actual self-host config
// (K_SELFHOST_CONFIG, e.g. the installed private gemma-main.json; never committed).
// Network and the lms CLI are blocked and counted, so listing reaches no engine,
// Colab or GPU.
async function realRows(file) {
  const [{loadGemmaConnections}, {createLocalModelRuntime}, {scratchBase}, {copyFile, mkdtemp}] = await Promise.all([
    import('../src/gemma-main.mjs'),
    import('../src/local-model-runtime.mjs'),
    import('./scratch.mjs'),
    import('node:fs/promises')
  ]);
  const stateRoot = await mkdtemp(path.join(scratchBase, 'selfhost-real-'));
  await mkdir(path.join(stateRoot, '.runtime'));
  await copyFile(file, path.join(stateRoot, '.runtime', 'gemma-main.json'));
  const fetches = [],
    lmsRuns = [];
  const fetchImpl = async url => {
    fetches.push(String(url));
    throw new Error('network blocked in UI probe');
  };
  const connections = await loadGemmaConnections(stateRoot, {
    fetchImpl,
    dolphinFetchImpl: fetchImpl,
    localRuntimeFactory: options =>
      createLocalModelRuntime({
        ...options,
        runImpl: async (...args) => {
          lmsRuns.push(args.map(String));
          throw new Error('lms blocked in UI probe');
        }
      })
  });
  const rows = (await Promise.all(connections.map(c => c.models()))).flatMap(r => r.models);
  await Promise.all(connections.map(c => c.close()));
  return {rows: rows.map(row => ({...row, provider: 'gemma'})), fetches, lmsRuns: lmsRuns.length};
}
let currentModels = models;
const results = [],
  errors = [],
  posts = [];

// remote: the phone (remote) layout, as K serves it to the phone, with touch input.
async function openPage(browser, state, {remote = false, width = 1440, height = 900} = {}) {
  const page = await browser.newPage({viewport: {width, height}, hasTouch: remote});
  if (remote)
    await page.route(`${origin}/`, async r => {
      const res = await r.fetch();
      await r.fulfill({response: res, body: (await res.text()).replace('<html', '<html data-k-remote="true"')});
    });
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(state => {
    window.EventSource = class {
      constructor() {
        window.testState = s => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: s})});
        setTimeout(() => {
          this.onopen?.();
          window.testState(state);
        }, 0);
      }
      close() {}
    };
  }, state);
  await page.route('**/api/**', async route => {
    const request = route.request(),
      name = new URL(request.url()).pathname;
    if (request.method() === 'POST') posts.push(name);
    await route.fulfill({
      json:
        name === '/api/state'
          ? state
          : name === '/api/projects'
            ? {projects: [{path: root, name: '假工作區'}]}
            : name === '/api/sessions'
              ? {sessions: []}
              : name === '/api/models'
                ? {models: currentModels}
                : name.endsWith('/auth')
                  ? {available: false}
                  : {}
    });
  });
  await page.goto(origin);
  return page;
}

let browser;
try {
  browser = await launchProbeBrowser();

  // 1. New-conversation dialog: self-host note and permission copy.
  {
    const page = await openPage(browser, {
      threadId: null,
      workspace: root,
      status: 'idle',
      busy: false,
      messages: [],
      tools: [],
      questions: [],
      artifacts: [],
      accessMode: 'workspace-write',
      provider: 'codex',
      capabilities: {},
      conversationActivity: []
    });
    await page.getByRole('button', {name: '新對話', exact: true}).click();
    const providers = page.getByRole('group', {name: '選擇主代理提供者', exact: true});
    const note = '選取不會載入模型；本機模型在送出工作後才由 K 在背景載入。';
    await providers.getByRole('button', {name: 'GPT', exact: true}).click();
    assert.equal(await page.getByText(note, {exact: true}).count(), 0, 'note is self-host only');
    const trigger = page.getByRole('button', {name: '新對話操作權限', exact: true}),
      menu = page.getByRole('menu', {name: '操作權限選單', exact: true});
    await trigger.click();
    await menu.waitFor({state: 'visible'});
    const gptFull = await menu.getByRole('menuitemradio', {name: /^完整存取權/}).textContent();
    assert.match(gptFull, /K 沒有另外的隔離層/);
    assert.doesNotMatch(gptFull, /外部隔離/);
    assert.match(await menu.getByRole('menuitemradio', {name: /^代我核准/}).textContent(), /額外存取由 Codex 自動審查/);
    await page.keyboard.press('Escape');
    await menu.waitFor({state: 'hidden'});

    await providers.getByRole('button', {name: '自架', exact: true}).click();
    await page.getByText(note, {exact: true}).waitFor();
    await trigger.click();
    await menu.waitFor({state: 'visible'});
    const autoReview = await menu.getByRole('menuitemradio', {name: /^代我核准/}).textContent(),
      full = await menu.getByRole('menuitemradio', {name: /^完整存取權/}).textContent();
    assert.match(autoReview, /沿用 Codex 原生自動審查設定/);
    assert.match(autoReview, /尚未驗證/);
    assert.match(full, /K 沒有另外的隔離層/);
    for (const text of [autoReview, full]) assert.doesNotMatch(text, /外部隔離|Dolphin|GPT|已驗證/);
    await page.screenshot({path: path.join(out, 'selfhost-permission-menu.png')});
    await menu.getByRole('menuitemradio', {name: /^代我核准/}).click();
    const confirm = page.getByRole('group', {name: '確認操作權限', exact: true});
    await confirm.getByText('改用 Codex 原生自動審查？', {exact: true}).waitFor();
    assert.match(await confirm.textContent(), /尚未驗證.*K 不會替你改成其他權限模式/s);
    await page.screenshot({path: path.join(out, 'selfhost-auto-review-confirm.png')});
    await confirm.getByRole('button', {name: '取消', exact: true}).click();
    // Cancelling keeps the default; nothing was chosen or sent for the owner.
    assert.equal((await trigger.textContent()).trim(), '要求核准');
    assert.equal(posts.includes('/api/open'), false);
    results.push({part: 'new-dialog', passed: true});
    await page.close();
  }

  // 2. Self-hosted room: Chinese failure first, raw native record expandable.
  {
    const state = {
      threadId: 'fake-selfhost-room',
      title: '假資料：自架模型載入失敗',
      workspace: root,
      provider: 'gemma',
      model: selfHostModel,
      accessMode: 'workspace-write',
      status: 'failed',
      busy: false,
      error: observed.message,
      turnError: {threadId: 'fake-selfhost-room', turnId: 'fake-turn', status: 'failed', error: observed},
      messages: [
        {
          id: 'fake-user',
          role: 'user',
          turnId: 'fake-turn',
          text: '你好 你中文如何?',
          createdAt: '2026-10-19T12:01:00Z'
        }
      ],
      tools: [],
      questions: [],
      notices: [{id: 'failure', kind: 'nativeError', level: 'error', message: observed.message, error: observed}],
      artifacts: [],
      capabilities: {},
      conversationActivity: [],
      workerActivity: {running: 0, unconfirmed: 0, uncertain: false}
    };
    const page = await openPage(browser, state);
    await page.getByRole('heading', {name: state.title}).waitFor();
    const alert = page.locator('main > [role="alert"]');
    await alert.getByText('本機模型載入失敗；未送出推論。', {exact: true}).waitFor();
    assert.equal(await page.locator('[role="alert"]').count(), 1, 'failure is shown once');
    let details = alert.locator('details');
    // The untranslated native diagnostic stays collapsed until asked for.
    assert.equal(await details.locator('pre').isVisible(), false);
    assert.equal(await details.locator('summary').textContent(), '查看原生錯誤詳細內容');
    await page.screenshot({path: path.join(out, 'selfhost-failure-summary.png')});
    await details.locator('summary').click();
    assert.deepEqual(JSON.parse(await details.locator('pre').textContent()), state.turnError);
    await page.screenshot({path: path.join(out, 'selfhost-failure-raw.png')});

    // Permission menu inside the self-hosted room uses the same honest copy.
    await page.locator('.composer-options .permission-trigger').click();
    const menu = page.getByRole('menu', {name: '操作權限選單', exact: true});
    await menu.waitFor({state: 'visible'});
    assert.match(await menu.getByRole('menuitemradio', {name: /^代我核准/}).textContent(), /尚未驗證/);
    await page.keyboard.press('Escape');

    // A K error string without a native record still offers its original text.
    await page.evaluate(s => window.testState({...s, turnError: null, notices: []}), state);
    await alert.getByText('本機模型載入失敗；未送出推論。', {exact: true}).waitFor();
    details = alert.locator('details');
    await details.getByText('查看原始內容', {exact: true}).waitFor();
    await details.locator('summary').click();
    assert.equal(await details.locator('pre').textContent(), observed.message);

    // 3. Busy self-hosted turn before model output: honest preparation wording only.
    const now = await page.evaluate(() => Date.now());
    await page.evaluate(s => window.testState(s), {
      ...state,
      status: 'working',
      busy: true,
      error: null,
      turnError: null,
      notices: [],
      activity: {startedAt: now, lastEventAt: now, phase: 'starting', phaseSince: now}
    });
    const status = page.locator('.work-status').first();
    await status.getByText(/^正在準備自架模型或等待回覆 · /).waitFor();
    assert.doesNotMatch(await status.textContent(), /已載入|正在載入|執行中/);
    await page.screenshot({path: path.join(out, 'selfhost-preparing-status.png')});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(posts.length, 0, 'viewing never submits, loads or replays work');
    results.push({part: 'selfhost-room', passed: true});
    await page.close();
  }
  // 4. Self-host models grouped by where they run, with K-recorded Colab status;
  // checked at desktop and phone widths. Choosing never posts anything.
  currentModels = placeModels;
  for (const width of [1440, 412, 360]) {
    const page = await openPage(browser, {
      threadId: null,
      workspace: root,
      status: 'idle',
      busy: false,
      messages: [],
      tools: [],
      questions: [],
      artifacts: [],
      accessMode: 'workspace-write',
      provider: 'codex',
      capabilities: {},
      conversationActivity: []
    });
    await page.setViewportSize({width, height: width === 1440 ? 900 : 800});
    const create = page.getByRole('button', {name: '新對話', exact: true});
    if (!(await create.isVisible()))
      await page
        .getByRole('button', {name: /開啟側欄|側欄/})
        .first()
        .click();
    await create.click();
    await page
      .getByRole('group', {name: '選擇主代理提供者', exact: true})
      .getByRole('button', {name: '自架', exact: true})
      .click();
    await page
      .getByText('Colab 雲端尚待本人建立 Google 授權用戶端，相關模型暫時不能選；不會啟動 runtime 或消耗運算單元。', {
        exact: true
      })
      .waitFor();
    await page.getByRole('button', {name: '主代理模型', exact: true}).click();
    const menu = page.getByRole('menu', {name: '主代理模型選單', exact: true});
    await menu.waitFor({state: 'visible'});
    const groups = await menu
      .getByRole('group')
      .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.deepEqual(groups, [
      '本機 · 8GB 顯卡＋RAM 量化',
      'Colab 雲端 · Gemma · 高精度',
      'Colab 雲端 · Qwen · 高精度',
      'Colab 雲端 · 其他 · 量化'
    ]);
    assert.equal(await page.getByText(/自管 SSH|SSH 轉送|租用機器/).count(), 0, 'no cancelled SSH route or hint');
    const item = name => menu.getByRole('menuitemradio', {name, exact: true});
    assert.equal(await item('Qwen3.6 35B-A3B Abliterated · BF16 · Colab 雲端').isDisabled(), true);
    assert.match(
      await item('Qwen3.6 35B-A3B Abliterated · BF16 · Colab 雲端').textContent(),
      /未設定（待本人建立授權用戶端）/
    );
    assert.match(await item('Dolphin 2.7 Mixtral 8x7B · Q8_0 · Colab 雲端').textContent(), /關閉待確認/);
    assert.match(await item('Gemma 4 31B IT ARA-heretic · BF16 · Colab 雲端').textContent(), /未啟動/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({path: path.join(out, `selfhost-place-groups-${width}.png`)});
    await item('Gemma 4 31B IT ARA-heretic · BF16 · Colab 雲端').click();
    await page
      .getByText('選取與建立對話不會啟動 Colab；送出工作後才由 K 準備雲端，取消或說結束時由 K 關閉並讀回。', {
        exact: true
      })
      .waitFor();
    if (width === 1440) await page.screenshot({path: path.join(out, 'selfhost-colab-selected.png')});
    assert.equal(posts.length, 0, 'listing and choosing a Colab model start nothing');
    await page.close();
  }
  results.push({part: 'self-host-places', passed: true});
  // 5. Fork catalog retains unavailable candidates and their status, matching
  // new/switch menus. Looking at or selecting a target submits nothing.
  for (const width of [1440, 360]) {
    const page = await openPage(browser, {
      threadId: 'fake-fork-room',
      workspace: root,
      provider: 'gemma',
      model: selfHostModel,
      status: 'completed',
      busy: false,
      accessMode: 'workspace-write',
      messages: [
        {id: 'u', role: 'user', groupId: 'g', text: '假請求'},
        {id: 'a', role: 'assistant', groupId: 'g', text: '假結論', completedAt: '2026-11-13T00:00:00Z'}
      ],
      tools: [],
      questions: [],
      artifacts: [],
      capabilities: {},
      conversationActivity: []
    });
    await page.setViewportSize({width, height: 900});
    if (width < 600) await page.getByRole('button', {name: '收合側欄', exact: true}).click();
    await page.getByRole('button', {name: '分支', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: '分支到新對話'});
    await dialog.getByLabel('目標供應商').selectOption('gemma');
    const select = dialog.getByRole('combobox').nth(1);
    await select.getByRole('option', {name: /Qwen3.6.*未設定/}).waitFor({state: 'attached'});
    assert.equal(await select.getByRole('option', {name: /Qwen3.6.*未設定/}).evaluate(node => node.disabled), true);
    assert.equal(await select.getByRole('option', {name: /Mixtral.*關閉待確認/}).evaluate(node => node.disabled), true);
    assert.deepEqual(await select.locator('optgroup').evaluateAll(nodes => nodes.map(node => node.label)), [
      '本機 · 8GB 顯卡＋RAM 量化',
      'Colab 雲端 · Gemma · 高精度',
      'Colab 雲端 · Qwen · 高精度',
      'Colab 雲端 · 其他 · 量化'
    ]);
    await select.selectOption('selfhost-colab-gemma31/gemma31-bf16');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({path: path.join(out, `selfhost-fork-${width}.png`)});
    assert.equal(posts.length, 0);
    await page.close();
  }
  results.push({part: 'self-host-fork-places', passed: true});
  // 6. Real config rows (only when K_SELFHOST_CONFIG is given): new conversation,
  // switch and fork all show exactly local + Colab, every Colab row greyed out.
  if (process.env.K_SELFHOST_CONFIG) {
    const real = await realRows(process.env.K_SELFHOST_CONFIG);
    const local = real.rows.filter(row => row.location === 'local'),
      colabRows = real.rows.filter(row => row.location === 'colab');
    assert.equal(local.length, 5, 'the installed configuration retains the five local models');
    assert(colabRows.length >= 12, 'the Colab candidates are represented');
    const darkQuant = colabRows.find(row => row.model.startsWith('selfhost-colab-dark-champion-24b-heretic-i1-q4-k-m/'));
    assert.equal(local.length + colabRows.length, real.rows.length, 'only local and Colab rows');
    assert(colabRows.every(row => row.runtimeStatus === 'unconfigured' && row.available === false));
    assert.equal(real.lmsRuns, 0, 'listing never runs lms');
    currentModels = [models[0], ...real.rows];
    const expectedGroups = [
      '本機 · 8GB 顯卡＋RAM 量化',
      'Colab 雲端 · Gemma · 高精度',
      'Colab 雲端 · Qwen · 高精度',
      'Colab 雲端 · Qwen · 量化',
      'Colab 雲端 · 其他 · 高精度',
      'Colab 雲端 · 其他 · 量化'
    ];
    const groupsOf = menu => menu.getByRole('group').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label')));
    const checkMenu = async (page, menu) => {
      assert.deepEqual(await groupsOf(menu), expectedGroups);
      const colabGroup = menu.getByRole('group', {name: /^Colab 雲端/});
      assert.equal(await colabGroup.getByRole('menuitemradio').count(), colabRows.length);
      for (const row of colabRows) {
        const item = colabGroup.getByRole('menuitemradio', {name: row.displayName, exact: true});
        assert.equal(await item.isDisabled(), true);
        assert.match(await item.textContent(), /未設定（待本人建立授權用戶端）/);
      }
      if (darkQuant) {
        assert.equal(darkQuant.quantization, 'i1-Q4_K_M');
        assert.equal(await menu
          .getByRole('group', {name: 'Colab 雲端 · 其他 · 量化'})
          .getByRole('menuitemradio', {name: darkQuant.displayName, exact: true}).count(), 1);
      }
      assert.equal(
        await menu.getByRole('group', {name: '本機 · 8GB 顯卡＋RAM 量化'}).getByRole('menuitemradio').count(),
        local.length
      );
      assert.equal(await page.getByText(/自管 SSH|SSH 轉送|租用機器/).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    };
    const shoot = async (page, menu, name) => {
      await page.screenshot({path: path.join(out, `${name}.png`)});
      await menu.evaluate(node => (node.scrollTop = node.scrollHeight));
      await page.screenshot({path: path.join(out, `${name}-bottom.png`)});
    };
    const idle = {
      threadId: null,
      workspace: root,
      status: 'idle',
      busy: false,
      messages: [],
      tools: [],
      questions: [],
      artifacts: [],
      accessMode: 'workspace-write',
      provider: 'codex',
      capabilities: {},
      conversationActivity: []
    };
    const room = {
      ...idle,
      threadId: 'fake-real-room',
      provider: 'gemma',
      model: local[0].model,
      status: 'completed',
      messages: [
        {id: 'u', role: 'user', groupId: 'g', text: '假請求'},
        {id: 'a', role: 'assistant', groupId: 'g', text: '假結論', completedAt: '2026-11-13T00:00:00Z'}
      ]
    };
    for (const width of [1440, 360]) {
      // The phone width is checked in K's phone (remote) layout.
      const view = {width, height: width === 1440 ? 900 : 800, remote: width < 600};
      const collapseSidebar = async page => {
        const collapse = page.getByRole('button', {name: '收合側欄', exact: true});
        if (width < 600 && (await collapse.isVisible())) await collapse.click();
      };
      // New conversation.
      let page = await openPage(browser, idle, view);
      const create = page.getByRole('button', {name: '新對話', exact: true});
      if (!(await create.isVisible()))
        await page
          .getByRole('button', {name: /開啟側欄|側欄/})
          .first()
          .click();
      await create.click();
      await page
        .getByRole('group', {name: '選擇主代理提供者', exact: true})
        .getByRole('button', {name: '自架', exact: true})
        .click();
      await page.getByRole('button', {name: '主代理模型', exact: true}).click();
      let menu = page.getByRole('menu', {name: '主代理模型選單', exact: true});
      await menu.waitFor({state: 'visible'});
      await checkMenu(page, menu);
      await shoot(page, menu, `real-new-${width}`);
      await page.close();
      // Switch model inside an existing self-hosted room.
      page = await openPage(browser, room, view);
      await collapseSidebar(page);
      if (view.remote) {
        await page.getByRole('button', {name: '對話設定', exact: true}).click();
        await page
          .locator('.mobile-conversation-settings .setting-row', {hasText: '主代理模型'})
          .getByRole('button')
          .click();
      } else await page.getByRole('button', {name: '選擇主代理模型', exact: true}).click();
      await page.getByRole('button', {name: '主代理模型', exact: true}).click();
      menu = page.getByRole('menu', {name: '主代理模型選單', exact: true});
      await menu.waitFor({state: 'visible'});
      await checkMenu(page, menu);
      await shoot(page, menu, `real-switch-${width}`);
      await page.keyboard.press('Escape');
      await menu.waitFor({state: 'hidden'});
      await page.keyboard.press('Escape');
      await page.close();
      // Fork to a new conversation.
      page = await openPage(browser, room, view);
      await collapseSidebar(page);
      await page.getByRole('button', {name: '分支', exact: true}).click();
      const dialog = page.getByRole('dialog', {name: '分支到新對話'});
      await dialog.getByLabel('目標供應商').selectOption('gemma');
      const select = dialog.getByRole('combobox').nth(1);
      await select.locator('optgroup').first().waitFor({state: 'attached'});
      assert.deepEqual(
        await select.locator('optgroup').evaluateAll(nodes => nodes.map(node => node.label)),
        expectedGroups
      );
      const colabOptions = await select
        .locator('optgroup[label^="Colab 雲端"] option')
        .evaluateAll(nodes => nodes.map(node => [node.textContent, node.disabled]));
      assert.equal(colabOptions.length, colabRows.length);
      assert(colabOptions.every(([text, disabled]) => disabled && /未設定（待本人建立授權用戶端）$/.test(text)));
      assert.equal(await select.locator('optgroup[label="本機 · 8GB 顯卡＋RAM 量化"] option').count(), local.length);
      assert.equal(await page.getByText(/自管 SSH|SSH 轉送|租用機器/).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const layout = await select.evaluate(node => {
        const select = node.getBoundingClientRect(),
          row = node.closest('.setting-row').getBoundingClientRect();
        const body = node.closest('.modal-body');
        return {
          left: select.left,
          right: select.right,
          rowLeft: row.left,
          rowRight: row.right,
          bodyWidth: body.clientWidth,
          bodyScrollWidth: body.scrollWidth
        };
      });
      await writeFile(path.join(out, `real-fork-layout-${width}.json`), JSON.stringify(layout, null, 2));
      assert(
        layout.left >= layout.rowLeft - 1 && layout.right <= layout.rowRight + 1,
        `fork model selector is clipped inside the dialog: ${JSON.stringify(layout)}`
      );
      assert(layout.bodyScrollWidth <= layout.bodyWidth + 1, 'fork dialog has no internal horizontal overflow');
      await page.screenshot({path: path.join(out, `real-fork-${width}.png`)});
      await page.close();
    }
    assert.equal(posts.length, 0, 'listing and looking at real rows start nothing');
    results.push({
      part: 'real-config-rows',
      passed: true,
      local: local.map(row => row.displayName),
      colab: colabRows.map(row => row.displayName),
      fetches: real.fetches,
      lmsRuns: real.lmsRuns
    });
  } else results.push({part: 'real-config-rows', skipped: 'K_SELFHOST_CONFIG not set'});
  // A refresh whose numeric balance did not change still has a visible result inside K.
  for (const width of [1440, 360, 412]) {
    const previous = {state: 'fresh', accounts: [{account: 'first@example.test', units: '195.37'}, {account: 'second@example.test', units: '200'}], checkedAt: '2026-11-19T22:56:03Z'};
    const latest = {...previous, checkedAt: '2026-11-20T00:24:23Z'};
    const state = {
      threadId: 'balance-room', workspace: root, status: 'idle', busy: false, provider: 'codex',
      messages: [], tools: [], questions: [], artifacts: [], capabilities: {}, conversationActivity: [],
      colabBalance: previous
    };
    const page = await openPage(browser, state, {width, remote: width < 700});
    const control = page.locator('.colab-balance');
    const popover = page.getByRole('dialog', {name: 'Colab 剩餘額度'});
    await page.getByRole('button', {name: 'Colab 195.37·200', exact: true}).waitFor();
    let calls = 0;
    const response = Promise.withResolvers();
    await page.route('**/api/colab/balance', async route => {
      assert.equal(route.request().method(), 'POST');
      assert.deepEqual(route.request().postDataJSON(), {});
      if (++calls === 1) await route.fulfill({json: await response.promise});
      else await route.fulfill({status: 503, json: {error: 'fixture'}});
    });
    // Measured before any click: Playwright scrolls a clicked control into view.
    const layout = await control.evaluate(node => {
      const bounds = node.getBoundingClientRect(), previous = node.parentElement.previousElementSibling;
      return {left: bounds.left, right: bounds.right, previousRight: previous.getBoundingClientRect().right,
        previousIsWorker: previous.classList.contains('worker-activity-popover-anchor'), viewport: innerWidth,
        visibleRight: node.closest('.header-status')?.getBoundingClientRect().right || innerWidth};
    });
    assert(layout.previousIsWorker && layout.left >= layout.previousRight - 1 &&
      layout.right <= Math.min(layout.viewport, layout.visibleRight) + 0.5, JSON.stringify(layout));
    await control.click();
    await popover.getByText('正在讀取 Colab 餘額…', {exact: true}).waitFor();
    assert(await popover.getByRole('button', {name: '重新查詢'}).isDisabled());
    response.resolve(latest);
    await page.evaluate(({s, balance}) => window.testState({...s, colabBalance: balance}), {s: state, balance: latest});
    await popover.getByText('195.37 個運算單元', {exact: true}).waitFor();
    await popover.getByText('200 個運算單元', {exact: true}).waitFor();
    await popover.getByText('second@example.test', {exact: true}).waitFor();
    assert.equal(await popover.locator('time').getAttribute('datetime'), latest.checkedAt);
    const dialogBox = await popover.boundingBox();
    assert.equal(calls, 1);
    assert(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= layout.viewport);
    await page.screenshot({path: path.join(out, `colab-balance-${width}.png`)});
    await popover.getByRole('button', {name: '重新查詢'}).click();
    await popover.getByText('目前查不到 Colab 餘額。', {exact: true}).waitFor();
    assert.equal(calls, 2);
    assert.equal(await popover.locator('time').count(), 0);
    await page.keyboard.press('Escape');
    await popover.waitFor({state: 'hidden'});
    results.push({part: `colab-balance-${width}`, passed: true});
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({results, errors, posts}, null, 2));
  console.log(JSON.stringify({results, errors}));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
