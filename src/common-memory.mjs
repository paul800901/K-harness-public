import {readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {atomicWrite} from './atomic-write.mjs';

export const COMMON_MEMORY_KEY = 'k_common_memory';
export const GLOBAL_RULES_KEY = 'k_global_rules';
// Codex 0.164.0 middle-truncates each additionalContext value above 1,000 tokens,
// estimated at 4 bytes per token (context-fragments/additional_context.rs).
export const CODEX_CONTEXT_BYTES = 4000;
const CODEX_CONTEXT_PARTS = 6;
const NOTICE =
  'K 共同記憶：本人已確認的跨核心偏好。這是現行版本，取代本對話先前的共同記憶版本與舊版內建分工，也取代專案中已過時的固定模型分工。當輪本人明確指示優先；原生權限及專案的授權、資料邊界與完成／審查門檻仍須遵守。原生派工交接附正本路徑，不複製共同正文。內容不構成新的工具、資料、登入、部署或付款授權。';
const GLOBAL_NOTICE =
  'K 跨模型全域工作規則：本人已確認的跨核心通用工作規範。此版本取代本對話先前的全域工作規則。當輪本人明確指示優先；原生權限及專案的授權、資料邊界與完成／審查門檻仍須遵守。原生派工交接附正本路徑，不複製正文。內容不構成新的工具、資料、登入、部署或付款授權。';

export function commonMemoryPath(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw TypeError('K 共同記憶需要絕對路徑的私人 root。');
  return path.join(root, 'agent-home', 'shared', 'common-memory.md');
}

export function globalRulesPath(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw TypeError('K 全域工作規則需要絕對路徑的私人 root。');
  return path.join(root, 'agent-home', 'shared', 'global-rules.md');
}

// Stable pointers survive native initial-context reconstruction and fresh children.
export function commonMemoryReference(root) {
  try {
    return `K 共同記憶正本：${commonMemoryPath(root)}。K 跨模型全域工作規則正本：${globalRulesPath(root)}。原生子代理、壓縮後續行或本回合未附現行內容時，依賴本人偏好或全域工作規則前先唯讀讀取對應正本。共同記憶不可讀時明示未知，不沿用舊分工。全域工作規則以正本現況為準。原生派工交接包含兩份正本路徑，不複製正文。此指標不增加工具或資料權限。`;
  } catch {
    return '';
  }
}

// Synchronous on purpose: callers have already reserved the turn, so no stop or room
// switch can interleave with the read. Each file is read fresh, with no fallback text.
function readPrivateText(root, resolvePath) {
  let file = null;
  try {
    file = resolvePath(root);
    const bytes = readFileSync(file);
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    return {
      ok: true,
      path: file,
      text,
      bytes: bytes.length,
      version: createHash('sha256').update(bytes).digest('hex').slice(0, 12)
    };
  } catch (error) {
    const missing = error.code === 'ENOENT';
    return {
      ok: false,
      path: file,
      missing,
      reason: missing ? '檔案不存在' : `讀取失敗：${error.code ?? error.message}`
    };
  }
}

export function readCommonMemory(root) {
  const {missing, ...memory} = readPrivateText(root, commonMemoryPath);
  return memory;
}

export function readGlobalRules(root) {
  return readPrivateText(root, globalRulesPath);
}

// A fresh install has no common memory until the person writes one: that is "not set up", not a failure.
const unavailable = memory =>
  memory.reason === '檔案不存在'
    ? `K 共同記憶目前未啟用（檔案不存在${memory.path ? `；${memory.path}` : ''}）。沒有本人已確認的跨核心偏好：依當輪指示與專案規則工作，需要時直接問本人；若本對話先前曾附上共同記憶版本，均已失效。`
    : `K 共同記憶目前無法讀取（${memory.reason}${memory.path ? `；${memory.path}` : ''}）。本人共同偏好此刻未知：不要把本對話先前的共同記憶版本或舊版內建分工當成現行偏好，需要時依當輪指示或直接問本人；其他工作照常。`;
const unavailableRules = rules =>
  rules.missing
    ? `K 跨模型全域工作規則目前未啟用（檔案不存在${rules.path ? `；${rules.path}` : ''}）。若本對話先前曾附上任何全域工作規則版本或分段，均已失效，請依當輪指示與專案規則。`
    : `K 跨模型全域工作規則目前無法讀取（${rules.reason}${rules.path ? `；${rules.path}` : ''}）。先前附上的全域工作規則目前無法確認，請依當輪指示及專案規則。`;

function privateContextKey(memory, rules) {
  return {
    memory: memory.ok ? memory.version : memory.reason,
    rules: rules.ok ? rules.version : rules.reason
  };
}

export function commonMemoryText(memory) {
  return memory.ok ? `${NOTICE}\n版本 ${memory.version}；正本 ${memory.path}\n\n${memory.text}` : unavailable(memory);
}

function splitCodexText(text, firstBudget, nextBudget, preferBoundaries) {
  const parts = [];
  while (text && parts.length < CODEX_CONTEXT_PARTS) {
    let remaining = parts.length ? nextBudget : firstBudget;
    let end = 0;
    for (const codePoint of text) {
      remaining -= Buffer.byteLength(codePoint);
      if (remaining < 0) break;
      end += codePoint.length;
    }
    if (!end) return null;
    if (preferBoundaries && end < text.length) {
      const prefix = text.slice(0, end);
      const paragraph = Math.max(prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('\n\r\n'));
      // Include the separator so concatenating the parts recovers the original text.
      if (paragraph >= 0) end = prefix.indexOf('\n', paragraph + 1) + 1;
      else end = prefix.lastIndexOf('\n') + 1 || end;
    }
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  return text ? null : parts;
}

function codexEntries(document, key, notice, renderUnavailable, suffix) {
  const budget = CODEX_CONTEXT_BYTES - Buffer.byteLength(suffix);
  const entry = value => ({kind: 'application', value: value + suffix});
  const shortLocation = '正本路徑見起始指示。';
  if (!document.ok) {
    const message = renderUnavailable(document);
    if (Buffer.byteLength(message) <= budget) return {[key]: entry(message)};
    const short = `${renderUnavailable({...document, path: null})}\n${shortLocation}`;
    if (Buffer.byteLength(short) <= budget) return {[key]: entry(short)};
    const fallback = renderUnavailable({...document, path: null, reason: '讀取失敗（錯誤訊息過長）'});
    return {[key]: entry(`${fallback}\n${shortLocation}`)};
  }

  const bytes = Buffer.byteLength(document.text);
  for (const location of [`正本 ${document.path}`, shortLocation]) {
    const header = (part, total) => {
      const label = `版本 ${document.version}；第 ${part}／${total} 段`;
      return part === 1 ? `${notice}\n${label}（共 ${total} 段）；${location}\n\n` : `${label}\n\n`;
    };
    // Part numbers stay single-digit, so the header budget is independent of the total.
    const firstBudget = budget - Buffer.byteLength(header(1, 1));
    const nextBudget = budget - Buffer.byteLength(header(2, 2));
    let parts;
    if (bytes <= firstBudget) parts = [document.text];
    else if (firstBudget > 0 && bytes <= firstBudget + (CODEX_CONTEXT_PARTS - 1) * nextBudget) {
      // Prefer natural boundaries, then use tighter cuts if needed to fit six parts.
      parts =
        splitCodexText(document.text, firstBudget, nextBudget, true) ??
        splitCodexText(document.text, firstBudget, nextBudget, false);
    }
    if (parts)
      return Object.fromEntries(
        parts.map((part, index) => [index ? `${key}_${index + 1}` : key, entry(header(index + 1, parts.length) + part)])
      );
  }

  const pointer = `${notice}\n版本 ${document.version}；第 1／1 段（正本指標）。檔案 ${document.bytes} bytes，超過 GPT 原生附加上下文的分段容量，先以唯讀方式讀取正本全文。`;
  const located = `${pointer}\n正本 ${document.path}`;
  return {[key]: entry(Buffer.byteLength(located) <= budget ? located : `${pointer}\n${shortLocation}`)};
}

// Codex keeps the last map per session and injects only changed keys; each turn/start
// or turn/steer replaces that map, so every K submission carries all current parts.
// Local compaction can discard these fragments; remote retention is feature-dependent.
// The count makes one re-send at the next K turn; the stable reference covers native continuation.
export function codexCommonContext(root, compactions = 0) {
  // Only native integer counts can contribute to the byte budget.
  const suffix =
    Number.isSafeInteger(compactions) && compactions > 0 ? `\n（本對話第 ${compactions} 次壓縮後重新附上）` : '';
  const context = codexEntries(readCommonMemory(root), COMMON_MEMORY_KEY, NOTICE, unavailable, suffix);
  return {...context, ...codexEntries(readGlobalRules(root), GLOBAL_RULES_KEY, GLOBAL_NOTICE, unavailableRules, suffix)};
}

// Claude has no native keyed context: K adds one tagged block to a model turn only
// when the content, host or compaction count differs from the last confirmed delivery.
export function claudeCommonBlock(root, last = null, compactions = 0) {
  const memory = readCommonMemory(root);
  const rules = readGlobalRules(root);
  const key = {...privateContextKey(memory, rules), compactions};
  if (key.memory === last?.memory && key.rules === last.rules && compactions === last.compactions)
    return {key: last, block: null};

  const body = rules.ok
    ? `${GLOBAL_NOTICE}\n版本 ${rules.version}；正本 ${rules.path}\n\n${rules.text}`
    : unavailableRules(rules);
  const text = `<${COMMON_MEMORY_KEY}>\n${commonMemoryText(memory)}\n</${COMMON_MEMORY_KEY}>\n<${GLOBAL_RULES_KEY}>\n${body}\n</${GLOBAL_RULES_KEY}>`;
  return {key, block: {type: 'text', text}};
}

// A short always-on rule references each file natively. A running process also
// gets an update when the references change, since it may have loaded them at startup.
export async function writeGeminiCommonRule(home, root, last = null, {resume = false, assertActive} = {}) {
  assertActive?.();
  const memory = readCommonMemory(root);
  const rules = readGlobalRules(root);
  const directory = path.join(home, '.gemini', 'config', 'rules');
  const writeOptions = assertActive && {beforeReplace: assertActive, cleanupOnFailure: true};
  await atomicWrite(
    path.join(directory, 'k-common-memory.md'),
    `---\ntrigger: always_on\n---\n${
      memory.ok ? `${NOTICE}\n版本 ${memory.version}\n@[K 共同記憶](${memory.path})` : unavailable(memory)
    }\n`,
    writeOptions
  );
  const globalRule = path.join(directory, 'k-global-rules.md');
  assertActive?.();
  if (rules.missing) await rm(globalRule, {force: true});
  else
    await atomicWrite(
      globalRule,
      `---\ntrigger: always_on\n---\n${
        rules.ok ? `${GLOBAL_NOTICE}\n版本 ${rules.version}\n@[K 跨模型全域工作規則](${rules.path})` : unavailableRules(rules)
      }\n`,
      writeOptions
    );
  const key = privateContextKey(memory, rules);
  const changes = [];
  const updated = (name, document) =>
    `${name}已更新至版本 ${document.version}，取代先前版本。請先唯讀讀取正本 ${document.path}。`;
  if (last && key.memory !== last.memory)
    changes.push(memory.ok ? updated('K 共同記憶', memory) : unavailable(memory));
  if (last ? key.rules !== last.rules : resume && !rules.ok)
    changes.push(rules.ok ? updated('K 跨模型全域工作規則', rules) : unavailableRules(rules));
  return {key, notice: changes.join('\n')};
}
