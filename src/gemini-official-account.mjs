import {quotaZeroUntil, quotaZeroRecheckDue} from './quota-zero.mjs';

const emptyQuota = note => ({status: 'unavailable', windows: [], checkedAt: null, note});
const unknown = reason => ({available: false, auth: {status: 'unknown'}, reason});
const changingNote = 'Gemini 帳號正在變更，請先完成或取消官方登入。';

// The HTTP interface, room controllers and workers share one official session.
// Keep the quota, its retry deadline and outstanding native reads with that session.
export function createOfficialGeminiAccount(login, onChange = () => {}) {
  const reads = new Set();
  let quota = emptyQuota('尚未取得 Antigravity 官方額度。'), lastAttempt = 0, pendingRead;
  let revision = 0, action = null, loginPending = false;
  const unavailable = () => unknown(changingNote);
  const changing = () => !!action || loginPending;
  const invalidate = note => {
    revision++;
    quota = emptyQuota(note);
    lastAttempt = 0;
    pendingRead = null;
    onChange();
  };
  const read = async (options, catalog = false) => {
    if (changing()) return unavailable();
    const generation = revision;
    if (!catalog && pendingRead) return pendingRead;
    if (!catalog) lastAttempt = Date.now();
    const operation = Promise.resolve().then(() => login.status(options));
    reads.add(operation);
    const result = operation.catch(() => unknown('官方查詢失敗，請稍後刷新。')).then(value => {
      if (generation !== revision) return unknown('Gemini 帳號已變更，請重新查詢。');
      if (!catalog) {
        if (value.auth?.status === 'signed-out' || value.installed === false) quota = emptyQuota(value.reason);
        else quota = value.quota ?? {...quota, status: quota.windows.length ? 'stale' : 'unavailable',
          note: value.reason ?? '無法取得官方額度。'};
        onChange();
      }
      return value;
    }).finally(() => {
      reads.delete(operation);
      if (pendingRead === result) pendingRead = null;
    });
    if (!catalog) pendingRead = result;
    return result;
  };
  return {
    get quota() { return quota; },
    get loginPending() { return loginPending; },
    get busy() { return changing(); },
    assertStable() {
      if (changing()) throw Object.assign(Error(changingNote), {notSent: true, notCreated: true, dispatch: 'not-started'});
    },
    status: options => read(options, options?.checkAuth === false),
    async usage(refresh = false) {
      if (!changing() && (refresh || (!quotaZeroUntil(quota) && (quotaZeroRecheckDue(quota) || Date.now() - lastAttempt >= 60000))))
        await read();
      return quota;
    },
    async change(kind, operation) {
      if (action || (loginPending !== ['code', 'finish', 'cancel'].includes(kind)))
        throw Object.assign(Error('Gemini 登入操作狀態已變更，請重新整理。'), {statusCode: 409});
      action = kind;
      try {
        if (kind === 'login' || kind === 'logout') {
          invalidate(changingNote);
          // An official usage or catalog command may still be using this same native profile.
          await Promise.allSettled([...reads]);
        }
        const result = await operation();
        if (kind === 'login') loginPending = true;
        if (kind === 'finish' || kind === 'cancel') loginPending = false;
        return result;
      } finally {
        action = null;
        if (!loginPending) invalidate('尚未取得目前 Gemini 帳號的官方額度。');
      }
    }
  };
}
