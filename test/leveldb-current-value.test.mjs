import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile, lstat, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {scratchBase} from './scratch.mjs';
import {LevelDbUnreadable, crc32c, readLevelDbValue} from '../src/leveldb-current-value.mjs';
import {
  batch,
  freshManifest,
  logFile,
  snappyCompress,
  tableFile,
  versionEdit,
  writeLevelDb
} from './leveldb-fixture.mjs';

const KEY = Buffer.from('kProfileId'),
  A = JSON.stringify('a'.repeat(32)),
  B = JSON.stringify('b'.repeat(32)),
  C = JSON.stringify('c'.repeat(32)),
  BYTEWISE = 'leveldb.BytewiseComparator';
let n = 0;
const folder = () => path.join(scratchBase, `leveldb-${n++}`);
const read = async directory => (await readLevelDbValue(directory, KEY))?.toString();
const manifest = (...edits) => logFile(edits.map(versionEdit));
// Fills in each added table's real size from the files that will be written.
const sized = (files, ...edits) =>
  edits.map(edit => ({
    ...edit,
    added: (edit.added ?? []).map(table => {
      const base = String(table.number).padStart(6, '0');
      return {size: (files[`${base}.ldb`] ?? files[`${base}.sst`])?.length, ...table};
    })
  }));
const unreadable = reason => error => error instanceof LevelDbUnreadable && error.message === reason;

test('CRC-32C matches the published check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
});

test('the fixture writes the same bytes as K Chrome storage on disk (66-byte log, 41-byte manifest)', async () => {
  assert.equal(freshManifest().length, 41);
  assert.equal(logFile([batch(1, [{key: 'kProfileId', value: A}])]).length, 66);
});

test('the latest write wins inside the log; an overwritten identity is not current', async () => {
  const directory = folder();
  // The reviewer's case: sequence 1 kProfileId=A, sequence 2 the same key = B.
  await writeLevelDb(directory, {
    'MANIFEST-000001': freshManifest(),
    '000003.log': logFile([batch(1, [{key: 'kProfileId', value: A}]), batch(2, [{key: 'kProfileId', value: B}])])
  });
  assert.equal(await read(directory), B);
});

test('a cleared identity is absent, and a rebuilt one replaces it', async () => {
  const cleared = folder(),
    rebuilt = folder();
  const records = [batch(1, [{key: 'kProfileId', value: A}]), batch(2, [{key: 'kProfileId'}])];
  await writeLevelDb(cleared, {'MANIFEST-000001': freshManifest(), '000003.log': logFile(records)});
  assert.equal(await read(cleared), undefined);
  await writeLevelDb(rebuilt, {
    'MANIFEST-000001': freshManifest(),
    '000003.log': logFile([
      ...records,
      batch(3, [
        {key: 'other', value: '1'},
        {key: 'kProfileId', value: C}
      ])
    ])
  });
  assert.equal(await read(rebuilt), C);
});

test('tables, plain or Snappy-compressed, are read, and newer log writes override them', async () => {
  for (const compression of [0, 1]) {
    const directory = folder();
    const files = {
      '000005.ldb': tableFile(
        [
          {key: 'aaa', sequence: 1, value: 'x'.repeat(40)},
          {key: 'kProfileId', sequence: 2, value: A},
          {key: 'kProfileIdx', sequence: 3, value: B},
          {key: 'zzz', sequence: 4, value: 'x'.repeat(40)}
        ],
        {compression}
      ),
      '000007.log': logFile([batch(5, [{key: 'other', value: '1'}])])
    };
    files['MANIFEST-000004'] = manifest(
      ...sized(files, {
        comparator: BYTEWISE,
        logNumber: 7,
        nextFile: 8,
        lastSequence: 4,
        added: [{level: 0, number: 5}]
      })
    );
    await writeLevelDb(directory, files, 'MANIFEST-000004');
    assert.equal(await read(directory), A, `compression ${compression}`);
    await writeFile(path.join(directory, '000007.log'), logFile([batch(5, [{key: 'kProfileId', value: B}])]));
    assert.equal(await read(directory), B);
    await writeFile(path.join(directory, '000007.log'), logFile([batch(5, [{key: 'kProfileId'}])]));
    assert.equal(await read(directory), undefined);
  }
  assert.ok(snappyCompress(Buffer.from('x'.repeat(40))).length < 20, 'the fixture really compresses');
});

test('only live files count: obsolete logs and tables deleted by the manifest are ignored', async () => {
  const directory = folder();
  const files = {
    // Left behind by a crash; even with a higher sequence they are not current.
    '000003.log': logFile([batch(30, [{key: 'kProfileId', value: C}])]),
    '000004.ldb': tableFile([{key: 'kProfileId', sequence: 3, value: C}]),
    '000005.ldb': tableFile([{key: 'kProfileId', sequence: 2, value: A}]),
    '000008.log': logFile([])
  };
  files['MANIFEST-000009'] = manifest(
    ...sized(
      files,
      {comparator: BYTEWISE, logNumber: 3, nextFile: 4, lastSequence: 0},
      {
        logNumber: 6,
        nextFile: 7,
        lastSequence: 3,
        added: [
          {level: 0, number: 4},
          {level: 0, number: 5}
        ]
      },
      // Compaction: table 4 is gone, table 5 moves to level 1 (same number).
      {
        logNumber: 8,
        nextFile: 9,
        lastSequence: 3,
        deleted: [
          {level: 0, number: 4},
          {level: 0, number: 5}
        ],
        added: [{level: 1, number: 5}]
      }
    )
  );
  await writeLevelDb(directory, files, 'MANIFEST-000009');
  assert.equal(await read(directory), A);
  // A live table of the legacy .sst name is read too (same size, other value).
  await rm(path.join(directory, '000005.ldb'));
  await writeFile(path.join(directory, '000005.sst'), tableFile([{key: 'kProfileId', sequence: 2, value: B}]));
  assert.equal(await read(directory), B);
});

test('a record spanning several 32 KiB log blocks is reassembled', async () => {
  const directory = folder(),
    big = 'y'.repeat(70000);
  await writeLevelDb(directory, {
    'MANIFEST-000001': freshManifest(),
    '000003.log': logFile([
      batch(1, [{key: 'kProfileId', value: A}]),
      batch(2, [{key: 'big', value: big}]),
      batch(3, [{key: 'kProfileId', value: B}])
    ])
  });
  assert.equal(await read(directory), B);
});

test('no database yet means no identity; leftover data without CURRENT is not guessed', async () => {
  const empty = folder();
  await mkdir(empty, {recursive: true});
  assert.equal(await read(empty), undefined);
  const orphan = folder();
  await writeLevelDb(orphan, {'000003.log': logFile([batch(1, [{key: 'kProfileId', value: A}])])}, null);
  await assert.rejects(read(orphan), unreadable('data without CURRENT'));
});

test('a recorded log that is missing is refused instead of answering from an older table', async () => {
  // Reviewer's case: MANIFEST log number 7, live table 5 holds A, 000007.log is gone
  // (it may have held a later B). LevelDB itself would skip the missing log.
  const directory = folder();
  const files = {'000005.ldb': tableFile([{key: 'kProfileId', sequence: 2, value: A}])};
  files['MANIFEST-000004'] = manifest(
    ...sized(files, {comparator: BYTEWISE, logNumber: 7, nextFile: 8, lastSequence: 2, added: [{level: 0, number: 5}]})
  );
  await writeLevelDb(directory, files, 'MANIFEST-000004');
  await assert.rejects(read(directory), unreadable('missing live log'));
  await writeFile(path.join(directory, '000007.log'), logFile([]));
  assert.equal(await read(directory), A);
  // NewDB's log number 0 names no file; Chrome's fresh stores live in 000003.log.
  const fresh = folder();
  await writeLevelDb(fresh, {'MANIFEST-000001': freshManifest(), '000003.log': logFile([])});
  assert.equal(await read(fresh), undefined);
});

test('a manifest missing what VersionSet::Recover requires, or out of its ranges, is refused', async () => {
  const log = logFile([batch(1, [{key: 'kProfileId', value: A}])]),
    table = tableFile([{key: 'kProfileId', sequence: 1, value: A}]),
    full = {comparator: BYTEWISE, logNumber: 3, nextFile: 4, lastSequence: 1};
  const cases = [
    // Reviewer's case: only the comparator and log number.
    ['manifest without next file number', {comparator: BYTEWISE, logNumber: 3}],
    ['manifest without last sequence', {comparator: BYTEWISE, logNumber: 3, nextFile: 4}],
    ['manifest without log number', {comparator: BYTEWISE, nextFile: 4, lastSequence: 1}],
    ['table number', {...full, added: [{level: 0, number: 4, size: table.length}]}],
    ['manifest level', {...full, added: [{level: 7, number: 2, size: table.length}]}],
    ['manifest key', {...full, added: [{level: 0, number: 2, size: table.length, smallest: 'a'}]}],
    ['table size', {...full, added: [{level: 0, number: 2, size: table.length + 1}]}],
    ['table entry newer than manifest', {...full, lastSequence: 0, added: [{level: 0, number: 2, size: table.length}]}],
    [
      'table in two levels',
      {
        ...full,
        added: [
          {level: 0, number: 2, size: table.length},
          {level: 1, number: 2, size: table.length}
        ]
      }
    ]
  ];
  for (const [reason, edit] of cases) {
    const directory = folder();
    await writeLevelDb(directory, {'MANIFEST-000001': manifest(edit), '000002.ldb': table, '000003.log': log});
    await assert.rejects(read(directory), unreadable(reason), reason);
  }
  // The same table with consistent metadata is read.
  const directory = folder();
  await writeLevelDb(directory, {
    'MANIFEST-000001': manifest({...full, added: [{level: 0, number: 2, size: table.length}]}),
    '000002.ldb': table,
    '000003.log': logFile([])
  });
  assert.equal(await read(directory), A);
});

test('a database that changes while being read is refused, and the next read sees the new state', async () => {
  // Reviewer's case: the file list is taken, then Chrome starts 000004.log with B.
  const directory = folder();
  await writeLevelDb(directory, {
    'MANIFEST-000001': freshManifest(),
    '000003.log': logFile([batch(1, [{key: 'kProfileId', value: A}])])
  });
  // `change` runs after each file read until it reports that it changed something.
  let change;
  const files = {
    lstat,
    readdir,
    readFile: async file => {
      const contents = await readFile(file);
      if (await change?.(path.basename(file))) change = undefined;
      return contents;
    }
  };
  const write = (name, contents) => writeFile(path.join(directory, name), contents).then(() => true);
  change = async name =>
    name === '000003.log' && write('000004.log', logFile([batch(2, [{key: 'kProfileId', value: B}])]));
  await assert.rejects(readLevelDbValue(directory, KEY, files), unreadable('changed while reading'));
  assert.equal(await read(directory), B);
  // A write appended to a log already read.
  change = async name =>
    name === '000004.log' &&
    appendFile(path.join(directory, name), logFile([batch(3, [{key: 'kProfileId', value: C}])])).then(() => true);
  await assert.rejects(readLevelDbValue(directory, KEY, files), unreadable('changed while reading'));
  assert.equal(await read(directory), C);
  // CURRENT switching to a new manifest after it was read.
  change = async name =>
    name === 'CURRENT' && (await write('MANIFEST-000005', freshManifest())) && write('CURRENT', 'MANIFEST-000005\n');
  await assert.rejects(readLevelDbValue(directory, KEY, files), unreadable('changed while reading'));
  assert.equal(await read(directory), C);
});

test('anything not fully understood fails closed instead of returning a stale value', async () => {
  const good = logFile([batch(1, [{key: 'kProfileId', value: A}]), batch(2, [{key: 'kProfileId', value: B}])]),
    meta = {comparator: BYTEWISE, logNumber: 3, nextFile: 4, lastSequence: 2},
    unsupported = tableFile([{key: 'kProfileId', sequence: 1, value: A}], {compression: 2});
  const cases = {
    'record checksum': {'MANIFEST-000001': freshManifest(), '000003.log': Buffer.from(good).fill(0x41, 100, 101)},
    'torn record': {'MANIFEST-000001': freshManifest(), '000003.log': good.subarray(0, good.length - 5)},
    comparator: {'MANIFEST-000001': manifest({...meta, comparator: 'other'}), '000003.log': good},
    'manifest tag': {'MANIFEST-000001': manifest({...meta, extra: [Buffer.from([8, 0])]}), '000003.log': good},
    'missing live table': {
      'MANIFEST-000001': manifest({...meta, added: [{level: 0, number: 2, size: 100}]}),
      '000003.log': good
    },
    'block compression': {
      'MANIFEST-000001': manifest({...meta, added: [{level: 0, number: 2, size: unsupported.length}]}),
      '000002.ldb': unsupported,
      '000003.log': logFile([])
    }
  };
  for (const [reason, files] of Object.entries(cases)) {
    const directory = folder();
    await writeLevelDb(directory, files);
    await assert.rejects(read(directory), unreadable(reason), reason);
  }
  // A damaged table block checksum.
  const directory = folder(),
    table = tableFile([{key: 'kProfileId', sequence: 1, value: A}]);
  table[3] ^= 1;
  await writeLevelDb(directory, {
    'MANIFEST-000001': manifest({...meta, added: [{level: 0, number: 2, size: table.length}]}),
    '000002.ldb': table,
    '000003.log': logFile([])
  });
  await assert.rejects(read(directory), unreadable('block checksum'));
  // An oversize file is not read at all.
  const huge = folder();
  await writeLevelDb(huge, {'MANIFEST-000001': freshManifest(), '000003.log': Buffer.alloc(1024 * 1024 + 1)});
  await assert.rejects(read(huge), unreadable('unsafe file'));
  assert.ok((await readFile(path.join(huge, 'CURRENT'), 'utf8')).startsWith('MANIFEST-'));
});

// Written by a real Chromium 149 (see docs/k-chrome-target-profile-20261114.md):
// a test extension's storage after kProfileId = A was compacted into a table
// (plain block), overwritten by B and compacted again (Snappy block), deleted and
// compacted (tombstone), then set to C (log). Live files only, gzipped JSON.
test('storage written by a real Chromium reads back only its current identity', async () => {
  const bundle = JSON.parse(
    gunzipSync(await readFile(new URL('./fixtures/chromium-extension-storage.json.gz', import.meta.url)))
  );
  const files = Object.fromEntries(
    Object.entries(bundle.files).map(([name, data]) => [name, Buffer.from(data, 'base64')])
  );
  const directory = folder();
  await writeLevelDb(directory, files, null);
  const {current, previous} = bundle.expected;
  assert.equal(await read(directory), JSON.stringify(current));
  for (const old of previous) assert.notEqual(await read(directory), JSON.stringify(old));
  // Its MANIFEST records a real log number (C lives in that log); without the log
  // the answer would come from the older tables, so it is refused.
  const log = Object.keys(files).find(name => name.endsWith('.log'));
  await rm(path.join(directory, log));
  await assert.rejects(read(directory), unreadable('missing live log'));
});
