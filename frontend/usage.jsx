import React, {useEffect, useRef, useState} from 'react';
import {ChevronDown, RefreshCw} from 'lucide-react';
import './usage.css';
import {
  extraQuotaLines,
  quotaIsHistorical,
  quotaPercent,
  quotaCountdown,
  quotaReset,
  weeklyQuotaNote,
  emmaMonthParts,
  emmaMonthText
} from './quota-display.mjs';
import {SECRETARY_NAME} from '../shared/voice-secretary-name.mjs';

const windowName = w =>
  w.minutes === 10080
    ? '每週'
    : w.minutes === 300
      ? '5 小時'
      : w.minutes
        ? `${w.minutes} 分鐘`
        : w.key === 'primary'
          ? '短期額度'
          : '長期額度';
// One reset line: official time on the left, time left on the right so nobody has to check the clock.
const ResetLine = ({children, window: w, now}) => {
  const left = quotaCountdown(w, now);
  return (
    <span className="usage-reset-line">
      <span>{children}</span>
      {left && <b>{left}</b>}
    </span>
  );
};
// Thin weekly bar under a provider row so the eye can compare providers without reading numbers.
const WeekBar = ({percent}) =>
  Number.isFinite(percent) ? (
    <span className={`usage-bar${percent < 20 ? ' warning' : ''}`} aria-hidden="true">
      <span style={{width: `${Math.max(0, Math.min(100, percent))}%`}} />
    </span>
  ) : null;
// Claude also reports model-only weekly windows with minutes 10080, so its row picks seven_day by key instead.
const weekPercent = windows => windows?.find(w => w.minutes === 10080)?.remainingPercent;
const creditBalance = b =>
  b == null ? '—' : Number.isFinite(Number(b)) ? Number(b).toLocaleString('zh-TW', {maximumFractionDigits: 20}) : b;
// DeepSeek bills an API balance in its own currency; NT$ is an approximate conversion at a daily public rate.
const money = (value, symbol) =>
  `${symbol}${Number(value).toLocaleString('zh-TW', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
const twd = (value, rate) =>
  Number.isFinite(value) && rate > 0 ? `約 NT$${Math.round(value * rate).toLocaleString('zh-TW')}` : '';
export function deepseekBalanceText(quota, online) {
  const balance = quota?.balance;
  if (!balance || quotaIsHistorical(quota, online) || !Number.isFinite(balance.cny)) return '—';
  return twd(balance.cny, quota.fx?.twdPerCny) || money(balance.cny, '¥');
}
const refreshUsage = async force => {
  const response = await fetch(`/api/usage${force ? '?refresh=1' : ''}`, {cache: 'no-store'});
  if (!response.ok) throw Error('額度查詢失敗；請確認電腦連線後再試。');
  return response.json();
};

export function Usage({state, online, onDetails}) {
  const quota = state.usage?.codex;
  const gemini = state.usage?.gemini,
    geminiHistorical = quotaIsHistorical(gemini, online);
  useEffect(() => {
    let inFlight = false;
    const update = async () => {
      if (document.hidden || inFlight || !online) return;
      inFlight = true;
      try {
        await refreshUsage(false);
      } catch {
      } finally {
        inFlight = false;
      }
    };
    void update();
    const timer = setInterval(update, 10000);
    document.addEventListener('visibilitychange', update);
    const refreshOnAccountChange = () => {
      void refreshUsage(true).catch(() => {});
    };
    window.addEventListener('k-gemini-usage-refresh', refreshOnAccountChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('k-gemini-usage-refresh', refreshOnAccountChange);
    };
  }, [online, state.threadId]);
  const stale = !online || quota?.status === 'stale';
  const windows = (quota?.windows ?? []).filter(w => Number.isFinite(w.remainingPercent));
  // The card starts folded to its title so the room list keeps the space; the corner chevron folds it again.
  const [unfolded, setOpen] = useState(false);
  if (!unfolded)
    return (
      <section className="usage-compact" aria-label="額度與用量">
        <button
          type="button"
          className="usage-summary usage-folded"
          aria-expanded="false"
          onClick={() => setOpen(true)}
        >
          <span className="usage-label">剩餘額度</span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      </section>
    );
  return (
    <section className="usage-compact" aria-label="額度與用量">
      <button
        type="button"
        className="usage-fold"
        title="收起剩餘額度"
        aria-label="收起剩餘額度"
        aria-expanded="true"
        onClick={() => setOpen(false)}
      >
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="usage-summary"
        title="查看額度與用量詳情"
        aria-label="查看額度與用量詳情"
        aria-haspopup="dialog"
        onClick={onDetails}
      >
        <span className="usage-label">剩餘額度</span>
        <span className="usage-row">
          <span className="usage-provider">Codex</span>
          <span className="usage-values">
            {windows.length
              ? [...windows]
                  .sort((a, b) => b.minutes - a.minutes)
                  .map((w, i) => (
                    <React.Fragment key={w.key}>
                      {i > 0 ? ' · ' : ''}
                      <span className={w.remainingPercent < 20 ? 'warning' : undefined}>
                        {w.minutes === 10080 ? '本週' : w.minutes === 300 ? '5 小時' : windowName(w)}{' '}
                        {w.remainingPercent}%
                      </span>
                    </React.Fragment>
                  ))
              : '—'}
          </span>
          {stale && <em>舊</em>}
          <WeekBar percent={weekPercent(windows)} />
        </span>
        <span className="usage-row">
          <span className="usage-provider">Claude</span>
          <span className="usage-values">
            {state.usage?.claude?.windows?.some(w => w.remainingPercent != null)
              ? state.usage.claude.windows
                  .filter(w => ['five_hour', 'seven_day'].includes(w.key))
                  .sort((a, b) => (a.key === 'seven_day' ? -1 : b.key === 'seven_day' ? 1 : 0))
                  .map((w, i) => (
                    <React.Fragment key={w.key}>
                      {i > 0 ? ' · ' : ''}
                      <span
                        className={
                          Number.isFinite(w.remainingPercent) && w.remainingPercent < 20 ? 'warning' : undefined
                        }
                      >
                        {w.key === 'five_hour' ? '5 小時' : '本週'} {w.remainingPercent ?? '—'}
                        {w.remainingPercent == null ? '' : '%'}
                      </span>
                    </React.Fragment>
                  ))
              : '—'}
          </span>
          {(!online || state.usage?.claude?.status === 'stale') && <em>舊</em>}
          <WeekBar percent={state.usage?.claude?.windows?.find(w => w.key === 'seven_day')?.remainingPercent} />
        </span>
        <span className="usage-row">
          <span className="usage-provider">Gemini</span>
          <span className="usage-values">
            {!geminiHistorical && gemini?.windows?.length
              ? [...gemini.windows]
                  .sort((a, b) => b.minutes - a.minutes)
                  .map((w, i) => (
                    <React.Fragment key={w.key}>
                      {i > 0 ? ' · ' : ''}
                      <span className={w.remainingPercent < 20 ? 'warning' : undefined}>
                        {w.minutes === 10080 ? '本週' : windowName(w)} {quotaPercent(w)}
                      </span>
                    </React.Fragment>
                  ))
              : '—'}
          </span>
          {!geminiHistorical && <WeekBar percent={weekPercent(gemini?.windows)} />}
          <span className="usage-sub" title={gemini?.accountEmail || undefined}>
            {gemini?.accountEmail && <span className="usage-account-email">{gemini.accountEmail}</span>}
            <span className="usage-account-count">
              {gemini?.accounts?.length > 0 && `${gemini.accounts.length} 個帳號 · `}
              {gemini?.checking
                ? `正在查詢 ${gemini.checking.current}／${gemini.checking.total}`
                : geminiHistorical
                  ? '目前額度待查詢'
                  : '上次查詢結果'}
            </span>
          </span>
        </span>
        <span className="usage-row">
          <span className="usage-provider">Grok</span>
          <span className="usage-values">
            {!quotaIsHistorical(state.usage?.grok, online) &&
            state.usage?.grok?.windows?.some(w => Number.isFinite(w.remainingPercent))
              ? state.usage.grok.windows.map((w, i) => (
                  <React.Fragment key={w.key}>
                    {i > 0 ? ' · ' : ''}
                    <span className={w.remainingPercent < 20 ? 'warning' : undefined}>
                      {w.minutes === 10080 ? '本週' : windowName(w)} {quotaPercent(w)}
                    </span>
                  </React.Fragment>
                ))
              : '—'}
          </span>
          {!quotaIsHistorical(state.usage?.grok, online) && (
            <WeekBar percent={weekPercent(state.usage?.grok?.windows)} />
          )}
        </span>
        <span className="usage-row">
          <span className="usage-provider">DeepSeek</span>
          <span className="usage-values">
            <span className={state.usage?.deepseek?.balance?.available === false ? 'warning' : undefined}>
              {deepseekBalanceText(state.usage?.deepseek, online)}
            </span>
          </span>
        </span>
        {state.usage?.emma && (
          <span className="usage-row">
            <span className="usage-provider">{SECRETARY_NAME}</span>
            <span className="usage-values">
              {emmaMonthParts(state.usage.emma).map((part, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? ' · ' : ''}
                  <span className="usage-nowrap">{part}</span>
                </React.Fragment>
              ))}
            </span>
          </span>
        )}
      </button>
    </section>
  );
}

export function UsageDetails({state, online}) {
  const [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [switching, setSwitching] = useState(false),
    [usage, setUsage] = useState(state.usage);
  const liveUsage = useRef(state.usage);
  liveUsage.current = state.usage;
  useEffect(() => setUsage(state.usage), [state.usage]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const quota = usage?.codex,
    claude = usage?.claude;
  async function refresh() {
    const startedWith = liveUsage.current;
    // A newer shared snapshot wins over an older HTTP response (including another device's switch).
    const acceptUsage = updated => {
      if (liveUsage.current === startedWith) setUsage(updated);
    };
    setError('');
    setNotice('');
    setRefreshing(true);
    try {
      const updated = await refreshUsage(true);
      acceptUsage(updated);
      if (updated.gemini?.accounts?.length) {
        const response = await fetch('/api/gemini/accounts/refresh-all', {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'X-K-Request': '1', 'X-K-Command': crypto.randomUUID()},
          body: '{}'
        });
        const result = await response.json().catch(() => {
          throw Error('未收到完整額度查詢結果；請確認電腦狀態，未自動重送查詢。');
        });
        if (!response.ok) throw Error(result.error || '全部帳號額度查詢未完成。');
        const active = result.accounts.find(a => a.id === result.activeAccountId);
        acceptUsage({
          ...updated,
          gemini: {
            ...active?.quota,
            accountId: result.activeAccountId,
            accountEmail: active?.email,
            accounts: result.accounts
          }
        });
        setNotice(result.note);
      } else setNotice('已完成目前登入帳號的額度查詢。');
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  }
  // Same activate route as the desktop settings page; the server refuses while Gemini works.
  async function switchAccount(account) {
    setError('');
    setNotice('');
    setSwitching(true);
    try {
      const unconfirmed = '未收到切換結果；請按更新額度讀回目前帳號，未自動重送。';
      const response = await fetch('/api/gemini/accounts/activate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-K-Request': '1', 'X-K-Command': crypto.randomUUID()},
        body: JSON.stringify({accountId: account.id})
      }).catch(() => {
        throw Error(unconfirmed);
      });
      const result = await response.json().catch(() => {
        throw Error(unconfirmed);
      });
      if (!response.ok)
        throw Error(`${result.error || 'Gemini 帳號操作未完成。'} 請按更新額度確認目前帳號，未自動重送。`);
      const active = result.accounts?.find(a => a.id === result.activeAccountId);
      if (!active || active.id !== account.id) throw Error(unconfirmed);
      // The route broadcasts publicState before responding. Keep the sidebar and dialog on that same
      // stream; a delayed command response must not undo a newer switch made on another device.
      setNotice('帳號切換已完成。');
    } catch (e) {
      setError(e.message);
    } finally {
      setSwitching(false);
    }
  }
  const gemini = usage?.gemini,
    geminiHistorical = quotaIsHistorical(gemini, online, now),
    geminiAccounts = gemini?.accounts ?? [];
  const quotaLine = (windows, key) => quotaPercent(windows?.find(w => w.key === key));
  return (
    <section className="usage-details" aria-label="額度與用量詳細資訊">
      <div className="usage-toolbar">
        <span>剩餘額度 · 同一帳號的對話共用</span>
        <button
          type="button"
          title="更新額度與用量"
          aria-label="更新額度與用量"
          disabled={refreshing || switching || !online}
          onClick={refresh}
        >
          <RefreshCw size={15} />
          {refreshing ? '查詢中…' : '更新額度'}
        </button>
      </div>
      {error && (
        <p role="alert" className="usage-note">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="usage-note">
          {notice}
        </p>
      )}
      {usage?.emma && <EmmaMonth emma={usage.emma} />}
      <section className="usage-provider-section" aria-label="Claude 訂閱剩餘額度">
        <div className="usage-heading">
          <strong>Claude 訂閱剩餘額度</strong>
        </div>
        <div className="quota-line">
          {claude?.windows?.length ? (
            claude.windows.map(w => (
              <span key={w.key}>
                {w.label} <b>{w.remainingPercent == null ? '—' : `${w.remainingPercent}%`}</b>
              </span>
            ))
          ) : (
            <span>官方額度暫時無法取得；可用 Claude Code /usage 核對。</span>
          )}
        </div>
        {(!online || claude?.status === 'stale') && <p className="usage-note">舊資料，等待更新。</p>}
        <details className="usage-more">
          <summary>查詢與重設時間</summary>
          <div className="usage-timestamps">
            <span>
              {claude?.checkedAt
                ? `上次取得：${new Date(claude.checkedAt).toLocaleString('zh-TW')}`
                : '尚未取得官方額度。'}
            </span>
            {(claude?.windows ?? []).map(w => (
              <ResetLine key={w.key} window={w} now={now}>
                {w.label}重設：{w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString('zh-TW') : '官方未提供'}
              </ResetLine>
            ))}
          </div>
          {claude?.extraUsageDisabled === true && (
            <p className="usage-note">
              依目前觀察到的 Claude CLI 狀態，額外用量：未啟用（額度用完即停止，不會加價計費）。
            </p>
          )}
          <p className="usage-note">
            Claude 連線中約每分鐘更新；無連線時約每 5 分鐘更新。共用額度歸零時等待官方重設，人工更新可重查。不以 Token
            推算。
          </p>
        </details>
      </section>
      <section className="usage-provider-section" aria-label="GPT / Codex 訂閱剩餘額度">
        <div className="usage-heading">
          <strong>GPT / Codex 訂閱剩餘額度</strong>
        </div>
        <div className="quota-line">
          {quota?.windows?.some(w => Number.isFinite(w.remainingPercent)) ? (
            quota.windows
              .filter(w => Number.isFinite(w.remainingPercent) || w.minutes)
              .map(w => (
                <span key={w.key}>
                  {windowName(w)} <b>{w.remainingPercent == null ? '—' : `${w.remainingPercent}%`}</b>
                </span>
              ))
          ) : (
            <span>額度暫時無法取得</span>
          )}
        </div>
        {(quota?.credits || quota?.resetCredits) && (
          <div className="quota-line">
            {quota.credits && (
              <span>
                剩餘點數 <b>{quota.credits.unlimited ? '不限' : creditBalance(quota.credits.balance)}</b>
              </span>
            )}
            {quota.resetCredits && (
              <span>
                可用重置 <b>{quota.resetCredits.availableCount}</b>
              </span>
            )}
          </div>
        )}
        {(!online || quota?.status === 'stale') && <p className="usage-note">舊資料，等待更新。</p>}
        <details className="usage-more">
          <summary>查詢與重設時間</summary>
          <div className="usage-timestamps">
            <span>
              {quota?.checkedAt
                ? `上次取得：${new Date(quota.checkedAt).toLocaleString('zh-TW')}`
                : '尚未取得官方額度。'}
            </span>
            {(quota?.windows ?? [])
              .filter(w => w.resetsAt)
              .map(w => (
                <ResetLine key={w.key} window={w} now={now}>
                  {windowName(w)}重設：{new Date(w.resetsAt * 1000).toLocaleString('zh-TW')}
                </ResetLine>
              ))}
            {(quota?.resetCredits?.items ?? []).map((c, i) => (
              <span key={i}>
                {c.title || '重置'}到期：
                {c.expiresAt ? new Date(c.expiresAt * 1000).toLocaleString('zh-TW') : '不會到期'}
              </span>
            ))}
            {quota?.resetCredits?.availableCount > 0 && !quota.resetCredits.items && (
              <span>重置到期時間：官方未提供</span>
            )}
          </div>
          <p className="usage-note">約每分鐘更新；額度歸零時等待官方重設，人工更新可重查。</p>
        </details>
      </section>
      <section className="usage-provider-section" aria-label="Gemini / Antigravity 訂閱剩餘額度">
        <div className="usage-heading">
          <strong>Gemini / Antigravity 訂閱剩餘額度</strong>
          {geminiAccounts.length > 0 && (
            <span role="status">
              {gemini?.checking
                ? `正在查詢 ${gemini.checking.current}／${gemini.checking.total}`
                : `${geminiAccounts.length} 個帳號`}
            </span>
          )}
        </div>
        {geminiAccounts.length ? (
          <>
            <div className="gemini-usage-accounts">
              {geminiAccounts.map(account => (
                <details className="gemini-usage-account" key={account.id} data-account-id={account.id}>
                  <summary>
                    <span className="gemini-usage-identity">
                      <strong>{account.email || '未確認帳號'}</strong>
                      <span className="gemini-usage-status">
                        {account.id === gemini.accountId && <span className="usage-current">目前使用</span>}
                        <span>
                          {account.auth?.status === 'authenticated'
                            ? '已驗證登入'
                            : account.auth?.status === 'signed-out'
                              ? '未登入'
                              : '尚未確認'}
                          {quotaIsHistorical(account.quota, online) ? ' · 目前額度待查詢' : ''}
                          {account.quota?.status === 'unavailable' ? ' · 尚無可用額度資料' : ''}
                        </span>
                        {weeklyQuotaNote(account.quota, online) && (
                          <strong className="usage-exhausted">
                            {weeklyQuotaNote(account.quota, online)}；等待重設
                          </strong>
                        )}
                      </span>
                      <span className="gemini-usage-status">
                        {account.quota?.checkedAt
                          ? `上次實查 ${new Date(account.quota.checkedAt).toLocaleString('zh-TW')}`
                          : '尚無查詢時間'}
                      </span>
                      {extraQuotaLines(account.quota, online, now).map(g => (
                        <span className="gemini-usage-status" key={g.name}>
                          {g.name}：{g.historical ? '—' : g.text}
                        </span>
                      ))}
                    </span>
                    <span className="gemini-usage-value">
                      每週{' '}
                      <b>
                        {quotaIsHistorical(account.quota, online)
                          ? '—'
                          : quotaLine(account.quota?.windows, 'seven_day')}
                      </b>
                    </span>
                    <span className="gemini-usage-value">
                      5 小時{' '}
                      <b>
                        {quotaIsHistorical(account.quota, online)
                          ? '—'
                          : quotaLine(account.quota?.windows, 'five_hour')}
                      </b>
                    </span>
                    <span className="usage-expand" aria-hidden="true">
                      ⌄
                    </span>
                  </summary>
                  <div className="usage-timestamps">
                    <span>
                      {account.quota?.checkedAt
                        ? `上次查詢：${new Date(account.quota.checkedAt).toLocaleString('zh-TW')}`
                        : '尚未查詢額度。'}
                    </span>
                    {(account.quota?.windows ?? []).map(w => (
                      <ResetLine key={w.key} window={w} now={now}>
                        {quotaIsHistorical(account.quota, online) ? '上次回報・' : ''}
                        {w.label || (w.key === 'seven_day' ? '每週' : '5 小時')}：{quotaPercent(w)}；重設時間：
                        {quotaReset(w)}
                      </ResetLine>
                    ))}
                    {extraQuotaLines(account.quota, online, now).flatMap(g =>
                      g.windows.map(w => (
                        <ResetLine key={g.name + w.key} window={w} now={now}>
                          {g.historical ? '上次回報・' : ''}
                          {g.name} {w.label}：{quotaPercent(w)}；重設時間：{quotaReset(w)}
                        </ResetLine>
                      ))
                    )}
                  </div>
                  {account.id !== gemini.accountId && account.auth?.status === 'authenticated' && (
                    <button
                      type="button"
                      className="gemini-usage-switch"
                      disabled={switching || refreshing || !online || !!gemini?.checking}
                      onClick={() => switchAccount(account)}
                    >
                      {switching ? '切換中…' : '切換使用此帳號'}
                    </button>
                  )}
                </details>
              ))}
            </div>
            <p className="usage-note">
              官方 /usage 顯示目前登入帳號的額度。展開可查看上次查詢與重設時間。私人原型另有查詢方式。
            </p>
          </>
        ) : (
          <>
            <div className="quota-line">
              {gemini?.windows?.length ? (
                gemini.windows.map(w => (
                  <span key={w.key}>
                    {windowName(w)} <b>{geminiHistorical ? '—' : quotaPercent(w)}</b>
                  </span>
                ))
              ) : (
                <span>{gemini?.note ?? '尚未取得官方額度。'}</span>
              )}
            </div>
            <p className="usage-note">
              {gemini?.windows?.length > 0 && gemini?.note && <>{gemini.note} </>}
              {geminiHistorical && gemini?.windows?.length > 0 ? '上次回報，等待更新。' : '約每分鐘更新；額度歸零時等待官方重設。'}
              額度來自目前登入帳號的 Antigravity 官方 /usage。私人原型另有查詢方式。
            </p>
            <details className="usage-more">
              <summary>查詢與重設時間</summary>
              <div className="usage-timestamps">
                <span>
                  {gemini?.checkedAt
                    ? `上次取得：${new Date(gemini.checkedAt).toLocaleString('zh-TW')}`
                    : '尚未取得官方額度。'}
                </span>
                {(gemini?.windows ?? []).map(w => (
                  <ResetLine key={w.key} window={w} now={now}>
                    {geminiHistorical ? '上次回報・' : ''}{windowName(w)}重設：{quotaReset(w, now)}
                  </ResetLine>
                ))}
              </div>
            </details>
          </>
        )}
      </section>
      <section className="usage-provider-section" aria-label="Grok 訂閱剩餘額度">
        <div className="usage-heading">
          <strong>Grok 訂閱剩餘額度{usage?.grok?.plan ? `（${usage.grok.plan}）` : ''}</strong>
        </div>
        <div className="quota-line">
          {usage?.grok?.windows?.length ? (
            usage.grok.windows.map(w => (
              <span key={w.key}>
                {w.label || windowName(w)} <b>{quotaIsHistorical(usage.grok, online) ? '—' : quotaPercent(w)}</b>
              </span>
            ))
          ) : (
            <span>{usage?.grok?.note ?? '尚未取得 Grok 官方額度。'}</span>
          )}
        </div>
        {usage?.grok?.note && usage?.grok?.windows?.length > 0 && <p className="usage-note">{usage.grok.note}</p>}
        <details className="usage-more">
          <summary>查詢與重設時間</summary>
          <div className="usage-timestamps">
            <span>
              {usage?.grok?.checkedAt
                ? `上次取得：${new Date(usage.grok.checkedAt).toLocaleString('zh-TW')}`
                : '尚未取得官方額度。'}
            </span>
            {(usage?.grok?.windows ?? []).map(w => (
              <ResetLine key={w.key} window={w} now={now}>
                {w.label || windowName(w)}重設：{quotaReset(w)}
              </ResetLine>
            ))}
          </div>
          <p className="usage-note">直接查詢 Grok 官方帳務資料，約每分鐘更新；不以 Token 推算。</p>
        </details>
      </section>
      <DeepSeekBalance quota={usage?.deepseek} online={online} />
    </section>
  );
}

// Emma (the voice secretary) this month: K's own estimate from Gemini's reported usage at the official prices.
function EmmaMonth({emma}) {
  return (
    <section className="usage-provider-section" aria-label={`${SECRETARY_NAME}本月費用估算`}>
      <div className="usage-heading">
        <strong>{SECRETARY_NAME}（K 語音秘書）本月費用估算</strong>
      </div>
      <div className="quota-line">
        <span>
          <b>{emmaMonthText(emma)}</b>
        </span>
        <span>
          通話 <b>{emma.calls ?? 0}</b> 通
        </span>
      </div>
      <details className="usage-more">
        <summary>計算方式與匯率</summary>
        <div className="usage-timestamps">
          <span>
            {emma.usdToTwd > 0
              ? `匯率：1 美元約 ${emma.usdToTwd.toFixed(2)} 新台幣（ExchangeRate-API${emma.fxUpdatedAt ? `，${new Date(emma.fxUpdatedAt).toLocaleDateString('zh-TW')}` : ''}）`
              : '匯率暫時無法取得，只顯示美金。'}
          </span>
        </div>
        <p className="usage-note">依 Gemini 每輪回報的用量與官方單價估算，實際金額以 AI Studio 為準。</p>
      </details>
    </section>
  );
}

function DeepSeekBalance({quota, online}) {
  const balance = quota?.balance,
    fx = quota?.fx,
    current = balance && !quotaIsHistorical(quota, online);
  const usdToTwd = fx?.twdPerCny > 0 && fx?.usdPerCny > 0 ? fx.twdPerCny / fx.usdPerCny : null;
  return (
    <section className="usage-provider-section" aria-label="DeepSeek 帳戶餘額">
      <div className="usage-heading">
        <strong>DeepSeek 帳戶餘額（API 計費）</strong>
      </div>
      <div className="quota-line">
        {current && Number.isFinite(balance.cny) ? (
          <>
            <span>
              人民幣 <b>{money(balance.cny, '¥')}</b>
              {fx ? `（${twd(balance.cny, fx.twdPerCny)}）` : ''}
            </span>
            {balance.usd > 0 && (
              <span>
                美元 <b>{money(balance.usd, '$')}</b>
                {usdToTwd ? `（${twd(balance.usd, usdToTwd)}）` : ''}
              </span>
            )}
            <span>
              帳戶 <b>{balance.available ? '可用' : '不可用'}</b>
            </span>
          </>
        ) : (
          <span>{quota?.note ?? '尚未查詢 DeepSeek 帳戶餘額。'}</span>
        )}
      </div>
      {current && quota.note && <p className="usage-note">{quota.note}</p>}
      <details className="usage-more">
        <summary>查詢時間與匯率</summary>
        <div className="usage-timestamps">
          <span>
            {quota?.checkedAt ? `上次取得：${new Date(quota.checkedAt).toLocaleString('zh-TW')}` : '尚未取得餘額。'}
          </span>
          <span>
            {fx
              ? `匯率：1 人民幣約 ${fx.twdPerCny.toFixed(2)} 新台幣（${fx.source}${fx.updatedAt ? `，${new Date(fx.updatedAt).toLocaleDateString('zh-TW')}` : ''}）`
              : '匯率暫時無法取得，只顯示原幣別。'}
          </span>
        </div>
        <p className="usage-note">
          直接查詢 DeepSeek
          官方帳戶餘額，約每分鐘更新。人民幣與美元是兩個分開儲值的錢包；新台幣只是依公開匯率的約略換算。
        </p>
      </details>
    </section>
  );
}

// A DeepSeek room's own numbers: context in use, and an estimate of what this room cost. The estimate
// (official token counts x the official price page) is a separate reference from the account balance.
const tokenCount = n => (n < 10000 ? `${(n / 1000).toFixed(1)}K` : `${(n / 10000).toFixed(n < 100000 ? 1 : 0)}萬`);
export function DeepSeekRoomUsage({progress, jobs = []}) {
  const context = progress?.contextUsage,
    room = progress?.roomUsage;
  if (!context && !room && !jobs.length) return null;
  const cost =
    room?.cny == null
      ? '本房花費未知'
      : room.cny > 0 && room.cny < 0.01
        ? '本房約 <¥0.01'
        : `本房約 ¥${room.cny.toFixed(2)}`;
  const title = room
    ? `本房累計 token：輸入 ${room.tokens.input.toLocaleString('zh-TW')}、快取命中 ${room.tokens.cacheRead.toLocaleString('zh-TW')}、輸出 ${room.tokens.output.toLocaleString('zh-TW')}。` +
      (!room.pricesAvailable
        ? '官方價格頁暫時讀不到，未估算花費。'
        : room.cny == null
          ? '本房用到的模型都沒有官方單價，未估算花費。'
          : `依 DeepSeek 官方價格頁${room.pricesCheckedAt ? `（${new Date(room.pricesCheckedAt).toLocaleDateString('zh-TW')} 讀取）` : ''}與尖峰／離峰時段估算，不是帳單；中國國定假日以尖峰價計，可能略高。`) +
      (room.unpriced && room.cny != null ? `另有 ${room.unpriced} 筆沒有官方單價，未計入。` : '') +
      (room.searches ? `網頁搜尋 ${room.searches} 次的費用未計入（一次搜尋的實際計費次數無法從紀錄得知）。` : '') +
      '只計本房主對話；DeepSeek 原生子代理與 K 工人的用量未計入。'
    : '本房尚無用量紀錄。';
  const jobText = jobs.length ? `背景工作：${jobs.map(job => job.label).join('；')}。` : '';
  return (
    <span className="status deepseek-room-usage" title={jobText + title}>
      {[
        jobs.length ? `背景工作 ${jobs.length} 個` : null,
        context ? `上下文 ${tokenCount(context.used)}／${tokenCount(context.size)}` : null,
        room ? cost : null
      ]
        .filter(Boolean)
        .join(' · ')}
    </span>
  );
}
