import {lstat, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

/**
 * Read-only lookup of one key's *current* value in a closed or running LevelDB
 * database (Chrome extension storage), following LevelDB's own read path:
 * CURRENT -> MANIFEST -> the live tables and the logs not yet folded into them;
 * the entry with the highest sequence number wins and a deletion means absent.
 * Records Chrome has overwritten, deleted or left in obsolete files never count.
 *
 * It never writes, never takes the LOCK and never repairs. Anything it does not
 * fully understand (checksum mismatch, torn or unknown record, unknown manifest
 * tag, manifest without the metadata LevelDB itself requires, foreign
 * comparator, unknown compression, missing live table or log, table not matching
 * its manifest entry, oversize or linked file) throws LevelDbUnreadable, so
 * callers can refuse to act instead of guessing from stale bytes. Supported: the
 * LevelDB log/manifest format, table format with uncompressed or Snappy blocks
 * (what Chrome writes).
 *
 * Without the LOCK, a running Chrome may write while this reads; after reading,
 * the database's file list and the bytes of every file used are checked again,
 * and any change fails (the caller may simply try again). That detects a change
 * during the read; it is not a lock.
 */
export class LevelDbUnreadable extends Error {}

const MAX_FILE_BYTES = 1024 * 1024,
  LOG_BLOCK = 32768,
  LEVELS = 7, // config::kNumLevels
  MAX_SEQUENCE = (1n << 56n) - 1n,
  TABLE_MAGIC = 0xdb4775248b80fb57n,
  BYTEWISE = 'leveldb.BytewiseComparator';

const fail = reason => {
  throw new LevelDbUnreadable(reason);
};

const CRC_TABLE = new Uint32Array(256).map((_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
  return c >>> 0;
});
/** CRC-32C (Castagnoli), as LevelDB checksums records and blocks. */
export function crc32c(...parts) {
  let c = 0xffffffff;
  for (const part of parts) for (const byte of part) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** LevelDB stores checksums masked so data that embeds checksums stays distinct. */
export const maskCrc = crc => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;

class Cursor {
  constructor(buffer) {
    this.buffer = buffer;
    this.at = 0;
  }
  get done() {
    return this.at >= this.buffer.length;
  }
  byte() {
    if (this.done) fail('truncated');
    return this.buffer[this.at++];
  }
  int() {
    let value = 0;
    for (let shift = 0; shift < 50; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    fail('varint');
  }
  /** A varint64 as BigInt (sequence numbers). */
  bigint() {
    let value = 0n;
    for (let shift = 0n; shift < 64n; shift += 7n) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
    }
    fail('varint');
  }
  bytes(length) {
    if (length > this.buffer.length - this.at) fail('truncated');
    return this.buffer.subarray(this.at, (this.at += length));
  }
  slice() {
    return this.bytes(this.int());
  }
  level() {
    const level = this.int();
    if (level >= LEVELS) fail('manifest level');
    return level;
  }
  internalKey() {
    // LevelDB rejects an empty one; a real one always has its 8-byte trailer.
    if (this.slice().length < 8) fail('manifest key');
  }
}

/** Whole records of a LevelDB log file (also the MANIFEST format). */
function logRecords(file) {
  const records = [];
  let pending;
  for (let at = 0; at < file.length;) {
    const left = LOG_BLOCK - (at % LOG_BLOCK);
    if (left < 7 || file.length - at < 7) {
      // Block trailer, or the end of the file: zeros only. Anything else is a
      // record still being written (or torn by a crash): not a known state.
      if (file.subarray(at, Math.min(at + left, file.length)).some(Boolean)) fail('torn record');
      at += left;
      continue;
    }
    const checksum = file.readUInt32LE(at),
      length = file.readUInt16LE(at + 4),
      type = file[at + 6];
    if (type === 0 && length === 0 && checksum === 0) {
      // Zero-filled space LevelDB skips to the next block.
      if (file.subarray(at, Math.min(at + left, file.length)).some(Boolean)) fail('bad record');
      at += left;
      continue;
    }
    if (length > left - 7 || at + 7 + length > file.length) fail('torn record');
    const data = file.subarray(at + 7, at + 7 + length);
    if (maskCrc(crc32c(file.subarray(at + 6, at + 7), data)) !== checksum) fail('record checksum');
    at += 7 + length;
    if (type === 1 && !pending) records.push(data);
    else if (type === 2 && !pending) pending = [data];
    else if (type === 3 && pending) pending.push(data);
    else if (type === 4 && pending) {
      records.push(Buffer.concat([...pending, data]));
      pending = undefined;
    } else fail('record type');
  }
  if (pending) fail('torn record');
  return records;
}

/**
 * Applies MANIFEST version edits the way LevelDB's VersionEdit::DecodeFrom and
 * VersionSet::Recover do, including their checks: levels below kNumLevels,
 * non-empty keys, and next file number, log number and last sequence all present
 * (LevelDB reports Corruption otherwise).
 */
function liveVersion(records) {
  let comparator, logNumber, prevLogNumber, nextFile, lastSequence;
  const tables = new Map();
  for (const record of records) {
    const edit = new Cursor(record),
      deleted = [],
      added = [];
    while (!edit.done) {
      switch (edit.int()) {
        case 1:
          comparator = edit.slice().toString('latin1');
          break;
        case 2:
          logNumber = edit.int();
          break;
        case 3:
          nextFile = edit.int();
          break;
        case 4:
          lastSequence = edit.bigint();
          break;
        case 5: // compaction pointer
          edit.level();
          edit.internalKey();
          break;
        case 6:
          deleted.push(`${edit.level()}:${edit.int()}`);
          break;
        case 7: {
          const level = edit.level(),
            number = edit.int(),
            size = edit.int();
          edit.internalKey();
          edit.internalKey();
          added.push([`${level}:${number}`, {number, size}]);
          break;
        }
        case 9:
          prevLogNumber = edit.int();
          break;
        default:
          fail('manifest tag');
      }
    }
    for (const key of deleted) tables.delete(key);
    for (const [key, table] of added) tables.set(key, table);
  }
  if (comparator !== BYTEWISE) fail('comparator');
  if (nextFile === undefined) fail('manifest without next file number');
  if (logNumber === undefined) fail('manifest without log number');
  if (lastSequence === undefined) fail('manifest without last sequence');
  if (lastSequence > MAX_SEQUENCE) fail('last sequence');
  // A table's number is taken from the counter before the edit recording the
  // table saves the counter, so a live table at or past it is not a state
  // LevelDB writes.
  const live = [...tables.values()];
  if (live.some(table => table.number >= nextFile)) fail('table number');
  if (new Set(live.map(table => table.number)).size !== live.length) fail('table in two levels');
  return {logNumber, prevLogNumber: prevLogNumber ?? 0, lastSequence, tables: live};
}

/** Raw Snappy block decompression. */
function snappy(input) {
  const source = new Cursor(input),
    size = source.int();
  if (size > MAX_FILE_BYTES * 8) fail('block size');
  const out = Buffer.alloc(size);
  let at = 0;
  while (!source.done) {
    const tag = source.byte();
    let length, offset;
    switch (tag & 3) {
      case 0: {
        length = tag >>> 2;
        if (length >= 60) {
          const bytes = length - 59;
          length = 0;
          for (let i = 0; i < bytes; i++) length += source.byte() * 2 ** (8 * i);
        }
        length += 1;
        if (at + length > size) fail('snappy literal');
        source.bytes(length).copy(out, at);
        at += length;
        continue;
      }
      case 1:
        length = 4 + ((tag >>> 2) & 7);
        offset = ((tag >>> 5) << 8) | source.byte();
        break;
      case 2:
        length = (tag >>> 2) + 1;
        offset = source.byte() | (source.byte() << 8);
        break;
      default:
        length = (tag >>> 2) + 1;
        offset = (source.byte() | (source.byte() << 8) | (source.byte() << 16) | (source.byte() << 24)) >>> 0;
    }
    if (!offset || offset > at || at + length > size) fail('snappy copy');
    for (let i = 0; i < length; i++, at++) out[at] = out[at - offset];
  }
  if (at !== size) fail('snappy size');
  return out;
}

function tableBlock(file, handle) {
  const offset = handle.int(),
    size = handle.int();
  if (offset + size + 5 > file.length - 48) fail('block handle');
  const end = offset + size;
  if (maskCrc(crc32c(file.subarray(offset, end + 1))) !== file.readUInt32LE(end + 1)) fail('block checksum');
  const type = file[end];
  if (type === 0) return file.subarray(offset, end);
  if (type === 1) return snappy(file.subarray(offset, end));
  fail('block compression');
}

function blockEntries(block, visit) {
  if (block.length < 4) fail('block');
  const restarts = block.readUInt32LE(block.length - 4),
    end = block.length - 4 - restarts * 4;
  if (restarts < 1 || end < 0) fail('block restarts');
  const entries = new Cursor(block.subarray(0, end));
  let key = Buffer.alloc(0);
  while (!entries.done) {
    const shared = entries.int(),
      unshared = entries.int(),
      valueLength = entries.int();
    if (shared > key.length) fail('block key');
    key = Buffer.concat([key.subarray(0, shared), entries.bytes(unshared)]);
    visit(key, entries.bytes(valueLength));
  }
}

function tableEntries(file, size, lastSequence, visit) {
  // LevelDB opens a table at the size its manifest entry records.
  if (file.length !== size) fail('table size');
  if (file.length < 48 || file.readBigUInt64LE(file.length - 8) !== TABLE_MAGIC) fail('table footer');
  const footer = new Cursor(file.subarray(file.length - 48, file.length - 8));
  footer.int(); // metaindex (filters only speed up lookups; every entry is read)
  footer.int();
  blockEntries(tableBlock(file, footer), (_, handle) =>
    blockEntries(tableBlock(file, new Cursor(handle)), (internalKey, value) => {
      if (internalKey.length < 8) fail('internal key');
      const trailer = internalKey.readBigUInt64LE(internalKey.length - 8),
        type = Number(trailer & 0xffn);
      if (type > 1) fail('entry type');
      // A table is written before the edit that records it saves the last
      // sequence, so nothing in a live table is newer than that sequence.
      if (trailer >> 8n > lastSequence) fail('table entry newer than manifest');
      visit(internalKey.subarray(0, -8), trailer >> 8n, type ? value : undefined);
    })
  );
}

function batchEntries(batch, visit) {
  if (batch.length < 12) fail('batch');
  let sequence = batch.readBigUInt64LE(0);
  const count = batch.readUInt32LE(8),
    entries = new Cursor(batch.subarray(12));
  if (sequence + BigInt(count) - 1n > MAX_SEQUENCE) fail('batch sequence');
  for (let i = 0; i < count; i++, sequence++) {
    const type = entries.byte();
    if (type > 1) fail('batch entry type');
    const key = entries.slice();
    visit(key, sequence, type ? entries.slice() : undefined);
  }
  if (!entries.done) fail('batch count');
}

async function readSmall(files, file) {
  const info = await files.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) fail('unsafe file');
  return files.readFile(file);
}

// The files LevelDB's read path can use; LOCK, LOG and temporary files are not.
const SOURCE = /^(?:CURRENT|MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/;
const sourceNames = async (files, directory) =>
  (await files.readdir(directory)).filter(name => SOURCE.test(name)).sort();
const fileName = (number, extension) => `${String(number).padStart(6, '0')}.${extension}`;

async function currentValue(names, load, key) {
  if (!names.includes('CURRENT')) {
    // No database yet. Leftover data files without CURRENT would be replayed by
    // LevelDB on its next open, so they are not "empty".
    if (names.length) fail('data without CURRENT');
    return undefined;
  }
  const manifest = /^(MANIFEST-\d+)\n$/.exec((await load('CURRENT')).toString('latin1'))?.[1] ?? fail('CURRENT');
  if (!names.includes(manifest)) fail('missing manifest');
  const version = liveVersion(logRecords(await load(manifest)));
  // LevelDB creates a log before an edit records its number and deletes it only
  // after a later edit raises the number, so a recorded log that is missing
  // means lost writes; LevelDB itself would silently skip it, this refuses.
  // Number 0 is NewDB's placeholder: no such file is ever created.
  for (const number of [version.logNumber, version.prevLogNumber])
    if (number && !names.includes(fileName(number, 'log'))) fail('missing live log');
  let best;
  const consider = (userKey, sequence, value) => {
    if (!userKey.equals(key)) return;
    if (best && best.sequence === sequence) fail('duplicate sequence');
    if (!best || sequence > best.sequence) best = {sequence, value};
  };
  for (const name of names) {
    const number = /^(\d+)\.log$/.exec(name)?.[1];
    if (number === undefined || (Number(number) < version.logNumber && Number(number) !== version.prevLogNumber))
      continue;
    for (const batch of logRecords(await load(name))) batchEntries(batch, consider);
  }
  for (const {number, size} of version.tables) {
    const name =
      [fileName(number, 'ldb'), fileName(number, 'sst')].find(candidate => names.includes(candidate)) ??
      fail('missing live table');
    tableEntries(await load(name), size, version.lastSequence, consider);
  }
  return best?.value;
}

/**
 * Current value (Buffer) of `key` in the LevelDB at `directory`, or undefined
 * when the key is absent or deleted, or the folder holds no database. A change
 * to the database while it is read throws LevelDbUnreadable. `files` (lstat,
 * readdir, readFile) lets tests change the database in the middle of a read.
 */
export async function readLevelDbValue(directory, key, files = {lstat, readdir, readFile}) {
  const names = await sourceNames(files, directory),
    used = new Map();
  const read = async name => {
    try {
      return await readSmall(files, path.join(directory, name));
    } catch (error) {
      if (error.code === 'ENOENT') fail('changed while reading');
      throw error;
    }
  };
  const value = await currentValue(
    names,
    async name => {
      const contents = await read(name);
      used.set(name, contents);
      return contents;
    },
    key
  );
  // Same files, same bytes as when the read began: the value comes from one
  // state of the database, not a mix of before and after a write.
  if ((await sourceNames(files, directory)).join('/') !== names.join('/')) fail('changed while reading');
  for (const [name, contents] of used) if (!(await read(name)).equals(contents)) fail('changed while reading');
  return value;
}
