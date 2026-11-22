import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {execFileSync, spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {pathToFileURL} from 'node:url';
import {scratchBase} from './scratch.mjs';
import {readSelfUpdate} from '../src/self-update.mjs';
import {startDesktop} from '../src/desktop-server.mjs';
import {remoteRouteAllowed} from '../src/remote-access.mjs';
import {startElectronIsolatedLauncher} from '../src/electron-isolated-launcher.mjs';
import {isolatedLauncherPaths} from '../src/isolated-launcher.mjs';

const RUNNING = '0123456789abcdef0123456789abcdef01234567';
const READY = 'abcdef0123456789abcdef0123456789abcdef01';

async function repo({version = RUNNING, ready, result} = {}) {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'self-update-'));
  await mkdir(path.join(root, '.local'));
  if (version !== undefined) await writeFile(path.join(root, '.local', 'runtime.json'), JSON.stringify({version}));
  if (ready !== undefined)
    await writeFile(
      path.join(root, '.local', 'update-ready.json'),
      typeof ready === 'string' ? JSON.stringify({ref: ready}) : String(ready)
    );
  if (result !== undefined)
    await writeFile(path.join(root, '.local', 'self-update-result.json'), JSON.stringify(result));
  return root;
}

test('an update is available only for a valid accepted mark that differs from the running version', async () => {
  assert.deepEqual(readSelfUpdate(await repo()), {available: null, failed: null});
  assert.deepEqual(readSelfUpdate(await repo({ready: RUNNING})), {available: null, failed: null});
  assert.deepEqual(readSelfUpdate(await repo({ready: READY})), {available: READY, failed: null});
  for (const ready of [READY.toUpperCase(), 'abc123', '{not json'])
    assert.deepEqual(readSelfUpdate(await repo({ready})), {available: null, failed: null});
  assert.deepEqual(readSelfUpdate(undefined), {available: null, failed: null});
});

test('a failed update is reported only for the version that is still offered', async () => {
  const failure = {ok: false, from: RUNNING, to: READY, finishedAt: '2026-10-24T00:00:00.000Z', reason: '測試未通過'};
  assert.deepEqual(readSelfUpdate(await repo({ready: READY, result: failure})).failed, {
    reason: '測試未通過',
    finishedAt: '2026-10-24T00:00:00.000Z'
  });
  assert.equal(readSelfUpdate(await repo({ready: READY, result: {...failure, to: RUNNING}})).failed, null);
  assert.equal(readSelfUpdate(await repo({ready: READY, result: {...failure, ok: true}})).failed, null);
});

test('the phone may read and press the update button', () => {
  assert.equal(remoteRouteAllowed('GET', '/api/self-update'), true);
  assert.equal(remoteRouteAllowed('POST', '/api/self-update'), true);
});

async function desktop({
  root,
  activity = [],
  gemini = {},
  corePending = false,
  controller = {},
  uiRoot,
  request = async () => {}
} = {}) {
  const app = await startDesktop({
    root: root ?? (await repo()),
    port: 0,
    requireLaunchToken: true,
    controllerFactory: () => ({state: {conversationActivity: activity}, async close() {}, ...controller}),
    geminiAccounts: {list: async () => ({accounts: [], ...gemini})},
    coreUpdates: {pending: corePending, async close() {}},
    ...(uiRoot ? {uiRoot} : {}),
    ...(root ? {selfUpdate: {repoRoot: root, request}} : {})
  });
  const boot = await fetch(app.createLaunchUrl(), {redirect: 'manual'}),
    cookie = boot.headers.get('set-cookie').split(';')[0];
  app.cookie = cookie;
  const call = async (method, route = '/api/self-update', body = '{}') => {
    const response = await fetch(app.origin + route, {
      method,
      headers: {Cookie: cookie, 'Content-Type': 'application/json', 'X-K-Request': '1', Origin: app.origin},
      ...(method === 'POST' ? {body} : {})
    });
    return {status: response.status, body: await response.json()};
  };
  return {app, call};
}

test('without a tray launcher there is nothing to update and pressing is refused', async () => {
  const {app, call} = await desktop();
  try {
    assert.deepEqual(await call('GET'), {status: 200, body: {available: false, updating: false, failed: null}});
    assert.equal((await call('POST')).status, 404);
  } finally {
    await app.close();
  }
});

test('failed update close exposes a safe recovery shell and permits only an explicit retry', async () => {
  const root = await repo({ready: READY});
  const ui = path.join(root, 'ui');
  await mkdir(path.join(ui, 'assets'), {recursive: true});
  await writeFile(path.join(ui, 'index.html'), '<html>recovery shell</html>');
  await writeFile(path.join(ui, 'assets', 'app.js'), '// synthetic asset');
  const activity = [],
    requests = [];
  let closes = 0,
    sends = 0;
  const retryEntered = Promise.withResolvers(),
    retryRelease = Promise.withResolvers();
  const {app, call} = await desktop({
    root,
    activity,
    uiRoot: pathToFileURL(ui + path.sep),
    request: async ref => requests.push(ref),
    controller: {
      send: async () => {
        sends++;
      },
      close: async () => {
        if (++closes === 1) throw Object.assign(Error('DO_NOT_LOG_NATIVE_TEXT'), {code: 'STOP_UNCONFIRMED'});
        retryEntered.resolve();
        await retryRelease.promise;
      }
    }
  });
  try {
    assert.equal((await call('POST')).status, 200);
    await assert.rejects(app.close(), {code: 'K_SHUTDOWN_PARTIAL'});
    const status = await call('GET');
    assert.equal(status.status, 200);
    assert.equal(status.body.updating, false, 'failed close releases the three-minute reservation immediately');
    assert.match(status.body.failed.reason, /對話控制器.*更新尚未開始.*再按「更新」/);
    assert.equal((await call('POST', '/api/send')).status, 503);
    assert.equal(sends, 0, 'partially closed resources are never reused for work');
    assert.equal((await fetch(app.origin + '/', {headers: {cookie: app.cookie}})).status, 200);
    assert.equal((await fetch(app.origin + '/assets/app.js')).status, 200);
    assert.equal((await fetch(app.origin + '/')).status, 403, 'recovery shell still requires a session');
    assert.equal((await fetch(app.origin + '/api/self-update')).status, 403);
    const abort = new AbortController();
    const events = await fetch(app.origin + '/api/events', {headers: {cookie: app.cookie}, signal: abort.signal});
    assert.equal(events.status, 200, 'a reloaded phone can reconnect to state without opening native rooms');
    abort.abort();
    activity.push({busy: true, title: 'still owned'});
    assert.equal((await call('POST')).status, 409, 'retry still checks all live work');
    assert.deepEqual(requests, [READY], 'failure never automatically replays update');
    activity.length = 0;
    assert.equal((await call('POST')).status, 200);
    assert.deepEqual(requests, [READY, READY]);
    const shuttingDown = call('POST', '/api/shutdown');
    await retryEntered.promise;
    const during = await call('GET');
    assert.equal(during.body.updating, true);
    assert.equal(during.body.failed, null, 'retry in progress does not show the old failure');
    const blockedRetry = await call('POST');
    assert.equal(blockedRetry.status, 503);
    assert.doesNotMatch(blockedRetry.body.error, /再按「更新」/);
    retryRelease.resolve();
    const shutdown = await shuttingDown;
    assert.equal(shutdown.status, 200);
    assert.equal((await call('GET')).body.failed, null, 'successful shutdown clears the old recovery state');
    assert.equal((await call('POST')).status, 503, 'the successful-close window cannot accept another update');
    assert.equal(closes, 2);
    const log = await readFile(path.join(root, '.runtime/diagnostics/shutdown.jsonl'), 'utf8');
    assert.doesNotMatch(log, /DO_NOT_LOG_NATIVE_TEXT/);
    assert.deepEqual(JSON.parse(log).resources, ['對話控制器']);
    assert.deepEqual(JSON.parse(log).codes, ['STOP_UNCONFIRMED']);
    assert.equal(JSON.parse(await readFile(path.join(root, '.local/runtime.json'), 'utf8')).version, RUNNING);
  } finally {
    retryRelease.resolve();
    await app.close();
  }
});

test('a write body that arrives after partial shutdown cannot enter the closed controller', async () => {
  let sends = 0,
    closes = 0;
  const {app, call} = await desktop({
    root: await repo({ready: READY}),
    controller: {
      send: async () => {
        sends++;
        return {};
      },
      close: async () => {
        if (++closes === 1) throw Error('unconfirmed');
      }
    }
  });
  let request;
  const bodyWritten = Promise.withResolvers();
  try {
    const response = new Promise((resolve, reject) => {
      request = httpRequest(
        app.origin + '/api/send',
        {
          method: 'POST',
          headers: {
            cookie: app.cookie,
            origin: app.origin,
            'Content-Type': 'application/json',
            'X-K-Request': '1'
          }
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      request.on('error', reject);
      request.write('{"text":', bodyWritten.resolve);
    });
    // Hold the request body open while the server begins (and fails) resource shutdown.
    await bodyWritten.promise;
    const busy = await call('POST');
    assert.equal(busy.status, 409);
    assert.deepEqual(busy.body.busy, ['有操作正在處理'], 'the server has accepted the unfinished request body');
    await assert.rejects(app.close(), {code: 'K_SHUTDOWN_PARTIAL'});
    assert.doesNotMatch((await call('GET')).body.failed.reason, /更新尚未開始|再按「更新」/);
    request.end('"late"}');
    assert.equal(await response, 503);
    assert.equal(sends, 0);
  } finally {
    request?.destroy();
    await app.close();
  }
});

test('pressing update hands the accepted version to the tray launcher once, only when everything is idle', async () => {
  const requested = [];
  const {app, call} = await desktop({root: await repo({ready: READY}), request: async ref => requested.push(ref)});
  try {
    assert.deepEqual((await call('GET')).body, {available: true, updating: false, failed: null});
    assert.deepEqual(await call('POST'), {status: 200, body: {started: true}});
    assert.deepEqual(requested, [READY]);
    assert.equal((await call('GET')).body.updating, true);
    assert.deepEqual(await call('POST'), {status: 409, body: {error: '已經在更新了。'}});
    assert.deepEqual(requested, [READY]);
  } finally {
    await app.close();
  }
});

test('running work refuses the update with one short line and never asks the launcher', async () => {
  const requested = [];
  const {app, call} = await desktop({
    root: await repo({ready: READY}),
    activity: [
      {title: '範例社群文', busy: true, pendingQuestions: 0, pendingWorkers: 0},
      {title: '小說', busy: false, pendingQuestions: 0, pendingWorkers: 2},
      {title: '閒置', busy: false, pendingQuestions: 0, pendingWorkers: 0}
    ],
    gemini: {busy: true},
    corePending: true,
    request: async ref => requested.push(ref)
  });
  try {
    const {status, body} = await call('POST');
    assert.equal(status, 409);
    assert.equal(body.error, '還有工作在跑，等結束再按。');
    // Obvious work is refused from the live snapshot at once, before the slower checks.
    assert.deepEqual(body.busy, ['聊天室：範例社群文 工作中', '聊天室：小說 子代理執行中', '核心更新進行中']);
    assert.deepEqual(requested, []);
    assert.equal((await call('GET')).body.updating, false);
  } finally {
    await app.close();
  }
});

test('no offered version, or a launcher that cannot be asked, leaves K running and the button usable', async () => {
  const none = await desktop({root: await repo({ready: RUNNING})});
  try {
    assert.deepEqual(await none.call('POST'), {status: 409, body: {error: '目前沒有可更新的版本。'}});
  } finally {
    await none.app.close();
  }
  const broken = await desktop({
    root: await repo({ready: READY}),
    request: async () => {
      throw Error('supervisor disconnected');
    }
  });
  try {
    assert.deepEqual(await broken.call('POST'), {status: 503, body: {error: 'K 無法開始更新，沒有關閉。'}});
    assert.equal((await broken.call('GET')).body.updating, false);
  } finally {
    await broken.app.close();
  }
});

test('the supervisor passes only a valid update request to the tray launcher', async () => {
  await mkdir(scratchBase, {recursive: true});
  const p = isolatedLauncherPaths(
    path.join(await mkdtemp(path.join(scratchBase, 'self-update-launcher-')), 'candidate')
  );
  await mkdir(path.dirname(p.electronExecutable), {recursive: true});
  await writeFile(p.electronExecutable, 'fixture');
  const mainPath = path.join(p.trustedRuntime, 'src', 'electron-isolated-main.cjs');
  await mkdir(path.dirname(mainPath), {recursive: true});
  await writeFile(mainPath, 'fixture');
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send(message, callback) {
      callback?.();
      if (message.type === 'owner-request')
        queueMicrotask(() =>
          child.emit('message', {type: 'owner-response', id: message.id, ok: true, value: {closed: true}})
        );
    }
  });
  const input = new PassThrough(),
    output = new PassThrough();
  let written = '';
  output.on('data', chunk => (written += chunk));
  const owner = await startElectronIsolatedLauncher({
    paths: p,
    mainPath,
    input,
    output,
    processObject: {env: {}, execPath: process.execPath, pid: 98765},
    spawnImpl: () => {
      queueMicrotask(() => child.emit('message', {type: 'owner-ready', origin: 'http://127.0.0.1:47831'}));
      return child;
    }
  });
  try {
    for (const ref of [READY.toUpperCase(), 'short', null, undefined])
      child.emit('message', {type: 'owner-self-update', ref});
    child.emit('message', {type: 'owner-self-update', ref: READY});
    const requests = written
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(event => event.type === 'self-update');
    assert.deepEqual(requests, [{type: 'self-update', ref: READY, pid: 98765}]);
  } finally {
    await owner.protocol.close();
    input.destroy();
    output.destroy();
  }
});

test(
  'the update script parses on PowerShell 5.1 and never touches phone sign-in or kills processes',
  {skip: process.platform !== 'win32'},
  async () => {
    const script = path.resolve('scripts/Self-Update-K.ps1');
    const parsed = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$t,[ref]$e);$e.Count`
      ],
      {encoding: 'utf8'}
    );
    assert.equal(parsed.trim(), '0');
    const text = await readFile(script, 'utf8');
    assert.equal(text.charCodeAt(0), 0xfeff, 'Windows PowerShell 5.1 needs the UTF-8 BOM for Chinese text');
    for (const forbidden of ['remote-access', 'remote-sessions', 'Stop-Process', 'taskkill'])
      assert.equal(text.includes(forbidden), false, forbidden);
  }
);

// Runs the real script under Windows PowerShell 5.1 against a fake repository and a fake Update-K.ps1.
async function runScript(updateLines, launcherPid, files = {}) {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'self-update-script-'));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, '.local'));
  await writeFile(path.join(root, 'scripts', 'Self-Update-K.ps1'), await readFile('scripts/Self-Update-K.ps1'));
  await writeFile(path.join(root, '.local', 'runtime.json'), JSON.stringify({version: RUNNING}));
  await writeFile(path.join(root, 'Update-K.ps1'), '\ufeff' + updateLines.join('\r\n'));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(root, 'scripts', 'Self-Update-K.ps1'),
        '-Ref',
        READY,
        '-LauncherPid',
        String(launcherPid),
        '-NoWindow'
      ],
      {stdio: 'ignore', timeout: 120000}
    );
  } catch {}
  return JSON.parse(await readFile(path.join(root, '.local', 'self-update-result.json'), 'utf8'));
}
const ended = () => {
  const {pid} = spawn(process.execPath, ['-e', ''], {stdio: 'ignore'});
  return new Promise(resolve => setTimeout(() => resolve(pid), 500));
};

test(
  'the update script judges only the exit code and reports the installer cause, not PowerShell noise',
  {skip: process.platform !== 'win32'},
  async () => {
    const pid = await ended();
    const success = await runScript(
      [
        'param([string]$Ref)',
        "$ErrorActionPreference='Stop'",
        "[Console]::Error.WriteLine('npm warn deprecated')",
        "Write-Output 'ok'",
        'exit 0'
      ],
      pid
    );
    assert.equal(success.ok, true);
    assert.equal(success.to, READY);
    const failure = await runScript(
      [
        'param([string]$Ref)',
        "$ErrorActionPreference='Stop'",
        "Write-Output 'building'",
        "& node (Join-Path $PSScriptRoot 'fail.js')",
        "if($LASTEXITCODE -ne 0){throw 'K 更新未完成；沒有強制結束工作，請保留錯誤交給 AI 檢查。'}"
      ],
      pid,
      {
        // The installer's cause, its "build left at" notice, and the CLIXML progress records Windows
        // PowerShell writes to stderr when it has no console (seen in a real deployment run).
        'fail.js': [
          "console.error('npm warn old');",
          "console.error('候選缺少 dist-ui/index.html');",
          "console.error('未套用的建置暫存留在 C:/x（可從 Git 版本重建）');",
          "console.error('#< CLIXML');",
          `console.error('<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"></Obj></Objs>');`,
          'process.exit(1);'
        ].join('\n')
      }
    );
    assert.deepEqual([failure.ok, failure.from, failure.reason], [false, RUNNING, '候選缺少 dist-ui/index.html']);
  }
);

test(
  'the update script applies nothing while the old launcher is still running',
  {skip: process.platform !== 'win32', timeout: 120000},
  async () => {
    const launcher = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], {stdio: 'ignore'});
    try {
      const result = await runScript(
        ['param([string]$Ref)', "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'applied.txt') -Value x", 'exit 0'],
        launcher.pid
      );
      assert.deepEqual([result.ok, result.reason], [false, '啟動器沒有結束，這次沒有更新。']);
    } finally {
      launcher.kill();
    }
  }
);

test(
  'the update script keeps the launcher lock alive while the installer runs',
  {skip: process.platform !== 'win32', timeout: 120000},
  async () => {
    // Observed from inside the fake Update-K.ps1 and reported through the failure line. A real update
    // runs this very test under its own lock, so the lock's absence is never asserted.
    const result = await runScript(
      [
        'param([string]$Ref)',
        '$lock = $null',
        "$held = [System.Threading.Mutex]::TryOpenExisting('Local\\KHarnessSelfUpdate', [ref]$lock)",
        'if ($lock) { $lock.Dispose() }',
        'throw "lock while updating: $held"'
      ],
      await ended()
    );
    assert.deepEqual([result.ok, result.reason], [false, 'lock while updating: True']);
  }
);

test(
  "a K opened again during the update is explained in the button's own words",
  {skip: process.platform !== 'win32', timeout: 120000},
  async () => {
    const result = await runScript(
      [
        'param([string]$Ref)',
        "& node (Join-Path $PSScriptRoot 'reopened.js')",
        "if($LASTEXITCODE -ne 0){throw 'K 更新未完成；沒有強制結束工作，請保留錯誤交給 AI 檢查。'}"
      ],
      await ended(),
      {'reopened.js': "console.error('請先「離開並停止 K」，更新不會強制結束工作。');\nprocess.exit(1);"}
    );
    assert.deepEqual([result.ok, result.reason], [false, '更新進行中 K 又被開啟了，這次沒有套用；再按一次更新即可。']);
  }
);

test('the request carries nothing: any body content is refused and K chooses the version', async () => {
  const requested = [];
  const {app, call} = await desktop({root: await repo({ready: READY}), request: async ref => requested.push(ref)});
  try {
    assert.equal((await call('POST', '/api/self-update', JSON.stringify({ref: RUNNING}))).status, 400);
    assert.deepEqual(requested, []);
  } finally {
    await app.close();
  }
});

test('two presses at once hand off once, and no new work starts while the update is reserved', async () => {
  const requested = [];
  let release;
  const {app, call} = await desktop({
    root: await repo({ready: READY}),
    // The asynchronous checks are slow, so both presses overlap them.
    gemini: {},
    controller: {backgroundCommands: () => new Promise(resolve => (release = () => resolve(0)))},
    request: async ref => requested.push(ref)
  });
  try {
    const first = call('POST');
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(await call('POST'), {status: 409, body: {error: '已經在更新了。'}});
    assert.equal((await call('POST', '/api/send', JSON.stringify({text: 'x'}))).status, 503);
    // Stopping work and answering a question are never blocked by a pending update.
    for (const route of ['/api/stop', '/api/answer']) assert.notEqual((await call('POST', route)).status, 503, route);
    release();
    assert.deepEqual(await first, {status: 200, body: {started: true}});
    assert.deepEqual(requested, [READY]);
  } finally {
    await app.close();
  }
});

test('background commands, a discussion or an unconfirmable state count as busy', async () => {
  for (const [controller, expected, gemini] of [
    [{backgroundCommands: async () => 1}, '背景命令執行中'],
    [{discussionBusy: true}, '討論進行中'],
    [{}, 'Gemini 程序執行中', {busy: true}],
    [
      {
        backgroundCommands: async () => {
          throw Error('terminal list unavailable');
        }
      },
      '部分工作狀態無法確認'
    ]
  ]) {
    const requested = [];
    const {app, call} = await desktop({
      root: await repo({ready: READY}),
      controller,
      gemini,
      request: async ref => requested.push(ref)
    });
    try {
      const {status, body} = await call('POST');
      assert.equal(status, 409);
      assert.deepEqual(body.busy, [expected]);
      assert.deepEqual(requested, []);
      assert.equal((await call('GET')).body.updating, false);
    } finally {
      await app.close();
    }
  }
});

test('an attachment upload neither starts during a pending update nor lets one begin while it runs', async () => {
  let finishUpload;
  const requested = [];
  const {app, call} = await desktop({
    root: await repo({ready: READY}),
    controller: {
      uploadStream: (meta, req) =>
        new Promise(resolve => {
          req.resume();
          finishUpload = () => resolve({id: 'a1'});
        })
    },
    request: async ref => requested.push(ref)
  });
  const upload = () =>
    fetch(app.origin + '/api/upload', {
      method: 'POST',
      headers: {
        Cookie: app.cookie,
        'X-K-Request': '1',
        'Content-Type': 'application/octet-stream',
        Origin: app.origin,
        'X-K-Thread-Id': 't1',
        'X-K-File-Name': 'a.txt',
        'X-K-Command': 'c1'
      },
      body: 'data'
    });
  try {
    const running = upload();
    while (!finishUpload) await new Promise(resolve => setTimeout(resolve, 5));
    const refused = await call('POST');
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body.busy, ['有操作正在處理']);
    finishUpload();
    assert.equal((await running).status, 200);
    assert.deepEqual(await call('POST'), {status: 200, body: {started: true}});
    assert.equal((await upload()).status, 503, 'no upload starts once the update is handed off');
    assert.deepEqual(requested, [READY]);
  } finally {
    await app.close();
  }
});

test('the older JSON attachment upload also holds back an update while it is written', async () => {
  let finishUpload;
  const requested = [];
  const {app, call} = await desktop({
    root: await repo({ready: READY}),
    controller: {upload: () => new Promise(resolve => (finishUpload = () => resolve({id: 'a2'})))},
    request: async ref => requested.push(ref)
  });
  try {
    const running = call('POST', '/api/upload', JSON.stringify({threadId: 't1', name: 'a.txt', base64: 'ZGF0YQ=='}));
    while (!finishUpload) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual((await call('POST')).body.busy, ['有操作正在處理']);
    finishUpload();
    assert.equal((await running).status, 200);
    assert.deepEqual(await call('POST'), {status: 200, body: {started: true}});
    assert.equal((await call('POST', '/api/upload', JSON.stringify({threadId: 't1', name: 'b.txt'}))).status, 503);
    assert.deepEqual(requested, [READY]);
  } finally {
    await app.close();
  }
});

test('any write still being handled, such as a send that is preparing, holds back an update', async () => {
  let finishSend;
  const requested = [];
  const {app, call} = await desktop({
    root: await repo({ready: READY}),
    controller: {send: () => new Promise(resolve => (finishSend = () => resolve({sent: true})))},
    request: async ref => requested.push(ref)
  });
  try {
    const sending = call('POST', '/api/send', JSON.stringify({text: 'x'}));
    while (!finishSend) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual((await call('POST')).body.busy, ['有操作正在處理']);
    finishSend();
    assert.equal((await sending).status, 200);
    assert.deepEqual(await call('POST'), {status: 200, body: {started: true}});
    assert.deepEqual(requested, [READY]);
  } finally {
    await app.close();
  }
});
