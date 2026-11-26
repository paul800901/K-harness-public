import path from 'node:path';
import {mkdir, mkdtemp, readFile, readdir, realpath, stat, copyFile} from 'node:fs/promises';
import {createReadStream, createWriteStream, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomicWrite} from './atomic-write.mjs';
import {dshCli} from './dsh-acp.mjs';
import {sendDirectoryToRecycleBin} from './archive-delete.mjs';

const exec = promisify(execFile),
  names = {codex: 'Codex', claude: 'Claude Code', gemini: 'Antigravity', grok: 'Grok Build', deepseek: 'DeepSeek Harness'};
// DeepSeek Harness ships pre-releases (0.2.1-rc.5); a pre-release sorts before its release.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;
// Distributed with K so a clean installation also avoids a confirmed incompatible release.
const withheldDefaults = {
  gemini: {'1.5.17': '工作區寫入權限實測未通過：原生工具仍可寫入工作區外（2026-11-26）。'}
};
const selectionFile = root => path.join(root, 'selected-cores.json');
async function readSelection(root) {
  try {
    return JSON.parse(await readFile(selectionFile(root), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
async function readWithheldVersions(root, provider) {
  const file = path.join(root, 'withheld-cores.json');
  const defaults = Object.entries(withheldDefaults[provider] ?? {});
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  try {
    const withheld = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(withheld)) throw Error('名單格式無效。');
    for (const versions of Object.values(withheld)) {
      if (!isRecord(versions)) throw Error('名單格式無效。');
      for (const [version, reason] of Object.entries(versions))
        if (!VERSION.test(version) || typeof reason !== 'string' || !reason.trim()) throw Error('名單格式無效。');
    }
    return new Map([...defaults, ...Object.entries(withheld[provider] ?? {})]);
  } catch (error) {
    if (error.code === 'ENOENT') return new Map(defaults);
    throw Error(`核心略過版本名單檔讀取失敗：${file}。未下載或變更核心，請讓 AI 檢查名單檔。`, {cause: error});
  }
}
async function selectedFile(root, file) {
  const base = await realpath(root),
    target = await realpath(path.resolve(root, file)),
    relative = path.relative(base, target);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !(await stat(target)).isFile()
  )
    throw Error('核心檔案不在 K 專用目錄內。');
  return target;
}

// Read once at startup. Preparing an update never changes this process's cores.
export async function selectedCoreExecutables(root, defaults) {
  try {
    const selected = await readSelection(root),
      result = {...defaults};
    for (const provider of Object.keys(names))
      if (selected[provider]) result[provider] = await selectedFile(root, selected[provider].file);
    return result;
  } catch (error) {
    throw Error(
      `K 核心選用紀錄或檔案無法讀取：${selectionFile(root)}。請依更新紀錄退回該核心；未自動換版。${error.message}`,
      {cause: error}
    );
  }
}
const versionOf = value => {
  const match = String(value).match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?![0-9A-Za-z.-])/u);
  if (!match) throw Error('無法確認官方核心版本，未套用更新。');
  return match[1];
};
export const newer = (a, b) => {
  const [leftCore, leftPre] = a.split('-', 2),
    [rightCore, rightPre] = b.split('-', 2);
  const left = leftCore.split('.').map(Number),
    right = rightCore.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  if (!leftPre || !rightPre) return !leftPre && !!rightPre;
  const l = leftPre.split('.'),
    r = rightPre.split('.');
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined || r[i] === undefined) return r[i] === undefined;
    if (l[i] === r[i]) continue;
    const ln = /^\d+$/u.test(l[i]),
      rn = /^\d+$/u.test(r[i]);
    return ln && rn ? Number(l[i]) > Number(r[i]) : ln !== rn ? rn : l[i] > r[i];
  }
  return false;
};
async function get(url, signal) {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    headers: {'User-Agent': 'K-harness-core-update'}
  });
  if (!response.ok) throw Error(`官方下載失敗（HTTP ${response.status}），原核心保持不變。`);
  return response;
}

// Use the vendors' published distribution metadata, never run downloaded installers.
export async function officialCoreRelease(provider, {signal, arch = process.arch, request = get} = {}) {
  if (!['x64', 'arm64'].includes(arch)) throw Error('目前核心更新只支援 Windows x64／ARM64。');
  if (provider === 'claude') {
    const base = 'https://downloads.claude.ai/claude-code-releases';
    const version = (await (await request(`${base}/latest`, signal)).text()).trim();
    if (!/^\d+\.\d+\.\d+$/u.test(version)) throw Error('官方 Claude 版本資料無效。');
    const manifest = await (await request(`${base}/${version}/manifest.json`, signal)).json();
    return {
      version,
      url: `${base}/${version}/win32-${arch}/claude.exe`,
      algorithm: 'sha256',
      digest: manifest.platforms?.[`win32-${arch}`]?.checksum,
      encoding: 'hex',
      file: 'claude.exe'
    };
  }
  if (provider === 'gemini') {
    const manifest = await (
      await request(
        `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_${arch === 'x64' ? 'amd64' : 'arm64'}.json`,
        signal
      )
    ).json();
    if (!/^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\//u.test(manifest.url))
      throw Error('官方 Antigravity 下載位置無效。');
    return {
      version: manifest.version,
      url: manifest.url,
      algorithm: 'sha512',
      digest: manifest.sha512,
      encoding: 'hex',
      file: 'agy.exe'
    };
  }
  if (provider === 'grok') {
    // xAI publishes no checksum for the Windows binary; its Authenticode signature by
    // X Corp. is verified after download instead (installer script and binary: 1.0.70).
    const base = 'https://x.ai/cli';
    const version = (await (await request(`${base}/stable`, signal)).text()).trim();
    if (!/^\d+\.\d+\.\d+$/u.test(version)) throw Error('官方 Grok 版本資料無效。');
    return {
      version,
      url: `${base}/grok-${version}-windows-${arch === 'x64' ? 'x86_64' : 'aarch64'}.exe`,
      algorithm: 'authenticode',
      signer: 'X Corp.',
      file: 'grok.exe'
    };
  }
  if (provider === 'deepseek') {
    // DeepSeek's desktop update feed: the official NSIS installer with its SHA-512, signed by DeepSeek.
    // K never runs the installer; it unpacks the bundled app (which carries the `dsh` CLI) with 7-Zip.
    if (arch !== 'x64') throw Error('DeepSeek Harness 官方目前只提供 Windows x64。');
    const feed = await (await request('https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml', signal)).text();
    const field = name => feed.match(new RegExp(`^${name}:\\s*(?:>-\\s*)?\\n?\\s*(\\S+)`, 'mu'))?.[1];
    const version = field('version'),
      url = field('path'),
      digest = field('sha512');
    if (!VERSION.test(version ?? '')) throw Error('官方 DeepSeek Harness 版本資料無效。');
    if (!/^https:\/\/download\.deepseek\.com\/dsh-desk\/bin\/win-x64\/[\w.-]+\.exe$/u.test(url ?? ''))
      throw Error('官方 DeepSeek Harness 下載位置無效。');
    return {
      version,
      url,
      algorithm: 'sha512',
      digest,
      encoding: 'base64',
      signer: 'Hangzhou DeepSeek Artificial Intelligence Co., Ltd.',
      installer: 'nsis-7z',
      file: path.join('app', 'DeepSeek Harness.exe')
    };
  }
  if (provider === 'codex') {
    const base = 'https://registry.npmjs.org/@openai/codex';
    const latest = await (await request(`${base}/latest`, signal)).json();
    const dependency = latest.optionalDependencies?.[`@openai/codex-win32-${arch}`];
    if (!/^npm:@openai\/codex@\d+\.\d+\.\d+-win32-(x64|arm64)$/u.test(dependency))
      throw Error('官方 Codex Windows 套件資料無效。');
    const pkg = await (await request(`${base}/${dependency.slice('npm:@openai/codex@'.length)}`, signal)).json();
    if (
      !/^https:\/\/registry\.npmjs\.org\/@openai\/codex\/-\//u.test(pkg.dist?.tarball) ||
      !pkg.dist?.integrity?.startsWith('sha512-')
    )
      throw Error('官方 Codex 下載資料無效。');
    // Retain the complete native bundle, including sandbox/runner support files.
    return {
      version: latest.version,
      url: pkg.dist.tarball,
      algorithm: 'sha512',
      digest: pkg.dist.integrity.slice(7),
      encoding: 'base64',
      archive: true,
      file: `package/vendor/${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc/bin/codex.exe`
    };
  }
  throw Error('不支援的核心。');
}

const signatureEnvironment = (env, file) => {
  const {PSModulePath, ...rest} = env;
  return {...rest, K_SIGNED_FILE: file};
};
// Windows Authenticode: the signature must be Valid and issued to the expected publisher.
export async function verifyAuthenticode(file, signer, {run = exec, env = process.env, signal} = {}) {
  const {stdout} = await run(
    path.join(env.SystemRoot ?? env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$s = Get-AuthenticodeSignature -LiteralPath $env:K_SIGNED_FILE; [Console]::Out.Write((@{status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject} | ConvertTo-Json -Compress))'
    ],
    {windowsHide: true, signal, timeout: 60000, maxBuffer: 65536, env: signatureEnvironment(env, file)}
  );
  const result = JSON.parse(stdout);
  // A CN that contains a comma is quoted (CN="Hangzhou DeepSeek ..., Ltd.").
  const cn = String(result.subject).match(/(?:^|,\s*)CN=(?:"((?:[^"]|"")*)"|([^,]*))/u);
  if (result.status !== 'Valid' || (cn?.[1]?.replaceAll('""', '"') ?? cn?.[2]?.trim()) !== signer)
    throw Error('下載檔案的數位簽章無效或發行者不符，原核心保持不變。');
}

// 7-Zip is the one tool that opens the official NSIS installer; K uses an existing installation only.
export function sevenZip(env = process.env) {
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean)) {
    const candidate = path.join(base, '7-Zip', '7z.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw Error('解開 DeepSeek Harness 官方安裝包需要 7-Zip（https://www.7-zip.org/），本機找不到；原核心保持不變。');
}
export async function downloadCoreRelease(release, directory, {signal, request = get, run = exec, unpacker = sevenZip} = {}) {
  if (release.algorithm === 'authenticode') {
    const payload = path.join(directory, release.file);
    const response = await request(release.url, signal);
    await pipeline(response.body, createWriteStream(payload, {flags: 'wx'}), {signal});
    await verifyAuthenticode(payload, release.signer, {run, signal});
    return selectedFile(directory, release.file);
  }
  const bytes = release.algorithm === 'sha256' ? 32 : 64;
  if (typeof release.digest !== 'string' || Buffer.from(release.digest, release.encoding).length !== bytes)
    throw Error('官方下載缺少有效校驗碼，未下載。');
  const payload = path.join(directory, release.archive ? 'core.tgz' : release.installer ? 'installer.exe' : release.file);
  const response = await request(release.url, signal);
  await pipeline(response.body, createWriteStream(payload, {flags: 'wx'}), {signal});
  const hash = createHash(release.algorithm);
  for await (const chunk of createReadStream(payload)) hash.update(chunk);
  if (hash.digest(release.encoding) !== release.digest) throw Error('下載檔案校驗失敗，原核心保持不變。');
  if (release.installer === 'nsis-7z') {
    await verifyAuthenticode(payload, release.signer, {run, signal});
    const tool = unpacker(),
      options = {windowsHide: true, signal, timeout: 600000, maxBuffer: 1048576};
    await run(tool, ['x', payload, '$PLUGINSDIR\\app-64.7z', `-o${path.join(directory, 'installer')}`, '-y'], options);
    await run(
      tool,
      ['x', path.join(directory, 'installer', '$PLUGINSDIR', 'app-64.7z'), `-o${path.join(directory, 'app')}`, '-y'],
      options
    );
    const file = await selectedFile(directory, release.file);
    await verifyAuthenticode(file, release.signer, {run, signal});
    return file;
  }
  if (release.archive)
    await run(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', payload, '-C', directory], {
      windowsHide: true,
      signal,
      timeout: 120000,
      maxBuffer: 65536
    });
  return selectedFile(directory, release.file);
}
// A version query never carries provider credentials; core homes come from the launcher.
export function versionEnvironment(source = process.env, extra = {}) {
  const env = {...source};
  for (const key of Object.keys(env))
    if (
      /^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|DEEPSEEK_API_KEY|XAI_API_KEY|GROK_DEPLOYMENT_KEY|GROK_CONFIG|GROK_CONFIG_PATH)$/iu.test(
        key
      )
    )
      delete env[key];
  return {
    ...env,
    ...extra,
    DISABLE_AUTOUPDATER: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_DISABLE_API_KEY_AUTH: '1'
  };
}
async function inspectVersion(file, signal, env = versionEnvironment(), provider) {
  // DeepSeek Harness is an Electron app: its version comes from the bundled CLI run as Node, not the window.
  const [command, args, extra] =
    provider === 'deepseek'
      ? [file, ['--expose-internals', dshCli(file), '--version'], {ELECTRON_RUN_AS_NODE: '1'}]
      : [file, ['--version'], {}];
  const {stdout} = await exec(command, args, {
    windowsHide: true,
    signal,
    timeout: 20000,
    maxBuffer: 65536,
    env: {...env, ...extra}
  });
  return versionOf(stdout);
}

export function createCoreUpdates({
  root,
  active,
  release = officialCoreRelease,
  download = downloadCoreRelease,
  inspect = inspectVersion,
  versionEnv = {},
  recycle = sendDirectoryToRecycleBin
}) {
  let pending = null,
    abort = null,
    closed = false;
  const updates = path.join(root, 'updates');
  // Each download is one `updates/<provider>-<version>-<random>` folder. Windows names ignore case.
  const folderIn = (base, file) => {
    const relative = path.relative(base, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep)[0].toLowerCase()
      : null;
  };
  async function pruneCores(provider, kept, signal) {
    // Downloads report real paths: compare both as written and resolved, so a linked parent never
    // makes a kept core look like an old one.
    const base = await realpath(updates),
      keep = new Set();
    for (const file of kept.filter(Boolean)) {
      const written = path.resolve(root, file);
      keep.add(folderIn(updates, written));
      keep.add(folderIn(base, await realpath(written).catch(() => written)));
    }
    for (const entry of await readdir(base, {withFileTypes: true})) {
      const name = entry.name.toLowerCase();
      if (entry.isDirectory() && name.startsWith(`${provider}-`) && !keep.has(name))
        // A recycle that never returns (a dialog over a locked file) must not hold the update or K's shutdown.
        await recycle(path.join(base, entry.name), {signal, timeout: 5 * 60_000});
    }
  }
  return {
    get pending() {
      return !!pending;
    },
    update(provider) {
      if (!Object.hasOwn(names, provider)) return Promise.reject(Error('不支援的核心。'));
      if (closed || pending) return Promise.reject(Error('核心更新正在處理或 K 正在關閉，請稍後再試。'));
      abort = new AbortController();
      const signal = abort.signal;
      pending = (async () => {
        const selected = await readSelection(root),
          current = active[provider]
            ? await inspect(active[provider], signal, versionEnvironment(process.env, versionEnv), provider)
            : null;
        const next = await release(provider, {signal});
        if (typeof next.version !== 'string' || !VERSION.test(next.version)) throw Error('官方核心版本資料無效。');
        const entry = selected[provider];
        const withheld = await readWithheldVersions(root, provider);
        const reason = withheld.get(next.version);
        if (reason) {
          let message =
            `${names[provider]} 官方最新版 ${next.version} 已列入略過名單（${reason}），暫不更新` +
            (current ? `；目前維持 ${current} 執行。` : '。');
          if (entry?.version && entry.version !== current) message += `下次啟動 K 時選用 ${entry.version}。`;
          if (withheld.has(entry?.version)) message += '選用的版本已列入略過名單，請先讓 AI 調整選用版本再重開 K。';
          return {message, restartRequired: false};
        }
        const readyMessage =
          `${names[provider]} ${next.version} 已準備好；` +
          (provider === 'gemini'
            ? '重新開啟前請先讓 AI 跑權限檢查。通過後再離開並停止 K，重新開啟即生效。'
            : '離開並停止 K 後，重新開啟即生效。');
        if (entry?.version === next.version && entry.version !== current)
          return {
            message: readyMessage,
            restartRequired: true
          };
        if (current && !newer(next.version, current))
          return {message: `${names[provider]} 目前為 ${current}，沒有較新的正式版本。`, restartRequired: false};
        await mkdir(path.join(root, 'updates'), {recursive: true});
        const directory = await mkdtemp(path.join(root, 'updates', `${provider}-${next.version}-`));
        const file = await download(next, directory, {signal});
        if ((await inspect(file, signal, versionEnvironment(process.env, versionEnv), provider)) !== next.version)
          throw Error('下載版本讀回不符，原核心保持不變。');
        let previous = entry?.version === current ? entry : (entry?.previous ?? null);
        // A pending rollback may be the only usable predecessor while a withheld core is still running.
        if (withheld.has(previous?.version ?? current))
          previous = [entry, entry?.previous].find(core => core?.version && !withheld.has(core.version)) ?? previous;
        // The first Gemini core may be the shared official install. Preserve its binary
        // inside K without altering that installation or any login data.
        if (!previous && provider === 'gemini' && active.gemini) {
          const backup = path.join(directory, 'previous', 'agy.exe');
          await mkdir(path.dirname(backup));
          await copyFile(active.gemini, backup);
          previous = {version: current, file: path.relative(root, backup)};
        }
        selected[provider] = {version: next.version, file: path.relative(root, file), previous};
        // Retain one predecessor pointer. No live swap.
        if (selected[provider].previous) delete selected[provider].previous.previous;
        signal.throwIfAborted();
        await atomicWrite(selectionFile(root), JSON.stringify(selected, null, 2) + '\n');
        // Only the new core, its predecessor and the one running now stay; older downloads go to the
        // recycle bin. A failed clean-up leaves them in place and never undoes the update.
        const pruned = await pruneCores(provider, [file, previous?.file, active[provider]], signal).catch(error => error);
        return {
          message:
            readyMessage +
            (pruned instanceof Error ? '（更舊的版本沒有清理完成，可能只有部分移到資源回收筒；剩下的會在這個核心下次更新到新版時再清。）' : ''),
          restartRequired: true
        };
      })().finally(() => {
        pending = null;
        abort = null;
      });
      return pending;
    },
    async close() {
      closed = true;
      abort?.abort();
      await pending?.catch(() => {});
    }
  };
}
