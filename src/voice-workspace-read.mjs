import {open, readdir, realpath, stat} from 'node:fs/promises';
import {isUtf8} from 'node:buffer';
import path from 'node:path';

// Emma's read-only view of K's registered workspaces and the folders the person opened for reading. Nothing here writes.
// Paths stay inside the workspace after links are resolved; K state, sign-ins and secret-looking files are never read.

export const FILE_READ_CHARS = 20000;
export const FILE_LIST_LIMIT = 200;
export const FILE_FIND_LIMIT = 50;
const FIND_VISIT_LIMIT = 50000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

// Folders that hold K state, sign-ins, or nothing a person would read (dependencies, Git internals).
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.runtime', '.local', 'vault', 'agent-home', '.ssh', '.codex', '.gnupg', '__pycache__']);
const SECRET_FILE = [
  /^\.env/iu,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ppk)$/iu,
  /credential|secret|password|cookie/iu,
  /^id_(rsa|ed25519|ecdsa|dsa)/iu,
  /^(auth|token|tokens|oauth[^/]*)\.json$/iu
];
const hiddenDir = name => HIDDEN_DIRS.has(name.toLowerCase());
const secretFile = name => SECRET_FILE.some(pattern => pattern.test(name));
const blocked = parts => parts.some(hiddenDir) || (parts.length > 0 && secretFile(parts.at(-1)));
const BLOCKED = '這個位置是 K 的狀態、登入資料或疑似密碼金鑰檔，秘書不能讀。';

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Resolves a workspace-relative path; refuses anything that leaves the workspace or passes a hidden or secret name.
async function resolve(workspacePath, relative) {
  if (relative !== undefined && typeof relative !== 'string') throw Error('path 須為文字（工作區內的相對路徑）。');
  const root = await realpath(workspacePath).catch(() => {
    throw Error('這個資料夾目前不存在或打不開。');
  });
  const wanted = (relative ?? '').trim().replace(/^[\\/]+/u, '');
  // A colon is never part of a Windows file name: it only means a drive or an NTFS stream.
  if (path.isAbsolute(wanted) || wanted.includes(':')) throw Error('path 要用工作區內的相對路徑。');
  const target = path.resolve(root, wanted);
  if (!inside(root, target)) throw Error('這個路徑在工作區外面，秘書不能讀。');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  if (blocked(parts)) throw Error(BLOCKED);
  let real;
  try {
    real = await realpath(target);
  } catch {
    throw Error(`找不到「${wanted || '.'}」。`);
  }
  if (!inside(root, real)) throw Error('這個路徑連到工作區外面，秘書不能讀。');
  const realParts = path.relative(root, real).split(path.sep).filter(Boolean);
  if (blocked(realParts)) throw Error(BLOCKED);
  return {root, target: real, shown: parts.join('/')};
}

const visible = entry => (entry.isDirectory() ? !hiddenDir(entry.name) : entry.isFile() && !secretFile(entry.name));

export async function listFolder(workspacePath, relative) {
  const {target, shown} = await resolve(workspacePath, relative);
  if (!(await stat(target)).isDirectory()) throw Error('這不是資料夾；要讀檔案請用 file_read。');
  const entries = (await readdir(target, {withFileTypes: true})).filter(visible);
  entries.sort((a, b) => b.isDirectory() - a.isDirectory() || a.name.localeCompare(b.name));
  const rows = await Promise.all(
    entries.slice(0, FILE_LIST_LIMIT).map(async e => {
      if (e.isDirectory()) return {name: e.name, type: '資料夾'};
      const size = await stat(path.join(target, e.name)).then(s => s.size, () => null);
      return {name: e.name, type: '檔案', size};
    })
  );
  return {path: shown || '.', entries: rows, ...(entries.length > FILE_LIST_LIMIT ? {truncated: `只列前 ${FILE_LIST_LIMIT} 項，共 ${entries.length} 項`} : {})};
}

// Name search (not content). Links are not followed, so the walk stays inside the workspace.
export async function findFiles(workspacePath, query, relative) {
  if (typeof query !== 'string' || !query.trim()) throw Error('請給要找的檔名關鍵字。');
  const {root, target} = await resolve(workspacePath, relative);
  const words = query.trim().toLowerCase().split(/\s+/u);
  const found = [],
    queue = [target];
  let visited = 0;
  while (queue.length && found.length < FILE_FIND_LIMIT && visited < FIND_VISIT_LIMIT) {
    const dir = queue.shift();
    const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
    for (const e of entries) {
      if (++visited > FIND_VISIT_LIMIT) break;
      if (e.isSymbolicLink() || !visible(e)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(full);
      const name = e.name.toLowerCase();
      if (words.every(w => name.includes(w)))
        found.push({path: path.relative(root, full).split(path.sep).join('/'), type: e.isDirectory() ? '資料夾' : '檔案'});
      if (found.length >= FILE_FIND_LIMIT) break;
    }
  }
  return {
    query: query.trim(),
    results: found,
    ...(found.length >= FILE_FIND_LIMIT || visited >= FIND_VISIT_LIMIT ? {note: '結果可能不完整；請縮小資料夾範圍或換更精確的關鍵字。'} : {})
  };
}

export async function readTextFile(workspacePath, relative, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) throw Error('offset 須為 0 以上的整數。');
  const {target, shown} = await resolve(workspacePath, relative);
  const info = await stat(target);
  if (!info.isFile()) throw Error('這不是檔案；要看資料夾內容請用 file_list。');
  if (info.size > MAX_TEXT_BYTES) throw Error('檔案超過 5 MB，秘書不讀；需要的話交給聊天室處理。');
  const handle = await open(target, 'r');
  let buffer;
  try {
    buffer = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (buffer.includes(0) || !isUtf8(buffer) || buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw Error('這不是 UTF-8 純文字檔，秘書不能直接讀；PDF、圖片或錄音請交給聊天室處理。');
  const text = buffer.toString('utf8');
  const part = text.slice(offset, offset + FILE_READ_CHARS);
  const next = offset + part.length;
  return {path: shown, offset, totalChars: text.length, text: part, nextOffset: next < text.length ? next : null};
}
