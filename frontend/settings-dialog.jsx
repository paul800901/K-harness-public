import React, {useState} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import featureList from '../docs/features.md?raw';
import {Moon, Power, Sun} from 'lucide-react';
import {Modal, api, remoteClient} from './app-common.jsx';
import {AccountConnections} from './account-connections.jsx';
import {AppearanceSettings} from './appearance.jsx';
import {CoreUpdates} from './core-updates.jsx';
import {DiscussionApiSettings} from './discussion-api-settings.jsx';

/** The settings window. App owns the state and the actions that leave this dialog. */
export function SettingsDialog({
  disabled,
  theme,
  onTheme,
  appearance,
  onAppearance,
  followUpMode,
  onFollowUpMode,
  mobile,
  archiveCount,
  onUsage,
  onArchive,
  onLogout,
  onShutdown,
  onClose
}) {
  const [showFeatures, setShowFeatures] = useState(false);
  return (
    <Modal title="設定" onClose={onClose}>
      <section className="settings-section">
        <h3 className="settings-section-label">{remoteClient ? '帳號與額度' : '帳號與核心'}</h3>
        <AccountConnections defaultOpen disabled={disabled} />
        {!remoteClient && <CoreUpdates />}
        {remoteClient && (
          <>
            <p className="modal-description">
              可在此登入、登出訂閱帳號；官方驗證請本人完成。更新核心及操作電腦視窗仍需在電腦進行。
            </p>
            <div className="setting-row">
              <span>
                額度與用量<small>查看目前登入帳號的官方額度與查詢時間。</small>
              </span>
              <button onClick={onUsage}>查看／更新額度</button>
            </div>
          </>
        )}
      </section>
      <details className="feature-reference" onToggle={event => setShowFeatures(event.currentTarget.open)}>
        <summary>功能清單與設定條件</summary>
        {showFeatures && (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            a: ({href, children}) => (
              <a href={new URL(href, 'https://github.com/paul800901/K-harness-public/blob/main/docs/features.md').href}
                target="_blank" rel="noreferrer">{children}</a>
            )
          }}>{featureList}</ReactMarkdown>
        )}
      </details>
      <section className="settings-section">
        <h3 className="settings-section-label">顯示</h3>
        <div className="setting-row">
          <span>介面外觀</span>
          <div>
            <button
              className={theme === 'light' ? 'chosen' : ''}
              aria-pressed={theme === 'light'}
              onClick={() => onTheme('light')}
            >
              <Sun size={16} />
              淺色
            </button>
            <button
              className={theme === 'warm' ? 'chosen' : ''}
              aria-pressed={theme === 'warm'}
              onClick={() => onTheme('warm')}
            >
              <Sun size={16} />
              暖色
            </button>
            <button
              className={theme === 'dark' ? 'chosen' : ''}
              aria-pressed={theme === 'dark'}
              onClick={() => onTheme('dark')}
            >
              <Moon size={16} />
              深色
            </button>
          </div>
        </div>
        <AppearanceSettings value={appearance} onChange={onAppearance} hideScale={mobile} />
      </section>
      <section className="settings-section">
        <h3 className="settings-section-label">訊息</h3>
        <div className="setting-row">
          <span>
            工作中的後續訊息<small>套用到所有聊天室。無法插話時會先排隊。</small>
          </span>
          <div role="group" aria-label="工作中的後續訊息">
            <button
              className={followUpMode === 'queue' ? 'chosen' : ''}
              aria-pressed={followUpMode === 'queue'}
              disabled={disabled}
              onClick={() => onFollowUpMode('queue')}
            >
              先排隊
            </button>
            <button
              className={followUpMode === 'steer' ? 'chosen' : ''}
              aria-pressed={followUpMode === 'steer'}
              disabled={disabled}
              onClick={() => onFollowUpMode('steer')}
            >
              立即插話
            </button>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3 className="settings-section-label">討論用 API 連線</h3>
        <DiscussionApiSettings request={api} disabled={remoteClient} />
      </section>
      <section className="settings-section">
        <h3 className="settings-section-label">資料</h3>
        <div className="setting-row">
          <span>
            已封存<small>查看、還原或刪除 K 的已封存對話紀錄</small>
          </span>
          <button onClick={onArchive}>管理已封存（{archiveCount}）</button>
        </div>
        <details className="attachment-help">
          <summary>附件說明</summary>
          <p className="modal-description">
            K 不以副檔名限制一般附件，也不另設份數、單檔大小或 PDF
            頁數上限。原始檔案存入這個對話的工作區，交給目前原生核心依權限使用工具讀取；能否解讀內容依核心、模型與電腦資源，不代表模型已直接看懂影音。圖片仍依核心的圖片輸入能力。PDF／DOCX
            可附上擷取文字供參考，原檔保留；較大檔案也可直接交代已授權工作區中的路徑。
          </p>
        </details>
      </section>
      <p className="modal-description">
        {remoteClient
          ? '關閉此頁或登出不會停止電腦的背景工作。'
          : '關閉視窗不會停止背景工作。需要完全結束 K，請使用下面的停止後端。'}
      </p>
      <div className="modal-actions">
        {remoteClient ? (
          <button onClick={onLogout}>登出此遠端裝置</button>
        ) : (
          <button className="danger" onClick={onShutdown}>
            <Power size={15} />
            停止後端
          </button>
        )}
        <button className="primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
