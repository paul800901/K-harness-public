// npm test: the unit tests, without the live-core pointers a K room passes down (see test-env.mjs).
import {spawnSync} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {fileURLToPath} from 'node:url';
import {testEnvironment} from './test-env.mjs';

// The Windows installer runs the suite alongside the user's other applications.
// Limit simultaneous native-process and loopback fixtures on high-core-count PCs.
const concurrency = Math.min(4, availableParallelism());
const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, 'test/*.test.mjs', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
  env: testEnvironment()
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
