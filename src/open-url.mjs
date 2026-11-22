import {spawn} from 'node:child_process';

// Same opener the official Claude CLI uses; only a validated official URL is passed.
export const openInDefaultBrowser = url =>
  new Promise((resolve, reject) => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
