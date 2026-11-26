import React, {useState} from 'react';
import {Modal, api, remoteClient} from './app-common.jsx';
import {nativeCores, visibleProviders} from '../shared/components.mjs';
import './component-picker.css';

const groups = [
  [
    'AI 核心',
    '選你要用來聊天與工作的 AI。',
    [
      ['codex', 'Codex', '使用 ChatGPT 訂閱的 GPT 模型。', '在帳號與核心下載 Codex，重開 K 後登入 ChatGPT。'],
      ['claude', 'Claude Code', '使用 Claude 訂閱的模型。', '在帳號與核心下載 Claude Code，重開 K 後登入 Claude。'],
      [
        'gemini',
        'Gemini（Antigravity）',
        '使用 Google 帳號的 Gemini 模型。',
        '在帳號與核心下載 Antigravity，重開 K 後登入 Google。'
      ],
      ['grok', 'Grok Build', '使用 Grok 訂閱的模型。', '在帳號與核心下載 Grok Build，重開 K 後登入 Grok。'],
      [
        'deepseek',
        'DeepSeek Harness',
        '使用 DeepSeek API，依用量付費。',
        '先安裝 7-Zip，再下載核心。在 API 連線設定自己的 DeepSeek 金鑰。'
      ]
    ]
  ],
  [
    '自架模型',
    '用自己的電腦或 Colab 跑模型。',
    [
      [
        'gemma',
        '本機模型',
        '在這台電腦上執行自己的模型。',
        '需要 Codex 官方程式，不必登入 GPT。將模型位置寫入私有狀態的 .runtime/gemma-main.json，再重新開啟 K。'
      ],
      [
        'colab',
        'Colab 雲端模型',
        '用自己的 Google Colab 執行模型，會用掉運算單元。',
        '需要 Codex 官方程式、自己的 Google 授權及運算單元。請依自架模型說明完成設定。'
      ]
    ]
  ],
  [
    '語音',
    '用說的輸入，或和秘書通話。',
    [
      [
        'dictation',
        '聽寫',
        '把說的話轉成文字草稿。',
        '安裝 Windows 繁體中文語音辨識，再於安裝資料夾執行 .\\Setup-K.ps1 -DictationProvider windows。也可依安裝說明選用 Whisper。'
      ],
      [
        'emma',
        '語音秘書艾瑪',
        '通話聊天、唯讀查看聊天室與工作區文字檔、轉達訊息和記事。',
        '在 API 連線設定自己的 Gemini Live 金鑰。通話需要麥克風，依用量付費。Google 搜尋與工作區以外的唯讀資料夾預設關閉，可寫入私有狀態的 .runtime/voice-emma.json 開啟。'
      ]
    ]
  ],
  [
    '操作這台電腦',
    '讓 AI 操作網頁或桌面程式。',
    [
      [
        'browser',
        'K 專用瀏覽器',
        '讓 AI 在專用 Chrome 操作網頁。',
        '離開 K 後執行 .\\scripts\\Setup-K-Browser.ps1。需要無痕模式時，在 Chrome 擴充功能頁允許無痕操作。'
      ],
      [
        'desktop',
        'Windows 桌面控制',
        '讓 AI 使用你的滑鼠、鍵盤和前景視窗。',
        '安裝 Windows-MCP，將執行檔路徑寫入私有狀態的 .runtime/desktop-control.json 的 executable。只有完整存取的聊天室能使用。'
      ]
    ]
  ],
  [
    '外部服務',
    '連接自己的付費或授權服務。',
    [
      ['api', 'API 諮詢模型', '讓其他模型參與討論或提供意見，依用量付費。', '在 API 連線新增自己的服務與金鑰。'],
      [
        'google',
        'Google 商家',
        '讀取自己的商家據點、評論和貼文。',
        '將相容用戶端的資料夾寫入私有狀態的 .runtime/google-ops.json 的 directory，並選擇該資料夾或其上一層作為工作區。'
      ]
    ]
  ],
  [
    '手機',
    '從手機連回這台電腦。',
    [
      [
        'remote',
        '手機遠端',
        '用手機瀏覽器開啟 K。',
        '用 scripts/configure-remote.mjs 建立設定，再以 Tailscale Serve 連線。完整離開並重開 K 後生效。'
      ],
      [
        'android',
        'Android App',
        '接收通知、從通知回房、選字加入聊天。',
        '先完成手機遠端，再用 android/build.ps1 -ServerOrigin 你的網址建置。'
      ]
    ]
  ]
];
const rows = groups.flatMap(([, , items]) => items);
export const componentNames = Object.fromEntries(rows);
const billable = ['deepseek', 'emma', 'api'];
export function ComponentPicker({selection, firstRun, readError, onSaved, onSettings, onClose}) {
  const [chosen, setChosen] = useState(selection ?? []);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const has = id => chosen.includes(id);
  const toggle = id => {
    setChosen(previous => {
      const next = new Set(previous);
      if (next.delete(id)) {
        if (id === 'remote') next.delete('android');
      } else {
        next.add(id);
        if (id === 'android') next.add('remote');
      }
      return [...next];
    });
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await api('components', {components: chosen});
      onSaved(result.components);
      if (firstRun && chosen.length) setStep(2);
      else onClose();
    } catch (cause) {
      setError(cause.message || '無法儲存選擇，請再試一次。');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={step === 2 ? '完成設定' : firstRun ? '選擇要用的功能' : '元件'}
      onClose={onClose}
      className="component-picker"
    >
      {step === 1 ? (
        <>
          <p className="modal-description">
            {firstRun
              ? '只會顯示你選的項目，之後可在「設定」更改。'
              : '選擇 K 要顯示的功能。取消選取會保留登入、設定和聊天室。'}
          </p>
          {groups.map(([title, hint, items]) => (
            <fieldset key={title} disabled={saving || !!readError}>
              <legend>{title}</legend>
              <p>{hint}</p>
              <div className="component-grid">
                {items.map(([id, name, description]) => (
                  <label key={id}>
                    <input type="checkbox" checked={has(id)} onChange={() => toggle(id)} aria-label={name} />
                    <span>
                      <strong>{name}</strong>
                      <small>{description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {has('android') && <p>Android App 需要手機遠端，已一併選取。</p>}
          {!visibleProviders(has).length && <p>還沒選 AI，可以先看看，暫時不能開始聊天。</p>}
          {billable.some(has) && <p>API 費用由你的帳戶支付。</p>}
          {visibleProviders(id => selection?.includes(id)).some(id => !visibleProviders(has).includes(id)) && (
            <p>取消的 AI 仍保留舊聊天室，可以繼續使用。</p>
          )}
          {['browser', 'desktop', 'google', 'colab'].some(id => selection?.includes(id) && !has(id)) && (
            <p>已開啟的連線不受影響，下次連線起停用。</p>
          )}
          {selection?.includes('remote') && !has('remote') && <p>這不會關閉遠端入口。關閉方式請看安裝說明。</p>}
          {error || readError ? <p role="alert">{error || readError}</p> : null}
          <div className="modal-actions">
            <span aria-live="polite">已選 {chosen.length} 項</span>
            <button disabled={saving} onClick={onClose}>
              {firstRun ? '稍後再選' : '取消'}
            </button>
            <button className="primary" disabled={saving || !!readError} onClick={save}>
              {firstRun ? '下一步' : '儲存'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="modal-description">選擇已儲存。可以現在設定，也可以稍後再做。</p>
          {rows
            .filter(([id]) => has(id))
            .map(([id, name, , instructions]) => (
              <section className="component-next" key={id}>
                <h3>{name}</h3>
                <p>{instructions}</p>
                {(nativeCores.includes(id) || ['api', 'emma', 'gemma', 'colab'].includes(id)) && (
                  <button onClick={onSettings}>{['emma', 'api'].includes(id) ? '設定金鑰' : '前往設定'}</button>
                )}
              </section>
            ))}
          {remoteClient && <p>核心下載與金鑰請在電腦設定。</p>}
          <div className="modal-actions">
            <button onClick={() => setStep(1)}>回上一步</button>
            <button className="primary" onClick={onClose}>
              開始使用
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
