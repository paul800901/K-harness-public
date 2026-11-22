import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, writeFile, readFile, readdir, realpath, rm, symlink, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {
  createCoreUpdates,
  selectedCoreExecutables,
  officialCoreRelease,
  downloadCoreRelease
} from '../src/core-updates.mjs';
import {startDesktop} from '../src/desktop-server.mjs';
import {geminiExecutable} from '../src/gemini-worker.mjs';
import {scratchBase} from './scratch.mjs';

async function fixture() {
  const base = scratchBase;
  await mkdir(base, {recursive: true});
  const root = await mkdtemp(path.join(base, 'core-update-')),
    active = {};
  for (const key of ['claude', 'codex', 'gemini']) {
    active[key] = path.join(root, `${key}.exe`);
    await writeFile(active[key], '1.0.0');
  }
  const inspect = file => readFile(file, 'utf8');
  const release = async () => ({version: '1.0.1', file: 'core.exe'});
  const download = async (next, dir) => {
    const file = path.join(dir, next.file);
    await writeFile(file, next.version);
    return file;
  };
  // Tests never touch the real recycle bin.
  const recycled = [];
  const recycle = async dir => (recycled.push(path.basename(dir)), rm(dir, {recursive: true}));
  return {root, active, inspect, release, download, recycle, recycled};
}
test('updates are click-only, retain current cores, select new binaries only on next startup', async () => {
  const f = await fixture();
  let queries = 0;
  const updater = createCoreUpdates({
    ...f,
    release: async (...args) => {
      queries++;
      return f.release(...args);
    }
  });
  assert.equal(queries, 0);
  assert.deepEqual(await selectedCoreExecutables(f.root, f.active), f.active);
  for (const provider of ['claude', 'codex', 'gemini']) {
    assert.equal((await updater.update(provider)).restartRequired, true);
    assert.equal(await f.inspect(f.active[provider]), '1.0.0');
  }
  const next = await selectedCoreExecutables(f.root, f.active);
  for (const file of Object.values(next)) assert.equal(await f.inspect(file), '1.0.1');
  const saved = JSON.parse(await readFile(path.join(f.root, 'selected-cores.json')));
  assert.equal(await f.inspect(path.join(f.root, saved.gemini.previous.file)), '1.0.0');
  assert.equal(geminiExecutable({K_GEMINI_EXECUTABLE: next.gemini, LOCALAPPDATA: 'ignored'}), next.gemini);
  assert.equal(queries, 3);
  await updater.close();
});
test('successive prepared releases retain the actually running predecessor until restart', async () => {
  const f = await fixture();
  let version = '1.0.1';
  const updater = createCoreUpdates({...f, release: async () => ({version, file: 'core.exe'})});
  try {
    await updater.update('gemini');
    version = '1.0.2';
    await updater.update('gemini');
    const saved = JSON.parse(await readFile(path.join(f.root, 'selected-cores.json'), 'utf8'));
    assert.equal(saved.gemini.version, '1.0.2');
    assert.equal(saved.gemini.previous.version, '1.0.0');
    assert.equal(await f.inspect(path.join(f.root, saved.gemini.previous.file)), '1.0.0');
  } finally {
    await updater.close();
  }
});

test('same/newer installed version does not download or downgrade; prepared version is not downloaded twice', async () => {
  const f = await fixture();
  let downloads = 0;
  const updater = createCoreUpdates({
    ...f,
    download: async (...args) => {
      downloads++;
      return f.download(...args);
    }
  });
  await updater.update('claude');
  await updater.update('claude');
  assert.equal(downloads, 1);
  for (const version of ['1.0.0', '0.9.9']) {
    const u = createCoreUpdates({
      ...f,
      release: async () => ({version}),
      download: () => {
        throw Error('must not download');
      }
    });
    assert.equal((await u.update('codex')).restartRequired, false);
    await u.close();
  }
  await updater.close();
});
test('failed download or version readback leaves selected cores and unrelated data untouched', async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, 'unrelated.txt'), 'keep');
  for (const download of [
    async () => {
      throw Error('network failed');
    },
    async (next, dir) => f.download({...next, version: '9.9.9'}, dir)
  ]) {
    const updater = createCoreUpdates({...f, download});
    await assert.rejects(updater.update('codex'));
    assert.deepEqual(await selectedCoreExecutables(f.root, f.active), f.active);
    await updater.close();
  }
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'keep');
});
test('simultaneous clicks rejected; shutdown cancels download without selecting it or restarting work', async () => {
  const f = await fixture();
  let ready;
  const entered = new Promise(r => {
    ready = r;
  });
  const updater = createCoreUpdates({
    ...f,
    download: async (_r, _d, {signal}) => {
      ready();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }
  });
  const result = updater.update('claude');
  await entered;
  await assert.rejects(updater.update('gemini'), /正在/);
  await assert.rejects(updater.update('constructor'), /不支援/);
  const failed = assert.rejects(result);
  await updater.close();
  await failed;
  assert.deepEqual(await selectedCoreExecutables(f.root, f.active), f.active);
  await assert.rejects(updater.update('claude'), /關閉/);
});
test('malformed selection and escaped executable fail rather than silently changing to an old core', async () => {
  const f = await fixture();
  const file = path.join(f.root, 'selected-cores.json');
  await writeFile(file, 'bad json');
  await assert.rejects(
    selectedCoreExecutables(f.root, f.active),
    error => error.message.includes(file) && error.message.includes('未自動換版')
  );
  const outside = path.join(f.root, '..', `${path.basename(f.root)}-outside.exe`);
  await writeFile(outside, 'fixture');
  await writeFile(file, JSON.stringify({codex: {file: outside}}));
  await assert.rejects(selectedCoreExecutables(f.root, f.active), /專用目錄/);
});
test('download verifies provider digest before extraction, retains full Codex bundle, never runs installers', async () => {
  const f = await fixture(),
    signal = new AbortController().signal,
    body = Buffer.from('official archive');
  const release = {
    file: 'package/vendor/test/bin/codex.exe',
    archive: true,
    algorithm: 'sha512',
    digest: createHash('sha512').update(body).digest('base64'),
    encoding: 'base64',
    url: 'https://example.test/file'
  };
  const run = async (command, args, options) => {
    assert.match(command, /tar.exe$/);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(args, ['-xf', path.join(f.root, 'core.tgz'), '-C', f.root]);
    await mkdir(path.dirname(path.join(f.root, release.file)), {recursive: true});
    await writeFile(path.join(f.root, release.file), '1.0.1');
  };
  assert.equal(
    await downloadCoreRelease(release, f.root, {signal, request: async () => new Response(body), run}),
    path.join(f.root, release.file)
  );
  const dir = await mkdtemp(path.join(f.root, 'bad-'));
  await assert.rejects(
    downloadCoreRelease({...release, digest: Buffer.alloc(64).toString('base64')}, dir, {
      signal,
      request: async () => new Response(body),
      run: () => {
        throw Error('must not extract');
      }
    }),
    /校驗失敗/
  );
  await assert.rejects(
    downloadCoreRelease({...release, digest: undefined}, dir, {
      signal,
      request: () => {
        throw Error('must not fetch');
      }
    }),
    /有效校驗/
  );
});
test('official release adapters use vendor metadata, correct architecture and complete Codex platform package', async () => {
  const signal = new AbortController().signal,
    calls = [];
  const request = async url => {
    calls.push(url);
    if (url.endsWith('windows_arm64.json'))
      return Response.json({
        version: '1.2.16',
        url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/v/agy.exe',
        sha512: 'a'.repeat(128)
      });
    if (url === 'https://downloads.claude.ai/claude-code-releases/latest') return new Response('2.1.288\n');
    if (url.endsWith('manifest.json')) return Response.json({platforms: {'win32-arm64': {checksum: 'b'.repeat(64)}}});
    if (url.endsWith('/latest'))
      return Response.json({
        version: '0.160.0',
        optionalDependencies: {'@openai/codex-win32-arm64': 'npm:@openai/codex@0.160.0-win32-arm64'}
      });
    return Response.json({
      dist: {
        tarball: 'https://registry.npmjs.org/@openai/codex/-/codex.tgz',
        integrity: 'sha512-' + Buffer.alloc(64).toString('base64')
      }
    });
  };
  assert.match((await officialCoreRelease('claude', {signal, arch: 'arm64', request})).url, /win32-arm64\/claude.exe$/);
  assert.equal((await officialCoreRelease('gemini', {signal, arch: 'arm64', request})).algorithm, 'sha512');
  const codex = await officialCoreRelease('codex', {signal, arch: 'arm64', request});
  assert.equal(codex.archive, true);
  assert.match(codex.file, /aarch64-pc-windows-msvc\/bin\/codex.exe$/);
  assert.equal(calls.length, 5);
});
test('core-update route requires owner cookie, same origin and explicit POST; no startup/background update', async () => {
  const f = await fixture();
  let updates = 0,
    closed = 0;
  const login = () => ({close: async () => {}});
  const app = await startDesktop({
    root: f.root,
    port: 0,
    controllerFactory: () => ({state: {}, close: async () => {}}),
    claudeLoginFactory: login,
    codexLoginFactory: login,
    geminiLoginFactory: login,
    localDictationFactory: () => ({close: async () => {}}),
    coreUpdates: {
      update: async provider => {
        updates++;
        assert.equal(provider, 'gemini');
        return {message: 'prepared'};
      },
      close: async () => {
        closed++;
      }
    }
  });
  try {
    assert.equal(updates, 0);
    const url = app.origin + '/api/core-update';
    const headers = {'Content-Type': 'application/json', 'X-K-Request': '1'},
      body = JSON.stringify({provider: 'gemini'});
    assert.equal((await fetch(url, {method: 'POST', headers, body})).status, 403);
    const bootstrap = await fetch(app.createLaunchUrl(), {redirect: 'manual'}),
      cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    assert.equal(
      (await fetch(url, {method: 'POST', headers: {...headers, Cookie: cookie, Origin: 'https://evil.test'}, body}))
        .status,
      403
    );
    assert.equal((await fetch(url, {headers: {Cookie: cookie}})).status, 403);
    assert.equal(updates, 0);
    const result = await fetch(url, {method: 'POST', headers: {...headers, Cookie: cookie, Origin: app.origin}, body});
    assert.equal(result.status, 200);
    assert.equal((await result.json()).message, 'prepared');
    assert.equal(updates, 1);
  } finally {
    await app.close();
  }
  assert.equal(closed, 1);
});

test('a successful update keeps only the new core, its predecessor and the running one; older downloads are recycled', async () => {
  const f = await fixture();
  let version = '1.0.1';
  const updater = createCoreUpdates({...f, release: async () => ({version, file: 'core.exe'})});
  const updates = path.join(f.root, 'updates');
  // Another provider's download, and a leftover of this provider's failed attempt.
  await mkdir(path.join(updates, 'claude-0.9.0-old'), {recursive: true});
  await mkdir(path.join(updates, 'codex-1.0.5-failed'), {recursive: true});
  const folder = async prefix => (await readdir(updates)).find(n => n.startsWith(prefix));
  try {
    await updater.update('codex');
    assert.deepEqual(f.recycled, ['codex-1.0.5-failed']);
    // Restart onto 1.0.1, update to 1.0.2; restart onto 1.0.2, update to 1.0.3: 1.0.1 is then the oldest.
    const first = await folder('codex-1.0.1-');
    f.active.codex = path.join(updates, first, 'core.exe');
    version = '1.0.2';
    await updater.update('codex');
    assert.equal(f.recycled.length, 1, 'the running core and the new one stay');
    f.active.codex = path.join(updates, await folder('codex-1.0.2-'), 'core.exe');
    version = '1.0.3';
    await updater.update('codex');
    assert.deepEqual(f.recycled, ['codex-1.0.5-failed', first]);
    assert.deepEqual(
      (await readdir(updates)).map(n => n.replace(/-[^-]+$/u, '')).sort(),
      ['claude-0.9.0', 'codex-1.0.2', 'codex-1.0.3']
    );
    const saved = JSON.parse(await readFile(path.join(f.root, 'selected-cores.json'), 'utf8'));
    assert.equal(await f.inspect(path.join(f.root, saved.codex.file)), '1.0.3');
    assert.equal(await f.inspect(path.join(f.root, saved.codex.previous.file)), '1.0.2');
  } finally {
    await updater.close();
  }
});
test('a clean-up that fails leaves the old cores and never undoes the update', async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, 'updates', 'gemini-0.9.0-old'), {recursive: true});
  const updater = createCoreUpdates({
    ...f,
    recycle: async () => {
      throw Error('busy');
    }
  });
  try {
    const result = await updater.update('gemini');
    assert.equal(result.restartRequired, true);
    assert.match(result.message, /沒有清理完成，可能只有部分移到資源回收筒/u);
    assert.doesNotMatch(result.message, /busy/u, 'no raw error text');
    assert.equal(await f.inspect((await selectedCoreExecutables(f.root, f.active)).gemini), '1.0.1');
    await access(path.join(f.root, 'updates', 'gemini-0.9.0-old'));
  } finally {
    await updater.close();
  }
});
test('the clean-up keeps the right folders through a linked parent and Windows case differences, and can be cut short', async () => {
  const f = await fixture();
  // K reached through a junction: downloads report real paths, the selection uses the linked one.
  const linked = `${f.root}-link`;
  await symlink(f.root, linked, 'junction');
  let version = '1.0.1';
  const calls = [];
  const updater = createCoreUpdates({
    ...f,
    root: linked,
    release: async () => ({version, file: 'core.exe'}),
    download: async (next, dir) => realpath(await f.download(next, dir)),
    recycle: async (dir, options) => (calls.push(options), f.recycle(dir))
  });
  const updates = path.join(f.root, 'updates');
  try {
    await updater.update('codex');
    const first = (await readdir(updates)).find(n => n.startsWith('codex-1.0.1-'));
    assert.deepEqual(f.recycled, [], 'the new download is never taken for an old one');
    // The running core named with different letter case is still the running core.
    f.active.codex = path.join(linked, 'updates', first.toUpperCase(), 'core.exe');
    version = '1.0.2';
    await updater.update('codex');
    assert.deepEqual(f.recycled, []);
    await mkdir(path.join(updates, 'codex-0.9.0-old'));
    // Still running 1.0.1: the prepared 1.0.2 that never ran and the old leftover go; 1.0.1 and 1.0.3 stay.
    const second = (await readdir(updates)).find(n => n.startsWith('codex-1.0.2-'));
    version = '1.0.3';
    await updater.update('codex');
    assert.deepEqual(f.recycled.sort(), ['codex-0.9.0-old', second].sort());
    assert.ok((await readdir(updates)).includes(first));
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.ok(calls[0].timeout > 0);
  } finally {
    await updater.close();
    await rm(linked);
  }
});
