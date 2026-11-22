// Presentation only: never infer replenishment or change provider quota records.

// The voice secretary's estimate for this month: US$, plus NT$ at the daily rate when K has one (never guessed).
// Returned as parts so a narrow sidebar wraps between them, never inside one.
export function emmaMonthParts(emma) {
  if (!emma || !Number.isFinite(emma.usd)) return ['—'];
  const usd = `本月約 US$${emma.usd.toFixed(2)}`;
  return emma.usdToTwd > 0 ? [usd, `約 NT$${Math.round(emma.usd * emma.usdToTwd).toLocaleString('zh-TW')}`] : [usd];
}
export const emmaMonthText = emma => emmaMonthParts(emma).join(' · ');
export function quotaIsHistorical(quota, online = true, now = Date.now()) {
  if (!online || !['ready', 'available'].includes(quota?.status)) return true;
  const queried = Date.parse(quota.checkedAt ?? '');
  // Only a reset crossed after this official query invalidates its window.
  // Providers can legitimately report a past reset in a new successful query.
  return (
    quota.windows?.some(
      w =>
        Number.isFinite(w.resetsAt) &&
        w.resetsAt > 0 &&
        w.resetsAt * 1000 <= now &&
        (!Number.isFinite(queried) || w.resetsAt * 1000 > queried)
    ) ?? false
  );
}
export function quotaPercent(window) {
  if (window?.disabled === true) return '未啟用';
  const value = window?.remainingPercent;
  if (!Number.isFinite(value)) return '—';
  return value > 0 && value < 0.1 ? '<0.1%' : `${Number(value.toFixed(1))}%`;
}
// Official group names are English ("Claude and GPT models"); keep model names, translate the joiners.
export const quotaGroupName = name =>
  String(name ?? '')
    .replace(/\s+and\s+/giu, '／')
    .replace(/\s*\bmodels?\b/giu, ' 模型')
    .trim();
// One line per extra official group, e.g. "Gemini 4 Argon：每週 0.7%". Each group has its
// own resets, so it is historical by its own windows (plus the query's stale/offline state).
export const extraQuotaLines = (quota, online = true, now = Date.now()) =>
  (quota?.extra ?? []).map(g => ({
    name: quotaGroupName(g.name),
    text: g.windows.map(w => `${w.label} ${quotaPercent(w)}`).join(' · '),
    windows: g.windows,
    historical: quotaIsHistorical({...quota, windows: g.windows}, online, now)
  }));
export function quotaReset(window, now = Date.now()) {
  if (window?.disabled === true) return '不適用（官方未啟用）';
  if (!Number.isFinite(window?.resetsAt) || window.resetsAt <= 0) return '官方未提供';
  const at = window.resetsAt * 1000;
  return `${new Date(at).toLocaleString('zh-TW')}${at <= now ? '（已過）' : ''}`;
}

// Dated presentation only; never computes effective availability or changes quota.
export function weeklyQuotaNote(quota, online = true, now = Date.now()) {
  if (quotaIsHistorical(quota, online, now) || !Number.isFinite(Date.parse(quota?.checkedAt ?? ''))) return null;
  return quota.windows?.some(w => w.key === 'seven_day' && w.remainingPercent === 0)
    ? '上次實查：每週額度已用完'
    : null;
}

// Time left until an official reset, for the reader who would otherwise check the clock; null when unknown or past.
export function quotaCountdown(window, now = Date.now()) {
  if (window?.disabled === true || !Number.isFinite(window?.resetsAt) || window.resetsAt <= 0) return null;
  const minutes = Math.ceil((window.resetsAt * 1000 - now) / 60000);
  if (minutes <= 0) return null;
  const d = Math.floor(minutes / 1440),
    h = Math.floor((minutes % 1440) / 60),
    m = minutes % 60;
  if (d) return `還有 ${d} 天 ${h} 小時`;
  if (h) return `還有 ${h} 小時 ${m} 分`;
  return `還有 ${m} 分`;
}
