import {useComponentEnabled} from './component-context.jsx';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ChevronDown, RefreshCw} from 'lucide-react';
import {officialClaudeLoginUrl as officialLoginUrl} from '../shared/claude-login-url.mjs';
import {officialCodexLoginUrl} from '../shared/codex-login-url.mjs';
import {mobileLoginUrl} from '../shared/mobile-login-url.mjs';
import {api, remoteClient} from './app-common.jsx';

import {extraQuotaLines, quotaIsHistorical, quotaPercent, quotaReset} from './quota-display.mjs';

const NO_GEMINI_ACCOUNTS = [];
export function AccountConnections({
  disabled = false,
  provider = 'codex',
  defaultOpen = false,
  hidden = false,
  onStatus,
  onRefresh
}) {
  const selected = useComponentEnabled();
  // Switching models in a deselected AI's existing room still needs that AI's own login state.
  const enabled = id => selected(id) || (hidden && id === provider);
  const [claudeStatus, setClaudeStatus] = useState(null),
    [claudeLoading, setClaudeLoading] = useState(true),
    [claudeAction, setClaudeAction] = useState(false);
  const [claudeCode, setClaudeCode] = useState(''),
    [claudeLoginNotice, setClaudeLoginNotice] = useState('');
  const [codexStatus, setCodexStatus] = useState(null),
    [codexLoading, setCodexLoading] = useState(true),
    [codexAction, setCodexAction] = useState(false);
  const [geminiStatus, setGeminiStatus] = useState(null),
    [geminiLoading, setGeminiLoading] = useState(true),
    [geminiAction, setGeminiAction] = useState(false),
    [geminiNotice, setGeminiNotice] = useState('');
  const [geminiAccounts, setGeminiAccounts] = useState(null),
    [geminiAccountsLoading, setGeminiAccountsLoading] = useState(true);
  const geminiGeneration = useRef(0);
  const geminiAuthGeneration = useRef(0);
  const [geminiLogin, setGeminiLogin] = useState(null),
    [geminiCode, setGeminiCode] = useState('');
  const [grokStatus, setGrokStatus] = useState(null),
    [grokLoading, setGrokLoading] = useState(true),
    [grokAction, setGrokAction] = useState(false),
    [grokNotice, setGrokNotice] = useState('');
  const refreshGrokStatus = async ({refreshModels = false} = {}) => {
    setGrokLoading(true);
    try {
      const response = await fetch('/api/grok/auth', {cache: 'no-store'});
      if (!response.ok) throw new Error();
      const next = await response.json();
      const progress = await api('grok/login');
      setGrokStatus({...next, ...progress});
      if (refreshModels && next.available === true) await onRefresh?.('grok');
      return next;
    } catch {
      setGrokStatus({available: false, reason: '無法讀取 Grok 登入狀態。'});
    } finally {
      setGrokLoading(false);
    }
  };
  const startGrokLogin = async (cancel = false) => {
    setGrokAction(true);
    setGrokNotice('');
    try {
      const result = await api(cancel ? 'grok/login/cancel' : 'grok/login', {});
      setGrokNotice(result.reason || '');
      setGrokStatus(current => ({...current, login: result.login}));
    } catch (error) {
      setGrokNotice(error.message || '無法開啟 Grok 官方登入。');
    } finally {
      setGrokAction(false);
    }
  };
  const [accountsOpen, setAccountsOpen] = useState(defaultOpen);
  const [logoutAction, setLogoutAction] = useState(null),
    [logoutNotice, setLogoutNotice] = useState({});
  const signOut = async provider => {
    if (logoutAction) return;
    setLogoutAction(provider);
    setLogoutNotice(current => ({...current, [provider]: ''}));
    try {
      const route = provider === 'gemini' ? 'gemini/accounts/logout' : `${provider}/logout`;
      const result = await api(route, {});
      if (provider === 'codex') setCodexStatus(result);
      if (provider === 'claude') {
        setClaudeStatus(result);
        setClaudeCode('');
      }
      if (provider === 'grok') setGrokStatus(result);
      if (provider === 'gemini') {
        ++geminiGeneration.current;
        ++geminiAuthGeneration.current;
        setGeminiLoading(false);
        setGeminiAccounts(current => current?.mode === 'official' ? {...current, loginPending: false} : result);
        setGeminiStatus({available: false, installed: true, auth: {loggedIn: false, status: 'signed-out'}});
        window.dispatchEvent(new Event('k-gemini-usage-refresh'));
      }
      setLogoutNotice(current => ({...current, [provider]: '已登出，可重新登入。'}));
      try {
        await onRefresh?.(provider);
      } catch {
        setLogoutNotice(current => ({...current, [provider]: '已登出；模型清單尚未更新，請稍後刷新。'}));
      }
    } catch (error) {
      setLogoutNotice(current => ({...current, [provider]: error.message || '登出未確認，請刷新狀態。'}));
    } finally {
      setLogoutAction(null);
    }
  };
  const refreshClaudeStatus = async ({refreshModels = false, fresh = false} = {}) => {
    setClaudeLoading(true);
    try {
      const response = await fetch(`/api/claude/auth${fresh ? '?refresh=1' : ''}`, {cache: 'no-store'});
      if (!response.ok) throw new Error();
      const next = await response.json();
      setClaudeStatus(next);
      if (refreshModels && next.available === true) await onRefresh?.('claude');
    } catch {
      setClaudeStatus({available: false, reason: '無法讀取 Claude 登入狀態。', login: {status: 'idle'}});
    } finally {
      setClaudeLoading(false);
    }
  };
  const refreshCodexStatus = async ({refreshModels = false} = {}) => {
    setCodexLoading(true);
    try {
      const response = await fetch('/api/codex/auth', {cache: 'no-store'});
      if (!response.ok) throw new Error();
      const next = await response.json();
      setCodexStatus(next);
      if (refreshModels && next.available === true) await onRefresh?.('codex');
    } catch {
      setCodexStatus({available: false, reason: '無法讀取 Codex 登入狀態。', login: {status: 'idle'}});
    } finally {
      setCodexLoading(false);
    }
  };
  const refreshGeminiStatus = async ({refreshModels = false} = {}) => {
    const generation = ++geminiAuthGeneration.current;
    setGeminiLoading(true);
    try {
      const response = await fetch('/api/gemini/auth', {cache: 'no-store'});
      if (!response.ok) throw Error();
      const next = await response.json();
      if (generation !== geminiAuthGeneration.current) return;
      setGeminiStatus(next);
      if (refreshModels && next.available) await onRefresh?.('gemini');
    } catch {
      if (generation === geminiAuthGeneration.current) setGeminiStatus({available: false, reason: '無法確認 Antigravity 狀態。'});
    } finally {
      if (generation === geminiAuthGeneration.current) setGeminiLoading(false);
    }
  };
  const refreshGeminiAccounts = async ({quiet = false} = {}) => {
    const generation = ++geminiGeneration.current;
    if (!quiet) setGeminiAccountsLoading(true);
    try {
      const response = await fetch('/api/gemini/accounts', {cache: 'no-store'});
      if (!response.ok) throw Error();
      const next = await response.json();
      if (generation === geminiGeneration.current) setGeminiAccounts(next);
      return next;
    } catch {
      const unavailable = {
        enabled: false,
        activeAccountId: null,
        busy: false,
        loginPending: false,
        accounts: [],
        reason: '目前無法讀取 Gemini 帳號清單。'
      };
      if (generation === geminiGeneration.current) setGeminiAccounts(unavailable);
      return unavailable;
    } finally {
      if (!quiet && generation === geminiGeneration.current) setGeminiAccountsLoading(false);
    }
  };
  const geminiAccountAction = async (action, data = {}) => {
    ++geminiGeneration.current;
    setGeminiAction(true);
    setGeminiNotice('');
    try {
      setGeminiCode('');
      const result = await api(`gemini/accounts/${action}`, data);
      setGeminiAccounts(result);
      const current = await refreshGeminiAccounts();
      if (result.mode === 'official') {
        if (action === 'finish' || action === 'cancel') {
          await refreshGeminiStatus({refreshModels: action === 'finish'});
          window.dispatchEvent(new Event('k-gemini-usage-refresh'));
        }
        if (action === 'finish') setGeminiNotice('已確認官方登入。');
        if (action === 'login') setGeminiNotice(remoteClient ? '請依 Antigravity 官方流程完成登入。' : '請在官方視窗完成登入，關閉該視窗後回到這裡確認。');
        if (action === 'cancel') setGeminiNotice('已結束這次登入操作。');
        return;
      }
      if (action === 'finish') setGeminiNotice('Gemini 帳號已保存並確認登入。');
      if (action === 'refresh-all') setGeminiNotice(result.note || '已查詢全部帳號並切回原帳號。');
      if (action === 'refresh') {
        const active = current?.accounts?.find(a => a.id === current.activeAccountId);
        setGeminiNotice(
          quotaIsHistorical(active?.quota)
            ? active?.quota?.note || '目前帳號額度尚未取得，未把舊資料當作更新成功。'
            : '已更新目前帳號額度；其他帳號未查詢。'
        );
      }
      if (['capture', 'cancel'].includes(action) && !current?.accounts?.length) await refreshGeminiStatus();
      if (action === 'cancel')
        setGeminiNotice(
          result.activeAccountId
            ? '已取消新增，原有帳號已恢復。'
            : '已取消新增；若已在官方程式登入，該登入仍保留，尚未加入 K。'
        );
      if (action === 'login')
        setGeminiNotice(
          remoteClient
            ? '請開啟官方登入頁完成驗證，再貼回授權碼。'
            : '已開啟官方登入，請本人完成登入。登入完成後關閉官方視窗，再回來保存帳號。'
        );
      if (
        ['capture', 'finish', 'cancel', 'activate', 'refresh', 'refresh-all'].includes(action) &&
        current?.activeAccountId &&
        !current.loginPending
      ) {
        const active = current.accounts?.find(account => account.id === current.activeAccountId);
        if (active?.auth?.status === 'authenticated') await onRefresh?.('gemini');
      }
      if (!['refresh', 'refresh-all'].includes(action)) window.dispatchEvent(new Event('k-gemini-usage-refresh'));
    } catch (error) {
      setGeminiNotice(error.message || '無法更新 Gemini 帳號狀態。');
      await refreshGeminiAccounts();
    } finally {
      setGeminiAction(false);
    }
  };
  useEffect(() => {
    if (enabled('claude')) refreshClaudeStatus();
    if (enabled('codex')) refreshCodexStatus();
    if (enabled('gemini')) refreshGeminiStatus();
    if (enabled('gemini')) refreshGeminiAccounts();
    if (enabled('grok')) refreshGrokStatus();
  }, [selected]);
  const updateClaudeLogin = async (route, data = {}) => {
    setClaudeAction(true);
    setClaudeLoginNotice('');
    setClaudeCode('');
    try {
      const result = await api(`claude/${route}`, data);
      setClaudeStatus(current => ({...current, ...result}));
    } catch (cause) {
      setClaudeLoginNotice(cause.message || '無法更新登入，請刷新狀態。');
    } finally {
      setClaudeAction(false);
    }
  };
  const copyClaudeLogin = async () => {
    const url = officialLoginUrl(claudeStatus?.login?.url);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setClaudeLoginNotice('已複製登入連結，請貼到 Chrome 網址列。');
    } catch {
      setClaudeLoginNotice('未能複製，請右鍵「開啟官方登入頁」並複製連結網址。');
    }
  };
  useEffect(() => {
    if (claudeStatus?.login?.status !== 'running') return;
    let disposed = false,
      timer;
    const poll = async () => {
      try {
        const response = await fetch('/api/claude/login', {cache: 'no-store'});
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (disposed) return;
        setClaudeStatus(current => ({...current, ...next}));
        if (next.login?.status !== 'running') {
          setClaudeCode('');
          await refreshClaudeStatus({refreshModels: true});
          return;
        }
      } catch {
        if (!disposed) setClaudeLoginNotice('暫時無法更新登入進度，請按刷新狀態確認。');
      }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [claudeStatus?.login?.status]);
  const updateCodexLogin = async route => {
    setCodexAction(true);
    try {
      setCodexStatus(await api(`codex/${route}`, {}));
    } catch (error) {
      setCodexStatus(current => ({
        ...current,
        available: false,
        reason: error.message || '無法更新 Codex 登入，請刷新狀態。'
      }));
    } finally {
      setCodexAction(false);
    }
  };
  useEffect(() => {
    if (codexStatus?.login?.status !== 'running') return;
    let disposed = false,
      timer;
    const poll = async () => {
      try {
        const response = await fetch('/api/codex/auth', {cache: 'no-store'});
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (disposed) return;
        setCodexStatus(next);
        if (next.login?.status !== 'running') {
          if (next.available === true) await onRefresh?.('codex');
          return;
        }
      } catch {}
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [codexStatus?.login?.status]);
  const auth = claudeStatus?.auth,
    codexAuth = codexStatus?.auth;
  const geminiLegacyVerified = geminiStatus?.available === true && geminiStatus?.auth?.loggedIn === true;
  const geminiAccountRows = geminiAccounts?.accounts ?? NO_GEMINI_ACCOUNTS;
  const geminiAccountActive = geminiAccountRows.find(item => item.id === geminiAccounts?.activeAccountId);
  const geminiAccountsEnabled = geminiAccounts?.enabled === true;
  const geminiLoginPending = geminiAccounts?.loginPending === true;
  useEffect(() => {
    if (!geminiLoginPending) {
      setGeminiLogin(null);
      return;
    }
    let disposed = false,
      timer;
    const poll = async () => {
      try {
        const next = await api('gemini/login');
        if (disposed) return;
        setGeminiLogin(next.login);
        if (next.login?.status !== 'running') setGeminiCode('');
      } catch {
        if (!disposed) setGeminiNotice('無法更新登入進度，請重新連線讀回。');
      }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [geminiLoginPending]);
  useEffect(() => {
    if (grokStatus?.login?.status !== 'running') return;
    let disposed = false,
      timer;
    const poll = async () => {
      try {
        const next = await api('grok/login');
        if (disposed) return;
        setGrokStatus(current => ({...current, ...next}));
        if (next.login?.status !== 'running') {
          await refreshGrokStatus({refreshModels: true});
          return;
        }
      } catch {
        if (!disposed) setGrokNotice('無法更新登入進度，請刷新狀態確認。');
      }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [grokStatus?.login?.status]);
  const geminiBusy = geminiAccounts?.busy === true;
  const geminiManualLogin = remoteClient || ['running', 'complete', 'error'].includes(geminiLogin?.status);
  const geminiRegistered = geminiAccountRows.length > 0;
  const geminiActiveVerified = geminiRegistered
    ? !!geminiAccountActive && geminiAccountActive.auth?.status === 'authenticated' && !geminiLoginPending
    : geminiLegacyVerified && !geminiLoginPending;
  const geminiUncertain = geminiAccounts?.uncertain === true;
  // A busy snapshot can outlive the native status/catalog lookup that caused it.
  // Re-read while actually busy, without replacing account cards with a spinner.
  useEffect(() => {
    if (!geminiBusy || geminiUncertain || geminiLoginPending || geminiAction || geminiAccountsLoading) return;
    const timer = setTimeout(() => {
      void refreshGeminiAccounts({quiet: true});
    }, 1000);
    return () => clearTimeout(timer);
  }, [geminiAccounts, geminiBusy, geminiUncertain, geminiLoginPending, geminiAction, geminiAccountsLoading]);
  const geminiStatusForConsumers = useMemo(
    () =>
      geminiRegistered
        ? {
            ...geminiStatus,
            available: geminiActiveVerified,
            auth: {
              ...(geminiStatus?.auth ?? {}),
              status: geminiLoginPending ? 'unknown' : (geminiAccountActive?.auth?.status ?? 'signed-out'),
              loggedIn: geminiActiveVerified,
              checkedAt: geminiAccountActive?.auth?.checkedAt
            },
            accounts: geminiAccountRows,
            activeAccountId: geminiAccounts?.activeAccountId
          }
        : geminiLoginPending
          ? {
              ...geminiStatus,
              available: false,
              auth: {...(geminiStatus?.auth ?? {}), status: 'unknown', loggedIn: false}
            }
          : geminiStatus,
    [
      geminiStatus,
      geminiRegistered,
      geminiActiveVerified,
      geminiLoginPending,
      geminiAccountActive,
      geminiAccountRows,
      geminiAccounts?.activeAccountId
    ]
  );
  const codexVerified =
    codexStatus?.available === true && codexAuth?.loggedIn === true && codexAuth?.authMethod === 'chatgpt';
  const claudeVerified =
    claudeStatus?.available === true &&
    auth?.loggedIn === true &&
    auth?.authMethod === 'claude.ai' &&
    auth?.apiProvider === 'firstParty' &&
    ['pro', 'max', 'team', 'enterprise'].includes(auth?.subscriptionType);
  const grokVerified = grokStatus?.available === true && grokStatus?.auth?.loggedIn === true;
  const needsLogin =
    provider === 'claude'
      ? !claudeLoading && !claudeVerified
      : provider === 'gemini'
        ? !geminiAccountsLoading && !geminiActiveVerified
        : provider === 'grok'
          ? !grokLoading && !grokVerified
          : provider === 'deepseek'
            ? false
            : !codexLoading && !codexVerified;
  const grokStatusText = grokLoading
    ? '正在讀取登入狀態…'
    : grokVerified
      ? `已確認 Grok 訂閱${grokStatus.plan ? `（${grokStatus.plan}）` : ''}${grokStatus.version ? ` · Grok Build ${grokStatus.version}` : ''}`
      : grokStatus?.reason || '尚未確認 Grok 訂閱狀態。';
  useEffect(() => {
    if (needsLogin) setAccountsOpen(true);
  }, [needsLogin]);
  const claudeStatusText = claudeLoading
    ? '正在讀取登入狀態…'
    : claudeVerified
      ? `已確認 Claude.ai ${auth.subscriptionType} 訂閱${claudeStatus.version ? ` · Claude Code ${claudeStatus.version}` : ''}`
      : auth?.loggedIn === false
        ? '尚未登入 Claude 訂閱，請先完成官方登入。'
        : claudeStatus?.reason || '尚未確認 Claude 訂閱狀態。';
  const codexStatusText = codexLoading
    ? '正在讀取登入狀態…'
    : codexVerified
      ? `已確認 ChatGPT${codexAuth.planType ? ` ${codexAuth.planType} 訂閱` : ' 訂閱'}`
      : codexAuth?.loggedIn === false
        ? '尚未登入 ChatGPT 訂閱，請先完成官方登入。'
        : codexStatus?.reason || '尚未確認 Codex 訂閱狀態。';
  const claudeLogin = claudeStatus?.login,
    codexLogin = codexStatus?.login;
  const codexUrl = remoteClient ? mobileLoginUrl('codex', codexLogin?.url) : officialCodexLoginUrl(codexLogin?.url);
  const grokUrl = remoteClient ? mobileLoginUrl('grok', grokStatus?.login?.url) : grokStatus?.login?.url;
  useEffect(() => {
    onStatus?.({claude: claudeStatus, codex: codexStatus, gemini: geminiStatusForConsumers, grok: grokStatus});
  }, [claudeStatus, codexStatus, geminiStatusForConsumers, grokStatus, onStatus]);
  if (hidden || !['codex', 'claude', 'gemini', 'grok'].some(enabled)) return null;
  return (
    <details
      className="provider-auth-status"
      open={accountsOpen}
      onToggle={event => setAccountsOpen(event.newState === 'open')}
    >
      <summary aria-label="帳號連線">
        <span>帳號連線</span>
        <span className="account-summary">
          {enabled('codex') && (<span className={codexVerified ? 'connected' : ''}>
            GPT {codexLoading ? '讀取中' : codexVerified ? '已連線' : '未連線'}
          </span>)}
          {enabled('claude') && (<span className={claudeVerified ? 'connected' : ''}>
            Claude {claudeLoading ? '讀取中' : claudeVerified ? '已連線' : '未連線'}
          </span>)}
          {enabled('gemini') && (<span className={geminiActiveVerified ? 'connected' : ''}>
            Gemini{' '}
            {geminiAccountsLoading || geminiLoading
              ? '確認中'
              : geminiActiveVerified
                ? '已登入'
                : geminiAccountActive?.auth?.status === 'signed-out' || geminiStatus?.auth?.loggedIn === false
                  ? '未登入'
                  : geminiStatus?.installed === false
                    ? '未安裝'
                    : '尚未確認'}
          </span>)}
          {enabled('grok') && (<span className={grokVerified ? 'connected' : ''}>
            Grok{' '}
            {grokLoading
              ? '確認中'
              : grokVerified
                ? '已登入'
                : grokStatus?.auth?.loggedIn === false
                  ? '未登入'
                  : grokStatus?.installed === false
                    ? '未安裝'
                    : '尚未確認'}
          </span>)}
          <ChevronDown size={14} />
        </span>
      </summary>
      {enabled('codex') && (<div className="provider-auth-row">
        <div className="provider-auth-copy">
          <strong>GPT / Codex 訂閱</strong>
          <span>{codexStatusText}</span>
        </div>
        <div className="provider-auth-actions">
          {codexLogin?.status === 'running' ? (
            <>
              <span role="status">等待完成官方登入。</span>
              {remoteClient && codexLogin.url && !codexUrl && (
                <small>這次登入由電腦啟動；請先停止登入，再從手機重新開始。</small>
              )}
              {codexLogin.userCode && (
                <span>
                  裝置驗證碼：<strong>{codexLogin.userCode}</strong>
                </span>
              )}
              {codexUrl && (
                <a href={codexUrl} target="_blank" rel="noreferrer">
                  開啟官方登入頁
                </a>
              )}
              <button type="button" disabled={codexAction} onClick={() => updateCodexLogin('login/cancel')}>
                停止登入
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={disabled || !!logoutAction || codexAction || codexLoading || codexVerified}
              onClick={() => updateCodexLogin('login')}
            >
              登入 GPT / Codex
            </button>
          )}
          {codexAuth?.loggedIn && (
            <button
              type="button"
              disabled={disabled || !!logoutAction || codexAction || codexLoading || codexLogin?.status === 'running'}
              onClick={() => signOut('codex')}
            >
              登出 GPT / Codex
            </button>
          )}
          {logoutNotice.codex && <small role="status">{logoutNotice.codex}</small>}
          <button
            type="button"
            disabled={codexAction || codexLoading}
            onClick={() => refreshCodexStatus({refreshModels: true})}
          >
            <RefreshCw size={14} />
            刷新狀態
          </button>
          {codexLogin?.status === 'error' && <small role="status">登入未成功；刷新狀態後可再試一次。</small>}
          {codexLogin?.status === 'complete' && !codexVerified && (
            <small role="status">登入流程已結束，但目前尚未確認可用的 ChatGPT 訂閱。</small>
          )}
        </div>
      </div>)}
      {enabled('grok') && (<div className="provider-auth-row">
        <div className="provider-auth-copy">
          <strong>Grok 訂閱</strong>
          <span>{grokStatusText}</span>
        </div>
        <div className="provider-auth-actions">
          <button
            type="button"
            disabled={
              disabled ||
              !!logoutAction ||
              grokAction ||
              grokLoading ||
              grokVerified ||
              grokStatus?.installed === false ||
              grokStatus?.login?.status === 'running'
            }
            onClick={() => startGrokLogin()}
          >
            登入 Grok
          </button>
          {grokStatus?.auth?.loggedIn && (
            <button
              type="button"
              disabled={disabled || !!logoutAction || grokAction || grokLoading}
              onClick={() => signOut('grok')}
            >
              登出 Grok
            </button>
          )}
          {logoutNotice.grok && <small role="status">{logoutNotice.grok}</small>}
          <button
            type="button"
            disabled={grokAction || grokLoading}
            onClick={() => refreshGrokStatus({refreshModels: true})}
          >
            <RefreshCw size={14} />
            刷新狀態
          </button>
          {grokStatus?.login?.status === 'running' && (
            <>
              {remoteClient && grokStatus.login.url && !grokUrl && (
                <small>這次登入由電腦啟動；請先停止登入，再從手機重新開始。</small>
              )}
              {grokStatus.login.userCode && (
                <span>
                  裝置驗證碼：<strong>{grokStatus.login.userCode}</strong>
                </span>
              )}
              <button type="button" disabled={grokAction} onClick={() => startGrokLogin(true)}>
                停止登入
              </button>
            </>
          )}
          {grokStatus?.login?.error && <small role="status">{grokStatus.login.error}</small>}
          {grokUrl && !grokVerified && (
            <a href={grokUrl} target="_blank" rel="noreferrer">
              開啟官方登入頁
            </a>
          )}
          {grokNotice && <small role="status">{grokNotice}</small>}
        </div>
      </div>)}
      {enabled('claude') && (<div className="provider-auth-row">
        <div className="provider-auth-copy">
          <strong>Claude 訂閱</strong>
          <span>{claudeStatusText}</span>
        </div>
        <div className="provider-auth-actions">
          {claudeLogin?.status === 'running' ? (
            <>
              <span role="status">
                {claudeLogin.codeSubmitted ? '已交付官方驗證，尚未確認登入完成。' : '等待你完成官方登入。'}
              </span>
              {officialLoginUrl(claudeLogin.url) ? (
                <>
                  <a href={officialLoginUrl(claudeLogin.url)} target="_blank" rel="noreferrer">
                    開啟官方登入頁
                  </a>
                  <button type="button" onClick={copyClaudeLogin}>
                    複製登入連結
                  </button>
                  <small>官方顯示授權碼後，貼到下方，不要貼進聊天。</small>
                  {!claudeLogin.codeSubmitted && (
                    <div className="claude-code-entry">
                      <label>
                        Claude 官方授權碼
                        <input
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={claudeCode}
                          maxLength={4096}
                          onChange={event => setClaudeCode(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Enter') event.preventDefault();
                          }}
                          placeholder="貼上這次登入的完整授權碼"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={claudeAction || !claudeCode.trim()}
                        onClick={() => updateClaudeLogin('login/code', {code: claudeCode})}
                      >
                        交付官方驗證
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <small>正在等候官方登入連結…</small>
              )}
              <button type="button" disabled={claudeAction} onClick={() => updateClaudeLogin('login/cancel')}>
                停止登入
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={disabled || !!logoutAction || claudeAction || claudeLoading || claudeVerified}
              onClick={() => updateClaudeLogin('login')}
            >
              登入 Claude 訂閱
            </button>
          )}
          {auth?.loggedIn && (
            <button
              type="button"
              disabled={
                disabled || !!logoutAction || claudeAction || claudeLoading || claudeLogin?.status === 'running'
              }
              onClick={() => signOut('claude')}
            >
              登出 Claude
            </button>
          )}
          {logoutNotice.claude && <small role="status">{logoutNotice.claude}</small>}
          {claudeLoginNotice && <small role="status">{claudeLoginNotice}</small>}
          <button
            type="button"
            disabled={claudeAction || claudeLoading}
            onClick={() => refreshClaudeStatus({refreshModels: true, fresh: true})}
          >
            <RefreshCw size={14} />
            刷新狀態
          </button>
          {claudeLogin?.status === 'error' && <small role="status">登入未成功；刷新狀態後可再試一次。</small>}
          {claudeLogin?.status === 'complete' && !claudeVerified && (
            <small role="status">登入流程已結束，但目前尚未確認可用的 Claude 訂閱。</small>
          )}
        </div>
      </div>)}
      {enabled('gemini') && (<div className="provider-auth-row gemini-account-row">
        <div className="provider-auth-copy">
          <strong>Gemini / Antigravity 訂閱</strong>
          <span>
            {geminiAccountsLoading
              ? '正在讀取帳號狀態…'
              : geminiAccountActive
                ? `目前使用：${geminiAccountActive.email}`
                : geminiRegistered
                  ? '尚未選擇目前使用的帳號。'
                  : geminiLoading
                    ? '正在確認 Gemini 登入狀態…'
                    : geminiStatus?.reason}
          </span>
          {geminiStatus?.auth?.checkedAt && !geminiAccountRows.length && (
            <small>上次確認：{new Date(geminiStatus.auth.checkedAt).toLocaleTimeString('zh-TW')}</small>
          )}
        </div>
        <div className="provider-auth-actions">
          {geminiAccountsLoading ? (
            <span role="status">正在讀取 Gemini 帳號…</span>
          ) : (
            <>
              {!geminiLoginPending && geminiAccountsEnabled && (
                <div className="provider-auth-actions">
                  {geminiActiveVerified && (
                    <button
                      type="button"
                      disabled={disabled || !!logoutAction || geminiAction || geminiBusy}
                      onClick={() => signOut('gemini')}
                    >
                      登出 Gemini
                    </button>
                  )}
                </div>
              )}
              {logoutNotice.gemini && <small role="status">{logoutNotice.gemini}</small>}
              {geminiAccountRows.map(account => {
                const active = account.id === geminiAccounts.activeAccountId,
                  authenticated = account.auth?.status === 'authenticated',
                  quota = account.quota;
                const historical = quotaIsHistorical(quota);
                const value = key => (historical ? '—' : quotaPercent(quota?.windows?.find(w => w.key === key)));
                return (
                  <div className="gemini-account-card" key={account.id} data-account-id={account.id}>
                    <div className="gemini-account-card-head">
                      <strong>{account.email || '未確認帳號'}</strong>
                      <span>
                        {active ? '目前使用 · ' : ''}
                        {authenticated ? '已驗證' : account.auth?.status === 'signed-out' ? '待重新登入' : '尚未確認'}
                      </span>
                    </div>
                    {account.auth?.checkedAt && (
                      <small>登入確認：{new Date(account.auth.checkedAt).toLocaleString('zh-TW')}</small>
                    )}
                    <small>
                      {quota?.checkedAt
                        ? `上次實查：${new Date(quota.checkedAt).toLocaleString('zh-TW')}`
                        : '尚無查詢時間'}
                      ；以下為該次回報，非即時額度。
                    </small>
                    <div className="gemini-account-quota">
                      <span>每週：{value('seven_day')}</span>
                      <span>5 小時：{value('five_hour')}</span>
                      {extraQuotaLines(quota).map(g => (
                        <span key={g.name}>
                          {g.name}：{g.historical ? '—' : g.text}
                        </span>
                      ))}
                    </div>
                    {historical && <small>目前額度待查詢，不以舊資料判定可用或耗盡。</small>}
                    <details className="account-quota-history">
                      <summary>{historical ? '上次查詢紀錄' : '查詢與重設時間'}</summary>
                      <small>
                        {quota?.checkedAt
                          ? `額度查詢：${new Date(quota.checkedAt).toLocaleString('zh-TW')}`
                          : '尚未查詢額度。'}
                      </small>
                      {quota?.windows?.map(w => (
                        <small key={w.key}>
                          {historical ? '上次回報・' : ''}
                          {w.label || (w.key === 'seven_day' ? '每週' : '5 小時')}：{quotaPercent(w)}；重設時間：
                          {quotaReset(w)}
                        </small>
                      ))}
                      {extraQuotaLines(quota).flatMap(g =>
                        g.windows.map(w => (
                          <small key={g.name + w.key}>
                            {g.historical ? '上次回報・' : ''}
                            {g.name} {w.label}：{quotaPercent(w)}；重設時間：{quotaReset(w)}
                          </small>
                        ))
                      )}
                    </details>
                    {!active && (
                      <button
                        type="button"
                        disabled={
                          disabled || geminiAction || geminiBusy || !geminiAccountsEnabled || geminiLoginPending
                        }
                        onClick={() => geminiAccountAction('activate', {accountId: account.id})}
                      >
                        切換使用
                      </button>
                    )}
                  </div>
                );
              })}
              {!geminiAccountRows.length && (
                <div className="gemini-account-empty">
                  <span>
                    {geminiAccounts?.mode === 'official'
                      ? 'K 使用 Antigravity 目前的官方登入。換帳號時，請先結束工作，再登出並登入另一個帳號。'
                      : geminiLoading
                      ? '正在確認登入狀態…'
                      : geminiLegacyVerified
                        ? '目前 Antigravity 登入已驗證；可直接新增帳號，或選擇保存目前登入。'
                        : geminiStatus?.auth?.loggedIn === false
                          ? '目前尚未登入 Gemini，可直接開始新增帳號。'
                          : '尚未確認目前登入狀態，可直接開始新增帳號。'}
                  </span>
                  <div className="provider-auth-actions">
                    {geminiLegacyVerified && geminiAccounts?.mode !== 'official' && (
                      <button
                        type="button"
                        disabled={
                          disabled || geminiAction || geminiBusy || geminiLoginPending || !geminiAccountsEnabled
                        }
                        onClick={() => geminiAccountAction('capture')}
                      >
                        保存目前登入
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={
                        disabled ||
                        geminiAction ||
                        geminiBusy ||
                        geminiLoginPending ||
                        !geminiAccountsEnabled ||
                        !geminiStatus?.installed
                      }
                      onClick={() => geminiAccountAction('login')}
                    >
                      {geminiAccounts?.mode === 'official' ? '開啟官方登入' : '新增 Gemini 帳號'}
                    </button>
                    <button
                      type="button"
                      disabled={
                        geminiAction ||
                        geminiLoading ||
                        geminiLoginPending ||
                        (geminiUncertain && !geminiAccountsEnabled)
                      }
                      onClick={async () => {
                        if (geminiUncertain) await geminiAccountAction('refresh');
                        void refreshGeminiStatus();
                        void refreshGeminiAccounts();
                      }}
                    >
                      <RefreshCw size={14} />
                      刷新狀態
                    </button>
                  </div>
                  {!remoteClient && geminiAccounts?.mode !== 'official' && (
                    <small>開始新增前請先關閉官方 Antigravity／agy；保存或取消前也請先關閉。K 不會強制關閉程式。</small>
                  )}
                </div>
              )}
              {geminiLoginPending && (
                <div className="gemini-login-pending" role="status">
                  <strong>{geminiAccounts?.mode === 'official' ? '正在進行官方登入' : '正在新增 Gemini 帳號'}</strong>
                  {geminiManualLogin ? (
                    <>
                      <span>
                        {geminiLogin?.codeSubmitted
                          ? '已交付官方驗證，請等待登入結果。'
                          : '開啟 Google 官方登入頁，完成後把授權碼貼到下方。'}
                      </span>
                      {mobileLoginUrl('gemini', geminiLogin?.url) && (
                        <>
                          <a href={mobileLoginUrl('gemini', geminiLogin.url)} target="_blank" rel="noreferrer">
                            開啟官方登入頁
                          </a>
                          {geminiLogin.status === 'running' && !geminiLogin.codeSubmitted && (
                            <div className="claude-code-entry">
                              <label>
                                Gemini 官方授權碼
                                <input
                                  type="password"
                                  autoComplete="off"
                                  spellCheck={false}
                                  maxLength={4096}
                                  value={geminiCode}
                                  onChange={event => setGeminiCode(event.target.value)}
                                />
                              </label>
                              <button
                                type="button"
                                disabled={geminiAction || !geminiCode.trim()}
                                onClick={() => geminiAccountAction('code', {code: geminiCode.trim()})}
                              >
                                交付官方驗證
                              </button>
                            </div>
                          )}
                        </>
                      )}
                      {geminiLogin?.status === 'complete' && <span>官方流程已結束，請確認登入狀態。</span>}
                      {geminiLogin?.error && <span>{geminiLogin.error}</span>}
                    </>
                  ) : geminiAccounts?.mode === 'official' ? (
                    <span>請在官方視窗完成驗證並關閉視窗，再回來按「確認登入」。取消前也請先關閉視窗。</span>
                  ) : (
                    <span>
                      請本人在官方 Antigravity 登入程式完成 Google
                      登入；完成後先關閉官方視窗，再按「登入完成，保存帳號」。取消前也請先關閉官方視窗；K
                      不會強制關閉。若已有原帳號，取消會恢復原帳號；若原本未登入，取消不會撤銷你在官方程式完成的登入，該登入仍未加入
                      K。
                    </span>
                  )}
                  <div className="provider-auth-actions">
                    <button
                      type="button"
                      disabled={
                        disabled ||
                        geminiAction ||
                        !geminiAccountsEnabled ||
                        (geminiManualLogin && (!geminiLogin || geminiLogin.status === 'running'))
                      }
                      onClick={() => geminiAccountAction('finish')}
                    >
                      {geminiAccounts?.mode === 'official' ? '確認登入' : '登入完成，保存帳號'}
                    </button>
                    <button
                      type="button"
                      disabled={geminiAction || !geminiAccountsEnabled}
                      onClick={() => geminiAccountAction('cancel')}
                    >
                      {geminiAccounts?.mode === 'official' ? '取消登入' : '取消新增'}
                    </button>
                  </div>
                </div>
              )}
              {geminiAccountRows.length > 0 && (
                <div className="provider-auth-actions">
                  {!geminiLoginPending && (
                    <button
                      type="button"
                      disabled={disabled || !!logoutAction || geminiAction || geminiBusy || !geminiAccountsEnabled}
                      onClick={() => geminiAccountAction('login')}
                    >
                      {geminiActiveVerified ? '新增 Gemini 帳號' : '登入 Gemini'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={
                      disabled ||
                      geminiAction ||
                      (geminiBusy && !geminiUncertain) ||
                      !geminiAccountsEnabled ||
                      geminiLoginPending
                    }
                    onClick={() => geminiAccountAction('refresh-all')}
                  >
                    更新全部帳號額度
                  </button>
                </div>
              )}
              {geminiBusy && !geminiUncertain && (
                <small role="status">
                  {geminiAccounts?.checking
                    ? geminiAccounts.progress
                      ? `正在查詢 Gemini 額度（${geminiAccounts.progress.current}／${geminiAccounts.progress.total}），查詢結束後即可切換帳號。`
                      : '正在查詢 Gemini 額度，查詢結束後即可切換帳號。'
                    : 'Gemini 正在工作或確認帳號，請等目前操作結束後再切換或登入其他帳號。'}
                </small>
              )}
              {!geminiAccountsEnabled && (
                <small role="status">此版本尚未開放帳號保存、登入或切換；不會更動目前登入。</small>
              )}
              {geminiAccounts?.reason && <small>{geminiAccounts.reason}</small>}
            </>
          )}
          {!geminiAccountRows.length && !geminiAccountsLoading && geminiAccounts?.mode !== 'official' && (
            <small>目前 Antigravity 登入只供本機使用；保存前仍須確認登入狀態。首次需完成官方初始設定。</small>
          )}
          {geminiNotice && <small role="status">{geminiNotice}</small>}
        </div>
      </div>)}
    </details>
  );
}
