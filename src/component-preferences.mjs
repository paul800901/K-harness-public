import path from 'node:path';
import {readFile, readdir, stat} from 'node:fs/promises';
import {atomicWrite} from './atomic-write.mjs';
import {componentIds, validateComponents} from '../shared/components.mjs';

async function ifPresent(operation, fallback) {
  try {
    return await operation;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function createComponentPreferences(root) {
  const directory = path.join(root, '.runtime');
  const file = path.join(directory, 'components.json');
  let value = null,
    readError = null;
  try {
    const saved = await ifPresent(readFile(file, 'utf8'), null);
    if (saved === null) {
      const legacy =
        (await ifPresent(stat(path.join(directory, 'sidebar-preferences.json')), null)) ||
        (await ifPresent(readdir(path.join(directory, 'main-sessions')), [])).some(name => name.endsWith('.json'));
      await atomicWrite(file, JSON.stringify({version: 1, mode: legacy ? 'all' : 'pending'}));
      if (legacy) value = componentIds;
    } else {
      const record = JSON.parse(saved);
      if (record.version !== 1 || !['chosen', 'all', 'pending'].includes(record.mode)) throw Error('Invalid selection');
      if (record.mode === 'chosen') value = validateComponents(record.selected);
      if (record.mode === 'all') value = componentIds;
    }
  } catch {
    readError = '元件設定無法讀取，已保留原檔，目前顯示全部功能。';
    value = componentIds;
  }
  let pending = Promise.resolve();
  return {
    get value() {
      return value;
    },
    get error() {
      return readError;
    },
    set(selection) {
      if (readError) throw Error(readError);
      const next = validateComponents(selection);
      pending = pending
        .catch(() => {})
        .then(async () => {
          await atomicWrite(file, JSON.stringify({version: 1, mode: 'chosen', selected: next}));
          value = next;
          return next;
        });
      return pending;
    }
  };
}
