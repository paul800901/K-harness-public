import {spawn, execFile} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);

// Shared by every core that speaks ACP JSON-RPC over stdio (Grok Build, DeepSeek Harness). The native
// core owns sessions, history, compaction and tools; K only presents and coordinates.
export async function killAcpTree(
  pid,
  {execImpl = exec, platform = process.platform, env = process.env, label = 'ACP'} = {}
) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error(`無效的 ${label} PID，未終止程序。`);
  if (platform === 'win32')
    await execImpl(
      path.join(env.SystemRoot ?? env.WINDIR, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {windowsHide: true, timeout: 10000, maxBuffer: 32768}
    ).catch(error => {
      // 128: the process already exited.
      if (error.code !== 128) throw error;
    });
  else process.kill(-pid, 'SIGKILL');
}

/**
 * One ACP agent process (`grok agent stdio`, `dsh --profile acp`, ...). Agent requests (permission
 * prompts) go to onRequest; notifications go to onNotification. close() ends stdin, then confirms
 * the tree ended. `label` names the core in human messages.
 */
export async function openAcpAgent({
  executable,
  args,
  label,
  missing,
  env,
  cwd,
  onNotification = () => {},
  onRequest = async () => {
    throw Error(`K 未處理這項 ${label} 請求。`);
  },
  spawnImpl = spawn,
  killTree = pid => killAcpTree(pid, {label}),
  signal
} = {}) {
  if (!executable) throw Error(missing);
  signal?.throwIfAborted();
  const child = spawnImpl(executable, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let nextId = 0,
    exited = false,
    stderr = '';
  const waiting = new Map();
  const closed = new Promise(resolve => {
    child.once('exit', (code, sig) => {
      exited = true;
      const error = Error(`${label} 程序已結束（${code ?? sig}）。${stderr.trim().slice(-500)}`);
      for (const item of waiting.values()) item.reject(Object.assign(error, {processEnded: true}));
      waiting.clear();
      resolve({code, signal: sig});
    });
    child.once('error', error => {
      exited = true;
      for (const item of waiting.values()) item.reject(error);
      waiting.clear();
      resolve({code: null, error});
    });
  });
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.stdin.on('error', () => {});
  const write = message => {
    if (exited || !child.stdin.writable) throw Object.assign(Error(`${label} 程序已結束；未送出。`), {notSent: true});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
  };
  readline.createInterface({input: child.stdout}).on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const item = waiting.get(message.id);
      if (!item) return;
      waiting.delete(message.id);
      if (message.error)
        item.reject(Object.assign(Error(message.error.message ?? `${label} 請求失敗。`), {rpc: message.error}));
      else item.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      Promise.resolve()
        .then(() => onRequest(message))
        .then(
          result => write({id: message.id, result}),
          error => write({id: message.id, error: {code: -32603, message: String(error?.message ?? error)}})
        )
        .catch(() => {});
      return;
    }
    if (message.method) {
      try {
        onNotification(message);
      } catch {}
    }
  });
  const agent = {
    pid: child.pid,
    closed,
    get exited() {
      return exited;
    },
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        waiting.set(id, {resolve, reject});
        try {
          write({id, method, params});
        } catch (error) {
          waiting.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params) {
      write({method, params});
    },
    // Confirms the process tree ended; a failure to confirm is thrown, never assumed.
    async close({graceMs = 3000} = {}) {
      if (exited) return;
      try {
        child.stdin.end();
      } catch {}
      const ended = await Promise.race([closed.then(() => true), new Promise(r => setTimeout(r, graceMs, false))]);
      if (ended) return;
      await killTree(child.pid);
      const killed = await Promise.race([closed.then(() => true), new Promise(r => setTimeout(r, 10000, false))]);
      if (!killed) throw Error(`${label} 程序停止未確認。`);
    }
  };
  // A stop during initialize ends this process (the caller holds no handle yet) and ends
  // this wait; a stop that cannot be confirmed is reported with the PID, never swallowed.
  let stopped;
  const aborted = new Promise((_, reject) => (stopped = reject));
  aborted.catch(() => {});
  const abort = () =>
    void agent.close().then(
      () => stopped(Object.assign(Error(`${label} 啟動已停止。`), {name: 'AbortError'})),
      error =>
        stopped(Object.assign(Error(`${label} 啟動已停止但程序停止未確認：${error.message}`), {unresolvedPid: child.pid}))
    );
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  try {
    agent.initialize = await Promise.race([
      aborted,
      agent.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}
      })
    ]);
    signal?.throwIfAborted();
  } catch (error) {
    if (error.unresolvedPid) throw error;
    try {
      await agent.close();
    } catch (closeError) {
      throw Object.assign(Error(`${label} 啟動失敗且程序停止未確認：${closeError.message}`), {
        cause: error,
        unresolvedPid: child.pid
      });
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return agent;
}
