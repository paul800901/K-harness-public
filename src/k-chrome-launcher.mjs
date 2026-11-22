import {execFile} from 'node:child_process';
import {lstat, open, readdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {aborted} from 'node:util';
import {validateProfileId} from './chrome-native-connection.mjs';
import {readLevelDbValue} from './leveldb-current-value.mjs';

const script = fileURLToPath(new URL('../scripts/start-k-chrome-minimized.ps1', import.meta.url));
// Chrome's own names for profile folders; anything else (System Profile, Guest
// Profile, links, model input) is never passed to --profile-directory.
const PROFILE_DIRECTORY = /^(?:Default|Profile [1-9]\d{0,3})$/;
const IDENTITY_KEY = Buffer.from('kProfileId', 'latin1');
// One Chrome launch at a time: two launches racing into the same Chrome would
// each take the other's new window for their own.
let launches = Promise.resolve();
// Requests for the same target (user data folder + profileId, or no profileId =
// whichever profile Chrome opens) share one start: its launch and the wait for
// that launch to connect.
const starts = new Map();

// A running Chrome keeps `lockfile` in its user data directory open; a file left
// behind by a crash or power loss opens normally and does not mean it is running.
async function chromeRunning(userDataDir) {
  try {
    await (await open(path.join(userDataDir, 'lockfile'), 'r+')).close();
    return false;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

// undefined: no such folder; a link or file is treated like a missing folder.
async function realDirectory(directory) {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// The identity the assistant would use now in one profile folder, or undefined.
async function currentIdentity(store, retries) {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await readLevelDbValue(store, IDENTITY_KEY);
      if (value === undefined) return undefined;
      // Chrome's extension storage keeps values as JSON.
      let stored;
      try {
        stored = JSON.parse(value.toString('utf8'));
      } catch {
        return undefined;
      }
      // Same rule as the assistant: anything else is replaced by a new identity.
      return typeof stored === 'string' && /^[a-f0-9]{32}$/.test(stored) ? stored : undefined;
    } catch (error) {
      // A running profile may be writing or compacting its storage right now.
      if (attempt >= retries) throw error;
      await delay(50);
    }
  }
}

/**
 * Finds which folder of K's dedicated Chrome holds a browser assistant profile
 * identity. The assistant keeps only `kProfileId` in its own extension storage
 * (`<folder>/Local Extension Settings/<extensionId>`, a LevelDB database), so
 * only that database is read, for the identity's *current* value: an identity
 * Chrome has since overwritten or cleared does not count. Local State,
 * Preferences, cookies and account data are never read. Exactly one folder must
 * currently hold the identity, and every assistant storage must be readable;
 * otherwise nothing is chosen.
 */
export async function findKChromeProfileDirectory({userDataDir, extensionId, profileId, retries = 3}) {
  validateProfileId(profileId);
  if (!/^[a-p]{32}$/.test(extensionId ?? '')) throw Error('K 瀏覽器助手設定無效。');
  const matches = [];
  for (const entry of await readdir(userDataDir, {withFileTypes: true})) {
    if (!entry.isDirectory() || !PROFILE_DIRECTORY.test(entry.name)) continue;
    const settings = path.join(userDataDir, entry.name, 'Local Extension Settings'),
      store = path.join(settings, extensionId);
    let identity;
    try {
      if (!(await realDirectory(settings)) || !(await realDirectory(store))) continue;
      identity = await currentIdentity(store, retries);
    } catch (error) {
      // Unreadable storage could hold this very identity (for example a copied
      // folder); guessing could open the wrong profile.
      throw Error(
        `K Chrome 設定檔「${entry.name}」的瀏覽器助手儲存目前無法可靠讀取，無法確定識別碼對應哪個資料夾；沒有開啟任何設定檔。`,
        {cause: error}
      );
    }
    if (identity === profileId) matches.push(entry.name);
  }
  if (matches.length === 1) return matches[0];
  throw Error(
    matches.length
      ? '有多個 K Chrome 設定檔資料夾含有這個識別碼，無法確定要開哪一個；沒有開啟任何設定檔。'
      : '找不到目前使用這個識別碼的 K Chrome 設定檔資料夾（可能已刪除，或助手儲存已清除、換了新識別碼）；沒有開啟其他設定檔。'
  );
}

/**
 * Start K's dedicated Chrome, minimized, for an AI browser request and wait for
 * the browser assistant to connect. With a profileId, only that profile's own
 * verified native connection counts, and that profile is opened even while
 * Chrome already runs other profiles (the new window is minimized; the running
 * Chrome and its other windows are left alone). Without one, Chrome is started
 * only when it is not running and any connected profile counts.
 *
 * Requests for the same target, from any room, share one start for its whole
 * life: queued launch, the launch itself, and the wait (until the target
 * connects or the start's deadline passes). A start whose requests all stopped
 * before it launched is dropped at once, so a later request gets its own
 * launch; one that already launched keeps serving later requests until its
 * deadline instead of opening another window.
 */
export async function startKChrome({
  chromeExecutable,
  userDataDir,
  extensionId,
  listProfiles,
  profileId,
  signal,
  env = process.env,
  execFileImpl = execFile,
  findProfileDirectory = findKChromeProfileDirectory,
  timeoutMs = 20000,
  intervalMs = 500
}) {
  // A stopped request never starts Chrome, and stops waiting for a start that
  // another room still needs without cancelling it.
  signal?.throwIfAborted();
  if (profileId !== undefined) validateProfileId(profileId);
  const ready = profiles =>
    profiles.some(profile => profile.connected && (profileId === undefined || profile.profileId === profileId));
  const key = `${userDataDir}|${profileId ?? ''}`;
  let start = starts.get(key);
  if (!start || (start.deadline !== undefined && Date.now() >= start.deadline)) {
    // states: queued -> launching -> settled (deadline set); or failed.
    const created = {waiters: new Set(), state: 'queued', timeoutMs};
    const wanted = () => [...created.waiters].some(other => !other.signal?.aborted);
    // Every request stopped before the launch: skip it and let nobody join it.
    const abandoned = () => {
      if (wanted()) return false;
      if (starts.get(key) === created) starts.delete(key);
      return true;
    };
    created.launch = launches
      .then(async () => {
        if (abandoned()) return;
        let directory;
        if (profileId !== undefined) {
          // Another start may have opened this profile while this one queued.
          if (ready(await listProfiles())) return;
          directory = await findProfileDirectory({userDataDir, extensionId, profileId});
        } else if (await chromeRunning(userDataDir)) return;
        if (abandoned()) return;
        created.state = 'launching';
        const powershell = path.join(
          env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        );
        await new Promise((resolve, reject) =>
          execFileImpl(
            powershell,
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'RemoteSigned',
              '-File',
              script,
              '-Chrome',
              chromeExecutable,
              '-UserDataDir',
              userDataDir,
              ...(directory ? ['-ProfileDirectory', directory] : [])
            ],
            {windowsHide: true, timeout: 30000},
            error => (error ? reject(Error('無法開啟 K 專用 Chrome。', {cause: error})) : resolve())
          )
        );
      })
      .then(
        () => {
          created.state = 'settled';
          created.deadline = Date.now() + timeoutMs;
        },
        error => {
          // Reported to every request of this start; a later request may try again.
          created.state = 'failed';
          if (starts.get(key) === created) starts.delete(key);
          throw error;
        }
      );
    launches = created.launch.catch(() => {});
    starts.set(key, (start = created));
  }
  const waiter = {signal};
  start.waiters.add(waiter);
  try {
    await (signal ? Promise.race([start.launch, aborted(signal, start.launch)]) : start.launch);
    signal?.throwIfAborted();
    for (;;) {
      const profiles = await listProfiles();
      if (ready(profiles)) {
        // Connected: a later request checks afresh instead of sharing this start.
        if (starts.get(key) === start) starts.delete(key);
        // A request stopped during the check reports the stop, not success.
        signal?.throwIfAborted();
        return profiles;
      }
      signal?.throwIfAborted();
      if (Date.now() >= start.deadline) break;
      await delay(Math.min(intervalMs, Math.max(0, start.deadline - Date.now())), undefined, {signal});
    }
  } finally {
    start.waiters.delete(waiter);
    // Nobody wants a start that has not launched yet: it will be skipped, so it
    // must not capture later requests.
    if (
      start.state === 'queued' &&
      ![...start.waiters].some(other => !other.signal?.aborted) &&
      starts.get(key) === start
    )
      starts.delete(key);
  }
  throw Error(
    profileId === undefined
      ? `瀏覽器助手沒有在 ${Math.round(start.timeoutMs / 1000)} 秒內連上；請確認 K 專用 Chrome 已開啟並啟用擴充。`
      : `指定的 K Chrome 設定檔沒有在 ${Math.round(start.timeoutMs / 1000)} 秒內連上瀏覽器助手；沒有改用其他設定檔。若該設定檔本來就開著，可能需要在它的擴充頁重新載入 K 瀏覽器助手。`
  );
}
