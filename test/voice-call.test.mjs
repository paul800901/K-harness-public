import test from 'node:test';
import assert from 'node:assert/strict';
import {startVoiceCall, callSlot, microphone, voiceCost, VOICE_SOCKET, LATE_TRANSCRIPT_MS, RISKY_RESUME_NOTICE} from '../frontend/voice-call.mjs';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

// Fakes for the browser pieces the call touches: sockets, audio contexts, the microphone and window events.
function harness({tool = () => ({rooms: []}), mediaDelay, tokenError, addModule = async () => {}, now, audioPlay} = {}) {
  const sockets = [],
    requests = [],
    contexts = [],
    tracks = [],
    sources = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      this.closed = null;
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close(code = 1000) {
      if (this.closed) return;
      this.closed = code;
      this.readyState = 3;
      this.onclose?.({code, reason: ''});
    }
    push(message) {
      this.onmessage?.({data: JSON.stringify(message)});
    }
  }
  class FakeContext {
    constructor({sampleRate}) {
      this.sampleRate = sampleRate;
      this.currentTime = 0;
      this.destination = {};
      this.closed = false;
      this.audioWorklet = {addModule};
      contexts.push(this);
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return {duration: length / rate, getChannelData: () => data};
    }
    createBufferSource() {
      const source = {connect() {}, start() {}, stopped: false, stop() {
        this.stopped = true;
      }};
      sources.push(source);
      return source;
    }
    createMediaStreamSource() {
      return {connect() {}};
    }
    createGain() {
      const node = {gain: {value: 1}, target: null, connect(t) {
        node.target = t;
      }, disconnect() {
        node.target = null;
      }};
      this.gainNode = node;
      return node;
    }
    createMediaStreamDestination() {
      this.speakerDestination = {stream: {fake: 'stream'}};
      return this.speakerDestination;
    }
  }
  const elements = [];
  class FakeAudio {
    constructor() {
      this.muted = false;
      this.played = false;
      this.paused = false;
      elements.push(this);
    }
    play() {
      this.played = true;
      return audioPlay ? audioPlay() : Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }
  class FakeNode {
    constructor() {
      this.port = {};
      this.disconnected = false;
      harness.node = this;
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  const listeners = {};
  const target = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: type => delete listeners[type],
    hidden: false
  };
  const media = {
    getUserMedia: async () => {
      if (mediaDelay) await mediaDelay;
      const track = {stopped: false, stop() {
        this.stopped = true;
      }};
      tracks.push(track);
      return {getTracks: () => [track]};
    }
  };
  const views = [];
  const request = async (route, data) => {
    requests.push({route, data});
    if (route === 'voice/token' && tokenError) throw tokenError;
    if (route === 'voice/token')
      return {token: `auth_tokens/t${requests.filter(r => r.route === 'voice/token').length}`, model: 'models/gemini-3.8-live', expireTime: new Date(Date.now() + 30 * 60e3).toISOString()};
    if (route === 'voice/tool') return tool(data);
    return {saved: true};
  };
  const call = startVoiceCall({
    request,
    onUpdate: view => views.push(view),
    workletUrl: '/assets/worklet.js',
    WebSocketImpl: FakeSocket,
    AudioContextImpl: FakeContext,
    AudioWorkletNodeImpl: FakeNode,
    AudioElementImpl: FakeAudio,
    media,
    win: target,
    doc: target,
    callId: 'call-test-0001',
    ...(now ? {now} : {})
  });
  return {call, sockets, requests, contexts, tracks, sources, elements, views, listeners, target, view: () => views.at(-1), logs: () => requests.filter(r => r.route === 'voice/log').map(r => r.data)};
}
const audio = data => ({serverContent: {modelTurn: {parts: [{inlineData: {data, mimeType: 'audio/pcm;rate=24000'}}]}}});
async function connected(h) {
  await tick();
  await tick();
  const ws = h.sockets.at(-1);
  ws.push({setupComplete: {}});
  await tick();
  return ws;
}

test('the call opens the constrained socket with the K token and streams 16 kHz PCM after setup', async () => {
  const h = harness();
  assert.equal(microphone.snapshot().call, true, 'the call holds the microphone');
  const ws = await connected(h);
  assert.equal(ws.url, `${VOICE_SOCKET}?access_token=${encodeURIComponent('auth_tokens/t1')}`);
  assert.deepEqual(ws.sent[0], {setup: {model: 'models/gemini-3.8-live', sessionResumption: {}}});
  assert.deepEqual(h.contexts.map(c => c.sampleRate), [16000, 24000]);
  harness.node.port.onmessage({data: new Float32Array([0, 0.5, -1, 1])});
  const frame = ws.sent.at(-1).realtimeInput.audio;
  assert.equal(frame.mimeType, 'audio/pcm;rate=16000');
  assert.deepEqual([...new Int16Array(Uint8Array.from(atob(frame.data), c => c.charCodeAt(0)).buffer)], [0, 16383, -32768, 32767]);
  assert.equal(h.view().phase, 'listening');
  h.call.hangUp();
});

test("a tool turn's own turnComplete is not the end: the answer joins the same transcript segment", async () => {
  let clock = Date.now();
  const h = harness({
    now: () => clock,
    tool: data =>
      data.name === 'room_send'
        ? {status: 'queued', title: '甲房', sentText: '（K 語音秘書轉達 #abcdef）\n整理報表', code: 'abcdef'}
        : {rooms: [{title: '甲房'}]}
  });
  const ws = await connected(h);
  ws.push({serverContent: {inputTranscription: {text: '有哪些房'}}});
  ws.push({toolCall: {functionCalls: [{id: 'c1', name: 'room_list', args: {}}]}});
  ws.push({serverContent: {generationComplete: true}});
  ws.push({serverContent: {turnComplete: true}});
  await tick();
  // The call's id and Gemini's tool call id go with it, so K recognises the same call arriving again.
  assert.deepEqual(h.requests.find(r => r.route === 'voice/tool').data, {name: 'room_list', args: {}, callId: 'call-test-0001', toolCallId: 'c1'});
  const response = ws.sent.find(m => m.toolResponse).toolResponse.functionResponses[0];
  assert.deepEqual(response, {id: 'c1', name: 'room_list', response: {rooms: [{title: '甲房'}], scheduling: 'WHEN_IDLE'}});
  assert.equal(h.view().phase, 'thinking', 'still waiting for the answer');
  ws.push({serverContent: {outputTranscription: {text: '有甲房。'}}});
  ws.push(audio(btoa('\0\0\0\0')));
  ws.push({serverContent: {turnComplete: true}});
  clock += LATE_TRANSCRIPT_MS + 1; // The person speaks again a moment later: a new segment.
  ws.push({serverContent: {inputTranscription: {text: '送去甲房'}}});
  ws.push({toolCall: {functionCalls: [{id: 'c2', name: 'room_send', args: {threadId: 'a', text: '整理報表'}}]}});
  await tick();
  const sendResponse = ws.sent.filter(m => m.toolResponse).at(-1).toolResponse.functionResponses[0];
  assert.equal(sendResponse.response.scheduling, undefined, 'room_send stays blocking');
  assert.deepEqual(h.view().lastSend, {title: '甲房', text: '（K 語音秘書轉達 #abcdef）\n整理報表', status: '已排隊', duplicate: false});
  h.call.hangUp();
  await tick();
  const logs = h.logs();
  const final = Object.fromEntries(logs.map(l => [l.seq, l]));
  assert.equal(final[0].text, '有哪些房');
  assert.equal(final[1].text, '有甲房。');
  assert.equal(final[1].role, 'secretary');
  assert.equal(final[2].text, '送去甲房');
  assert.equal(final[2].incomplete, true, 'the turn cut by hanging up is marked incomplete');
  assert(logs.every(l => l.callId === 'call-test-0001'));
});

test('an interruption clears queued playback', async () => {
  const h = harness();
  const ws = await connected(h);
  ws.push(audio(btoa('\0\0\0\0')));
  ws.push(audio(btoa('\0\0\0\0')));
  assert.equal(h.view().phase, 'speaking');
  ws.push({serverContent: {interrupted: true}});
  assert(h.sources.every(s => s.stopped));
  assert.equal(h.view().phase, 'listening');
  h.call.hangUp();
});

test('GoAway resumes with the latest handle at a quiet moment', async () => {
  const h = harness();
  const ws = await connected(h);
  ws.push({sessionResumptionUpdate: {newHandle: 'handle-1', resumable: true}});
  ws.push({usageMetadata: {promptTokenCount: 1500, responseTokenCount: 1500}});
  assert.equal(h.view().cost.toFixed(3), voiceCost({promptTokenCount: 1500, responseTokenCount: 1500}).toFixed(3));
  ws.push({goAway: {timeLeft: '30s'}});
  await tick();
  await tick();
  assert.equal(ws.closed, 1000);
  const next = h.sockets.at(-1);
  assert.notEqual(next, ws);
  assert.equal(next.url, ws.url, 'the same token is reused while valid');
  await tick();
  assert.deepEqual(next.sent[0], {setup: {model: 'models/gemini-3.8-live', sessionResumption: {handle: 'handle-1'}}});
  next.push({setupComplete: {}});
  await tick();
  assert.equal(h.view().phase, 'listening');
  h.call.hangUp();
});

test('after hanging up nothing comes back: no reconnect, microphone and audio released', async () => {
  const h = harness();
  const ws = await connected(h);
  ws.push({sessionResumptionUpdate: {newHandle: 'handle-1'}});
  // Speaking, so the GoAway waits for its forced timer, which the hang-up must cancel.
  ws.push(audio(btoa('\0\0\0\0')));
  ws.push({goAway: {timeLeft: '0s'}});
  h.call.hangUp();
  await tick(20);
  assert.equal(h.sockets.length, 1, 'no reconnect timer survives the hang-up');
  assert.equal(ws.closed, 1000);
  assert(h.tracks.every(t => t.stopped));
  assert(h.contexts.every(c => c.closed));
  assert(harness.node.disconnected);
  assert.equal(microphone.snapshot().call, false);
  assert.equal(h.view().phase, 'ended');
  assert.deepEqual(Object.keys(h.listeners), [], 'page listeners removed');
});

test('an unconfigured voice connection ends before requesting the microphone', async () => {
  const h = harness({tokenError: Error('尚未設定 Gemini Live')});
  await tick();
  assert.equal(h.view().phase, 'ended');
  assert.equal(h.tracks.length, 0);
  assert.equal(h.sockets.length, 0);
});

test('a microphone that arrives after hanging up is stopped at once', async () => {
  let release;
  const h = harness({mediaDelay: new Promise(resolve => (release = resolve))});
  await tick(); // The configured call has requested the microphone, which is still pending.
  h.call.hangUp();
  release();
  await tick();
  await tick();
  assert.equal(h.tracks.length, 1);
  assert.equal(h.tracks[0].stopped, true);
  assert.equal(h.sockets.length, 0);
});

test('going to the background or offline hangs up; an unexpected drop resumes once', async () => {
  const h = harness();
  const ws = await connected(h);
  ws.push({sessionResumptionUpdate: {newHandle: 'handle-9'}});
  ws.close(1006);
  await tick();
  await tick();
  assert.equal(h.sockets.length, 2);
  assert.deepEqual(h.sockets[1].sent[0].setup.sessionResumption, {handle: 'handle-9'});
  h.target.hidden = true;
  h.listeners.visibilitychange();
  assert.equal(h.view().phase, 'ended');
  assert.match(h.view().notice, /背景/);
  const other = harness();
  await connected(other);
  other.listeners.offline();
  assert.match(other.view().notice, /網路中斷/);
});

// --- Code review fixes (docs/voice-secretary-design-20261106.md, 程式互審修正) ---

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return {promise, resolve, reject};
};

test('review 2: a tool result from an ended call never reaches the page or a newer call', async () => {
  const pending = deferred();
  const h = harness({tool: () => pending.promise});
  const ws = await connected(h);
  ws.push({toolCall: {functionCalls: [{id: 's1', name: 'room_send', args: {threadId: 'a', text: 'x'}}]}});
  h.call.hangUp();
  const seen = h.views.length;
  pending.resolve({status: 'sent', title: '甲房', sentText: 'x', code: 'abcdef'});
  await tick();
  assert.equal(h.views.length, seen, 'no update after the final ended view');
  assert.equal(h.view().ended, true);
  // The page slot: an earlier call's late update cannot overwrite the newer call's panel.
  const shown = [],
    begun = [];
  const slot = callSlot(
    view => shown.push(view),
    options => {
      const fake = {options, hangUp() {}};
      begun.push(fake);
      options.onUpdate({phase: 'connecting', ended: false});
      return fake;
    }
  );
  slot.start({});
  begun[0].options.onUpdate({phase: 'ended', ended: true, notice: 'x'});
  slot.dismiss();
  slot.start({});
  const before = shown.length;
  begun[0].options.onUpdate({phase: 'ended', ended: true, lastSend: {title: '舊'}});
  assert.equal(shown.length, before, 'the old call is out of the slot');
  begun[1].options.onUpdate({phase: 'listening', ended: false});
  assert.equal(shown.at(-1).phase, 'listening');
  slot.start({});
  assert.equal(begun.length, 2, 'no second call while one is active');
});

test('review 3: a microphone that arrives after the worklet failed is stopped', async () => {
  const media = deferred();
  const h = harness({mediaDelay: media.promise, addModule: async () => {
    throw Error('worklet failed');
  }});
  await tick();
  assert.equal(h.view().ended, true);
  assert.match(h.view().notice, /worklet failed/);
  media.resolve();
  await tick();
  await tick();
  assert.equal(h.tracks.length, 1);
  assert.equal(h.tracks[0].stopped, true, 'the late microphone is released');
  assert.equal(h.sockets.length, 0);
});

test('review 4: a cancelled tool call does not leave the turn stuck', async () => {
  const pending = deferred();
  let clock = Date.now();
  const h = harness({tool: () => pending.promise, now: () => clock});
  const ws = await connected(h);
  ws.push({serverContent: {inputTranscription: {text: '查一下'}}});
  ws.push({toolCall: {functionCalls: [{id: 'c1', name: 'room_list', args: {}}]}});
  ws.push({serverContent: {turnComplete: true}});
  ws.push({toolCallCancellation: {ids: ['c1']}});
  pending.resolve({rooms: []});
  await tick();
  assert(!ws.sent.some(m => m.toolResponse), 'no answer for a cancelled call');
  ws.push({serverContent: {outputTranscription: {text: '好'}}});
  ws.push({serverContent: {turnComplete: true}});
  assert.equal(h.view().phase, 'listening');
  clock += LATE_TRANSCRIPT_MS + 1;
  ws.push({serverContent: {inputTranscription: {text: '下一句'}}});
  h.call.hangUp();
  await tick();
  const segs = Object.fromEntries(h.logs().map(l => [l.seq, l.text]));
  assert.equal(segs[0], '查一下');
  assert.equal(segs[2], '下一句', 'the turn moved on');
});

test('review 4: a reconnect drops what the old connection was waiting for', async () => {
  const pending = deferred();
  const h = harness({tool: () => pending.promise});
  const ws = await connected(h);
  ws.push({sessionResumptionUpdate: {newHandle: 'h1', resumable: true}});
  ws.push({toolCall: {functionCalls: [{id: 'c1', name: 'room_read', args: {threadId: 'a'}}]}});
  ws.close(1006);
  await tick();
  await tick();
  const next = h.sockets.at(-1);
  next.push({setupComplete: {}});
  pending.resolve({threadId: 'a'});
  await tick();
  assert(!next.sent.some(m => m.toolResponse), 'the old call is not answered on the new connection');
  assert.equal(h.view().phase, 'listening', 'nothing left waiting');
  next.push({serverContent: {outputTranscription: {text: '好'}}});
  next.push({serverContent: {turnComplete: true}});
  assert.equal(h.view().phase, 'listening');
  h.call.hangUp();
});

test('review 5: GoAway waits for the turn to end and for a resumable point', async () => {
  const h = harness();
  const ws = await connected(h);
  ws.push({sessionResumptionUpdate: {newHandle: 'h1', resumable: true}});
  ws.push({serverContent: {outputTranscription: {text: '我正在說'}}});
  ws.push({goAway: {timeLeft: '30s'}});
  await tick();
  assert.equal(ws.closed, null, 'still generating: not yet');
  ws.push({sessionResumptionUpdate: {resumable: false}});
  ws.push({serverContent: {turnComplete: true}});
  await tick();
  assert.equal(ws.closed, null, 'the session says it cannot resume here');
  ws.push({sessionResumptionUpdate: {newHandle: 'h2', resumable: true}});
  await tick();
  await tick();
  assert.equal(ws.closed, 1000);
  await tick();
  assert.deepEqual(h.sockets.at(-1).sent[0].setup.sessionResumption, {handle: 'h2'});
  assert.equal(h.view().notice, '');
  h.call.hangUp();
});

test('review 5: close to the deadline it resumes anyway and says something may be lost', async () => {
  const h = harness();
  const ws = await connected(h);
  ws.push({sessionResumptionUpdate: {newHandle: 'h1', resumable: true}});
  ws.push({serverContent: {outputTranscription: {text: '一直說'}}});
  ws.push({goAway: {timeLeft: '2.03s'}});
  await tick();
  assert.equal(ws.closed, null);
  await tick(60);
  assert.equal(ws.closed, 1000);
  assert.equal(h.view().notice, RISKY_RESUME_NOTICE);
  h.call.hangUp();
});

test('review 7: a late transcript of the person joins its own turn by audio offset', async () => {
  const h = harness();
  const ws = await connected(h);
  const speak = s => harness.node.port.onmessage({data: new Float32Array(16000 * s)});
  speak(2);
  ws.push({serverContent: {inputTranscription: {text: '幫我看', startOffset: '0.2s', endOffset: '1.0s'}}});
  ws.push({serverContent: {outputTranscription: {text: '好的'}}});
  ws.push({serverContent: {turnComplete: true}});
  ws.push({serverContent: {inputTranscription: {text: '甲房', startOffset: '1.0s', endOffset: '1.8s'}}});
  speak(3);
  ws.push({serverContent: {inputTranscription: {text: '還有乙房', startOffset: '3.0s', endOffset: '4.0s'}}});
  h.call.hangUp();
  await tick();
  const segs = Object.fromEntries(h.logs().map(l => [l.seq, l]));
  assert.equal(segs[0].text, '幫我看甲房');
  assert.equal(segs[0].uncertain, undefined, 'the offset settles it');
  assert.equal(segs[2].text, '還有乙房');
});

test('review 7: without an offset a late part stays with its turn and is marked uncertain', async () => {
  let clock = Date.now();
  const h = harness({now: () => clock});
  const ws = await connected(h);
  ws.push({serverContent: {inputTranscription: {text: '幫我看'}}});
  ws.push({serverContent: {outputTranscription: {text: '好的'}}});
  ws.push({serverContent: {turnComplete: true}});
  clock += 300;
  ws.push({serverContent: {inputTranscription: {text: '甲房'}}});
  clock += LATE_TRANSCRIPT_MS;
  ws.push({serverContent: {inputTranscription: {text: '下一件'}}});
  h.call.hangUp();
  await tick();
  const segs = Object.fromEntries(h.logs().map(l => [l.seq, l]));
  assert.equal(segs[0].text, '幫我看甲房');
  assert.equal(segs[0].uncertain, true);
  assert.equal(segs[2].text, '下一件');
  assert.equal(segs[2].uncertain, undefined);
});

test('review 2-1: a part still being spoken when the reply began is marked uncertain', async () => {
  const h = harness();
  const ws = await connected(h);
  const speak = s => harness.node.port.onmessage({data: new Float32Array(16000 * s)});
  speak(2);
  ws.push({serverContent: {inputTranscription: {text: '幫我看', startOffset: '0.2s', endOffset: '1.0s'}}});
  ws.push({serverContent: {outputTranscription: {text: '好的'}}});
  ws.push({serverContent: {inputTranscription: {text: '再查乙房', startOffset: '1.8s', endOffset: '2.8s'}}});
  ws.push({serverContent: {turnComplete: true}});
  h.call.hangUp();
  await tick();
  const segs = Object.fromEntries(h.logs().map(l => [l.seq, l]));
  assert.equal(segs[0].text, '幫我看再查乙房');
  assert.equal(segs[0].uncertain, true, 'the reply began while the person was still talking');
});

test('review 2-2: an earlier resume deadline replaces a later one', async () => {
  const h = harness();
  const ws = await connected(h);
  ws.push({sessionResumptionUpdate: {newHandle: 'h1', resumable: true}});
  ws.push({serverContent: {outputTranscription: {text: '一直說'}}});
  ws.push({goAway: {timeLeft: '90s'}});
  ws.push({goAway: {timeLeft: '2.03s'}});
  await tick();
  assert.equal(ws.closed, null);
  await tick(80);
  assert.equal(ws.closed, 1000, 'the 2-second deadline was not held back by the 88-second one');
  assert.equal(h.view().notice, RISKY_RESUME_NOTICE);
  h.call.hangUp();
});

test('review 2-3: a call that fails while starting frees the slot', () => {
  const shown = [];
  let attempts = 0;
  const slot = callSlot(
    view => shown.push(view),
    () => {
      attempts++;
      throw Error('AudioContext unavailable');
    }
  );
  slot.start({});
  assert.equal(shown.at(-1).ended, true);
  assert.match(shown.at(-1).notice, /通話無法開始：AudioContext unavailable/);
  slot.start({});
  assert.equal(attempts, 2, 'the next press tries again');
});

test('volume and mute: the secretary plays through an audio element, and muting closes the audio stream', async () => {
  const h = harness();
  const ws = await connected(h);
  const play = h.contexts[1],
    [element] = h.elements;
  assert.equal(element.played, true, 'started inside the click');
  assert.equal(element.srcObject, play.speakerDestination.stream);
  assert.equal(play.gainNode.target, play.speakerDestination);
  assert.equal(h.view().canAdjustVolume, true);
  assert.equal(h.view().notice, '');
  h.call.setVolume(2);
  assert.equal(play.gainNode.gain.value, 2);
  assert.equal(h.view().volume, 2);
  // A clip goes through the volume node, and a context the system paused is resumed.
  let resumed = 0;
  play.state = 'suspended';
  play.resume = () => (resumed++, Promise.resolve());
  const connections = [];
  play.createBufferSource = () => {
    const source = {connect: t => connections.push(t), start() {}, stop() {}};
    h.sources.push(source);
    return source;
  };
  ws.push(audio(btoa('\x00\x00\x00\x00')));
  assert.equal(connections[0], play.gainNode);
  assert.equal(resumed, 1);
  // Muted: the stream is closed once and no microphone audio is sent; unmuted, audio flows again.
  const chunks = () => ws.sent.filter(m => m.realtimeInput?.audio).length,
    ends = () => ws.sent.filter(m => m.realtimeInput?.audioStreamEnd).length;
  const before = chunks();
  h.call.setMuted(true);
  h.call.setMuted(true);
  assert.equal(ends(), 1, 'one audioStreamEnd');
  harness.node.port.onmessage({data: new Float32Array(1600)});
  assert.equal(chunks(), before);
  h.call.setMuted(false);
  harness.node.port.onmessage({data: new Float32Array(1600)});
  assert.equal(chunks(), before + 1);
  assert.equal(ends(), 1);
  h.call.hangUp();
  assert.equal(element.paused, true);
  assert.equal(element.srcObject, null);
});

test('a refused audio element falls back to the context and says so', async () => {
  const h = harness({audioPlay: () => Promise.reject(Error('NotAllowedError'))});
  await connected(h);
  const play = h.contexts[1];
  assert.equal(play.gainNode.target, play.destination);
  assert.match(h.view().notice, /擋下了擴音播放/);
  h.call.hangUp();
});

test('the running cost estimate goes out with the transcript flush and on hang-up, only when it grows', async () => {
  const h = harness();
  const ws = await connected(h);
  const costs = () => h.logs().filter(d => 'cost' in d);
  try {
    ws.push({usageMetadata: {promptTokenCount: 1500, responseTokenCount: 1500}});
    ws.push({serverContent: {turnComplete: true}});
    await tick();
    await tick();
    assert.deepEqual(costs(), [{callId: 'call-test-0001', cost: voiceCost({promptTokenCount: 1500, responseTokenCount: 1500})}]);
    // Nothing new: the next flush sends nothing.
    ws.push({serverContent: {turnComplete: true}});
    await tick();
    await tick();
    assert.equal(costs().length, 1);
    ws.push({usageMetadata: {promptTokenCount: 3000, responseTokenCount: 0}});
    h.call.hangUp();
    await tick();
    await tick();
    assert.deepEqual(
      costs().map(d => d.callId),
      ['call-test-0001', 'call-test-0001'],
      'the same call ID, sent again at hang-up with the larger total'
    );
    assert.equal(costs()[1].cost.toFixed(4), (voiceCost({promptTokenCount: 1500, responseTokenCount: 1500}) + voiceCost({promptTokenCount: 3000})).toFixed(4));
  } finally {
    h.call.hangUp();
  }
});

test('the cost estimate prices text, audio and thinking at their own official rates', () => {
  // A real turn reported by gemini-3.8-live (2026-11-07 probe): 355 text + 222 audio of a 616-token prompt.
  const turn = {
    promptTokenCount: 616,
    responseTokenCount: 31,
    promptTokensDetails: [
      {modality: 'TEXT', tokenCount: 355},
      {modality: 'AUDIO', tokenCount: 222}
    ],
    responseTokensDetails: [{modality: 'AUDIO', tokenCount: 31}]
  };
  // 355 × 0.75 + (222 + 39 unattributed) × 3 + 31 × 12, per million.
  assert.equal(voiceCost(turn).toFixed(9), ((355 * 0.75 + 261 * 3 + 31 * 12) / 1e6).toFixed(9));
  // Thinking and tool results are text; with no breakdown everything counts at the audio rates.
  assert.equal(
    voiceCost({promptTokenCount: 1000, toolUsePromptTokenCount: 100, responseTokenCount: 10, thoughtsTokenCount: 20}).toFixed(9),
    ((1000 * 3 + 100 * 0.75 + 10 * 12 + 20 * 4.5) / 1e6).toFixed(9)
  );
  assert.equal(voiceCost({}), 0);
});
