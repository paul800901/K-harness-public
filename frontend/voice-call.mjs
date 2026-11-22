// The browser talks to Gemini Live directly
// with a one-use token from K, streams 16 kHz microphone PCM, plays 24 kHz replies, forwards tool calls to K and
// writes transcripts to the secretary room. Nothing here can send to a room by itself; K runs every tool.

export const VOICE_SOCKET =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
// Official gemini-3.8-live prices, US$ per million tokens (AI Studio pricing page, 2026-11-07). Each turn reports its
// own usage, and its prompt is the whole conversation so far; Google bills that again every turn, so turns add up.
// The prompt is split by modality where Gemini says so: K's instructions and history are text, far cheaper than
// audio. Tokens Gemini does not attribute are counted at the audio rate, so the estimate leans high, never low.
export const VOICE_PRICE = {
  input: {TEXT: 0.75, AUDIO: 3, IMAGE: 1, VIDEO: 1},
  output: {TEXT: 4.5, AUDIO: 12}
};
const priced = (total, details, rates, fallback) => {
  let counted = 0,
    cost = 0;
  for (const d of Array.isArray(details) ? details : []) {
    const n = Number(d?.tokenCount) || 0;
    counted += n;
    cost += n * (rates[d?.modality] ?? fallback);
  }
  return cost + Math.max(0, (Number(total) || 0) - counted) * fallback;
};
export const voiceCost = usage =>
  (priced(usage.promptTokenCount, usage.promptTokensDetails, VOICE_PRICE.input, VOICE_PRICE.input.AUDIO) +
    (Number(usage.toolUsePromptTokenCount) || 0) * VOICE_PRICE.input.TEXT +
    priced(
      usage.responseTokenCount ?? usage.candidatesTokenCount,
      usage.responseTokensDetails ?? usage.candidatesTokensDetails,
      VOICE_PRICE.output,
      VOICE_PRICE.output.AUDIO
    ) +
    (Number(usage.thoughtsTokenCount) || 0) * VOICE_PRICE.output.TEXT) /
  1e6;
// A person's transcript part without an audio offset that arrives this soon after a turn ended may be the late
// tail of that turn or the start of the next: it is kept with the earlier segment and marked uncertain.
export const LATE_TRANSCRIPT_MS = 1500;
export const RISKY_RESUME_NOTICE = '伺服器即將結束連線，已在對話未停頓時接續；最後一小段內容可能遺失。';

// The microphone belongs to one of: a call, or any dictation. Each side disables the other's button.
const micListeners = new Set(),
  dictating = new Set();
let micState = {call: false, dictation: false};
const micChanged = next => {
  micState = {...micState, ...next};
  for (const listener of micListeners) listener();
};
export const microphone = {
  snapshot: () => micState,
  subscribe(listener) {
    micListeners.add(listener);
    return () => micListeners.delete(listener);
  },
  dictation(owner, active) {
    if (active) dictating.add(owner);
    else dictating.delete(owner);
    if (micState.dictation !== dictating.size > 0) micChanged({dictation: dictating.size > 0});
  },
  call: active => micState.call !== active && micChanged({call: active})
};

// The page's one call slot: only the call now in the slot may change what the page shows, so a late result from
// an earlier call can never overwrite a newer call's panel.
export function callSlot(show, begin = startVoiceCall) {
  let current = null;
  return {
    start(options) {
      if (current && !current.ended) return;
      const owner = {ended: false, call: null};
      current = owner;
      try {
        owner.call = begin({
          ...options,
          onUpdate: view => {
            if (current !== owner) return;
            owner.ended = !!view.ended;
            show(view);
          }
        });
      } catch (error) {
        // Failed before it could report: free the slot so the next press can try again.
        if (current === owner) current = null;
        show({phase: 'ended', ended: true, cost: 0, lastSend: null, notice: `通話無法開始：${error.message}`});
      }
    },
    hangUp: () => current?.call?.hangUp(),
    control: (name, value) => current?.call?.[name]?.(value),
    dismiss() {
      const owner = current;
      current = null;
      owner?.call?.hangUp();
      show(null);
    }
  };
}

const SEND_STATUS = {sent: '已送出', queued: '已排隊', 'not-sent': '確定未送出', uncertain: '狀態不明'};
const CREATE_STATUS = {'not-created': '新聊天室確定未建立', uncertain: '新聊天室建立狀態不明'};
// The tools that act: answered only once K knows the outcome, and shown as the latest send.
const RELAY_TOOLS = new Set(['room_send', 'room_create']);
// The shape K accepts for Gemini's tool call id (src/voice-secretary.mjs).
const TOOL_CALL_ID = /^[!-~]{1,128}$/u;
const FLAGS = ['incomplete', 'uncertain'];
const base64 = bytes => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const pcm16 = floats => {
  const out = new Int16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
};
const seconds = value => (typeof value === 'string' ? parseFloat(value) : Number(value?.seconds ?? value)) || 0;
const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());

export function startVoiceCall({
  request,
  onUpdate,
  workletUrl,
  WebSocketImpl = globalThis.WebSocket,
  AudioContextImpl = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  AudioWorkletNodeImpl = globalThis.AudioWorkletNode,
  AudioElementImpl = globalThis.Audio,
  media = globalThis.navigator?.mediaDevices,
  win = globalThis.window,
  doc = globalThis.document,
  now = () => Date.now(),
  callId = crypto.randomUUID()
}) {
  const view = {phase: 'connecting', cost: 0, lastSend: null, notice: '', ended: false, volume: 1, canAdjustVolume: false, muted: false};
  let ended = false,
    ws = null,
    token = null,
    model = null,
    expireAt = 0,
    handle = null,
    resumable = true,
    generating = false,
    setupDone = false,
    reconnecting = false,
    pendingReconnect = null,
    renewTimer = null,
    forceTimer = null,
    forceAt = Infinity,
    stream = null,
    worklet = null,
    playHead = 0,
    pendingTools = 0,
    toolTurn = null, // {socket, calls: ids still unanswered, answered, responded, timer}
    turn = 0,
    lastEnd = null, // {turn, at, interrupted}
    audioSent = 0; // samples sent on the current socket: the audio clock that transcript offsets refer to
  const timers = new Set(),
    playing = new Set(),
    cancelled = new Set(),
    segments = new Map(), // seq -> {role, text, posted, incomplete, uncertain, postedFlags}
    starts = new Map(); // model turn -> {socket, audioAt}: when its first output arrived
  // Nothing from this call reaches the page after its final "ended" update.
  const update = changes => {
    if (view.ended) return;
    Object.assign(view, changes);
    onUpdate({...view});
  };
  const phase = () => {
    if (ended) return;
    const next = reconnecting
      ? 'reconnecting'
      : !setupDone
        ? 'connecting'
        : playing.size
          ? 'speaking'
          : pendingTools || toolTurn
            ? 'thinking'
            : 'listening';
    if (next !== view.phase) update({phase: next});
  };
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!ended) fn();
    }, ms);
    timers.add(timer);
    return timer;
  };
  const cancelTimer = timer => {
    clearTimeout(timer);
    timers.delete(timer);
  };
  // A safe boundary is preferred; by this deadline the call resumes anyway. A later deadline never delays an
  // earlier one.
  const forceResumeIn = ms => {
    const at = now() + ms;
    if (forceTimer && forceAt <= at) return;
    if (forceTimer) cancelTimer(forceTimer);
    forceAt = at;
    forceTimer = later(() => reconnect({forced: true}), ms);
  };

  // Audio contexts are created inside the click so mobile browsers allow sound.
  const captureContext = new AudioContextImpl({sampleRate: 16000}),
    playContext = new AudioContextImpl({sampleRate: 24000});
  void captureContext.resume?.().catch?.(() => {});
  void playContext.resume?.().catch?.(() => {});
  // Output: every clip goes through one volume node. With the microphone open, Samsung's Chrome sends Web Audio
  // straight from the context to the earpiece; an audio element fed from the context plays as media on the
  // loudspeaker. The element is started inside the click. A web page cannot pick the earpiece or the loudspeaker
  // itself, so there is no switch for it.
  const volumeNode = playContext.createGain?.() ?? null,
    speakerElement = volumeNode && playContext.createMediaStreamDestination && AudioElementImpl ? new AudioElementImpl() : null,
    speakerStream = speakerElement ? playContext.createMediaStreamDestination() : null;
  const output = volumeNode ?? playContext.destination;
  if (volumeNode) volumeNode.connect(speakerStream ?? playContext.destination);
  view.canAdjustVolume = !!volumeNode;
  if (speakerElement) {
    speakerElement.srcObject = speakerStream.stream;
    Promise.resolve(speakerElement.play?.()).catch(() => {
      // The phone refused the media element: play straight from the context instead, which may come out of the
      // earpiece, and say so rather than showing "speaking" in silence.
      if (ended) return;
      volumeNode.disconnect();
      volumeNode.connect(playContext.destination);
      update({notice: '手機擋下了擴音播放，已改用一般播放；聲音可能從聽筒出來，請把手機貼近耳朵或調大音量。'});
    });
  }

  const play = (data, mimeType) => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)),
      samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1),
      rate = Number(/rate=(\d+)/u.exec(mimeType ?? '')?.[1]) || 24000,
      buffer = playContext.createBuffer(1, samples.length, rate),
      channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;
    const source = playContext.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    // A context the system paused (another app took the audio, the screen dimmed) would hold every clip silently.
    if (playContext.state === 'suspended') void playContext.resume?.().catch?.(() => {});
    const at = Math.max(playContext.currentTime + 0.03, playHead);
    source.start(at);
    playHead = at + buffer.duration;
    playing.add(source);
    source.onended = () => {
      playing.delete(source);
      phase();
      maybeReconnect();
    };
    phase();
  };
  // The person talked over the secretary: drop everything still queued to play.
  const clearPlayback = () => {
    for (const source of playing) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already stopped. */
      }
    }
    playing.clear();
    playHead = 0;
    phase();
  };

  // Transcripts: one segment per speaker per model turn, id = call id + sequence, stable across reconnects. A tool
  // call's own turnComplete does not end the turn; the answer that follows belongs to it. Input transcripts have no
  // guaranteed order against turnComplete, so the person's part is matched to a turn by its audio offset when it
  // has one; without one, a part right after a turn ended stays with that turn and is marked uncertain.
  const segment = (k, role) => {
    const seq = k * 2 + (role === 'owner' ? 0 : 1);
    if (!segments.has(seq)) segments.set(seq, {role, text: '', posted: '', postedFlags: new Set()});
    return segments.get(seq);
  };
  const markStart = socket => {
    if (!starts.has(turn)) starts.set(turn, {socket, audioAt: audioSent / 16000});
  };
  const ownerTurn = (transcription, socket) => {
    const offset = transcription.startOffset ?? transcription.endOffset;
    if (offset !== undefined) {
      // The utterance answered by turn k ends before turn k's first output; the earliest such turn owns it. The
      // first output only estimates where the person stopped: a part still being spoken when a reply began, or
      // begun after it, cannot be placed for sure and is marked uncertain.
      const t = seconds(offset),
        end = transcription.endOffset === undefined ? t : seconds(transcription.endOffset);
      for (let k = 0; k <= turn; k++) {
        const start = starts.get(k);
        if (start?.socket === socket && start.audioAt > t) return {k, uncertain: end > start.audioAt};
      }
      return {k: turn, uncertain: starts.has(turn)};
    }
    if (
      lastEnd &&
      !lastEnd.interrupted &&
      lastEnd.turn === turn - 1 &&
      !starts.has(turn) &&
      !segment(turn, 'owner').text &&
      now() - lastEnd.at < LATE_TRANSCRIPT_MS
    )
      return {k: turn - 1, uncertain: true};
    return {k: turn};
  };
  let flushing = Promise.resolve(),
    postedCost = 0;
  const flush = () => {
    flushing = flushing.then(async () => {
      for (const [seq, s] of segments) {
        const wanted = s.text.trim(),
          flags = FLAGS.filter(f => s[f]);
        if (!wanted || (wanted === s.posted && flags.every(f => s.postedFlags.has(f)))) continue;
        try {
          await request('voice/log', {callId, seq, role: s.role, text: wanted, ...Object.fromEntries(flags.map(f => [f, true]))});
          s.posted = wanted;
          for (const f of flags) s.postedFlags.add(f);
        } catch {
          /* Retried on the next flush; K drops what it already has. */
        }
      }
      // The call's running cost estimate, for the monthly total; K keeps only the highest value per call.
      const cost = view.cost;
      if (cost > postedCost)
        try {
          await request('voice/log', {callId, cost});
          postedCost = Math.max(postedCost, cost);
        } catch {
          /* Retried on the next flush. */
        }
    });
    return flushing;
  };
  const flushTimer = setInterval(() => !ended && void flush(), 4000);
  const clearToolTurn = () => {
    if (toolTurn?.timer) cancelTimer(toolTurn.timer);
    toolTurn = null;
  };
  const endTurn = ({interrupted = false} = {}) => {
    lastEnd = {turn, at: now(), interrupted};
    turn++;
    generating = false;
    clearToolTurn();
    void flush();
  };

  const send = message => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(message));
  };
  const runTool = (call, socket) => {
    pendingTools++;
    phase();
    // This call's id and Gemini's tool call id let K recognise the same call arriving again (a resumed connection
    // replaying it); an id in an unexpected shape is left out rather than failing the tool.
    request('voice/tool', {
      name: call.name,
      args: call.args ?? {},
      ...(typeof call.id === 'string' && TOOL_CALL_ID.test(call.id) ? {callId, toolCallId: call.id} : {})
    })
      .catch(error =>
        RELAY_TOOLS.has(call.name)
          ? {status: 'uncertain', result: '狀態不明', error: `K 的回應未確認：${error.message}`}
          : {error: error.message}
      )
      .then(response => {
        pendingTools--;
        if (ended) return;
        if (RELAY_TOOLS.has(call.name) && response?.status)
          update({
            lastSend: {
              title: response.title ?? '',
              text: response.sentText ?? '',
              status:
                call.name === 'room_create' && response.created !== 'created'
                  ? (CREATE_STATUS[response.created] ?? CREATE_STATUS.uncertain)
                  : `${call.name === 'room_create' ? '已開新聊天室，' : ''}${SEND_STATUS[response.status] ?? response.status}`,
              duplicate: !!response.duplicate
            }
          });
        if (toolTurn?.socket === socket) toolTurn.calls.delete(call.id);
        if (socket !== ws || cancelled.has(call.id)) {
          phase();
          return maybeReconnect();
        }
        send({
          toolResponse: {
            functionResponses: [
              {
                id: call.id,
                name: call.name,
                response: RELAY_TOOLS.has(call.name) ? response : {...response, scheduling: 'WHEN_IDLE'}
              }
            ]
          }
        });
        if (toolTurn) {
          toolTurn.responded = true;
          // A non-blocking answer may be folded in silently; do not wait for it forever.
          if (toolTurn.timer) cancelTimer(toolTurn.timer);
          toolTurn.timer = later(() => {
            if (toolTurn) toolTurn.timer = null;
            if (toolTurn && !toolTurn.answered) endTurn();
            phase();
            maybeReconnect();
          }, 15000);
        }
        phase();
      });
  };
  const onMessage = (socket, message) => {
    if (message.setupComplete) {
      setupDone = true;
      reconnecting = false;
      phase();
    }
    const resumption = message.sessionResumptionUpdate;
    if (resumption) {
      resumable = resumption.resumable !== false;
      if (resumable && resumption.newHandle) handle = resumption.newHandle;
    }
    if (message.usageMetadata) update({cost: view.cost + voiceCost(message.usageMetadata)});
    if (message.goAway) {
      pendingReconnect ??= 'goAway';
      // Prefer a safe boundary; reconnect anyway shortly before the server closes, and say so.
      forceResumeIn(Math.max(0, seconds(message.goAway.timeLeft) * 1000 - 2000));
    }
    if (message.toolCall) {
      markStart(socket);
      toolTurn ??= {socket, calls: new Set(), answered: false, responded: false, timer: null};
      for (const call of message.toolCall.functionCalls ?? []) {
        toolTurn.calls.add(call.id);
        runTool(call, socket);
      }
    }
    if (message.toolCallCancellation) {
      for (const id of message.toolCallCancellation.ids ?? []) {
        cancelled.add(id);
        toolTurn?.calls.delete(id);
      }
      // Every call of the tool turn was cancelled and none answered: no answer will follow it.
      if (toolTurn && !toolTurn.calls.size && !toolTurn.responded) clearToolTurn();
      phase();
    }
    const content = message.serverContent;
    if (content) {
      if (content.interrupted) {
        clearPlayback();
        generating = false;
        if (!toolTurn) endTurn({interrupted: true});
      }
      if (content.inputTranscription?.text) {
        const owner = ownerTurn(content.inputTranscription, socket),
          s = segment(owner.k, 'owner');
        s.text += content.inputTranscription.text;
        if (owner.uncertain) s.uncertain = true;
      }
      const spoken = content.outputTranscription?.text,
        audio = (content.modelTurn?.parts ?? []).filter(p => p.inlineData?.data);
      if (spoken || audio.length) {
        markStart(socket);
        generating = true;
      }
      if (spoken) segment(turn, 'secretary').text += spoken;
      if ((spoken || audio.length) && toolTurn?.responded) toolTurn.answered = true;
      for (const part of audio) play(part.inlineData.data, part.inlineData.mimeType);
      if (content.turnComplete) {
        generating = false;
        if (!toolTurn || toolTurn.answered) endTurn();
        phase();
      }
    }
    maybeReconnect();
  };

  const refreshToken = async () => {
    const minted = await request('voice/token', {});
    if (ended) throw Error('已掛斷。');
    ({token, model} = minted);
    expireAt = Date.parse(minted.expireTime);
    // Renew before the token expires: a new token resumes the same session with the handle.
    if (renewTimer) cancelTimer(renewTimer);
    renewTimer = later(() => {
      renewTimer = null;
      pendingReconnect ??= 'token';
      forceResumeIn(90e3);
      maybeReconnect();
    }, Math.max(0, expireAt - now() - 120e3));
  };

  const open = fresh =>
    new Promise(async (resolve, reject) => {
      try {
        if (fresh || !token || now() > expireAt - 120e3) {
          await refreshToken();
        }
      } catch (error) {
        return reject(error);
      }
      if (ended) return reject(Error('已掛斷。'));
      setupDone = false;
      audioSent = 0;
      const socket = new WebSocketImpl(`${VOICE_SOCKET}?access_token=${encodeURIComponent(token)}`);
      ws = socket;
      let opened = false;
      const timeout = later(() => {
        if (!opened) socket.close();
      }, 15000);
      socket.onopen = () =>
        socket.send(JSON.stringify({setup: {model, sessionResumption: handle ? {handle} : {}}}));
      socket.onmessage = async event => {
        let message;
        try {
          message = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
        } catch {
          return;
        }
        if (socket !== ws || ended) return;
        if (message.setupComplete && !opened) {
          opened = true;
          cancelTimer(timeout);
          resolve();
        }
        onMessage(socket, message);
      };
      socket.onerror = () => {};
      socket.onclose = event => {
        cancelTimer(timeout);
        if (!opened) return reject(Error(`連線被拒（${event.code}${event.reason ? `：${String(event.reason).slice(0, 120)}` : ''}）`));
        if (socket === ws && !ended && !reconnecting) {
          // An unexpected drop: one resumption attempt with the latest handle.
          if (handle) reconnect();
          else hangUp('通話連線中斷。');
        }
      };
    });

  // A safe moment to move to a new connection: the turn is over, the session says it can resume here, nothing is
  // playing and no tool is waiting for its answer.
  const quiet = () => setupDone && resumable && !generating && !playing.size && !pendingTools && !toolTurn;
  function maybeReconnect() {
    if (pendingReconnect && !reconnecting && quiet()) reconnect();
  }
  async function reconnect({forced = false} = {}) {
    if (ended || reconnecting) return;
    if (forced && !quiet()) update({notice: RISKY_RESUME_NOTICE});
    const fresh = pendingReconnect === 'token';
    pendingReconnect = null;
    if (forceTimer) cancelTimer(forceTimer);
    forceTimer = null;
    forceAt = Infinity;
    reconnecting = true;
    clearPlayback();
    phase();
    const old = ws;
    ws = null;
    // Whatever the old connection was still waiting for will not arrive on the new one.
    if (toolTurn?.socket === old) clearToolTurn();
    generating = false;
    if (old) {
      old.onclose = null;
      old.close(1000);
    }
    if (!handle) return hangUp('無法接續通話：伺服器沒有提供接續代碼。');
    try {
      await open(fresh);
    } catch {
      if (ended) return;
      try {
        await open(true);
      } catch (error) {
        return hangUp(`無法接續通話：${error.message}`);
      }
    }
    reconnecting = false;
    phase();
  }

  const onHidden = () => doc?.hidden && hangUp('K 切到背景，通話已掛斷。請通話時保持 K 在前景。');
  const onOffline = () => hangUp('網路中斷，通話已掛斷。');
  const onPageHide = () => hangUp();
  doc?.addEventListener?.('visibilitychange', onHidden);
  win?.addEventListener?.('offline', onOffline);
  win?.addEventListener?.('pagehide', onPageHide);

  function hangUp(notice = '') {
    if (ended) return;
    ended = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    clearInterval(flushTimer);
    doc?.removeEventListener?.('visibilitychange', onHidden);
    win?.removeEventListener?.('offline', onOffline);
    win?.removeEventListener?.('pagehide', onPageHide);
    const socket = ws;
    ws = null;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        /* Already closing. */
      }
    }
    clearPlayback();
    stopTracks(stream);
    worklet?.disconnect();
    void captureContext.close?.().catch?.(() => {});
    void playContext.close?.().catch?.(() => {});
    if (speakerElement) {
      speakerElement.pause?.();
      speakerElement.srcObject = null;
    }
    // The turn that was still going is saved as far as it got and marked incomplete.
    for (const [seq, s] of segments) if (seq >= turn * 2 && s.text.trim()) s.incomplete = true;
    void flush();
    microphone.call(false);
    update({phase: 'ended', ended: true, notice});
  }

  const sendAudio = floats => {
    if (!setupDone || reconnecting || ended || view.muted) return;
    audioSent += floats.length;
    send({realtimeInput: {audio: {data: base64(pcm16(floats)), mimeType: 'audio/pcm;rate=16000'}}});
  };
  microphone.call(true);
  update({});
  (async () => {
    try {
      if (typeof media?.getUserMedia !== 'function') throw Error('這個裝置無法使用麥克風。');
      await refreshToken();
      if (ended) return;
      // The microphone is registered the moment it arrives, so a hang-up or a failed step can always stop it,
      // even when it arrives after the call already ended.
      const captured = media
        .getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1}})
        .then(s => {
          if (ended) stopTracks(s);
          else stream = s;
        });
      await Promise.all([captured, captureContext.audioWorklet.addModule(workletUrl)]);
      if (ended) return;
      const source = captureContext.createMediaStreamSource(stream);
      worklet = new AudioWorkletNodeImpl(captureContext, 'k-pcm-capture');
      worklet.port.onmessage = event => sendAudio(event.data);
      source.connect(worklet);
      worklet.connect(captureContext.destination); // Silent output keeps the node processing.
      await open(false);
    } catch (error) {
      hangUp(ended ? '' : `通話未接通：${error.message}`);
    }
  })();
  return {
    hangUp: () => hangUp(),
    callId,
    setVolume(level) {
      if (ended || !volumeNode) return;
      // A short glide instead of a jump, so the change does not click.
      if (volumeNode.gain.setTargetAtTime) volumeNode.gain.setTargetAtTime(level, playContext.currentTime, 0.03);
      else volumeNode.gain.value = level;
      update({volume: level});
    },
    setMuted(on) {
      if (ended || on === view.muted) return;
      update({muted: on});
      // A paused microphone stream must be closed so Gemini finishes what it heard; audio simply resumes after.
      if (on && setupDone && !reconnecting) send({realtimeInput: {audioStreamEnd: true}});
    }
  };
}
