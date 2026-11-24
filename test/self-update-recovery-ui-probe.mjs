// Real desktop server + phone HTTPS route + built UI; synthetic close failures, no live K or updater.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {mkdir, mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {launchProbeBrowser, probeEvidenceDir, probeTlsCertificate} from './ui-probe.mjs';
import {scratchBase} from './scratch.mjs';
import {startConfiguredDesktop} from './configured-desktop.mjs';
import {remoteKeyHash} from '../src/remote-access.mjs';

const root = await mkdtemp(path.join(scratchBase, 'update-recovery-'));
const output = probeEvidenceDir('self-update-recovery-20261112');
await mkdir(output, {recursive: true});
await mkdir(path.join(root, '.local'));
const remotePort = 54868,
  httpsPort = 54869;
const origin = `https://update.test.ts.net:${httpsPort}`;
const key = 'synthetic-update-key';
const ready = 'abcdef0123456789abcdef0123456789abcdef01';
await writeFile(
  path.join(root, '.local/remote-access.json'),
  JSON.stringify({
    origin,
    login: 'update@example.invalid',
    keyHash: remoteKeyHash(key),
    port: remotePort
  })
);
await writeFile(
  path.join(root, '.local/runtime.json'),
  JSON.stringify({version: '0123456789abcdef0123456789abcdef01234567'})
);
await writeFile(path.join(root, '.local/update-ready.json'), JSON.stringify({ref: ready}));
const state = {
  threadId: null,
  workspace: root,
  status: 'idle',
  busy: false,
  model: 'gpt-6.1-sol',
  provider: 'codex',
  messages: [],
  tools: [],
  questions: [],
  artifacts: [],
  workers: [],
  queuedMessages: [],
  conversationActivity: [],
  capabilities: {},
  usage: {}
};
const serviceCloses = [];
const service = name => () => ({
  status: async () => ({available: false}),
  progress: () => ({}),
  close: async () => {
    serviceCloses.push(name);
  }
});
const requests = [],
  closeResults = [];
let closes = 0,
  closeTask,
  app,
  browser;
app = await startConfiguredDesktop({
  root,
  port: 0,
  controllerFactory: () => ({
    state,
    sessions: async () => ({sessions: []}),
    models: async () => ({models: []}),
    usage: async () => ({}),
    close: async () => {
      if (++closes === 1) throw Object.assign(Error('DO_NOT_EXPOSE_NATIVE_CONTENT'), {code: 'STOP_UNCONFIRMED'});
    }
  }),
  claudeLoginFactory: service('claude'),
  codexLoginFactory: service('codex'),
  geminiLoginFactory: service('gemini'),
  grokLoginFactory: service('grok'),
  localDictationFactory: service('dictation'),
  selfUpdate: {
    repoRoot: root,
    request: async ref => {
      requests.push(ref);
      // Like the tray, close only after the original HTTP request has returned.
      closeTask = new Promise(resolve => setTimeout(resolve, 50))
        .then(() => app.close())
        .then(
          () => {
            closeResults.push('confirmed');
          },
          e => {
            closeResults.push(e.code);
          }
        );
    }
  }
});
const proxy = https.createServer(await probeTlsCertificate(), (req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: remotePort,
      path: req.url,
      method: req.method,
      headers: {...req.headers, 'tailscale-user-login': 'update@example.invalid'}
    },
    response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
await new Promise(resolve => proxy.listen(httpsPort, '127.0.0.1', resolve));
const errors = [];
try {
  browser = await launchProbeBrowser({
    args: ['--host-resolver-rules=MAP update.test.ts.net 127.0.0.1', '--no-proxy-server']
  });
  const pc = await browser.newPage({viewport: {width: 1440, height: 900}});
  const phone = await browser.newPage({viewport: {width: 390, height: 844}, ignoreHTTPSErrors: true});
  for (const page of [pc, phone]) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
  }
  await pc.goto(app.createLaunchUrl());
  await phone.goto(origin);
  await phone.getByLabel('K 存取金鑰').fill(key);
  await phone.getByRole('button', {name: '連接 K', exact: true}).click();
  await phone.getByRole('button', {name: '展開側欄', exact: true}).click();
  const button = page => page.locator('.self-update-button');
  await button(phone).click();
  await phone.locator('.self-update-failed').filter({hasText: '更新尚未開始'}).waitFor();
  assert.equal(await button(phone).isDisabled(), false);
  assert.deepEqual(requests, [ready]);
  assert.deepEqual(closeResults, ['K_SHUTDOWN_PARTIAL']);
  assert.equal(await phone.locator('.self-update-notice').count(), 0);
  assert.equal(await phone.evaluate(() => sessionStorage.getItem('k-self-update-at')), null);
  await pc.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pc.locator('.self-update-failed').filter({hasText: '更新尚未開始'}).waitFor();
  await pc.screenshot({path: path.join(output, 'desktop-failed.png')});
  // The mobile page can be reopened after a failed close; authenticated static UI + SSE remain usable.
  await phone.reload();
  await phone.getByRole('button', {name: '展開側欄', exact: true}).click();
  await phone.locator('.self-update-failed').filter({hasText: '更新尚未開始'}).waitFor();
  await phone.screenshot({path: path.join(output, 'phone-reopened.png')});
  assert.equal(await button(phone).isDisabled(), false);
  assert.deepEqual(requests, [ready], 'reopening is not an update replay');
  await button(phone).click();
  await phone.getByText('K 更新中…', {exact: true}).waitFor();
  await closeTask;
  assert.deepEqual(requests, [ready, ready]);
  assert.deepEqual(closeResults, ['K_SHUTDOWN_PARTIAL', 'confirmed']);
  assert.equal(closes, 2);
  assert.deepEqual(
    serviceCloses.sort(),
    ['claude', 'codex', 'dictation', 'gemini', 'grok'],
    'closed resources are not restarted or closed twice'
  );
  assert.deepEqual(errors, []);
  const diagnostics = await readFile(path.join(root, '.runtime/diagnostics/shutdown.jsonl'), 'utf8');
  assert.doesNotMatch(diagnostics, /DO_NOT_EXPOSE_NATIVE_CONTENT/);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {requests, closeResults, serviceCloses, errors, actualPhone: false, actualUpdater: false, passed: true},
      null,
      2
    )
  );
  console.log(
    'Real phone update failure, status recovery, desktop visibility, phone reopen and explicit retry passed.'
  );
} finally {
  await closeTask;
  await browser?.close();
  await app.close();
  await new Promise(resolve => proxy.close(resolve));
}
