import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {findKChromeProfileDirectory, startKChrome} from '../src/k-chrome-launcher.mjs';
import {batch, freshManifest, logFile, writeLevelDb} from './leveldb-fixture.mjs';

let n = 0;
async function profileDir() {
  const dir = path.join(scratchBase, `k-chrome-${n++}`);
  await mkdir(dir, {recursive: true});
  return dir;
}
// Holds the file the way a running Chrome does (no sharing) until released.
async function holdLock(file) {
  const holder = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$f = [IO.File]::Open($env:K_LOCK, 'OpenOrCreate', 'ReadWrite', 'None'); 'locked'; [Console]::In.ReadLine() | Out-Null; $f.Close()"
    ],
    {env: {...process.env, K_LOCK: file}, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']}
  );
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', data => String(data).includes('locked') && resolve());
    holder.on('error', reject);
    holder.on('exit', () => reject(Error('lock holder exited')));
  });
  return () => new Promise(resolve => (holder.on('exit', resolve), holder.stdin.end('\n')));
}
const connected = [{profileId: 'a'.repeat(32), connected: true, modes: ['regular']}],
  waiting = [{profileId: 'a'.repeat(32), connected: false, modes: []}];

test('a running K Chrome is never started again, only waited for', async () => {
  const userDataDir = await profileDir();
  const release = await holdLock(path.join(userDataDir, 'lockfile'));
  let runs = 0,
    lists = 0;
  const options = {chromeExecutable: 'C:\\fake\\chrome.exe', userDataDir, intervalMs: 1, execFileImpl: () => runs++};
  try {
    assert.deepEqual(
      await startKChrome({...options, listProfiles: async () => (++lists < 2 ? waiting : connected)}),
      connected
    );
    await assert.rejects(
      startKChrome({...options, timeoutMs: 10, listProfiles: async () => waiting}),
      /瀏覽器助手沒有在 0 秒內連上/
    );
  } finally {
    await release();
  }
  assert.equal(runs, 0);
});

test('a lockfile left behind by a crash does not stop K from starting Chrome', async () => {
  const userDataDir = await profileDir();
  await writeFile(path.join(userDataDir, 'lockfile'), '');
  let runs = 0;
  await startKChrome({
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    listProfiles: async () => connected,
    execFileImpl: (file, args, options, done) => {
      runs++;
      done(null);
    }
  });
  assert.equal(runs, 1);
});

test('requests from several rooms share one Chrome start', async () => {
  const userDataDir = await profileDir();
  let runs = 0,
    finish;
  const options = {
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    listProfiles: async () => connected,
    execFileImpl: (file, args, opts, done) => {
      runs++;
      finish = done;
    }
  };
  const first = startKChrome(options),
    second = startKChrome(options);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  finish(null);
  assert.deepEqual(await Promise.all([first, second]), [connected, connected]);
  assert.equal(runs, 1);
});

test('K Chrome starts through the minimizing script, then waits for the assistant to connect', async () => {
  const userDataDir = await profileDir();
  const runs = [];
  let lists = 0;
  const profiles = await startKChrome({
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    env: {SystemRoot: 'C:\\Windows'},
    intervalMs: 1,
    listProfiles: async () => (++lists < 3 ? waiting : connected),
    execFileImpl: (file, args, options, done) => {
      runs.push({file, args, options});
      done(null);
    }
  });
  assert.deepEqual(profiles, connected);
  assert.equal(lists, 3);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].file, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.match(runs[0].args[runs[0].args.indexOf('-File') + 1], /start-k-chrome-minimized\.ps1$/);
  assert.equal(runs[0].args[runs[0].args.indexOf('-Chrome') + 1], 'C:\\fake\\chrome.exe');
  assert.equal(runs[0].args[runs[0].args.indexOf('-UserDataDir') + 1], userDataDir);
  assert.equal(runs[0].args.at(-1), userDataDir, 'Chrome always starts with a regular window');
  assert.equal(runs[0].options.windowsHide, true);
});

test('starting a bound Chrome profile selects its configured profile directory', async () => {
  const userDataDir = await profileDir();
  let launched = false;
  await startKChrome({
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    profileId: connected[0].profileId,
    findProfileDirectory: async () => 'Profile 3',
    listProfiles: async () => (launched ? connected : waiting),
    execFileImpl: (_file, args, options, done) => {
      assert.deepEqual(args.slice(-2), ['-ProfileDirectory', 'Profile 3']);
      assert.equal(options.windowsHide, true);
      launched = true;
      done(null);
    }
  });
  assert.equal(launched, true);
});

test('a failed start or an assistant that never connects is reported, not retried', async () => {
  const userDataDir = await profileDir();
  let runs = 0;
  await assert.rejects(
    startKChrome({
      chromeExecutable: 'C:\\fake\\chrome.exe',
      userDataDir,
      listProfiles: async () => connected,
      execFileImpl: (file, args, options, done) => {
        runs++;
        done(Error('spawn failed'));
      }
    }),
    /無法開啟 K 專用 Chrome/
  );
  await assert.rejects(
    startKChrome({
      chromeExecutable: 'C:\\fake\\chrome.exe',
      userDataDir,
      timeoutMs: 20,
      intervalMs: 5,
      listProfiles: async () => waiting,
      execFileImpl: (file, args, options, done) => {
        runs++;
        done(null);
      }
    }),
    /沒有在 0 秒內連上/
  );
  assert.equal(runs, 2, 'each request starts Chrome at most once');
});

test('a request stopped before Chrome starts never starts it', async () => {
  const userDataDir = await profileDir();
  let runs = 0;
  await assert.rejects(
    startKChrome({
      chromeExecutable: 'C:\\fake\\chrome.exe',
      userDataDir,
      signal: AbortSignal.abort(),
      listProfiles: async () => connected,
      execFileImpl: () => runs++
    }),
    {name: 'AbortError'}
  );
  assert.equal(runs, 0);
});

test('a request stopped while K checks whether Chrome runs does not start it', async () => {
  const userDataDir = await profileDir();
  let runs = 0;
  const abort = new AbortController();
  const pending = startKChrome({
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    signal: abort.signal,
    listProfiles: async () => connected,
    execFileImpl: (file, args, options, done) => {
      runs++;
      done(null);
    }
  });
  abort.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runs, 0);
});

test('a stopped request stops waiting at once while the start another room needs continues', async () => {
  const userDataDir = await profileDir();
  let runs = 0,
    finish;
  const options = {
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    listProfiles: async () => connected,
    execFileImpl: (file, args, opts, done) => {
      runs++;
      finish = done;
    }
  };
  const abort = new AbortController();
  const stopped = startKChrome({...options, signal: abort.signal}),
    other = startKChrome(options);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  abort.abort();
  await assert.rejects(stopped, {name: 'AbortError'});
  finish(null);
  assert.deepEqual(await other, connected);
  assert.equal(runs, 1);
});

test('cancelling the request stops waiting for the assistant', async () => {
  const userDataDir = await profileDir();
  const abort = new AbortController();
  const pending = startKChrome({
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    signal: abort.signal,
    intervalMs: 10000,
    listProfiles: async () => waiting,
    execFileImpl: (file, args, options, done) => done(null)
  });
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(pending, {name: 'AbortError'});
});

test('a request stopped while K checks the connection reports the stop even if the profile then connects', async () => {
  for (const profileId of [undefined, 'a'.repeat(32)]) {
    const userDataDir = await profileDir();
    const abort = new AbortController();
    // With a target, K checks once before launching (not connected yet); the
    // check after the launch is answered only after the request stopped.
    let lists = 0,
      answer;
    const pending = startKChrome({
      chromeExecutable: 'C:\\fake\\chrome.exe',
      userDataDir,
      profileId,
      signal: abort.signal,
      findProfileDirectory: async () => 'Default',
      listProfiles: () =>
        ++lists === 1 && profileId !== undefined
          ? Promise.resolve(waiting)
          : new Promise(resolve => (answer = resolve)),
      execFileImpl: (file, args, options, done) => done(null)
    });
    while (!answer) await new Promise(resolve => setTimeout(resolve, 1));
    abort.abort();
    answer(connected);
    await assert.rejects(pending, {name: 'AbortError'}, `profileId ${profileId}`);
  }
});

const EXT = 'jhbfglfjhiebacbkjnohgmpgcppadblm',
  A = 'a'.repeat(32),
  B = 'b'.repeat(32),
  C = 'c'.repeat(32);
// The assistant's extension storage as Chrome writes it: a LevelDB database whose
// log holds kProfileId (identities in order: later ones overwrite earlier ones;
// null = the storage was cleared).
const storeDir = (userDataDir, folder) => path.join(userDataDir, folder, 'Local Extension Settings', EXT);
async function store(userDataDir, folder, ...identities) {
  await writeLevelDb(storeDir(userDataDir, folder), {
    'MANIFEST-000001': freshManifest(),
    '000003.log': logFile(
      identities.map((id, i) =>
        batch(i + 1, [{key: 'kProfileId', value: id === null ? undefined : JSON.stringify(id)}])
      )
    )
  });
}
const fakeScript = runs => (file, args, options, done) => {
  runs.push(args);
  done(null);
};
const argument = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

test('a profile identity resolves to exactly one Chrome profile folder of K Chrome', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Default', A);
  await store(userDataDir, 'Profile 3', B);
  await store(userDataDir, 'System Profile', C);
  await store(userDataDir, 'Profile x', C);
  await mkdir(path.join(userDataDir, 'Profile 4'), {recursive: true});
  const linked = await profileDir();
  await store(linked, 'Profile 1', C);
  await symlink(path.join(linked, 'Profile 1'), path.join(userDataDir, 'Profile 9'), 'junction');
  assert.equal(await findKChromeProfileDirectory({userDataDir, extensionId: EXT, profileId: A}), 'Default');
  assert.equal(await findKChromeProfileDirectory({userDataDir, extensionId: EXT, profileId: B}), 'Profile 3');
  // Only Chrome's own profile folder names, never links or System/odd folders.
  await assert.rejects(
    findKChromeProfileDirectory({userDataDir, extensionId: EXT, profileId: C}),
    /找不到目前使用這個識別碼/
  );
  await assert.rejects(
    findKChromeProfileDirectory({userDataDir, extensionId: EXT, profileId: '../Default'}),
    /設定檔識別碼無效/
  );
  await assert.rejects(findKChromeProfileDirectory({userDataDir, extensionId: '../x', profileId: A}), /設定無效/);
  // A copied profile folder makes the identity ambiguous; nothing is chosen.
  await store(userDataDir, 'Profile 7', A);
  await assert.rejects(findKChromeProfileDirectory({userDataDir, extensionId: EXT, profileId: A}), /有多個/);
});

test('a requested profile opens through --profile-directory even while K Chrome runs other profiles', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 2', B);
  const release = await holdLock(path.join(userDataDir, 'lockfile'));
  const runs = [];
  let lists = 0;
  try {
    const profiles = await startKChrome({
      chromeExecutable: 'C:\\fake\\chrome.exe',
      userDataDir,
      extensionId: EXT,
      profileId: B,
      intervalMs: 1,
      execFileImpl: fakeScript(runs),
      listProfiles: async () => {
        lists++;
        return [
          {profileId: A, connected: true, modes: ['regular']},
          {profileId: B, connected: lists > 3, modes: lists > 3 ? ['regular'] : []}
        ];
      }
    });
    assert.equal(profiles.find(p => p.profileId === B).connected, true);
  } finally {
    await release();
  }
  assert.equal(runs.length, 1, 'a running Chrome does not stop K from opening the requested profile');
  assert.equal(argument(runs[0], '-ProfileDirectory'), 'Profile 2');
  assert.equal(argument(runs[0], '-UserDataDir'), userDataDir);
});

test('only the requested profile counts as connected; another connected profile is not success', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 1', B);
  const runs = [];
  await assert.rejects(
    startKChrome({
      chromeExecutable: 'C:\\fake\\chrome.exe',
      userDataDir,
      extensionId: EXT,
      profileId: B,
      timeoutMs: 20,
      intervalMs: 5,
      execFileImpl: fakeScript(runs),
      listProfiles: async () => [
        {profileId: A, connected: true, modes: ['regular']},
        {profileId: B, connected: false, modes: []}
      ]
    }),
    /指定的 K Chrome 設定檔沒有在 0 秒內連上.*沒有改用其他設定檔/
  );
  assert.equal(runs.length, 1, 'the start is not retried');
});

test('an unknown or deleted profile folder fails without starting any Chrome', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Default', A);
  const runs = [];
  await assert.rejects(
    startKChrome({
      chromeExecutable: 'C:\\fake\\chrome.exe',
      userDataDir,
      extensionId: EXT,
      profileId: B,
      execFileImpl: fakeScript(runs),
      listProfiles: async () => [{profileId: B, connected: false, modes: []}]
    }),
    /找不到目前使用這個識別碼/
  );
  assert.equal(runs.length, 0);
  await assert.rejects(
    startKChrome({userDataDir, extensionId: EXT, profileId: 'Default', listProfiles: async () => []}),
    /設定檔識別碼無效/
  );
});

test('rooms asking for the same profile share one start; different profiles start one after another', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 1', A);
  await store(userDataDir, 'Profile 2', B);
  const runs = [],
    finishers = [],
    connected = new Set();
  const options = {
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    extensionId: EXT,
    intervalMs: 1,
    listProfiles: async () =>
      [A, B].map(profileId => ({profileId, connected: connected.has(profileId), modes: ['regular']})),
    execFileImpl: (file, args, opts, done) => {
      const folder = argument(args, '-ProfileDirectory');
      runs.push(folder);
      finishers.push(() => {
        connected.add(folder === 'Profile 1' ? A : B);
        done(null);
      });
    }
  };
  const first = startKChrome({...options, profileId: A}),
    second = startKChrome({...options, profileId: A}),
    other = startKChrome({...options, profileId: B});
  while (!finishers.length) await tick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(runs, ['Profile 1'], 'the second profile waits for the first launch to finish');
  finishers[0]();
  while (finishers.length < 2) await tick();
  assert.deepEqual(runs, ['Profile 1', 'Profile 2']);
  finishers[1]();
  await Promise.all([first, second, other]);
  assert.equal(runs.length, 2);
});

test('a queued profile start is skipped when its request stopped or that profile connected meanwhile', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 1', A);
  await store(userDataDir, 'Profile 2', B);
  await store(userDataDir, 'Profile 3', C);
  const runs = [],
    connected = new Set();
  let finish;
  const options = {
    chromeExecutable: 'C:\\fake\\chrome.exe',
    userDataDir,
    extensionId: EXT,
    intervalMs: 1,
    listProfiles: async () =>
      [A, B, C].map(profileId => ({profileId, connected: connected.has(profileId), modes: ['regular']})),
    execFileImpl: (file, args, opts, done) => {
      runs.push(argument(args, '-ProfileDirectory'));
      finish = done;
    }
  };
  const abort = new AbortController();
  const first = startKChrome({...options, profileId: A}),
    stopped = startKChrome({...options, profileId: B, signal: abort.signal}),
    later = startKChrome({...options, profileId: C});
  while (!finish) await tick();
  abort.abort();
  await assert.rejects(stopped, {name: 'AbortError'});
  // C connects (for example opened by the owner) while A's launch is still running.
  connected.add(A);
  connected.add(C);
  finish(null);
  await Promise.all([first, later]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(runs, ['Profile 1'], 'neither the stopped nor the already connected profile is started');
});

test('a request arriving after the launch finished but before the profile connected joins that start', async () => {
  // GPT review: the script returned, the profile is still offline, and a second
  // room asked for it; it used to open a second window (runs = 2).
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 1', A);
  const runs = [];
  let online = false,
    lists = 0;
  const options = {
    chromeExecutable: 'C:\fake\chrome.exe',
    userDataDir,
    extensionId: EXT,
    profileId: A,
    intervalMs: 1,
    execFileImpl: fakeScript(runs),
    listProfiles: async () => (lists++, [{profileId: A, connected: online, modes: online ? ['regular'] : []}])
  };
  const first = startKChrome(options);
  while (!runs.length) await tick();
  const afterLaunch = lists;
  while (lists < afterLaunch + 3) await tick();
  const abort = new AbortController();
  const second = startKChrome(options),
    stopped = startKChrome({...options, signal: abort.signal});
  await new Promise(resolve => setTimeout(resolve, 20));
  abort.abort();
  await assert.rejects(stopped, {name: 'AbortError'});
  online = true;
  await Promise.all([first, second]);
  assert.equal(runs.length, 1, 'one window for every room waiting for this profile');
  // Once connected, a later request checks afresh and does not launch.
  await startKChrome(options);
  assert.equal(runs.length, 1);
});

test('a start whose requests all stopped before it launched does not capture a later request', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 1', A);
  await store(userDataDir, 'Profile 2', B);
  const runs = [],
    finishers = [],
    connected = new Set();
  const options = {
    chromeExecutable: 'C:\fake\chrome.exe',
    userDataDir,
    extensionId: EXT,
    intervalMs: 1,
    listProfiles: async () =>
      [A, B].map(profileId => ({profileId, connected: connected.has(profileId), modes: ['regular']})),
    execFileImpl: (file, args, opts, done) => {
      const folder = argument(args, '-ProfileDirectory');
      runs.push(folder);
      finishers.push(() => (connected.add(folder === 'Profile 1' ? A : B), done(null)));
    }
  };
  const blocker = startKChrome({...options, profileId: B});
  while (!finishers.length) await tick();
  const abort = new AbortController();
  const stopped = startKChrome({...options, profileId: A, signal: abort.signal});
  abort.abort();
  await assert.rejects(stopped, {name: 'AbortError'});
  const later = startKChrome({...options, profileId: A});
  finishers[0]();
  await blocker;
  while (finishers.length < 2) await tick();
  finishers[1]();
  assert.equal((await later).find(p => p.profileId === A).connected, true);
  assert.deepEqual(runs, ['Profile 2', 'Profile 1'], 'the later request got its own launch, exactly once');
});

test('a start that already launched keeps serving later requests after its first requester stopped', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 1', A);
  const runs = [];
  let finish,
    online = false;
  const options = {
    chromeExecutable: 'C:\fake\chrome.exe',
    userDataDir,
    extensionId: EXT,
    profileId: A,
    intervalMs: 1,
    listProfiles: async () => [{profileId: A, connected: online, modes: online ? ['regular'] : []}],
    execFileImpl: (file, args, opts, done) => {
      runs.push(argument(args, '-ProfileDirectory'));
      finish = done;
    }
  };
  const abort = new AbortController();
  const stopped = startKChrome({...options, signal: abort.signal});
  while (!finish) await tick();
  abort.abort();
  await assert.rejects(stopped, {name: 'AbortError'});
  const later = startKChrome(options);
  finish(null);
  await new Promise(resolve => setTimeout(resolve, 20));
  online = true;
  await later;
  assert.deepEqual(runs, ['Profile 1']);
});

test('an identity the profile no longer holds (overwritten or cleared) never opens that profile', async () => {
  // GPT review: a valid log with sequence 1 kProfileId=A and sequence 2 the same
  // key = B made find(A) return Profile 1 and open it, although it is now B. A
  // stale native descriptor for A keeps A listed, which triggers the start.
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 1', A, B);
  await store(userDataDir, 'Profile 2', C, null);
  const runs = [];
  const options = {
    chromeExecutable: 'C:\fake\chrome.exe',
    userDataDir,
    extensionId: EXT,
    timeoutMs: 20,
    intervalMs: 1,
    execFileImpl: fakeScript(runs),
    listProfiles: async () => [A, B, C].map(profileId => ({profileId, connected: false, modes: []}))
  };
  for (const stale of [A, C]) {
    await assert.rejects(
      findKChromeProfileDirectory({userDataDir, extensionId: EXT, profileId: stale}),
      /找不到目前使用這個識別碼/
    );
    await assert.rejects(startKChrome({...options, profileId: stale}), /找不到目前使用這個識別碼.*沒有開啟其他設定檔/);
  }
  assert.equal(runs.length, 0, 'no window was opened for a stale identity');
  assert.equal(await findKChromeProfileDirectory({userDataDir, extensionId: EXT, profileId: B}), 'Profile 1');
  await assert.rejects(startKChrome({...options, profileId: B}), /沒有在 0 秒內連上/);
  assert.deepEqual(
    runs.map(args => argument(args, '-ProfileDirectory')),
    ['Profile 1']
  );
});

test('storage that cannot be read reliably in any profile folder blocks the choice', async () => {
  const userDataDir = await profileDir();
  await store(userDataDir, 'Profile 1', A);
  await store(userDataDir, 'Profile 2', B);
  // Profile 2's log ends in a record still being written (or torn).
  const log = path.join(storeDir(userDataDir, 'Profile 2'), '000003.log');
  await writeFile(log, logFile([batch(1, [{key: 'kProfileId', value: JSON.stringify(B)}])]).subarray(0, 60));
  const runs = [];
  await assert.rejects(
    startKChrome({
      chromeExecutable: 'C:\fake\chrome.exe',
      userDataDir,
      extensionId: EXT,
      profileId: A,
      execFileImpl: fakeScript(runs),
      findProfileDirectory: options => findKChromeProfileDirectory({...options, retries: 1}),
      listProfiles: async () => [{profileId: A, connected: false, modes: []}]
    }),
    /「Profile 2」的瀏覽器助手儲存目前無法可靠讀取.*沒有開啟任何設定檔/
  );
  assert.equal(runs.length, 0);
});
