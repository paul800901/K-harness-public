const validEntry = entry =>
  typeof entry?.account === 'string' && /^[^@\s]+@[^@\s]+$/u.test(entry.account) && /^[a-f0-9]{32}$/u.test(entry.profileId ?? '');

// Each subscribed account has its own Chrome profile; all are read in one refresh, one at a time.
export function createColabBalance({read, accounts}) {
  if (!read || !Array.isArray(accounts) || !accounts.length || !accounts.every(validEntry)) return undefined;
  const closed = new AbortController();
  const listeners = new Set();
  let value = {state: 'unchecked'};
  let pending;
  const set = next => {
    value = next;
    for (const listener of listeners) listener();
    return value;
  };
  const readOne = async ({account, profileId}) => {
    const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(30000)]);
    try {
      const units = await read({account, profileId, signal});
      signal.throwIfAborted();
      if (typeof units !== 'string' || !/^\d+(?:\.\d+)?$/u.test(units)) throw Error('Invalid Colab balance');
      return {account, units};
    } catch {
      return {account, units: null};
    }
  };
  return {
    get value() {
      return value;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      if (closed.signal.aborted) return Promise.resolve({state: 'unavailable'});
      if (pending) return pending;
      pending = (async () => {
        const rows = [];
        for (const entry of accounts) if (!closed.signal.aborted) rows.push(await readOne(entry));
        if (closed.signal.aborted || !rows.some(row => row.units !== null)) return set({state: 'unavailable'});
        return set({state: 'fresh', accounts: rows, checkedAt: new Date().toISOString()});
      })().finally(() => {
        pending = null;
      });
      set({state: 'checking'});
      return pending;
    },
    async close() {
      listeners.clear();
      closed.abort();
      await pending;
    }
  };
}
