import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import test from 'node:test';
import {NO_CLAUDE_CONFIG, testEnvironment} from '../scripts/test-env.mjs';

test('tests started inside K drop the live-core pointers and keep everything else', () => {
  const env = testEnvironment({
    PATH: 'p',
    K_GROK_EXECUTABLE: 'grok.exe',
    K_GROK_HOME: 'grok-home',
    K_DSH_EXECUTABLE: 'dsh.exe',
    K_DSH_HOME: 'dsh-home',
    k_gemini_executable: 'agy.exe',
    K_CANDIDATE_ROOT: 'candidate',
    K_INCIDENT_PROJECTION: 'live-room.json',
    claude_config_dir: 'live-claude-home',
    K_DICTATION_PYTHON: 'python.exe'
  });
  assert.deepEqual(env, {PATH: 'p', K_DICTATION_PYTHON: 'python.exe', CLAUDE_CONFIG_DIR: NO_CLAUDE_CONFIG});
  assert.equal(existsSync(NO_CLAUDE_CONFIG), false);
});
