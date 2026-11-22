import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {atomicWrite} from './atomic-write.mjs';

export async function createFollowUpPreference(root) {
  const file = path.join(root, '.runtime', 'follow-up-mode');
  let mode = 'queue',
    pending = Promise.resolve();
  try {
    if ((await readFile(file, 'utf8')) === 'steer') mode = 'steer';
  } catch {
    // Keep K usable if the preference is missing or unreadable. An explicit change still has to save successfully.
  }
  return {
    get mode() {
      return mode;
    },
    async set(value) {
      if (value !== 'queue' && value !== 'steer') throw Error('後續訊息處理方式無效。');
      const task = pending
        .catch(() => {})
        .then(async () => {
          await atomicWrite(file, value);
          mode = value;
          return mode;
        });
      pending = task;
      return task;
    }
  };
}
