import React, {useState} from 'react';
import {api} from './app-common.jsx';
import {useAnchoredPopover} from './anchored-popover.jsx';

export function ColabBalancePopover({balance, online}) {
  const menu = useAnchoredPopover({width: 245});
  const [requesting, setRequesting] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const checking = requesting || balance.state === 'checking';
  const failed = requestFailed || balance.state === 'unavailable';
  const fresh = online && balance.state === 'fresh' && !checking && !failed;
  // An older K publishes one unlabeled balance.
  const rows = balance.accounts ?? [{account: '', units: balance.units}];
  const refresh = async () => {
    if (!online || checking) return;
    setRequesting(true);
    setRequestFailed(false);
    try {
      await api('colab/balance', {});
    } catch {
      setRequestFailed(true);
    } finally {
      setRequesting(false);
    }
  };
  let label = '查餘額';
  let message = '按重新查詢讀取最新餘額。';
  if (!online) {
    label = '—';
    message = 'K 尚未連線。';
  } else if (checking) {
    label = '查詢中';
    message = '正在讀取 Colab 餘額…';
  } else if (failed) {
    label = '待確認';
    message = '目前查不到 Colab 餘額。';
  } else if (fresh) label = rows.map(row => row.units ?? '待確認').join('·');

  return (
    <div className="colab-balance-anchor">
      <button
        type="button"
        className="status colab-balance"
        aria-haspopup="dialog"
        aria-expanded={menu.open}
        aria-controls={menu.id}
        ref={menu.trigger}
        popoverTarget={menu.id}
        onClick={() => {
          if (!menu.popup.current?.matches(':popover-open')) void refresh();
        }}
      >
        Colab {label}
      </button>
      <section
        className="colab-balance-popover anchored-popover"
        ref={menu.popup}
        id={menu.id}
        popover="auto"
        onToggle={menu.onToggle}
        role="dialog"
        aria-label="Colab 剩餘額度"
      >
        <strong>Colab 剩餘額度</strong>
        <div role="status" aria-live="polite">
          {fresh ? (
            <>
              <ul>
                {rows.map(row => (
                  <li key={row.account}>
                    {row.account && <span>{row.account}</span>}
                    {row.units === null ? (
                      <p>查不到</p>
                    ) : (
                      <p>
                        <b>{row.units}</b> 個運算單元
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <time dateTime={balance.checkedAt}>查詢於 {new Date(balance.checkedAt).toLocaleString('zh-TW')}</time>
            </>
          ) : (
            <p>{message}</p>
          )}
        </div>
        <button type="button" disabled={!online || checking} onClick={() => void refresh()}>
          重新查詢
        </button>
      </section>
    </div>
  );
}
