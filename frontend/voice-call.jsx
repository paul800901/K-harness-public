import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Mic, MicOff, Minus, Phone, PhoneOff, Plus} from 'lucide-react';
import {api, remoteClient} from './app-common.jsx';
import {callSlot, microphone} from './voice-call.mjs';
import workletUrl from './pcm-capture-worklet.js?url&no-inline';
import './voice-call.css';
import {SECRETARY_NAME, SECRETARY_TITLE} from '../shared/voice-secretary-name.mjs';

// Sent when the call panel's height (and so the room kept under it) changes.
export const CALL_PANEL_RESIZED = 'k-call-panel-resized';

export const useMicrophone = () => useSyncExternalStore(microphone.subscribe, microphone.snapshot);

// Volume steps; above 100% the secretary is boosted for a noisy room.
const VOLUMES = [0.5, 0.75, 1, 1.5, 2, 3];
const PHASE = {
  connecting: '連線中…',
  listening: '聆聽中',
  speaking: `${SECRETARY_NAME}說話中`,
  thinking: `${SECRETARY_NAME}處理中`,
  reconnecting: '重新連線中…',
  ended: '已掛斷'
};

// One call at a time for the whole page; hanging up (or leaving the page) ends it for good.
export function useVoiceCall() {
  const [view, setView] = useState(null);
  const [configured, setConfigured] = useState(null);
  useEffect(() => {
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const result = await api('voice/status');
        if (current === generation) setConfigured(typeof result.configured === 'boolean' ? result.configured : null);
      } catch {
        if (current === generation) setConfigured(null);
      }
    };
    void refresh();
    window.addEventListener('k-discussion-api-refresh', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      generation++;
      window.removeEventListener('k-discussion-api-refresh', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  // Only the call in the slot may update the view; a late result from an earlier call is dropped.
  const [slot] = useState(() => callSlot(setView));
  useEffect(() => () => slot.hangUp(), [slot]);
  // An ended call closes by itself; what was sent stays in the secretary room. Only a problem stays to be read.
  useEffect(() => {
    if (view?.ended && !view.notice) slot.dismiss();
  }, [view, slot]);
  return {
    view,
    configured,
    active: !!view && !view.ended,
    start: () => slot.start({request: api, workletUrl}),
    hangUp: () => slot.hangUp(),
    control: (name, value) => slot.control(name, value),
    dismiss: () => slot.dismiss()
  };
}

export function CallButton({call, online}) {
  const mic = useMicrophone();
  const busy = !call.active && mic.dictation;
  return (
    <button
      type="button"
      className={`voice-call-button${call.active ? ' active' : ''}`}
      disabled={!call.active && (!online || busy)}
      title={
        busy
          ? '聽寫進行中，結束後才能通話'
          : call.active
            ? '通話中，按這裡掛斷'
            : call.configured === false
              ? '語音秘書尚未設定。請在電腦的「設定 → 討論用 API 連線」設定自己的 Gemini Live 金鑰。'
              : `打電話給${SECRETARY_NAME}（K 語音秘書）。首次使用請在設定連接自己的 Gemini Live 金鑰。`
      }
      onClick={() => (call.active ? call.hangUp() : call.start())}
    >
      {call.active ? <PhoneOff size={16} /> : <Phone size={16} />}
      <span>{call.active ? '掛斷' : '通話'}</span>
    </button>
  );
}

export function CallPanel({call}) {
  const view = call.view,
    panel = useRef(null);
  useEffect(() => {
    const el = panel.current,
      root = document.documentElement;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      root.style.setProperty('--voice-call-panel-height', `${el.offsetHeight}px`);
      // The secretary room re-follows its newest line once the room under the panel has changed.
      window.dispatchEvent(new Event(CALL_PANEL_RESIZED));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--voice-call-panel-height');
      window.dispatchEvent(new Event(CALL_PANEL_RESIZED));
    };
  }, [!!view]);
  if (!view) return null;
  const phase = PHASE[view.phase] ?? view.phase;
  return (
    <section
      ref={panel}
      className={`voice-call-panel phase-${view.phase}`}
      role="dialog"
      aria-label={`${SECRETARY_TITLE}通話`}
    >
      <header>
        <strong>{SECRETARY_TITLE}</strong>
        <span className="voice-call-status" role="status">
          <i aria-hidden="true" />
          {phase}
        </span>
      </header>
      <div className="voice-call-cost">本次約 US${view.cost.toFixed(3)}（本機估算，以 AI Studio 為準）</div>
      {view.lastSend && (
        <div className="voice-call-sent">
          <div className="voice-call-sent-title">
            最近送出：「{view.lastSend.title || '未命名聊天室'}」· {view.lastSend.status}
            {view.lastSend.duplicate ? '（重複要求，未重送）' : ''}
          </div>
          {view.lastSend.text && <div className="voice-call-sent-text">{view.lastSend.text}</div>}
        </div>
      )}
      {view.notice && <div className="voice-call-notice">{view.notice}</div>}
      {!view.ended && (
        <div className="voice-call-controls">
          <button
            type="button"
            className={view.muted ? 'on' : ''}
            aria-pressed={view.muted}
            onClick={() => call.control('setMuted', !view.muted)}
          >
            {view.muted ? <MicOff size={18} /> : <Mic size={18} />}
            <span>{view.muted ? '已靜音' : '靜音'}</span>
          </button>
          {view.canAdjustVolume && (
            <div className="voice-call-volume" role="group" aria-label={`${SECRETARY_NAME}音量`}>
              <button
                type="button"
                title="小聲一點"
                disabled={view.volume <= VOLUMES[0]}
                onClick={() => call.control('setVolume', VOLUMES.findLast(v => v < view.volume) ?? VOLUMES[0])}
              >
                <Minus size={16} />
              </button>
              <span>音量 {Math.round(view.volume * 100)}%</span>
              <button
                type="button"
                title="大聲一點"
                disabled={view.volume >= VOLUMES.at(-1)}
                onClick={() => call.control('setVolume', VOLUMES.find(v => v > view.volume) ?? VOLUMES.at(-1))}
              >
                <Plus size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      {!view.ended && remoteClient && (
        <small className="voice-call-hint">通話時請保持 K 在前景；切到背景或關螢幕會掛斷。</small>
      )}
      <div className="voice-call-actions">
        {view.ended ? (
          <button type="button" className="voice-call-close" onClick={call.dismiss}>
            關閉
          </button>
        ) : (
          <button type="button" className="voice-call-hangup" onClick={call.hangUp}>
            <PhoneOff size={18} /> 掛斷
          </button>
        )}
      </div>
    </section>
  );
}
