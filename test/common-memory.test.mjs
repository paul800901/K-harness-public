import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile, stat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import path from 'node:path';
import {
  CODEX_CONTEXT_BYTES,
  COMMON_MEMORY_KEY,
  GLOBAL_RULES_KEY,
  claudeCommonBlock,
  codexCommonContext,
  commonMemoryReference,
  commonMemoryPath,
  globalRulesPath,
  readCommonMemory,
  readGlobalRules,
  writeGeminiCommonRule
} from '../src/common-memory.mjs';
import {openDiscussionSession} from '../src/discussion-native.mjs';
import {createClaudeWorker} from '../src/claude-worker.mjs';
import {createGeminiWorker} from '../src/gemini-worker.mjs';
import {scratchBase} from './scratch.mjs';

// These tests only use synthetic private roots.
async function privateRoot(content) {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'common memory 私人-'));
  if (content !== undefined) await writeMemory(root, content);
  return root;
}
async function writePrivateFile(file, content) {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, content);
}
const writeMemory = (root, content) => writePrivateFile(commonMemoryPath(root), content);
const writeRules = (root, content) => writePrivateFile(globalRulesPath(root), content);
const exists = file =>
  stat(file).then(
    () => true,
    () => false
  );

function codexBodies(context, key, version, compactions = 0) {
  const keys = Object.keys(context).filter(name => name === key || name.startsWith(`${key}_`));
  assert.ok(keys.length);
  const suffix = compactions ? `\n（本對話第 ${compactions} 次壓縮後重新附上）` : '';
  return keys.map((name, index) => {
    assert.equal(name, index ? `${key}_${index + 1}` : key);
    const {kind, value} = context[name];
    assert.equal(kind, 'application');
    assert.ok(Buffer.byteLength(value, 'utf8') <= CODEX_CONTEXT_BYTES);
    const bodyStart = value.indexOf('\n\n');
    assert.ok(bodyStart >= 0);
    assert.ok(value.slice(0, bodyStart).includes(`版本 ${version}；第 ${index + 1}／${keys.length} 段`));
    if (index === 0) assert.ok(value.slice(0, bodyStart).includes(`共 ${keys.length} 段`));
    if (suffix) assert.ok(value.endsWith(suffix));
    const body = value.slice(bodyStart + 2, suffix ? -suffix.length : undefined);
    assert.equal(Buffer.from(body, 'utf8').toString('utf8'), body, 'no split surrogate pairs');
    return body;
  });
}

test('reader returns the complete current file or an explicit unavailable state, never creating it', async () => {
  const root = await privateRoot('\uFEFF# 合成偏好\n- 假偏好甲\n');
  const file = commonMemoryPath(root);
  assert.equal(file, path.join(root, 'agent-home', 'shared', 'common-memory.md'));
  const first = readCommonMemory(root);
  assert.equal(first.ok, true);
  assert.equal(first.text, '# 合成偏好\n- 假偏好甲\n');
  assert.match(first.version, /^[0-9a-f]{12}$/);
  await writeMemory(root, '# 合成偏好\n- 假偏好乙\n');
  const second = readCommonMemory(root);
  assert.notEqual(second.version, first.version);
  assert.doesNotMatch(second.text, /假偏好甲/);

  await rm(file);
  assert.deepEqual(readCommonMemory(root), {ok: false, path: file, reason: '檔案不存在'});
  assert.equal(await exists(file), false, 'a normal read must not recreate the file');

  await writeFile(file, Buffer.from([0x23, 0xff, 0xfe]));
  assert.match(readCommonMemory(root).reason, /^讀取失敗/);
  await rm(file);
  await mkdir(file);
  assert.match(readCommonMemory(root).reason, /^讀取失敗：EISDIR/);
  assert.equal(readCommonMemory('relative/root').ok, false, 'an invalid root is unavailable, not a crash');
  assert.equal(readCommonMemory(undefined).path, null);
});

test('global rules read independently with a byte version and distinguish absence from read errors', async () => {
  const root = await privateRoot('- 合成偏好');
  const file = globalRulesPath(root);
  assert.equal(file, path.join(root, 'agent-home', 'shared', 'global-rules.md'));
  const missing = {ok: false, path: file, missing: true, reason: '檔案不存在'};
  assert.deepEqual(readGlobalRules(root), missing);
  assert.equal(await exists(file), false);
  const absent = codexCommonContext(root);
  assert.deepEqual(Object.keys(absent), [COMMON_MEMORY_KEY, GLOBAL_RULES_KEY]);
  assert.match(absent[GLOBAL_RULES_KEY].value, /目前未啟用（檔案不存在[\s\S]*均已失效/);

  const raw = '\uFEFF\uFEFF# 合成全域規則\r\n';
  await writeRules(root, raw);
  assert.deepEqual(readGlobalRules(root), {
    ok: true,
    path: file,
    text: raw.slice(1),
    bytes: Buffer.byteLength(raw),
    version: createHash('sha256').update(raw).digest('hex').slice(0, 12)
  });
  await rm(file);
  assert.deepEqual(readGlobalRules(root), missing);
  assert.deepEqual(codexCommonContext(root), absent);

  await writeRules(root, Buffer.from([0x23, 0xff, 0xfe]));
  assert.equal(readGlobalRules(root).missing, false);
  assert.match(readGlobalRules(root).reason, /^讀取失敗/);
  const context = codexCommonContext(root, 1);
  assert.match(context[COMMON_MEMORY_KEY].value, /合成偏好/);
  assert.match(context[GLOBAL_RULES_KEY].value, /全域工作規則目前無法讀取（讀取失敗[\s\S]*第 1 次壓縮後/);

  await rm(file);
  await mkdir(file);
  assert.equal(readGlobalRules(root).missing, false);
  assert.match(readGlobalRules(root).reason, /^讀取失敗：EISDIR/);
  assert.match(codexCommonContext(root)[GLOBAL_RULES_KEY].value, /EISDIR/);
  assert.equal(readGlobalRules('relative/root').missing, false);
  assert.equal(readGlobalRules(undefined).path, null);
  assert.equal(readCommonMemory(root).text, '- 合成偏好');
});

test('a missing common memory is reported as not set up and never falls back to older preferences', async () => {
  const root = await privateRoot();
  const value = codexCommonContext(root)[COMMON_MEMORY_KEY].value;
  assert.match(value, /K 共同記憶目前未啟用（檔案不存在；/);
  assert.match(value, /沒有本人已確認的跨核心偏好/);
  assert.match(value, /先前曾附上共同記憶版本，均已失效/);
  assert.doesNotMatch(value, /Flash|Opus|Sol|Astra/);
});

test('an unreadable common memory is explicit and never falls back to older preferences', async () => {
  const root = await privateRoot(Buffer.from([0xff]));
  const value = codexCommonContext(root)[COMMON_MEMORY_KEY].value;
  assert.match(value, /K 共同記憶目前無法讀取（讀取失敗/);
  assert.match(value, /本人共同偏好此刻未知/);
  assert.match(value, /不要把本對話先前的共同記憶版本或舊版內建分工當成現行偏好/);
});

test('native continuation reference uses the same private path without copying or requiring a body', async () => {
  const root = await privateRoot();
  const before = commonMemoryReference(root);
  assert.ok(before.includes(commonMemoryPath(root)));
  assert.ok(before.includes(globalRulesPath(root)));
  assert.match(before, /原生子代理、壓縮後續行/);
  await writeMemory(root, '- reference-only synthetic body');
  await writeRules(root, '- rules reference-only synthetic body');
  assert.equal(commonMemoryReference(root), before);
  assert.doesNotMatch(before, /reference-only synthetic body/);
  assert.equal(commonMemoryReference(undefined), '');
});

test('Codex keeps short documents in independent application entries', async () => {
  const root = await privateRoot('# 合成\n- 短偏好\n');
  await writeRules(root, '- 短全域規則\n');
  const context = codexCommonContext(root);
  assert.deepEqual(Object.keys(context), [COMMON_MEMORY_KEY, GLOBAL_RULES_KEY]);
  assert.match(context[COMMON_MEMORY_KEY].value, /取代本對話先前的共同記憶版本與舊版內建分工/);
  assert.match(context[COMMON_MEMORY_KEY].value, /取代專案中已過時的固定模型分工/);
  assert.match(context[COMMON_MEMORY_KEY].value, /授權、資料邊界與完成／審查門檻仍須遵守/);
  assert.match(context[GLOBAL_RULES_KEY].value, /K 跨模型全域工作規則：本人已確認的跨核心通用工作規範/);
  assert.match(context[GLOBAL_RULES_KEY].value, /內容不構成新的工具、資料、登入、部署或付款授權/);
  assert.deepEqual(codexBodies(context, COMMON_MEMORY_KEY, readCommonMemory(root).version), ['# 合成\n- 短偏好\n']);
  assert.deepEqual(codexBodies(context, GLOBAL_RULES_KEY, readGlobalRules(root).version), ['- 短全域規則\n']);
  assert.deepEqual(codexCommonContext(root), context, 'unchanged input yields identical entries');
});

test('Codex counts the final 3,999, 4,000 and 4,001-byte values including compaction and headers', async () => {
  const root = await privateRoot('');
  await writeRules(root, '');
  const empty = codexCommonContext(root, 2);
  for (const [key, write, read] of [
    [COMMON_MEMORY_KEY, writeMemory, readCommonMemory],
    [GLOBAL_RULES_KEY, writeRules, readGlobalRules]
  ]) {
    const overhead = Buffer.byteLength(empty[key].value, 'utf8');
    for (const size of [3999, 4000, 4001]) {
      const body = 'a'.repeat(size - overhead);
      await write(root, body);
      const context = codexCommonContext(root, 2);
      const parts = codexBodies(context, key, read(root).version, 2);
      assert.equal(parts.join(''), body);
      if (size <= CODEX_CONTEXT_BYTES) {
        assert.equal(parts.length, 1);
        assert.equal(Buffer.byteLength(context[key].value, 'utf8'), size);
      } else assert.equal(parts.length, 2);
    }
  }
});

test('Codex uses a short header for empty and one-byte documents behind long UTF-8 paths', t => {
  const root = path.join(scratchBase, '長'.repeat(1400));
  const original = fs.readFileSync;
  let body = '';
  const mocked = t.mock.method(fs, 'readFileSync', (file, ...args) =>
    file === commonMemoryPath(root) || file === globalRulesPath(root)
      ? Buffer.from(body)
      : original(file, ...args)
  );
  syncBuiltinESMExports();
  try {
    const compactions = Number.MAX_SAFE_INTEGER;
    for (body of ['', 'x']) {
      const context = codexCommonContext(root, compactions);
      for (const [key, read] of [[COMMON_MEMORY_KEY, readCommonMemory], [GLOBAL_RULES_KEY, readGlobalRules]]) {
        assert.match(context[key].value, /正本路徑見起始指示/);
        assert.deepEqual(codexBodies(context, key, read(root).version, compactions), [body]);
      }
    }
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Codex bounds unreadable entries even for a long uncoded error or an invalid compaction count', t => {
  const root = scratchBase;
  const original = fs.readFileSync;
  const mocked = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === commonMemoryPath(root) || file === globalRulesPath(root)) throw Error('合成錯誤😀'.repeat(1400));
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    for (const compactions of [1, '9'.repeat(5000)]) {
      const context = codexCommonContext(root, compactions);
      for (const {value} of Object.values(context)) {
        assert.ok(Buffer.byteLength(value, 'utf8') <= CODEX_CONTEXT_BYTES);
        assert.match(value, /目前無法讀取[\s\S]*正本路徑見起始指示/);
        if (compactions === 1) assert.match(value, /第 1 次壓縮後重新附上/);
      }
      assert.match(context[COMMON_MEMORY_KEY].value, /共同偏好此刻未知/);
      assert.match(context[GLOBAL_RULES_KEY].value, /先前附上的全域工作規則目前無法確認/);
    }
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Codex prefers paragraphs and lines and retains the original separators', async () => {
  const paragraph = `${'甲'.repeat(320)}\r\n${'乙'.repeat(350)}\r\n\r\n`;
  const rest = `${'丙'.repeat(240)}\r\n${'丁'.repeat(800)}\r\n`;
  const firstLine = `${'戊'.repeat(890)}\n`;
  const secondLine = `${'己'.repeat(600)}\n`;
  const root = await privateRoot(paragraph + rest);
  await writeRules(root, firstLine + secondLine);
  const context = codexCommonContext(root);
  assert.deepEqual(codexBodies(context, COMMON_MEMORY_KEY, readCommonMemory(root).version), [paragraph, rest]);
  assert.deepEqual(codexBodies(context, GLOBAL_RULES_KEY, readGlobalRules(root).version), [firstLine, secondLine]);
});

test('Codex splits long UTF-8 lines without breaking code points and refreshes every current part', async () => {
  const memory = '測試偏好'.repeat(1000);
  const rules = '規則😀'.repeat(1000);
  const root = await privateRoot(memory);
  await writeRules(root, rules);
  const ordinary = codexCommonContext(root);
  const compacted = codexCommonContext(root, 3);
  assert.deepEqual(Object.keys(compacted), Object.keys(ordinary));
  assert.ok(compacted.k_common_memory_2);
  assert.ok(compacted.k_global_rules_2);
  for (const [name, entry] of Object.entries(compacted)) assert.notEqual(entry.value, ordinary[name].value);
  assert.equal(codexBodies(compacted, COMMON_MEMORY_KEY, readCommonMemory(root).version, 3).join(''), memory);
  assert.equal(codexBodies(compacted, GLOBAL_RULES_KEY, readGlobalRules(root).version, 3).join(''), rules);

  await writeMemory(root, '- 新版偏好');
  await writeRules(root, '- 新版規則');
  const shortened = codexCommonContext(root, 3);
  assert.deepEqual(Object.keys(shortened), [COMMON_MEMORY_KEY, GLOBAL_RULES_KEY]);
  assert.deepEqual(codexBodies(shortened, COMMON_MEMORY_KEY, readCommonMemory(root).version, 3), ['- 新版偏好']);
  assert.deepEqual(codexBodies(shortened, GLOBAL_RULES_KEY, readGlobalRules(root).version, 3), ['- 新版規則']);
});

test('Codex keeps six parts when natural breaks run out of room and uses one pointer beyond capacity', async () => {
  const fits = (`${'甲'.repeat(800)}\n\n`).repeat(9);
  const oversized = `${'合成長文'.repeat(3000)}\n尾端假標記`;
  const root = await privateRoot(fits);
  await writeRules(root, oversized);
  const context = codexCommonContext(root, 1);
  const parts = codexBodies(context, COMMON_MEMORY_KEY, readCommonMemory(root).version, 1);
  assert.equal(parts.length, 6);
  assert.equal(parts.join(''), fits);
  assert.deepEqual(Object.keys(context).filter(key => key.startsWith(GLOBAL_RULES_KEY)), [GLOBAL_RULES_KEY]);
  const pointer = context[GLOBAL_RULES_KEY].value;
  assert.ok(Buffer.byteLength(pointer, 'utf8') <= CODEX_CONTEXT_BYTES);
  assert.match(pointer, /第 1／1 段（正本指標）/);
  assert.match(pointer, /先以唯讀方式讀取正本全文[\s\S]*第 1 次壓縮後重新附上/);
  assert.ok(pointer.includes(globalRulesPath(root)));
  assert.doesNotMatch(pointer, /合成長文|尾端假標記/);
  assert.match(claudeCommonBlock(root).block.text, /尾端假標記/);
});

test('Claude block is sent again only after content, compaction or host changes', async () => {
  const root = await privateRoot('- 假偏好甲');
  const first = claudeCommonBlock(root, null, 0);
  assert.match(first.block.text, /^<k_common_memory>\n[\s\S]*- 假偏好甲\n<\/k_common_memory>\n<k_global_rules>/);
  assert.match(first.block.text, /目前未啟用（檔案不存在[\s\S]*均已失效/);
  assert.equal(claudeCommonBlock(root, first.key, 0).block, null);
  await writeRules(root, '- 全域規則甲');
  const enabled = claudeCommonBlock(root, first.key);
  assert.match(enabled.block.text, /<k_global_rules>\n[\s\S]*全域規則甲\n<\/k_global_rules>$/);
  assert.equal(claudeCommonBlock(root, enabled.key).block, null);
  const compacted = claudeCommonBlock(root, enabled.key, 1);
  assert.match(compacted.block.text, /假偏好甲[\s\S]*全域規則甲/);
  assert.equal(claudeCommonBlock(root, compacted.key, 1).block, null);

  await writeRules(root, '- 全域規則乙');
  const updatedRules = claudeCommonBlock(root, compacted.key, 1);
  assert.match(updatedRules.block.text, /假偏好甲[\s\S]*全域規則乙/);
  assert.doesNotMatch(updatedRules.block.text, /全域規則甲/);
  await writeRules(root, Buffer.from([0xff]));
  const unreadable = claudeCommonBlock(root, updatedRules.key, 1);
  assert.match(unreadable.block.text, /假偏好甲[\s\S]*<k_global_rules>\nK 跨模型全域工作規則目前無法讀取/);
  assert.equal(claudeCommonBlock(root, unreadable.key, 1).block, null);

  await rm(globalRulesPath(root));
  const removed = claudeCommonBlock(root, unreadable.key, 1);
  assert.match(removed.block.text, /<k_global_rules>\nK 跨模型全域工作規則目前未啟用（檔案不存在.*均已失效/);
  assert.equal(claudeCommonBlock(root, removed.key, 1).block, null);
  assert.equal(claudeCommonBlock(root, removed.key, 2).block.text, removed.block.text);

  await writeMemory(root, '- 假偏好乙');
  const changed = claudeCommonBlock(root, removed.key, 1);
  assert.match(changed.block.text, /假偏好乙/);
  assert.doesNotMatch(changed.block.text, /假偏好甲/);
  await rm(commonMemoryPath(root));
  const missing = claudeCommonBlock(root, changed.key, 1);
  assert.match(missing.block.text, /未啟用（檔案不存在/);
  assert.equal(claudeCommonBlock(root, missing.key, 1).block, null, 'a missing notice is not repeated');
});

test('A tagged block updates the model from missing to unreadable and back to missing', async () => {
  const root = await privateRoot('- 合成偏好');
  const absent = claudeCommonBlock(root);
  await writeRules(root, Buffer.from([0xff]));
  const unreadable = claudeCommonBlock(root, absent.key);
  assert.match(unreadable.block.text, /<k_global_rules>\nK 跨模型全域工作規則目前無法讀取/);
  await rm(globalRulesPath(root));
  const restored = claudeCommonBlock(root, unreadable.key);
  assert.equal(restored.block.text, absent.block.text);
  assert.equal(claudeCommonBlock(root, restored.key).block, null);
});

test('Gemini rule is a short always-on native reference, or an explicit notice without a reference', async () => {
  const root = await privateRoot('- 假偏好甲');
  const home = path.join(root, 'gemini-home');
  await writeGeminiCommonRule(home, root);
  const rule = path.join(home, '.gemini', 'config', 'rules', 'k-common-memory.md');
  const globalRule = path.join(path.dirname(rule), 'k-global-rules.md');
  await assert.rejects(readFile(globalRule), {code: 'ENOENT'});
  const text = await readFile(rule, 'utf8');
  assert.ok(text.startsWith('---\ntrigger: always_on\n---\n'));
  assert.ok(text.includes(`@[K 共同記憶](${commonMemoryPath(root)})`));
  assert.doesNotMatch(text, /假偏好甲/, 'the body stays in the single private file');
  assert.ok(Buffer.byteLength(text) < 1024);
  await writeRules(root, '- 假全域規則甲');
  await writeGeminiCommonRule(home, root);
  const globalText = await readFile(globalRule, 'utf8');
  assert.ok(globalText.startsWith('---\ntrigger: always_on\n---\n'));
  assert.ok(globalText.includes(`@[K 跨模型全域工作規則](${globalRulesPath(root)})`));
  assert.doesNotMatch(globalText, /假全域規則甲/);
  assert.ok(Buffer.byteLength(globalText) < 1024);

  await writeRules(root, Buffer.from([0xff]));
  await writeGeminiCommonRule(home, root);
  const unreadable = await readFile(globalRule, 'utf8');
  assert.match(unreadable, /K 跨模型全域工作規則目前無法讀取（讀取失敗/);
  assert.doesNotMatch(unreadable, /@\[/);
  assert.equal(await readFile(rule, 'utf8'), text);

  await rm(globalRulesPath(root));
  await rm(commonMemoryPath(root));
  await writeGeminiCommonRule(home, root);
  const missing = await readFile(rule, 'utf8');
  assert.doesNotMatch(missing, /@\[/);
  assert.match(missing, /K 共同記憶目前未啟用（檔案不存在/);
  await assert.rejects(readFile(globalRule), {code: 'ENOENT'});
  assert.equal(await exists(globalRulesPath(root)), false);
  assert.equal(await exists(commonMemoryPath(root)), false);
});

test('Codex discussion turns carry the current entry; Claude discussion repeats it only after a change', async () => {
  const root = await privateRoot('- 討論假偏好甲');
  const rules = `- 討論全域規則原文\n${'長規則'.repeat(600)}`;
  await writeRules(root, rules);
  const calls = [];
  let event;
  const codex = await openDiscussionSession({
    root,
    workspace: root,
    selection: {model: 'gpt-6.1-sol', effort: 'high'},
    codexHost: opts => {
      event = opts.onEvent;
      return {
        closed: new Promise(() => {}),
        notify() {},
        async request(method, params) {
          calls.push({method, params});
          if (method === 'windowsSandbox/readiness') return {status: 'ready'};
          if (method === 'config/read') return {config: {}};
          if (method === 'thread/start') return {thread: {id: 'native-discussion'}};
          if (method === 'turn/start') {
            queueMicrotask(() => event({method: 'turn/completed', params: {turn: {status: 'completed'}}}));
            return {turn: {id: 'turn'}};
          }
          return {};
        },
        async close() {}
      };
    }
  });
  await codex.ask('第一輪');
  await writeMemory(root, '- 討論假偏好乙');
  event({method: 'item/completed', params: {item: {type: 'contextCompaction', id: 'c1'}}});
  await codex.ask('第二輪');
  await codex.close();
  const turns = calls.filter(c => c.method === 'turn/start').map(c => c.params);
  const developerInstructions = calls.find(c => c.method === 'thread/start').params.developerInstructions;
  assert.doesNotMatch(developerInstructions, /討論假偏好|討論全域規則原文/);
  assert.ok(developerInstructions.includes(commonMemoryPath(root)));
  assert.ok(developerInstructions.includes(globalRulesPath(root)));
  assert.match(turns[0].additionalContext[COMMON_MEMORY_KEY].value, /討論假偏好甲/);
  assert.match(turns[1].additionalContext[COMMON_MEMORY_KEY].value, /討論假偏好乙[\s\S]*第 1 次壓縮後/);
  assert.equal(codexBodies(turns[0].additionalContext, GLOBAL_RULES_KEY, readGlobalRules(root).version).join(''), rules);
  assert.equal(codexBodies(turns[1].additionalContext, GLOBAL_RULES_KEY, readGlobalRules(root).version, 1).join(''), rules);
  assert.deepEqual(turns[1].input, [{type: 'text', text: '第二輪'}]);

  const starts = [];
  let onMessage;
  const claude = await openDiscussionSession({
    root,
    workspace: root,
    selection: {model: 'claude-opus-5-5'},
    claudeHost: async opts => {
      assert.equal(opts.commonMemoryInstructions, commonMemoryReference(root));
      onMessage = opts.onMessage;
      return {
        closed: new Promise(() => {}),
        async start(content) {
          starts.push(content);
          queueMicrotask(() => onMessage({type: 'result', subtype: 'success', result: 'ok'}));
        },
        async close() {}
      };
    }
  });
  await claude.ask('一');
  await claude.ask('二');
  await writeMemory(root, '- 討論假偏好丙');
  await writeRules(root, '- 討論全域規則更新');
  await claude.ask('三');
  onMessage({type: 'system', subtype: 'compact_boundary'});
  await claude.ask('四');
  assert.match(starts[0][0].text, /討論假偏好乙[\s\S]*<k_global_rules>[\s\S]*討論全域規則原文/);
  assert.deepEqual(starts[0][1], {type: 'text', text: '一'});
  assert.equal(starts[1], '二', 'unchanged memory is not stacked into history');
  assert.match(starts[2][0].text, /討論假偏好丙[\s\S]*討論全域規則更新/);
  assert.equal(starts[3][0].text, starts[2][0].text, 'compaction resends both sources');
});

test('Gemini discussion refreshes its native reference rule before each ask', async () => {
  const root = await privateRoot('- 假偏好');
  await writeRules(root, '- 假討論規則');
  const homes = [];
  const session = await openDiscussionSession({
    root,
    workspace: root,
    selection: {model: 'gemini-3.8-flash'},
    env: {...process.env, LOCALAPPDATA: path.join(root, 'local')},
    runGemini: async (exe, args, options) => {
      const directory = path.join(options.env.USERPROFILE, '.gemini/config/rules');
      const globalRule = path.join(directory, 'k-global-rules.md');
      if (homes.length) await assert.rejects(readFile(globalRule), {code: 'ENOENT'});
      else assert.ok((await readFile(globalRule, 'utf8')).includes(`@[K 跨模型全域工作規則](${globalRulesPath(root)})`));
      homes.push(await readFile(path.join(directory, 'k-common-memory.md'), 'utf8'));
      options.onChunk(JSON.stringify({event: 'init', conversation_id: 'g-1'}) + '\n');
      options.onChunk(JSON.stringify({event: 'result', result: {status: 'SUCCESS', response: 'ok'}}) + '\n');
      return {code: 0, stderr: ''};
    }
  });
  await session.ask('一');
  await rm(commonMemoryPath(root));
  await rm(globalRulesPath(root));
  await session.ask('二');
  await session.close();
  assert.match(homes[0], /@\[K 共同記憶\]/);
  assert.match(homes[1], /未啟用（檔案不存在/);
  assert.doesNotMatch(homes[1], /@\[/);
});

test('leaf and nested Claude workers send the memory block before the unchanged delegated task', async () => {
  const root = await privateRoot('- 工人假偏好');
  await writeRules(root, '- 工人假全域規則');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, {recursive: true});
  for (const mcpConfig of [undefined, {mcpServers: {k_luna: {}}}]) {
    let sent;
    const worker = createClaudeWorker({
      root,
      workspace,
      hostFactory: async opts => {
        assert.equal(opts.commonMemoryInstructions, commonMemoryReference(root));
        let done;
        const closed = new Promise(resolve => (done = resolve));
        return {
          models: [{model: 'claude-opus-5-5', supportedReasoningEfforts: [{reasoningEffort: 'low'}]}],
          closed,
          pid: 1,
          async start(content) {
            sent = content;
            done();
          },
          async interrupt() {},
          async close() {}
        };
      }
    });
    await worker.run({task: '合成任務', model: 'claude-opus-5-5', effort: 'low', mcpConfig});
    assert.match(sent[0].text, /^<k_common_memory>[\s\S]*工人假偏好/);
    assert.match(sent[0].text, /<k_global_rules>[\s\S]*工人假全域規則/);
    assert.match(sent[1].text, /<DELEGATED_TASK>\n合成任務\n<\/DELEGATED_TASK>$/);
    assert.match(sent[1].text, mcpConfig ? /小工人不能再派工/ : /不再派工/, 'worker depth rules are unchanged');
  }
});

test('Flash worker writes the reference rule into the runHome that agy actually uses', async () => {
  const root = await privateRoot('- Flash 假偏好');
  await writeRules(root, '- Flash 假全域規則');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, {recursive: true});
  const calls = [];
  const worker = createGeminiWorker({
    root,
    workspace,
    accessMode: 'read-only',
    env: {LOCALAPPDATA: path.join(root, 'local'), Path: 'fake', SystemRoot: 'C:/Windows'},
    gitStatus: async () => null,
    spawnImpl: (exe, args, options) => {
      const child = new EventEmitter();
      Object.assign(child, {pid: 50000 + calls.length, stdout: new PassThrough(), stderr: new PassThrough()});
      calls.push({args, options});
      queueMicrotask(() => {
        child.stdout.write(
          args[0] === 'models'
            ? 'gemini-3.8-flash-low\tFlash'
            : JSON.stringify({event: 'result', result: {status: 'SUCCESS', response: 'done'}}) + '\n'
        );
        child.emit('close', 0);
      });
      return child;
    }
  });
  await worker.run({task: '合成任務', effort: 'low'});
  const run = calls.find(call => call.args[0] === '-p');
  const directory = path.join(run.options.env.USERPROFILE, '.gemini/config/rules');
  const rule = await readFile(path.join(directory, 'k-common-memory.md'), 'utf8');
  const globalRule = await readFile(path.join(directory, 'k-global-rules.md'), 'utf8');
  assert.ok(rule.includes(`@[K 共同記憶](${commonMemoryPath(root)})`));
  assert.ok(globalRule.includes(`@[K 跨模型全域工作規則](${globalRulesPath(root)})`));
  assert.doesNotMatch(run.args[1], /Flash 假偏好|Flash 假全域規則/, 'no second copy in the prompt');
});
