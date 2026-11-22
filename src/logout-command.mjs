import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);

// Native logout owns credential removal. Never expose its stdout/stderr or retry it.
export async function logoutCommand(command, args, {cwd, env, execImpl = exec, name} = {}) {
  try {
    await execImpl(command, args, {cwd, env, windowsHide: true, timeout: 10000, maxBuffer: 65536});
  } catch {
    throw Error(`${name} 登出未確認，請刷新狀態確認；未自動重試。`);
  }
}
