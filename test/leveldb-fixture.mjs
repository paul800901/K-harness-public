// Writes real LevelDB files (log, MANIFEST, table) for tests, in the on-disk
// format Chrome's LevelDB writes, with masked CRC-32C checksums.
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {crc32c, maskCrc} from '../src/leveldb-current-value.mjs';

const BLOCK = 32768;
const bytes = value => (Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1'));

export function varint(value) {
  const out = [];
  let n = BigInt(value);
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}
const slice = value => Buffer.concat([varint(bytes(value).length), bytes(value)]);

/** A log file: each record is fragmented across 32 KiB blocks like LevelDB does. */
export function logFile(records) {
  const parts = [];
  let offset = 0;
  for (const record of records) {
    let left = record,
      first = true;
    do {
      const room = BLOCK - (offset % BLOCK);
      if (room < 7) {
        parts.push(Buffer.alloc(room));
        offset += room;
        continue;
      }
      const fragment = left.subarray(0, room - 7),
        last = fragment.length === left.length,
        type = first && last ? 1 : first ? 2 : last ? 4 : 3,
        header = Buffer.alloc(7);
      header.writeUInt16LE(fragment.length, 4);
      header[6] = type;
      header.writeUInt32LE(maskCrc(crc32c(Buffer.from([type]), fragment)), 0);
      parts.push(header, fragment);
      offset += 7 + fragment.length;
      left = left.subarray(fragment.length);
      first = false;
      if (last) break;
    } while (true);
  }
  return Buffer.concat(parts);
}

/** A write batch: entries [{key, value}] with value undefined meaning deletion. */
export function batch(sequence, entries) {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(sequence), 0);
  head.writeUInt32LE(entries.length, 8);
  return Buffer.concat([
    head,
    ...entries.map(({key, value}) =>
      value === undefined
        ? Buffer.concat([Buffer.from([0]), slice(key)])
        : Buffer.concat([Buffer.from([1]), slice(key), slice(value)])
    )
  ]);
}

const internalKey = (key, sequence, deleted) => {
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64LE((BigInt(sequence) << 8n) | (deleted ? 0n : 1n));
  return Buffer.concat([bytes(key), trailer]);
};

/** One MANIFEST version edit; added tables need their real file size. */
export function versionEdit({
  comparator,
  logNumber,
  prevLogNumber,
  nextFile,
  lastSequence,
  deleted = [],
  added = [],
  extra = []
}) {
  const parts = [];
  if (comparator !== undefined) parts.push(varint(1), slice(comparator));
  if (logNumber !== undefined) parts.push(varint(2), varint(logNumber));
  if (prevLogNumber !== undefined) parts.push(varint(9), varint(prevLogNumber));
  if (nextFile !== undefined) parts.push(varint(3), varint(nextFile));
  if (lastSequence !== undefined) parts.push(varint(4), varint(lastSequence));
  for (const {level, number} of deleted) parts.push(varint(6), varint(level), varint(number));
  for (const {level, number, size, smallest = internalKey('a', 1), largest = internalKey('z', 1)} of added)
    parts.push(varint(7), varint(level), varint(number), varint(size), slice(smallest), slice(largest));
  parts.push(...extra);
  return Buffer.concat(parts);
}

// Prefix-compressed block with a restart every `interval` entries.
function block(entries, interval = 16) {
  const parts = [],
    restarts = [];
  let previous = Buffer.alloc(0),
    size = 0;
  entries.forEach(([key, value], i) => {
    let shared = 0;
    if (i % interval === 0) restarts.push(size);
    else while (shared < previous.length && shared < key.length && previous[shared] === key[shared]) shared++;
    const entry = Buffer.concat([
      varint(shared),
      varint(key.length - shared),
      varint(value.length),
      key.subarray(shared),
      value
    ]);
    parts.push(entry);
    size += entry.length;
    previous = key;
  });
  if (!restarts.length) restarts.push(0);
  const tail = Buffer.alloc(4 * restarts.length + 4);
  restarts.forEach((offset, i) => tail.writeUInt32LE(offset, 4 * i));
  tail.writeUInt32LE(restarts.length, 4 * restarts.length);
  return Buffer.concat([...parts, tail]);
}

/** Minimal raw Snappy encoder (literals plus 1/2-byte-offset copies). */
export function snappyCompress(input) {
  const out = [varint(input.length)];
  const literal = data => {
    for (let at = 0; at < data.length; at += 60) {
      const chunk = data.subarray(at, at + 60);
      out.push(Buffer.from([(chunk.length - 1) << 2]), chunk);
    }
  };
  let at = 0,
    start = 0;
  while (at < input.length) {
    let best = 0,
      offset = 0;
    for (let from = Math.max(0, at - 2047); from < at; from++) {
      let length = 0;
      while (at + length < input.length && length < 64 && input[from + length] === input[at + length]) length++;
      if (length > best) [best, offset] = [length, at - from];
    }
    if (best < 4) {
      at++;
      continue;
    }
    literal(input.subarray(start, at));
    if (best <= 11 && offset < 2048)
      out.push(Buffer.from([1 | ((best - 4) << 2) | ((offset >> 8) << 5), offset & 0xff]));
    else out.push(Buffer.from([2 | ((best - 1) << 2), offset & 0xff, offset >> 8]));
    at += best;
    start = at;
  }
  literal(input.subarray(start));
  return Buffer.concat(out);
}

/**
 * A table file holding entries [{key, sequence, value}] (value undefined =
 * deletion) in LevelDB internal-key order; `compression`: 0 none, 1 Snappy, or
 * any other byte to model an unsupported codec.
 */
export function tableFile(entries, {compression = 0} = {}) {
  const sorted = entries
    .map(({key, sequence, value}) => [internalKey(key, sequence, value === undefined), bytes(value ?? '')])
    .sort(([a], [b]) => {
      const byKey = Buffer.compare(a.subarray(0, -8), b.subarray(0, -8));
      if (byKey) return byKey;
      const [x, y] = [a, b].map(key => key.readBigUInt64LE(key.length - 8));
      return x > y ? -1 : x < y ? 1 : 0; // newer sequence first
    });
  const parts = [];
  let offset = 0;
  const put = (contents, type = 0) => {
    const stored = type === 1 ? snappyCompress(contents) : contents,
      trailer = Buffer.alloc(5);
    trailer[0] = type;
    trailer.writeUInt32LE(maskCrc(crc32c(stored, trailer.subarray(0, 1))), 1);
    const handle = Buffer.concat([varint(offset), varint(stored.length)]);
    parts.push(stored, trailer);
    offset += stored.length + 5;
    return handle;
  };
  const data = put(block(sorted, 2), compression),
    meta = put(block([])),
    index = put(block([[sorted.at(-1)[0], data]], 1)),
    footer = Buffer.alloc(48);
  Buffer.concat([meta, index]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([...parts, footer]);
}

/** Writes a LevelDB folder: files maps name -> Buffer; CURRENT names the manifest. */
export async function writeLevelDb(directory, files, manifest = 'MANIFEST-000001') {
  await mkdir(directory, {recursive: true});
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(directory, name), contents);
  if (manifest) await writeFile(path.join(directory, 'CURRENT'), `${manifest}\n`);
  await writeFile(path.join(directory, 'LOCK'), '');
}

// What a fresh Chrome extension storage looks like (and what K's real stores
// were on 2026-11-14): NewDB's manifest (log number 0) plus a reused 000003.log.
export const freshManifest = () =>
  logFile([versionEdit({comparator: 'leveldb.BytewiseComparator', logNumber: 0, nextFile: 2, lastSequence: 0})]);
export const identityValue = profileId => JSON.stringify(profileId);
