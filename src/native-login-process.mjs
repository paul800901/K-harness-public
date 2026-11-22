import {spawn} from 'node:child_process';

// Only a native authentication command runs here. Raw output and submitted codes never leave this adapter.
export function createNativeLoginProcess({name, parse, spawnImpl = spawn, stopChild, onComplete = () => {}}) {
  let current = null,
    starting = false,
    epoch = 0,
    stopping = null,
    login = {status: 'idle'};
  const progress = () => ({login: {...login}});
  return {
    progress,
    get running() {
      return starting || !!current;
    },
    async start(prepare) {
      if (starting || current || stopping) return progress();
      starting = true;
      const ownEpoch = ++epoch;
      login = {status: 'running'};
      try {
        const {command, args, cwd, env} = await prepare();
        if (ownEpoch !== epoch) return progress();
        const child = spawnImpl(command, args, {
          cwd,
          env,
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let finish;
        const item = {
          child,
          closed: new Promise(resolve => {
            finish = resolve;
          }),
          buffer: ''
        };
        current = item;
        const consume = chunk => {
          if (current !== item) return;
          item.buffer = (item.buffer + chunk.toString()).slice(-16384);
          let publicFields;
          try {
            publicFields = parse(item.buffer);
          } catch {
            return;
          }
          if (publicFields) login = {...login, ...publicFields};
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
        child.stdin.on('error', () => {});
        child.once('error', () => {
          if (current === item) login = {...login, error: `${name} 官方登入程序無法啟動，尚未確認停止。`};
        });
        child.once('close', code => {
          finish();
          if (current !== item) return;
          current = null;
          item.buffer = '';
          login = stopping
            ? {status: 'idle'}
            : code === 0
              ? {status: 'complete'}
              : {status: 'error', error: `${name} 官方登入尚未完成，請重新開始。`};
          onComplete(code === 0);
        });
        return progress();
      } catch {
        if (ownEpoch === epoch) login = {status: 'error', error: `${name} 官方登入無法啟動。`};
        return progress();
      } finally {
        starting = false;
      }
    },
    async submitCode({code} = {}) {
      const item = current;
      if (!item || login.status !== 'running' || !login.url || !login.needsCode || login.codeSubmitted || stopping)
        throw Error('沒有等待授權碼的登入程序，請重新開始登入。');
      if (typeof code !== 'string' || !/^[A-Za-z0-9/_=+.~:-]{1,4096}$/.test(code))
        throw Error('請貼上官方提供的完整單行授權碼。');
      login = {...login, codeSubmitted: true};
      item.buffer = '';
      try {
        await new Promise((resolve, reject) =>
          item.child.stdin.write(code + '\n', error => (error ? reject(error) : resolve()))
        );
      } catch {
        throw Error('交付官方驗證的結果未確認；未重送，請刷新狀態。');
      }
      return progress();
    },
    async cancel() {
      ++epoch;
      if (stopping) return stopping;
      const item = current;
      if (!item) {
        login = {status: 'idle'};
        return progress();
      }
      stopping = Promise.resolve().then(async () => {
        let timer;
        try {
          if (stopChild) await stopChild(item.child);
          else if (typeof item.child.terminate === 'function') {
            const result = await item.child.terminate('cancelled');
            if (result !== true && result?.confirmed !== true) throw Error();
          } else if (item.child.kill() === false) throw Error();
          await Promise.race([
            item.closed,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error()), 10000);
            })
          ]);
          login = {status: 'idle'};
          return progress();
        } catch {
          login = {...login, status: 'running', error: `${name} 登入程序停止尚未確認，請稍後再停止。`};
          throw Error(login.error);
        } finally {
          clearTimeout(timer);
        }
      });
      try {
        return await stopping;
      } finally {
        stopping = null;
      }
    },
    async close() {
      await this.cancel();
    }
  };
}
