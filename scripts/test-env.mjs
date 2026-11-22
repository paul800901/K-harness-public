import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Tests started from inside K (an AI in a K room) inherit the launcher's pointers to the live cores and
// their homes. Tests that do not inject a fake would then start the real Grok / DeepSeek / agy with the
// owner's login. Outside K (the updater) these are absent, so removing them makes both runs the same.
const LIVE_POINTERS = [
  'K_GROK_EXECUTABLE',
  'K_GROK_HOME',
  'K_DSH_EXECUTABLE',
  'K_DSH_HOME',
  'K_GEMINI_EXECUTABLE',
  'K_CANDIDATE_ROOT',
  'K_INCIDENT_PROJECTION'
];
// Claude's pre-launch check reads settings.json from CLAUDE_CONFIG_DIR, else ~/.claude, so removing the
// variable is not enough. This folder is never created: the check finds nothing there and moves on.
// Tests that need a Claude config set their own.
export const NO_CLAUDE_CONFIG = path.join(fileURLToPath(new URL('..', import.meta.url)), '.runtime', 'tests', 'no-claude-config');

export function testEnvironment(source = process.env) {
  const env = {...source};
  for (const key of Object.keys(env))
    if (LIVE_POINTERS.includes(key.toUpperCase()) || key.toUpperCase() === 'CLAUDE_CONFIG_DIR') delete env[key];
  env.CLAUDE_CONFIG_DIR = NO_CLAUDE_CONFIG;
  return env;
}
