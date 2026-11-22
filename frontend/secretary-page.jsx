import React, {useEffect, useRef, useState} from 'react';
import {PanelLeft} from 'lucide-react';
import {api, IconButton, Modal} from './app-common.jsx';
import {CallButton, CALL_PANEL_RESIZED} from './voice-call.jsx';
import {SECRETARY_NAME} from '../shared/voice-secretary-name.mjs';

const SEND = {sending: '送出中', sent: '已送出', queued: '已排隊（尚未處理）', 'not-sent': '確定未送出', uncertain: '狀態不明（未重送）'};
const END = {
  archived: '該房已封存，停止追蹤（未停止該房工作）',
  missing: '該房已不存在，停止追蹤',
  'queue-removed': '排隊訊息已被移除，從未送進該房',
  'turn-failed': '該房這一輪失敗或中斷，沒有回覆'
};
const CREATE = {creating: '建立中', created: '已建立', 'not-created': '確定未建立', uncertain: '建立狀態不明（未重開）'};
const EFFORT = {none: '無', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '極高', max: '最高', ultra: '超高（Ultra）'};
const pad = n => String(n).padStart(2, '0');
const when = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const NOTE_SOURCE = {emma: `${SECRETARY_NAME}經口頭確認`, owner: '本人在畫面修改'};
const noteEvent = e =>
  e.op === 'add'
    ? `${SECRETARY_NAME}記下了`
    : e.op === 'edit'
      ? '本人修改了筆記'
      : `${e.source === 'owner' ? '本人' : SECRETARY_NAME}刪除了筆記`;

// Emma's notes: what the person asked her to remember. The person can read, edit and delete them here; K writes
// every change and records it in the room. Deleting asks once more so a stray tap removes nothing. Each edit or
// delete carries the text it was decided on; when the note changed meanwhile (another device, Emma) K refuses it and
// the page reads the notes again, so the person decides on what the note says now.
function NotesDialog({notes, limit, maxLength, onClose, onReload}) {
  const [editing, setEditing] = useState(null),
    [confirm, setConfirm] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const act = async (route, body) => {
    setBusy(true);
    setError('');
    try {
      const result = await api(route, body);
      setEditing(null);
      setConfirm(null);
      if (result?.stale) {
        setError(result.message);
        onReload();
      }
    } catch (e) {
      setError(e.message);
      onReload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal className="secretary-notes-dialog" title={`${SECRETARY_NAME}的筆記`} onClose={onClose}>
      <p className="secretary-notes-help">
        只記你在通話中明確要{SECRETARY_NAME}記住、她複述後你說好的事（{notes.length}／{limit} 條）。筆記只是資料，不構成任何授權。
      </p>
      {error && (
        <div className="schedule-error-alert" role="alert">
          {error}
        </div>
      )}
      {notes.length === 0 && <div className="schedule-empty">還沒有筆記。通話時說「記住……」，{SECRETARY_NAME}確認後會記在這裡。</div>}
      <ul className="secretary-notes">
        {notes.map(n => (
          <li key={n.id} className="secretary-note">
            {editing?.id === n.id ? (
              <form
                className="secretary-note-edit"
                onSubmit={e => {
                  e.preventDefault();
                  void act('voice/notes/update', {id: n.id, text: editing.text, expected: editing.base});
                }}
              >
                <textarea
                  aria-label="筆記內容"
                  value={editing.text}
                  maxLength={maxLength}
                  rows={3}
                  autoFocus
                  onChange={e => setEditing({...editing, text: e.target.value})}
                />
                <div className="secretary-note-actions">
                  <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                    取消
                  </button>
                  <button type="submit" className="primary" disabled={busy || !editing.text.trim()}>
                    儲存
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="secretary-note-text">{n.text}</div>
                <small>
                  建立 {when(n.createdAt)}
                  {n.updatedAt !== n.createdAt ? ` · 修改 ${when(n.updatedAt)}` : ''} · {NOTE_SOURCE[n.source] ?? n.source}
                </small>
                {confirm?.id === n.id ? (
                  <div className="secretary-note-confirm">
                    <span>確定刪除這條筆記？</span>
                    <div className="secretary-note-actions">
                      <button type="button" autoFocus disabled={busy} onClick={() => setConfirm(null)}>
                        取消
                      </button>
                      <button type="button" className="danger" disabled={busy} onClick={() => act('voice/notes/remove', {id: n.id, expected: confirm.text})}>
                        確認刪除
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="secretary-note-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirm(null);
                        setEditing({id: n.id, text: n.text, base: n.text});
                      }}
                    >
                      修改
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditing(null);
                        setConfirm({id: n.id, text: n.text});
                      }}
                    >
                      刪除
                    </button>
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// The secretary room: the call transcripts, what was relayed and what each room answered. Read-only text.
export function SecretaryPage({voiceRevision, sessions, onOpenSession, sidebar, setSidebar, mobile, setInspector, call, online}) {
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [notesOpen, setNotesOpen] = useState(false);
  const sequence = useRef(0),
    scroller = useRef(null);
  const load = () => {
    const current = ++sequence.current;
    api('voice/log').then(
      r => current === sequence.current && (setData(r), setError('')),
      e => current === sequence.current && setError(e.message)
    );
  };
  useEffect(load, [voiceRevision]);
  // Unlike a chat, the room always follows the newest line: during a call that is what is being said. Scrolling the
  // container to its very end also clears the room kept under the call panel, which changes with the panel.
  useEffect(() => {
    const follow = () => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    follow();
    window.addEventListener(CALL_PANEL_RESIZED, follow);
    return () => window.removeEventListener(CALL_PANEL_RESIZED, follow);
  }, [data]);
  const room = threadId => sessions.find(s => s.threadId === threadId && !s.archived);
  const openButton = threadId =>
    room(threadId) && (
      <button type="button" className="secretary-open-room" onClick={() => onOpenSession(room(threadId))}>
        開啟聊天室
      </button>
    );
  const entry = (e, i) => {
    if (e.kind === 'note')
      return (
        <li key={i} className={`secretary-card note note-${e.op}`}>
          <small>
            {noteEvent(e)} · {when(e.at)}
          </small>
          {e.op === 'edit' && <div className="secretary-card-previous">原本：{e.previous}</div>}
          <div className="secretary-card-text">{e.op === 'edit' ? `改成：${e.text}` : e.text}</div>
        </li>
      );
    if (e.kind === 'transcript')
      return (
        <li key={i} className={`secretary-line ${e.role === 'owner' ? 'owner' : 'secretary'}`}>
          <small>
            {e.role === 'owner' ? '本人' : SECRETARY_NAME} · {when(e.at)}
            {e.incomplete ? ' · 未完整' : ''}
            {e.uncertain ? ' · 段落歸屬不確定' : ''}
          </small>
          <div>{e.text}</div>
        </li>
      );
    if (e.kind === 'send')
      return (
        <li key={i} className={`secretary-card send status-${e.status}`}>
          <small>
            送進「{e.title}」· {SEND[e.status] ?? e.status} · #{e.code} · {when(e.at)}
          </small>
          <div className="secretary-card-text">{e.text}</div>
          {e.error && <div className="secretary-card-error">原因：{e.error}</div>}
          {openButton(e.threadId)}
        </li>
      );
    if (e.kind === 'create')
      return (
        <li key={i} className={`secretary-card create status-${e.status}`}>
          <small>
            {SECRETARY_NAME}開了新聊天室 · {CREATE[e.status] ?? e.status} · #{e.code} · {when(e.at)}
          </small>
          <dl className="secretary-create-settings">
            <dt>工作區</dt>
            <dd>{e.workspaceName}</dd>
            <dt>模型</dt>
            <dd>{e.modelName}</dd>
            <dt>推理程度</dt>
            <dd>{e.effort ? (EFFORT[e.effort] ?? e.effort) : '無設定'}</dd>
            <dt>權限</dt>
            <dd>{e.permissionName}</dd>
          </dl>
          {e.error && <div className="secretary-card-error">原因：{e.error}</div>}
          {e.threadId && openButton(e.threadId)}
        </li>
      );
    if (e.kind === 'report')
      return (
        <li key={i} className="secretary-card report">
          <small>
            「{e.title}」已回覆 · #{e.code} · {when(e.replyAt ?? e.at)}
          </small>
          <div className="secretary-card-text">
            {e.text}
            {e.truncated ? '…（節錄）' : ''}
          </div>
          {openButton(e.threadId)}
        </li>
      );
    return (
      <li key={i} className="secretary-end">
        #{e.code}「{e.title ?? ''}」：{END[e.reason] ?? e.reason} · {when(e.at)}
      </li>
    );
  };
  return (
    <div className="schedule-page secretary-page">
      <header className="schedule-page-header">
        {!sidebar && (
          <IconButton
            title="展開側欄"
            onClick={() => {
              setSidebar(true);
              if (mobile) setInspector(false);
            }}
          >
            <PanelLeft size={18} />
          </IconButton>
        )}
        <h1>秘書室</h1>
        <button type="button" className="secretary-notes-button" disabled={!data} onClick={() => setNotesOpen(true)}>
          筆記{data ? ` ${data.notes?.length ?? 0}` : ''}
        </button>
        <CallButton call={call} online={online} />
      </header>
      <div className="schedule-page-scroll" ref={scroller}>
        <div className="schedule-page-content">
          {error && (
            <div className="schedule-error-alert" role="alert">
              {error}
            </div>
          )}
          {data?.truncated && <div className="secretary-end">更早的紀錄未顯示。</div>}
          {data?.entries.length === 0 && (
            <div className="schedule-empty">還沒有紀錄。按「通話」跟{SECRETARY_NAME}交代事情，通話逐字稿與各房回覆都會記在這裡。</div>
          )}
          <ul className="secretary-list">{data?.entries.map(entry)}</ul>
        </div>
      </div>
      {notesOpen && data && (
        <NotesDialog notes={data.notes ?? []} limit={data.noteLimit} maxLength={data.noteMaxLength} onClose={() => setNotesOpen(false)} onReload={load} />
      )}
    </div>
  );
}
