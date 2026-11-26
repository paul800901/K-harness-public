import React, {useState} from 'react';
import {Modal} from './app-common.jsx';
import {groupProjectSessions, projectKey} from './project-groups.mjs';
import './position-dialog.css';

// Keep every other workspace's and pin group's saved slots in place, including hidden rooms.
function placeWithinGroup(order, ids, source, target, after) {
  const group = new Set(ids);
  const moved = ids.filter(id => id !== source);
  moved.splice(moved.indexOf(target) + Number(after), 0, source);
  let index = 0;
  return order.map(id => (group.has(id) ? moved[index++] : id));
}

export function PositionDialog({source, projects, sessions, order, projectOrder, manual, onSave, onClose}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const groups = groupProjectSessions(projects, sessions, {sort: 'manual', order, projectOrder});
  const isProject = source.project !== undefined;
  const sourceId = isProject ? projectKey(source.project) : source.threadId;
  const workspace = isProject ? null : groups.find(p => p.sessions.some(s => s.threadId === sourceId));
  const items = isProject
    ? groups.map(p => ({id: projectKey(p.path), name: p.name, pinned: !!p.pinned}))
    : (workspace?.sessions ?? []).map(s => ({id: s.threadId, name: s.title || '未命名對話', pinned: !!s.pinned}));
  const current = items.find(item => item.id === sourceId);
  const peers = items.filter(item => item.pinned === current?.pinned);
  const visible = peers.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  async function place(target, after) {
    if (saving || !manual || !current || target === sourceId || !peers.some(item => item.id === target)) return;
    const complete = isProject ? projectOrder : order;
    const next = placeWithinGroup(
      complete,
      peers.map(p => p.id),
      sourceId,
      target,
      after
    );
    setSaving(true);
    try {
      await onSave(isProject ? {projectOrder: next} : {order: next});
      onClose();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }
  return (
    <Modal
      className="sidebar-position"
      title={current ? `將「${current.name}」移到…` : '移到指定位置'}
      onClose={event => {
        if (saving) event?.preventDefault();
        else onClose();
      }}
    >
      {error && <p role="alert">{error}</p>}
      {!manual || !current ? (
        <p>目前無法調整此項目的順序。</p>
      ) : (
        <>
          <p className="position-scope">
            {[workspace?.name, current.pinned ? '已釘選' : '未釘選', isProject ? '工作區' : '對話']
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className="position-actions">
            <button disabled={saving || peers[0]?.id === sourceId} onClick={() => place(peers[0].id, false)}>
              移到最前
            </button>
            <button disabled={saving || peers.at(-1)?.id === sourceId} onClick={() => place(peers.at(-1).id, true)}>
              移到最後
            </button>
          </div>
          {(peers.length > 8 || query) && (
            <input
              type="search"
              className="text-field"
              aria-label="搜尋名稱"
              placeholder="搜尋名稱"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setSelected(null);
              }}
            />
          )}
          <div className="position-list">
            {visible.map(item => (
              <div className="position-item" key={item.id}>
                <button
                  className="position-name"
                  disabled={saving || item.id === sourceId}
                  aria-expanded={selected === item.id}
                  onClick={() => setSelected(selected === item.id ? null : item.id)}
                >
                  {item.name}
                  {item.id === sourceId && <small>目前位置</small>}
                </button>
                {selected === item.id && (
                  <div className="position-actions">
                    <button disabled={saving} onClick={() => place(item.id, false)}>
                      放在上方
                    </button>
                    <button disabled={saving} onClick={() => place(item.id, true)}>
                      放在下方
                    </button>
                  </div>
                )}
              </div>
            ))}
            {!visible.length && <p>沒有符合的名稱</p>}
          </div>
        </>
      )}
    </Modal>
  );
}
