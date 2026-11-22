import {lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Test scratch is removed when the process exits cleanly and kept after a failure.
export const scratchBase = path.join(
  fileURLToPath(new URL('../.runtime/tests/', import.meta.url)),
  `run-${process.pid}-${Date.now()}`
);
mkdirSync(scratchBase, {recursive: true});
const scratchDirectories = new Set([scratchBase]);

// A live probe may need an independent volume without reusing an existing folder.
export function createTemporaryScratch() {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'k-harness-test-'));
  scratchDirectories.add(directory);
  return directory;
}

process.on('exit', code => {
  if (code || process.exitCode) return;
  for (const directory of scratchDirectories) recycleScratch(directory);
});

function recycleScratch(directory) {
  try {
    if (!lstatSync(directory).isDirectory()) return;
    if (process.platform === 'win32') {
      if (realpathSync(directory).toLowerCase() !== path.resolve(directory).toLowerCase()) return;
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
            '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:K_TEST_SCRATCH, "OnlyErrorDialogs", "SendToRecycleBin"); ' +
            'if (Test-Path -LiteralPath $env:K_TEST_SCRATCH) { exit 1 }'
        ],
        {env: {...process.env, K_TEST_SCRATCH: directory}, windowsHide: true, stdio: 'ignore'}
      );
      if (result.status !== 0) console.warn(`測試暫存保留，未確認移入回收筒：${directory}`);
    } else rmSync(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  } catch {
    /* A lingering child handle only leaves this run's folder. */
  }
}
