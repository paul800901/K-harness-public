import {DiscussionEntry} from './discussion-roundtable.jsx';
import {ActionBarPrimitive, MessagePrimitive, SelectionToolbarPrimitive, useAuiState} from '@assistant-ui/react';
import {Check, Copy, FileText} from 'lucide-react';
import {CopyFeedback, NativeReasoning, ThoughtStream} from './native-ui.jsx';
import {MarkdownTextPrimitive} from '@assistant-ui/react-markdown';
import React, {useContext, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {RemoteRecord} from './remote-record.jsx';
import {effortName} from './model-picker.jsx';
import {modelProvider as providerOf} from '../shared/model-provider.mjs';
import {elapsedConversationMs, formatElapsed} from '../shared/conversation-groups.mjs';
import {
  messageFileUrl,
  nativeDestinationKind,
  preserveNativeUrl,
  readableDestination,
  restoreNativeFileDestinations
} from '../shared/native-content.mjs';
import {parseResponseAnnotations} from './response-annotations.mjs';
import remarkGfm from 'remark-gfm';
import {Modal, TranscriptContext, api, toolStatusName} from './app-common.jsx';

export function CodeHeader({language, code}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-header">
      <span>{language || '程式碼'}</span>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? '已複製' : '複製程式碼'}
      </button>
    </div>
  );
}
export function NativeLink({href, children, title}) {
  const {preview, revealFile, state} = useContext(TranscriptContext),
    kind = nativeDestinationKind(href);
  if (kind === 'file')
    return (
      <a
        href={messageFileUrl(href, state.threadId)}
        draggable={false}
        className="inline-file"
        title={title || readableDestination(href)}
        onAuxClick={event => event.preventDefault()}
        onClick={event => {
          event.preventDefault();
          // The desktop shell reveals the file in File Explorer; a browser
          // cannot reach the OS, so it keeps the in-page preview.
          if (window.kBrowser?.revealMessageFile) void revealFile(event.currentTarget.href);
          else preview(href, 'message-file');
        }}
      >
        <FileText size={14} />
        {children}
      </a>
    );
  if (['web', 'external', 'fragment'].includes(kind))
    return (
      <a href={href} title={title} target={kind === 'fragment' ? undefined : '_blank'} rel="noreferrer">
        {children}
      </a>
    );
  return (
    <span>
      {children}
      {href && <code className="native-destination">{href}</code>}
    </span>
  );
}
export function NativeImage({src, alt, title}) {
  const {state} = useContext(TranscriptContext),
    kind = nativeDestinationKind(src);
  if (['file', 'web'].includes(kind) || /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/iu.test(src ?? ''))
    return (
      <img
        className="native-message-image"
        src={kind === 'file' ? messageFileUrl(src, state.threadId) : src}
        alt={alt ?? ''}
        title={title}
        referrerPolicy="no-referrer"
      />
    );
  return (
    <span>
      {alt}
      {src && <code className="native-destination">{src}</code>}
    </span>
  );
}
// The main model's start mark reads as a short note, not a code block. Whether a discussion actually started
// shows in the room (the discussion itself, or a "討論未開始" notice).
const discussionStartMark = {
  CodeHeader: () => null,
  SyntaxHighlighter: () => <p className="discussion-start-mark">主模型標記：開始討論</p>
};
export function Markdown() {
  return (
    <MarkdownTextPrimitive
      className="markdown"
      remarkPlugins={[remarkGfm, restoreNativeFileDestinations]}
      urlTransform={preserveNativeUrl}
      smooth={false}
      components={{CodeHeader, a: NativeLink, img: NativeImage}}
      componentsByLanguage={{'k-discussion': discussionStartMark}}
    />
  );
}
export const isImageAttachment = a => a.kind === 'image' || /\.(png|jpe?g|webp|gif|avif)$/i.test(a.name ?? '');
export const attachmentUrl = (id, threadId, download = false) =>
  `/api/attachment?id=${encodeURIComponent(id)}&threadId=${encodeURIComponent(threadId ?? '')}${download ? '&download=1' : ''}`;
const sizeText = size =>
  !Number.isFinite(size)
    ? ''
    : size < 1024
      ? `${size} B`
      : size < 1048576
        ? `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`
        : `${(size / 1048576).toFixed(size < 10485760 ? 1 : 0)} MB`;
export function AttachmentLabel({name, size, children}) {
  const type = name.match(/\.([^.]+)$/)?.[1].toUpperCase() ?? '檔案',
    bytes = sizeText(size);
  return (
    <>
      <span className="attachment-icon" aria-hidden="true">
        <FileText size={18} />
      </span>
      <span className="attachment-text">
        <span className="attachment-name">{name}</span>
        <span className="attachment-type">{bytes ? `${type} · ${bytes}` : type}</span>
        {children}
      </span>
    </>
  );
}
// Thumbnail plus an in-page viewer for the original; download stays one click away in the viewer.
export function AttachmentImage({attachment: a, threadId, className = '', children}) {
  const [open, setOpen] = useState(false),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  const src = `${attachmentUrl(a.id, threadId)}${attempt ? `&retry=${attempt}` : ''}`;
  // An image that cannot be shown falls back to a file card, so the original can still be downloaded.
  if (failed)
    return (
      <div className="file-chip attachment-chip attachment-image-failed" title={a.name}>
        <a className="attachment-download" href={attachmentUrl(a.id, threadId, true)} aria-label={`下載附件 ${a.name}`}>
          <AttachmentLabel name={a.name} size={a.size}>
            <small>圖片無法顯示</small>
          </AttachmentLabel>
        </a>
        <button
          type="button"
          className="attachment-retry"
          aria-label={`重新載入圖片 ${a.name}`}
          onClick={() => {
            setFailed(false);
            setAttempt(n => n + 1);
          }}
        >
          重新載入
        </button>
        {children}
      </div>
    );
  return (
    <div className={`attachment-chip attachment-image ${className}`} title={a.name}>
      <button type="button" className="attachment-image-open" aria-label={`檢視圖片 ${a.name}`} onClick={() => setOpen(true)}>
        <img src={src} alt={a.name} draggable={false} onError={() => setFailed(true)} />
      </button>
      {children}
      {open && (
        <Modal className="image-viewer" title={a.name} onClose={() => setOpen(false)}>
          <img className="image-viewer-picture" src={src} alt={a.name} />
          <div className="modal-actions">
            <a className="primary" href={attachmentUrl(a.id, threadId, true)}>
              下載原檔
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}
export function UserMessageText({children}) {
  const [expanded, setExpanded] = useState(false),
    [long, setLong] = useState(false),
    contentRef = useRef(null),
    textRef = useRef(null),
    buttonRef = useRef(null),
    restoreFocus = useRef(false),
    contentId = useId();
  useLayoutEffect(() => {
    const content = contentRef.current;
    // Measure wrapped text, not character count: phone widths and font sizes differ.
    const measure = () => setLong(content.scrollHeight > 8 * parseFloat(getComputedStyle(content).lineHeight) + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (expanded || !restoreFocus.current) return;
    restoreFocus.current = false;
    const button = buttonRef.current,
      reveal = () => button?.scrollIntoView({block: 'nearest', behavior: 'instant'});
    button?.focus({preventScroll: true});
    reveal();
    // The thread viewport reacts to this same collapse in its own content
    // observers (e.g. following new output to the bottom), after this effect.
    // An observer created now is notified after those in that frame, so the
    // collapsed control is revealed last. One notification, then disconnected.
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      reveal();
    });
    observer.observe(textRef.current);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <>
      <div ref={textRef} id={contentId} className="user-message-text" data-expanded={expanded}>
        <div ref={contentRef}>{children}</div>
      </div>
      {long && (
        <button
          ref={buttonRef}
          type="button"
          className="user-text-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => {
            restoreFocus.current = expanded;
            setExpanded(!expanded);
          }}
        >
          {expanded ? '收合' : '展開全文'}
        </button>
      )}
    </>
  );
}
export function UserContent({record}) {
  if (record?.discussionHandoff)
    return (
      <>
        <small>已帶入前段討論，保留各模型原始意見與分歧。</small>
        <UserContent record={{...record, text: record.displayText, discussionHandoff: false}} />
      </>
    );
  const envelope = parseResponseAnnotations(record?.text ?? '');
  if (!envelope) return <UserMessageText>{record?.displayText ?? <MessagePrimitive.Parts />}</UserMessageText>;
  return (
    <>
      {envelope.text && (
        <UserMessageText>
          <div className="user-quote-prompt">{envelope.text}</div>
        </UserMessageText>
      )}
      {!!envelope.references.length && (
        <details className="user-quote-context">
          <summary>引用 {envelope.references.length} 段助理回覆</summary>
          {envelope.references.map((item, index) => (
            <section key={`${index}-${item.source_message_id ?? ''}`}>
              <strong>引用段落 {index + 1}</strong>
              <blockquote>{item.quote}</blockquote>
              {item.annotation && (
                <p>
                  <strong>我的註解</strong>
                  {item.annotation}
                </p>
              )}
            </section>
          ))}
        </details>
      )}
      {!!envelope.notes?.length && (
        <details className="user-quote-context user-room-notes">
          <summary>協調訊息 {envelope.notes.length} 則</summary>
          {envelope.notes.map((item, index) => (
            <section key={item.id ?? index}>
              <strong>來自「{item.from.title || '未命名聊天室'}」</strong>
              <blockquote>{item.text}</blockquote>
            </section>
          ))}
        </details>
      )}
    </>
  );
}
export function userCopyText(record) {
  const text = (record?.discussionHandoff ? record.displayText : record?.text) ?? '',
    envelope = parseResponseAnnotations(text);
  return envelope
    ? [
        envelope.text,
        ...envelope.references.map(
          (item, index) =>
            `引用段落 ${index + 1}\n${item.quote}${item.annotation ? `\n\n我的註解\n${item.annotation}` : ''}`
        ),
        ...(envelope.notes ?? []).map(item => `協調訊息（來自「${item.from.title || '未命名聊天室'}」）\n${item.text}`)
      ]
        .filter(Boolean)
        .join('\n\n')
    : text;
}
export function UserMessage() {
  const id = useAuiState(s => s.message.id);
  const {state, modelName, models, messageIndex, userTurnIndex, openRoundtable} = useContext(TranscriptContext);
  const record = messageIndex.get(id);
  if (record?.kind === 'discussion' && !record.summary)
    return <DiscussionEntry record={record} state={state} onOpen={openRoundtable} />;
  // DeepSeek working on its own (goal rounds, background jobs): K did not send anything here.
  if (record?.kind === 'native-autonomous')
    return (
      <MessagePrimitive.Root className="message worker-event" data-aui-quote-selectable="false">
        <div role="note">
          <strong>DeepSeek 自主工作</strong>
          <p>{record.summary}</p>
        </div>
      </MessagePrimitive.Root>
    );
  const worker =
    record?.kind === 'worker-completion' || record?.source === 'worker-completion' || id.startsWith('luna-completion-');
  if (worker)
    return (
      <MessagePrimitive.Root className="message worker-event" data-aui-quote-selectable="false">
        <div role="note">
          <strong>K 系統事件</strong>
          <p>{record?.summary ?? 'Luna 工人完成通知'}</p>
          <details>
            <summary>查看工人結果資料</summary>
            <pre>{record?.text}</pre>
          </details>
        </div>
      </MessagePrimitive.Root>
    );
  const files = record?.attachments ?? [],
    change = state.modelChanges?.find(c => c.turnId === record?.turnId),
    capacityChange = change?.reason === 'capacity',
    changeAnchor = change ? userTurnIndex.get(change.turnId) : null,
    isCapacityContinuation = capacityChange && changeAnchor?.id === id,
    threadId = state.threadId,
    copyText = userCopyText(record);
  const plainModelName = model =>
    models.find(item => item.model === model)?.displayName ||
    (model === state.model ? state.modelDisplayName : null) ||
    {'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-sol': 'GPT-6.1 Sol'}[model] ||
    model ||
    '選擇模型';
  return (
    <MessagePrimitive.Root
      className={`message user-message${isCapacityContinuation ? ' capacity-continuation' : ''}`}
      data-aui-quote-selectable="false"
    >
      {isCapacityContinuation ? (
        <div className="capacity-model-change-note" role="note" data-aui-quote-selectable="false">
          服務容量不足，主代理已改由 {plainModelName(change.toModel)}／{effortName[change.toEffort] ?? change.toEffort}{' '}
          接續（原 {plainModelName(change.fromModel)}）
        </div>
      ) : (
        !capacityChange &&
        change &&
        changeAnchor?.id === id && (
          <div className="model-change-note">
            主代理已切換：{modelName(change.fromModel)} → {modelName(change.toModel)}
          </div>
        )
      )}
      {!isCapacityContinuation && (
        <div className="user-bubble">
          <UserContent key={`${threadId}:${id}`} record={record} />
        </div>
      )}
      {!isCapacityContinuation && !!files.length && (
        <div className="attachment-row">
          {files.map(a =>
            isImageAttachment(a) ? (
              <AttachmentImage
                attachment={a}
                threadId={threadId}
                className={files.length === 1 ? 'single' : ''}
                key={a.id}
              />
            ) : (
              <a
                className="file-chip attachment-chip"
                title={a.name}
                aria-label={`下載附件 ${a.name}`}
                href={attachmentUrl(a.id, threadId, true)}
                key={a.id}
              >
                <AttachmentLabel name={a.name} size={a.size} />
              </a>
            )
          )}
        </div>
      )}
      {!isCapacityContinuation && !!copyText && (
        <div className="message-actions">
          <CopyFeedback text={copyText} />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}
const isQuoteableReply = record =>
  record?.role === 'assistant' && !!record.text?.trim() && !record.partial && !record.streaming;
// Older projections used the native message UUID as their only proof of a public text snapshot.
const hasNativeReplySnapshot = record =>
  record?.role === 'assistant' && !!record.text?.trim() && !!(record.nativeSnapshot || record.nativeUuid);
const isCompletedReply = record =>
  isQuoteableReply(record) && !!(record.completedAt || hasNativeReplySnapshot(record));
const isTranscriptReply = (record, group) =>
  record?.role === 'assistant' &&
  (record.id === group.latestAssistant?.id ||
    record.id === group.conclusion?.id ||
    isCompletedReply(record) ||
    hasNativeReplySnapshot(record));

export function TurnProcess({group, state}) {
  const [now, setNow] = useState(Date.now()),
    [expanded, setExpanded] = useState(false),
    summaryRef = useRef(null),
    restoreFocus = useRef(false);
  const groupLatestAssistant = group?.latestAssistant,
    latestPartial = !!(groupLatestAssistant?.partial || groupLatestAssistant?.streaming),
    isLatest = !!group && group.messages.some(m => m.id === state.messages?.at(-1)?.id),
    active = isLatest && !!state.busy,
    unfinished = latestPartial && !active;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useLayoutEffect(() => {
    if (expanded || !restoreFocus.current) return;
    restoreFocus.current = false;
    // A pinned header moves back into flow on collapse; keep this reply reachable.
    summaryRef.current?.focus({preventScroll: true});
    summaryRef.current?.scrollIntoView({block: 'nearest', behavior: 'instant'});
  }, [expanded]);
  if (!group) return null;
  const close = () => {
    restoreFocus.current = true;
    setExpanded(false);
  };
  const elapsed = elapsedConversationMs(active || unfinished ? {...group, completedAt: null} : group, now),
    items = group.messages.filter(m => m.role !== 'user' && !isTranscriptReply(m, group)),
    tools = (state.tools ?? []).filter(t => t.groupId && t.groupId === group.id);
  const timeline = expanded
    ? [
        ...items.map(item => ({id: item.id, createdAt: item.createdAt, kind: 'message', item})),
        ...tools.map(item => ({id: `tool-${item.id}`, createdAt: item.createdAt, kind: 'tool', item}))
      ].sort((a, b) => {
        const aa = Date.parse(a.createdAt ?? ''),
          bb = Date.parse(b.createdAt ?? '');
        return Number.isFinite(aa) && Number.isFinite(bb) ? aa - bb : 0;
      })
    : [];
  return (
    <>
    <details className="turn-process" open={expanded}>
      <summary
        ref={summaryRef}
        onClick={event => {
          event.preventDefault();
          if (expanded) close();
          else setExpanded(true);
        }}
      >
        <span>
          {active
            ? `已耗時 ${elapsed === null ? '' : formatElapsed(elapsed)}`
            : unfinished
              ? '未完成'
              : elapsed === null
                ? '處理過程'
                : `處理了 ${formatElapsed(elapsed)}`}
        </span>
        <span className="turn-process-toggle">
          {expanded ? '收合細節' : '查看細節'}{' '}
          <span className="turn-process-chevron" aria-hidden="true">
            ›
          </span>
        </span>
      </summary>
      {expanded && (
        <div
          className="turn-process-content"
          tabIndex={0}
          role="region"
          aria-label="處理細節"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <NativeReasoning state={state} group={group} />
          {timeline.map(entry =>
            entry.kind === 'message' ? (
              <section key={entry.id}>
                <strong>
                  {entry.item.kind === 'worker-completion' || entry.item.source === 'worker-completion'
                    ? 'K 系統事件'
                    : entry.item.role === 'user'
                      ? '送入工作中的訊息'
                      : '助理過程'}
                </strong>
                <pre>{entry.item.summary ?? entry.item.text ?? ''}</pre>
              </section>
            ) : (
              <section key={entry.id}>
                {entry.item.detailsDeferred ? (
                  <RemoteRecord
                    threadId={state.threadId}
                    kind="tool"
                    id={entry.item.id}
                    summary={`工具：${entry.item.name} · ${toolStatusName[entry.item.status] ?? entry.item.status}`}
                  >
                    {({tool}) => (
                      <pre>
                        {tool.output ??
                          (typeof tool.details === 'string' ? tool.details : JSON.stringify(tool.details)) ??
                          tool.status}
                      </pre>
                    )}
                  </RemoteRecord>
                ) : (
                  <>
                    <strong>工具：{entry.item.name}</strong>
                    <pre>
                      {entry.item.output ??
                        (typeof entry.item.details === 'string'
                          ? entry.item.details
                          : JSON.stringify(entry.item.details)) ??
                        entry.item.status}
                    </pre>
                  </>
                )}
              </section>
            )
          )}
        </div>
      )}
    </details>
    {active && !expanded && <ThoughtStream state={state} group={group} />}
    </>
  );
}
// Shown when the core keeps no record of which model wrote a reply; the provider is bound to the room.
const providerLabel = {codex: 'GPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', deepseek: 'DeepSeek', gemma: '自架模型'};
export function AssistantMessage() {
  const id = useAuiState(s => s.message.id),
    {state, models, branch, groups, messageIndex, replyModels, openRoundtable} = useContext(TranscriptContext);
  const record = messageIndex.get(id),
    messageGroup = groups.get(id),
    groupLatestAssistant = messageGroup?.latestAssistant,
    groupHasTrailingPartial = !!(groupLatestAssistant?.partial || groupLatestAssistant?.streaming),
    isConclusion = messageGroup?.conclusion?.id === id,
    isGroupLatest = id === groupLatestAssistant?.id,
    latestPartial = isGroupLatest && groupHasTrailingPartial,
    group =
      (latestPartial && (state.busy || record?.partial || record?.streaming)) ||
      (isConclusion && !groupHasTrailingPartial)
        ? messageGroup
        : null;
  const quoteable = isQuoteableReply(record),
    completedReply = isCompletedReply(record);
  if (record?.kind === 'discussion' && !record.summary)
    return <DiscussionEntry record={record} state={state} onOpen={openRoundtable} />;
  if (record?.kind !== 'discussion' && messageGroup && !isTranscriptReply(record, messageGroup))
    return null;
  const discussion = record?.kind === 'discussion',
    speaker = record?.summary ? '討論整理（AI 產生）' : record?.speaker;
  const speakerProvider =
    record?.summary || record?.background
      ? 'neutral'
      : record?.model?.startsWith('gpt-')
        ? 'codex'
        : record?.model?.startsWith('claude-')
          ? 'claude'
          : providerOf(record?.model) === 'gemini'
            ? 'gemini'
            : 'neutral';
  const replyModel = replyModels?.get(id),
    replyLabel =
      discussion || record?.background
        ? null
        : replyModel
          ? models?.find(item => item.model === replyModel)?.displayName ||
            (replyModel === state.model ? state.modelDisplayName : null) ||
            replyModel
          : providerLabel[providerOf(state.model)];
  return (
    <MessagePrimitive.Root
      className={`message assistant-message${discussion ? ' discussion-message' : ''}`}
      data-discussion-provider={discussion ? speakerProvider : undefined}
    >
      <div className="assistant-body">
        {replyLabel && (
          <div className="assistant-model" data-aui-quote-selectable="false">
            {replyLabel}
          </div>
        )}
        {discussion && (
          <div className="discussion-speaker">
            <strong>{speaker}</strong>
            {record.effort && <span>／{effortName[record.effort] ?? record.effort}</span>}
            {record.partial && <span> · 未完成</span>}
          </div>
        )}
        {group && !discussion && <TurnProcess group={group} state={state} />}
        <div
          className="assistant-response-content"
          data-aui-quote-selectable={quoteable ? 'true' : 'false'}
          tabIndex={0}
          aria-label="助理回覆文字，可選取引用"
        >
          <MessagePrimitive.Parts components={{Text: Markdown}} />
        </div>
        <ActionBarPrimitive.Root className="message-actions">
          {quoteable && (isConclusion || completedReply) && (!discussion || isConclusion) && (
            <>
              {discussion && <span className="discussion-speaker-end">{speaker}</span>}
              <CopyFeedback text={record?.text} />
              {isConclusion && !groupHasTrailingPartial && !discussion && (
                <button
                  type="button"
                  title="從此結論分支新對話"
                  disabled={state.connectionOpening}
                  onClick={() => branch?.(record)}
                >
                  <Copy size={15} /> 分支
                </button>
              )}
              {record?.completedAt && (
                <time>
                  {new Date(record.completedAt).toLocaleTimeString('zh-TW', {hour: 'numeric', minute: '2-digit'})}
                </time>
              )}
            </>
          )}
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}
export const messageComponents = {UserMessage: React.memo(UserMessage), AssistantMessage: React.memo(AssistantMessage)};

export function SelectionToolbarAction({onAdd, disabled}) {
  const actionRef = useRef(null);
  useLayoutEffect(() => {
    const toolbar = actionRef.current?.closest('.response-selection-toolbar');
    if (!toolbar) return;
    let frame = 0;
    const clamp = () => {
      frame = 0;
      const selected = window.getSelection(),
        node = selected?.anchorNode,
        viewport = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.viewport'),
        bounds = viewport?.getBoundingClientRect(),
        visual = window.visualViewport,
        leftEdge = Math.max(bounds?.left ?? 0, visual?.offsetLeft ?? 0) + 8,
        topEdge = Math.max(bounds?.top ?? 0, visual?.offsetTop ?? 0) + 8,
        rightEdge =
          Math.min(bounds?.right ?? innerWidth, (visual?.offsetLeft ?? 0) + (visual?.width ?? innerWidth)) - 8,
        bottomEdge =
          Math.min(bounds?.bottom ?? innerHeight, (visual?.offsetTop ?? 0) + (visual?.height ?? innerHeight)) - 8,
        visible =
          !selected?.isCollapsed &&
          selected?.rangeCount &&
          viewport &&
          [...selected.getRangeAt(0).getClientRects()].find(
            r =>
              r.width > 0 &&
              r.height > 0 &&
              r.bottom > topEdge &&
              r.top < bottomEdge &&
              r.right > leftEdge &&
              r.left < rightEdge
          );
      const rect = toolbar.getBoundingClientRect(),
        fits = rightEdge - leftEdge >= rect.width && bottomEdge - topEdge >= rect.height;
      const style = {visibility: visible && fits ? 'visible' : 'hidden'};
      if (visible && fits) {
        const center = (Math.max(visible.left, leftEdge) + Math.min(visible.right, rightEdge)) / 2;
        style.left = `${Math.round(Math.min(Math.max(leftEdge, center - rect.width / 2), rightEdge - rect.width))}px`;
        style.top = `${Math.round(Math.min(Math.max(topEdge, visible.top - rect.height - 8), bottomEdge - rect.height))}px`;
        style.transform = 'none';
      }
      for (const [name, value] of Object.entries(style)) if (toolbar.style[name] !== value) toolbar.style[name] = value;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(clamp);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(toolbar, {attributes: true, attributeFilter: ['style']});
    window.visualViewport?.addEventListener('scroll', schedule);
    clamp();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, []);
  useEffect(() => {
    const dismiss = event => {
      if (event?.type === 'keydown' && event.key !== 'Escape') return;
      const selected = window.getSelection(),
        anchor = selected?.anchorNode,
        element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
      if (!selected || selected.isCollapsed || !element?.closest('[data-message-id]')) return;
      selected.removeAllRanges();
    };
    document.addEventListener('keydown', dismiss);
    window.addEventListener('resize', dismiss);
    window.visualViewport?.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
      window.removeEventListener('resize', dismiss);
      window.visualViewport?.removeEventListener('resize', dismiss);
    };
  }, []);
  return (
    <button ref={actionRef} type="button" aria-label="加入聊天" disabled={disabled} onClick={() => onAdd?.()}>
      加入聊天
    </button>
  );
}
// Android WebView re-finds the fixed selection handle by its on-screen point
// while the other handle is dragged. Once that handle scrolls out of the message
// viewport, the point lands on the header and the selection start jumps to the
// top of the page. Put an end that left the viewport back where it was.
export function useTouchSelectionGuard() {
  useEffect(() => {
    if (!/Android/i.test(navigator.userAgent)) return;
    let last = null;
    const inViewport = node => !!(node?.nodeType === 1 ? node : node?.parentElement)?.closest('.viewport'),
      // React may have shortened or moved the remembered node since.
      usable = (node, offset) =>
        inViewport(node) && offset <= (node.nodeType === 3 ? node.length : node.childNodes.length);
    const guard = () => {
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed) return void (last = null);
      const {anchorNode, anchorOffset, focusNode, focusOffset} = selected,
        anchorIn = inViewport(anchorNode),
        focusIn = inViewport(focusNode);
      if (anchorIn && focusIn) return void (last = {anchorNode, anchorOffset, focusNode, focusOffset});
      if (last && !anchorIn && focusIn && usable(last.anchorNode, last.anchorOffset))
        selected.setBaseAndExtent(last.anchorNode, last.anchorOffset, focusNode, focusOffset);
      else if (last && anchorIn && !focusIn && usable(last.focusNode, last.focusOffset))
        selected.setBaseAndExtent(anchorNode, anchorOffset, last.focusNode, last.focusOffset);
      else last = null;
    };
    document.addEventListener('selectionchange', guard);
    return () => document.removeEventListener('selectionchange', guard);
  }, []);
}
export function AddResponseSelectionButton({onAdd, disabled}) {
  // The primitive hides on every scroll but reopens on any keyup (including
  // Print Screen). Recheck once scrolling stops, avoiding a hide/show cycle on
  // every frame. The action only shows against visible selected lines.
  useEffect(() => {
    let timer = 0, dragging = false;
    const refresh = () => {
      clearTimeout(timer);
      if (!dragging) timer = setTimeout(() => document.dispatchEvent(new MouseEvent('mouseup')), 120);
    };
    const down = event => {if (event.pointerType === 'mouse') {dragging = true; clearTimeout(timer);}};
    const release = () => {dragging = false;};
    document.addEventListener('scroll', refresh, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', release);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('scroll', refresh, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', release);
    };
  }, []);
  // assistant-ui only re-checks the selection on mouseup/keyup. Touch selection
  // (long-press and drag handles) produces neither, so on touch devices re-run
  // the same check once the selection stops changing. Scrolling refreshes the
  // toolbar separately, so it also cancels a pending touch check.
  useEffect(() => {
    if (!window.matchMedia?.('(any-pointer: coarse)').matches) return;
    let timer = 0;
    const cancel = () => clearTimeout(timer);
    const settle = () => {
      cancel();
      timer = setTimeout(() => {
        const selected = window.getSelection();
        if (selected && !selected.isCollapsed) document.dispatchEvent(new MouseEvent('mouseup'));
      }, 400);
    };
    document.addEventListener('selectionchange', settle);
    document.addEventListener('scroll', cancel, true);
    return () => {
      cancel();
      document.removeEventListener('selectionchange', settle);
      document.removeEventListener('scroll', cancel, true);
    };
  }, []);
  return (
    <SelectionToolbarPrimitive.Root className="response-selection-toolbar">
      <SelectionToolbarAction onAdd={onAdd} disabled={disabled} />
    </SelectionToolbarPrimitive.Root>
  );
}

export function WorkProgress({plan}) {
  if (!Array.isArray(plan) || !plan.length) return null;
  const completed = plan.filter(item => ['completed', 'done'].includes(item?.status)).length,
    total = plan.length,
    current = plan.find(item => ['in_progress', 'inProgress', 'running'].includes(item?.status));
  const currentText = current?.activeForm || current?.step;
  const label = status =>
    ({
      pending: '待處理',
      in_progress: '進行中',
      inProgress: '進行中',
      running: '進行中',
      completed: '已完成',
      done: '已完成'
    })[status] ?? '未確認';
  return (
    <details className="chat-work-progress">
      <summary>
        工作進度 {completed}/{total}
        {currentText ? ` · ${currentText}` : ''}
      </summary>
      <ol>
        {plan.map((item, index) => (
          <li key={`${index}-${item?.step ?? ''}`} data-status={item?.status}>
            <span>{item?.step ?? item?.activeForm ?? '未命名項目'}</span>
            <small>{label(item?.status)}</small>
          </li>
        ))}
      </ol>
    </details>
  );
}
