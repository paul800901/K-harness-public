import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {
  createVoiceSecretary,
  relayMarker,
  VOICE_FIELD_MASK,
  HISTORY_LIMIT,
  NEW_ROOM_PERMISSIONS,
  SECRETARY_VOICE,
  taiwanText
} from '../src/voice-secretary.mjs';
import {SECRETARY_NAME} from '../shared/voice-secretary-name.mjs';
import {createConversationController} from '../src/conversation-controller.mjs';
import {saveMainSession} from '../src/main-sessions.mjs';
import {startDesktop} from '../src/desktop-server.mjs';
import {remoteRouteAllowed} from '../src/remote-access.mjs';
import {scratchBase} from './scratch.mjs';

const tempRoot = name => mkdtemp(path.join(scratchBase, `voice-${name}-`));
const logFile = root => path.join(root, '.runtime/voice-secretary.jsonl');
const readLog = async root =>
  (await readFile(logFile(root), 'utf8'))
    .split('\n')
    .filter(line => line && line !== '{"torn":')
    .map(line => JSON.parse(line));

// A fake K: rooms with saved sessions, optional open states, and a scripted send.
function fakeRooms({sessions = {}, states = {}, send} = {}) {
  const sent = [],
    notes = [];
  return {
    sent,
    notes,
    states,
    sessions,
    rooms: {
      list: async () =>
        Object.values(sessions)
          .filter(s => !s.archived)
          .map(s => ({threadId: s.threadId, title: s.title, workspace: 'D:\\work', status: 'idle', pendingNotes: 0})),
      session: async id => sessions[id] ?? null,
      read: async id => states[id] ?? {messages: []},
      peek: id => states[id] ?? null,
      send: async data => {
        sent.push(data);
        return send ? send(data) : {sent: true};
      },
      note: async (id, text) => notes.push({id, text})
    }
  };
}
const room = (threadId, title = threadId, extra = {}) => ({threadId, title, model: 'gpt-6-astra', ...extra});

test('only the listed tools with exact arguments are accepted', async () => {
  const root = await tempRoot('whitelist');
  const k = fakeRooms({sessions: {r1: room('r1', '甲房')}});
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  for (const name of ['delete_everything', 'note', 'stop', 'constructor', '__proto__', 'toString'])
    assert.match((await voice.tool({name, args: {}})).error, /只能使用/);
  assert.match((await voice.tool({name: 'room_list', args: {}, extra: 1})).error, /只能使用/);
  assert.match((await voice.tool({name: 'room_list', args: {threadId: 'r1'}})).error, /不接受參數/);
  assert.match((await voice.tool({name: 'room_read', args: {threadId: 'r1', all: true}})).error, /只接受 threadId/);
  assert.match(
    (await voice.tool({name: 'room_send', args: {threadId: 'r1', text: 'x', model: 'gpt-6-sol'}})).error,
    /只接受 threadId 與 text/
  );
  assert.match((await voice.tool({name: 'room_send', args: {threadId: 'r1', text: ' '}})).error, /1–4000/);
  assert.match((await voice.tool({name: 'room_send', args: {threadId: 'r1', text: 'x'.repeat(4001)}})).error, /1–4000/);
  assert.match((await voice.tool({name: 'room_send', args: {threadId: '../x', text: 'x'}})).error, /threadId 無效/);
  assert.match((await voice.tool({name: 'room_send', args: {threadId: 'nobody', text: 'x'}})).error, /找不到/);
  k.sessions.r1.archived = true;
  assert.match((await voice.tool({name: 'room_send', args: {threadId: 'r1', text: 'x'}})).error, /封存/);
  assert.match((await voice.tool({name: 'room_read', args: {threadId: 'r1'}})).error, /封存/);
  assert.equal(k.sent.length, 0);
  const list = await voice.tool({name: 'room_list', args: {}});
  assert.deepEqual(list.rooms, []);
  await voice.close();
});

test('room_send adds a fresh relay marker on the server and reports the four outcomes', async () => {
  const root = await tempRoot('outcomes');
  let next = {sent: true};
  const k = fakeRooms({
    sessions: {r1: room('r1', '甲房')},
    send: () => {
      if (next instanceof Error) throw next;
      return next;
    }
  });
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const a = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '請整理報表'}});
  assert.equal(a.status, 'sent');
  assert.equal(a.title, '甲房');
  assert.equal(k.sent[0].text, `${relayMarker(a.code)}\n請整理報表`);
  assert.equal(a.sentText, k.sent[0].text);
  next = {queued: true, id: 'q1'};
  const b = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '第二件'}});
  assert.equal(b.status, 'queued');
  assert.match(b.result, /已排隊/);
  assert.notEqual(a.code, b.code);
  next = Object.assign(Error('聊天室正在更新'), {notSent: true});
  const c = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '第三件'}});
  assert.equal(c.status, 'not-sent');
  next = Error('連線中斷');
  const d = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '第四件'}});
  assert.equal(d.status, 'uncertain');
  assert.match(d.message, /沒有重送/);
  // Failures leave a note from the voice secretary in the target room.
  assert.equal(k.notes.length, 2);
  assert.match(k.notes[0].text, /未送出/);
  assert.match(k.notes[1].text, /狀態不明、未重送/);
  assert(!k.notes.some(n => n.text.includes(relayMarker(c.code))), 'a note never carries the relay marker');
  next = Object.assign(Error('聊天室已封存。'), {notSent: true, noNote: true});
  await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '第五件'}});
  assert.equal(k.notes.length, 2);
  // Each send is recorded before the hand-over, then its result is appended.
  const events = (await readLog(root)).filter(e => e.type === 'send');
  assert.deepEqual(
    events.map(e => e.status),
    ['sending', 'sent', 'sending', 'queued', 'sending', 'not-sent', 'sending', 'uncertain', 'sending', 'not-sent']
  );
  await voice.close();
});

test('a repeat within ten minutes is not sent again; unknown stays unknown', async () => {
  const root = await tempRoot('dedup');
  let clock = new Date('2026-11-06T10:00:00Z'),
    next = {sent: true};
  const k = fakeRooms({
    sessions: {r1: room('r1'), r2: room('r2')},
    send: () => {
      if (next instanceof Error) throw next;
      return next;
    }
  });
  const voice = createVoiceSecretary({root, rooms: k.rooms, now: () => clock});
  const first = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '同一件事'}});
  clock = new Date('2026-11-06T10:05:00Z');
  const again = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: ' 同一件事 '}});
  assert.equal(again.duplicate, true);
  assert.equal(again.code, first.code);
  assert.equal(again.status, 'sent');
  assert.equal(k.sent.length, 1);
  // Another room, or the same room after ten minutes, is a new send.
  await voice.tool({name: 'room_send', args: {threadId: 'r2', text: '同一件事'}});
  clock = new Date('2026-11-06T10:10:01Z');
  await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '同一件事'}});
  assert.equal(k.sent.length, 3);
  // An unknown result is reported as unknown, never resent.
  next = Error('逾時');
  const unknown = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '不明的事'}});
  assert.equal(unknown.status, 'uncertain');
  next = {sent: true};
  const repeat = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '不明的事'}});
  assert.equal(repeat.status, 'uncertain');
  assert.equal(repeat.duplicate, true);
  assert.equal(k.sent.length, 4);
  // A send that certainly did not happen may be tried again.
  next = Object.assign(Error('忙碌'), {notSent: true});
  await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '沒送出的事'}});
  next = {sent: true};
  const retry = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '沒送出的事'}});
  assert.equal(retry.status, 'sent');
  assert.equal(retry.duplicate, undefined);
  // Two concurrent identical requests: the second sees the first still being handed over.
  let release;
  next = {sent: true};
  k.rooms.send = async data => {
    k.sent.push(data);
    await new Promise(resolve => (release = resolve));
    return {sent: true};
  };
  const slow = voice.tool({name: 'room_send', args: {threadId: 'r2', text: '慢慢送'}});
  await new Promise(resolve => setTimeout(resolve, 20));
  const racing = await voice.tool({name: 'room_send', args: {threadId: 'r2', text: '慢慢送'}});
  assert.equal(racing.status, 'uncertain');
  release();
  assert.equal((await slow).status, 'sent');
  await voice.close();
});

const user = (id, text, extra) => ({id, role: 'user', text, createdAt: `2026-11-06T10:0${id}:00Z`, ...extra});
const reply = (id, text, extra) => ({id, role: 'assistant', text, createdAt: `2026-11-06T10:0${id}:30Z`, ...extra});
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('a reply is matched by its relay code, never by time; queued work keeps earlier replies apart', async () => {
  const root = await tempRoot('match');
  const state = {title: '忙碌房', busy: true, status: 'working', messages: [user(1, '本人原本的工作')], queuedMessages: []};
  const k = fakeRooms({
    sessions: {r1: room('r1', '忙碌房')},
    states: {r1: state},
    send: data => {
      state.queuedMessages.push({id: `q${state.queuedMessages.length}`, text: data.text, status: 'queued'});
      return {queued: true};
    }
  });
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const one = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '第一件'}});
  const two = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '第二件'}});
  // The earlier work answers first: it is not a reply to either relay.
  state.messages.push(reply(1, '原本工作的答案'));
  state.busy = false;
  state.status = 'completed';
  voice.observe('r1', () => state);
  await settle();
  assert.equal((await readLog(root)).filter(e => e.type === 'report').length, 0);
  // The queue delivers the first relay; a partial reply does not count, the finished one does.
  state.messages.push(user(2, state.queuedMessages.shift().text));
  state.busy = true;
  state.status = 'working';
  state.messages.push(reply(2, '第一件處理中', {partial: true}));
  voice.observe('r1', () => state);
  await settle();
  assert.equal((await readLog(root)).filter(e => e.type === 'report').length, 0);
  state.messages.pop();
  state.messages.push(reply(2, '先看一下檔案'), reply(3, '第一件做好了'));
  state.messages.push(user(4, state.queuedMessages.shift().text));
  voice.observe('r1', () => state);
  await settle();
  state.messages.push(reply(5, '第二件做好了'));
  state.busy = false;
  state.status = 'completed';
  voice.observe('r1', () => state);
  voice.observe('r1', () => state);
  await settle();
  const events = await readLog(root),
    reports = events.filter(e => e.type === 'report');
  assert.deepEqual(
    reports.map(r => [r.code, r.text]),
    [
      [one.code, '第一件做好了'],
      [two.code, '第二件做好了']
    ]
  );
  assert.deepEqual(
    events.filter(e => e.type === 'trackEnd').map(e => [e.code, e.reason]),
    [
      [one.code, 'replied'],
      [two.code, 'replied']
    ]
  );
  // room_read answers "is it done" from the relay, not from an older reply.
  const read = await voice.tool({name: 'room_read', args: {threadId: 'r1'}});
  assert.equal(read.lastSend.code, two.code);
  assert.equal(read.lastSend.reply.text, '第二件做好了');
  assert.equal(read.latestReply.text, '第二件做好了');
  await voice.close();
});

test('room_read says there is no result yet instead of returning an old answer', async () => {
  const root = await tempRoot('read');
  const state = {title: '甲', busy: false, status: 'completed', messages: [user(1, '舊問題'), reply(1, '舊答案')]};
  const k = fakeRooms({
    sessions: {r1: room('r1', '甲')},
    states: {r1: state},
    send: data => {
      state.messages.push(user(2, data.text));
      state.busy = true;
      state.status = 'working';
      return {sent: true};
    }
  });
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const before = await voice.tool({name: 'room_read', args: {threadId: 'r1'}});
  assert.equal(before.lastSend, null);
  assert.equal(before.latestReply.text, '舊答案');
  assert.equal(before.latestReply.complete, true);
  await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '新問題'}});
  const after = await voice.tool({name: 'room_read', args: {threadId: 'r1'}});
  assert.equal(after.lastSend.reply, null);
  assert.match(after.lastSend.note, /尚無結果/);
  state.messages.push(reply(3, 'x'.repeat(5000)));
  state.busy = false;
  state.status = 'completed';
  const done = await voice.tool({name: 'room_read', args: {threadId: 'r1'}});
  assert.equal(done.lastSend.reply.truncated, true);
  assert.equal(done.lastSend.reply.text.length, 3000);
  await voice.close();
});

test('tracking ends when the queued relay is removed, the room is archived, or the turn fails', async () => {
  const root = await tempRoot('ends');
  const states = {
    q: {title: 'Q', busy: true, status: 'working', messages: [], queuedMessages: []},
    a: {title: 'A', busy: true, status: 'working', messages: []},
    f: {title: 'F', busy: false, status: 'completed', messages: []}
  };
  const k = fakeRooms({
    sessions: {q: room('q'), a: room('a'), f: room('f')},
    states,
    send: data => {
      const s = states[data.text.includes('排隊') ? 'q' : data.text.includes('封存') ? 'a' : 'f'];
      if (s === states.q) {
        s.queuedMessages.push({id: 'q1', text: data.text});
        return {queued: true};
      }
      s.messages.push(user(1, data.text));
      s.busy = true;
      s.status = 'working';
      return {sent: true};
    }
  });
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const queued = await voice.tool({name: 'room_send', args: {threadId: 'q', text: '排隊的事'}});
  const archived = await voice.tool({name: 'room_send', args: {threadId: 'a', text: '封存的事'}});
  const failed = await voice.tool({name: 'room_send', args: {threadId: 'f', text: '會失敗的事'}});
  states.q.queuedMessages = [];
  voice.observe('q', () => states.q);
  await voice.archived('a');
  Object.assign(states.f, {busy: false, status: 'failed'});
  voice.observe('f', () => states.f);
  await settle();
  const ends = Object.fromEntries((await readLog(root)).filter(e => e.type === 'trackEnd').map(e => [e.code, e.reason]));
  assert.deepEqual(ends, {[queued.code]: 'queue-removed', [archived.code]: 'archived', [failed.code]: 'turn-failed'});
  assert.equal(k.sent.length, 3);
  await voice.close();
});

test('a restart rebuilds tracking from the file without resending or reviving anything', async () => {
  const root = await tempRoot('restart');
  await mkdir(path.dirname(logFile(root)), {recursive: true});
  const at = '2026-11-06T09:00:00.000Z';
  const lines = [
    {type: 'send', code: 'aaaaaa', threadId: 'r1', title: '甲', text: '送到一半', hash: 'h1', status: 'sending', startedAt: at, at},
    {type: 'send', code: 'bbbbbb', threadId: 'r1', title: '甲', text: '已送出', hash: 'h2', status: 'sending', startedAt: at, at},
    {type: 'send', code: 'bbbbbb', status: 'sent', at},
    {type: 'send', code: 'cccccc', threadId: 'r2', title: '乙', text: '乙的事', hash: 'h3', status: 'sending', startedAt: at, at},
    {type: 'send', code: 'cccccc', status: 'queued', at},
    {type: 'send', code: 'dddddd', threadId: 'r1', title: '甲', text: '早就結束', hash: 'h4', status: 'sending', startedAt: at, at},
    {type: 'send', code: 'dddddd', status: 'sent', at},
    {type: 'trackEnd', code: 'dddddd', threadId: 'r1', reason: 'replied', at}
  ];
  await writeFile(logFile(root), lines.map(l => JSON.stringify(l)).join('\n') + '\n{"torn":');
  const state = {
    title: '甲',
    busy: false,
    status: 'completed',
    messages: [user(1, `${relayMarker('bbbbbb')}\n已送出`), reply(1, '甲已經回覆')]
  };
  const k = fakeRooms({sessions: {r1: room('r1', '甲'), r2: room('r2', '乙', {archived: true})}, states: {r1: state}});
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  await voice.ready();
  await voice.close();
  const events = (await readLog(root)).slice(lines.length);
  assert.deepEqual(
    events.map(e => [e.type, e.code, e.status ?? e.reason ?? '']),
    [
      ['send', 'aaaaaa', 'uncertain'],
      ['report', 'bbbbbb', ''],
      ['trackEnd', 'bbbbbb', 'replied'],
      ['trackEnd', 'cccccc', 'archived']
    ]
  );
  assert.equal(k.sent.length, 0, 'nothing is resent after a restart');
  // The unknown send still blocks an identical repeat within ten minutes of its start.
  const later = createVoiceSecretary({root, rooms: k.rooms, now: () => new Date('2026-11-06T09:05:00Z')});
  await later.ready();
  const page = await later.entries();
  assert.equal(page.entries.find(e => e.code === 'aaaaaa').status, 'uncertain');
  await later.close();
});

test('the browser can only write transcripts; segments dedupe, take late parts and mark incomplete', async () => {
  const root = await tempRoot('log');
  const voice = createVoiceSecretary({root, rooms: fakeRooms().rooms});
  const call = 'call-1234-abcd';
  for (const forged of [
    {type: 'send', callId: call, seq: 0, role: 'owner', text: '已送出'},
    {callId: call, seq: 0, role: 'owner', text: 'x', status: 'sent'},
    {callId: call, seq: 0, role: 'k', text: 'x'},
    {callId: call, seq: 0, role: 'report', text: 'x'},
    {callId: 'bad id', seq: 0, role: 'owner', text: 'x'},
    {callId: call, seq: -1, role: 'owner', text: 'x'},
    {callId: call, seq: 1.5, role: 'owner', text: 'x'},
    {callId: call, seq: 0, role: 'owner', text: 'x'.repeat(8001)},
    {callId: call, seq: 0, role: 'owner', text: 'x', incomplete: 'yes'},
    {code: 'aaaaaa', callId: call, seq: 0, role: 'owner', text: 'x'}
  ])
    await assert.rejects(voice.log(forged), /逐字稿格式無效/);
  assert.equal((await voice.log({callId: call, seq: 0, role: 'owner', text: '幫我'})).saved, true);
  assert.equal((await voice.log({callId: call, seq: 0, role: 'owner', text: '幫我'})).saved, false);
  assert.equal((await voice.log({callId: call, seq: 0, role: 'owner', text: '幫我看甲房'})).saved, true);
  assert.equal((await voice.log({callId: call, seq: 0, role: 'owner', text: '幫我'})).saved, false, 'a stale retry is ignored');
  await assert.rejects(voice.log({callId: call, seq: 0, role: 'secretary', text: '幫我看甲房好'}), /角色/);
  await voice.log({callId: call, seq: 1, role: 'secretary', text: '好的，要交給'});
  await voice.log({callId: call, seq: 1, role: 'secretary', text: '好的，要交給', incomplete: true});
  const {entries} = await voice.entries();
  assert.deepEqual(
    entries.map(e => [e.kind, e.role, e.text, !!e.incomplete]),
    [
      ['transcript', 'owner', '幫我看甲房', false],
      ['transcript', 'secretary', '好的，要交給', true]
    ]
  );
  assert(!(await readLog(root)).some(e => e.type !== 'transcript'));
  await voice.close();
});

test('the token locks every setup field except resumption and fences history from authorization', async () => {
  const root = await tempRoot('token');
  const calls = [];
  const connections = {
    rows: [{id: 'a'.repeat(32), name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyConfigured: true}],
    async list() {
      return {connections: this.rows};
    },
    async credentials(id) {
      assert.equal(id, 'a'.repeat(32));
      return {key: 'fake-key-for-test'};
    }
  };
  const fetchImpl = async (url, options) => {
    calls.push({url, options, body: JSON.parse(options.body)});
    return new Response(JSON.stringify({name: 'auth_tokens/fake'}), {status: 200});
  };
  const k = fakeRooms({sessions: {r1: room('r1', '甲房'), r2: room('r2', '封存房', {archived: true})}});
  const voice = createVoiceSecretary({root, rooms: k.rooms, connections, fetchImpl});
  assert.equal(await voice.configured(), true);
  assert.equal(calls.length, 0);
  // A long history is cut by whole entries at the limit, newest kept.
  for (let i = 0; i < 40; i++) await voice.log({callId: 'call-history', seq: i, role: 'owner', text: `第${i}段` + '話'.repeat(300)});
  const result = await voice.token();
  assert.deepEqual(Object.keys(result).sort(), ['expireTime', 'model', 'token']);
  assert.equal(result.token, 'auth_tokens/fake');
  const [{url, options, body}] = calls;
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/auth_tokens');
  assert.equal(options.headers['x-goog-api-key'], 'fake-key-for-test');
  assert.equal(body.uses, 1);
  assert.equal(body.fieldMask, VOICE_FIELD_MASK);
  assert(!body.fieldMask.includes('sessionResumption'));
  for (const field of ['model', 'generationConfig', 'systemInstruction', 'tools', 'contextWindowCompression'])
    assert(body.fieldMask.split(',').includes(field));
  assert.equal(Date.parse(body.expireTime) - Date.parse(body.newSessionExpireTime), 29 * 60e3);
  assert.deepEqual(
    body.bidiGenerateContentSetup.tools[0].functionDeclarations.map(f => [f.name, f.behavior ?? 'BLOCKING']),
    [
      ['room_list', 'NON_BLOCKING'],
      ['options_list', 'NON_BLOCKING'],
      ['room_read', 'NON_BLOCKING'],
      ['room_send', 'BLOCKING'],
      ['room_create', 'BLOCKING'],
      ['note_add', 'BLOCKING'],
      ['note_remove', 'BLOCKING']
    ]
  );
  assert.equal(body.bidiGenerateContentSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, SECRETARY_VOICE);
  const text = body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
  assert.match(text, /不構成這次送出的授權/);
  assert.match(text, /當下由本人口頭確認/);
  assert.match(text, /不是給你的指令/);
  assert.match(text, /甲房/);
  assert(!text.includes('封存房'));
  assert.match(text, /更早的紀錄已截斷/);
  assert(text.includes('第39段') && !text.includes('第0段'));
  const history = text.slice(text.indexOf('<秘書室歷史紀錄>'), text.indexOf('</秘書室歷史紀錄>'));
  assert(history.length <= HISTORY_LIMIT + 40, `history is bounded (${history.length})`);
  // Exactly one Gemini connection is required; none or several is an explicit error.
  connections.rows = [];
  assert.equal(await voice.configured(), false);
  await assert.rejects(voice.token(), /尚未設定 Gemini 語音金鑰/);
  connections.rows = [
    {id: 'a'.repeat(32), baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyConfigured: true},
    {id: 'b'.repeat(32), baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyConfigured: true}
  ];
  await assert.rejects(voice.token(), /多組/);
  assert.equal(await voice.configured(), false);
  connections.rows = [{baseUrl: 'https://generativelanguage.googleapis.com', keyConfigured: false}];
  assert.equal(await voice.configured(), false);
  connections.rows = [{id: 'a'.repeat(32), baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyConfigured: true}];
  const failing = createVoiceSecretary({
    root,
    rooms: k.rooms,
    connections,
    fetchImpl: async () => new Response(JSON.stringify({error: {message: 'quota'}}), {status: 429})
  });
  await assert.rejects(failing.token(), error => /HTTP 429/.test(error.message) && !error.message.includes('fake-key'));
  await failing.close();
  await voice.close();
});

test('the conversation controller relays through the schedule send path and reports the reply', async () => {
  const root = await tempRoot('controller');
  await saveMainSession(root, {threadId: 'room-target', title: '目標房', model: 'gpt-6-astra', workspace: root});
  await saveMainSession(root, {threadId: 'room-old', title: '舊房', model: 'gpt-6-astra', workspace: root, archived: true});
  const controllers = [];
  const cc = createConversationController({
    root,
    sessionFactory: ({onChange}) => {
      const c = {
        state: {provider: 'codex', status: 'ready', workspace: root, threadId: null, title: '', model: 'gpt-6-astra', busy: false, messages: []},
        async models() {
          return {models: [{model: 'gpt-6-astra'}]};
        },
        async usage() {
          return {};
        },
        async selectWorkspace() {
          return {workspace: root};
        },
        async open(data) {
          this.state.threadId = data.threadId;
          this.state.title = '目標房';
          return {threadId: data.threadId};
        },
        async send(data) {
          this.state.messages.push({id: 'u1', role: 'user', text: data.text, createdAt: new Date().toISOString()});
          this.state.busy = true;
          this.state.status = 'working';
          onChange();
          return {sent: true};
        },
        async workers() {
          return [];
        },
        async close() {},
        finish(text) {
          this.state.messages.push({id: 'a1', role: 'assistant', text, createdAt: new Date().toISOString()});
          this.state.busy = false;
          this.state.status = 'completed';
          onChange();
        }
      };
      controllers.push(c);
      return c;
    }
  });
  try {
    const list = await cc.voice.tool({name: 'room_list', args: {}});
    assert.deepEqual(
      list.rooms.map(r => r.title),
      ['目標房']
    );
    const result = await cc.voice.tool({name: 'room_send', args: {threadId: 'room-target', text: '幫我查帳'}});
    assert.equal(result.status, 'sent');
    const target = controllers.find(c => c.state.threadId === 'room-target');
    assert(target, 'the unopened room was opened in the background');
    assert(target.state.messages[0].text.startsWith(relayMarker(result.code)));
    assert.equal(cc.state.threadId, null, 'the shown room did not change');
    const archived = await cc.voice.tool({name: 'room_send', args: {threadId: 'room-old', text: 'x'}});
    assert.match(archived.error, /封存/);
    const before = cc.state.voiceRevision;
    target.finish('帳查好了');
    await settle();
    const {entries} = await cc.voice.entries();
    assert.equal(entries.find(e => e.kind === 'report')?.text, '帳查好了');
    assert(cc.state.voiceRevision > before);
  } finally {
    await cc.close();
  }
});

test('voice routes are exact on the phone, token takes no input, and CSP opens only the Gemini socket', async () => {
  for (const route of ['/api/voice/token', '/api/voice/tool', '/api/voice/log'])
    assert.equal(remoteRouteAllowed('POST', route), true, route);
  assert.equal(remoteRouteAllowed('GET', '/api/voice/log'), true);
  for (const route of ['/api/voice', '/api/voice/', '/api/voice/send', '/api/voice/token/x'])
    assert.equal(remoteRouteAllowed('POST', route), false, route);
  assert.equal(remoteRouteAllowed('GET', '/api/voice/token'), false);
  const root = await tempRoot('routes');
  const seen = [];
  const controller = {
    state: {},
    historyVersion: {},
    async close() {},
    voice: {
      token: async () => (seen.push('token'), {token: 't', model: 'm', expireTime: 'e'}),
      tool: async data => (seen.push(['tool', data]), {rooms: []}),
      log: async data => (seen.push(['log', data]), {saved: true}),
      entries: async () => ({entries: [], truncated: false})
    }
  };
  const app = await startDesktop({root, executable: 'test', port: 0, controllerFactory: () => controller});
  try {
    const page = await fetch(app.createLaunchUrl(), {redirect: 'manual'});
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const post = (route, body) =>
      fetch(app.origin + route, {
        method: 'POST',
        headers: {cookie, 'Content-Type': 'application/json', 'X-K-Request': '1'},
        body: JSON.stringify(body)
      });
    const log = await fetch(app.origin + '/api/voice/log', {headers: {cookie}});
    assert.equal(log.status, 200);
    const csp = log.headers.get('content-security-policy');
    assert.match(csp, /connect-src 'self' wss:\/\/generativelanguage\.googleapis\.com;/);
    assert.equal((await post('/api/voice/token', {})).status, 200);
    assert.equal((await post('/api/voice/token', {model: 'other'})).status, 400);
    assert.equal((await post('/api/voice/tool', {name: 'room_list', args: {}})).status, 200);
    assert.equal((await post('/api/voice/log', {callId: 'c', seq: 0, role: 'owner', text: 'x'})).status, 200);
    assert.equal((await post('/api/voice/other', {})).status, 404);
    assert.deepEqual(seen.map(s => (Array.isArray(s) ? s[0] : s)), ['token', 'tool', 'log']);
  } finally {
    await app.close();
  }
});

// --- Code review fixes (docs/voice-secretary-design-20261106.md, 程式互審修正) ---

test('review 1: identical room_send calls arriving together are sent once', async () => {
  const root = await tempRoot('race-send');
  const k = fakeRooms({sessions: {r1: room('r1', '甲房')}});
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  await voice.ready();
  const args = {threadId: 'r1', text: '同時抵達'};
  const results = await Promise.all([voice.tool({name: 'room_send', args}), voice.tool({name: 'room_send', args})]);
  assert.equal(k.sent.length, 1, 'handed over once');
  assert.equal(results.filter(r => r.duplicate).length, 1);
  assert.equal(new Set(results.map(r => r.code)).size, 1, 'one relay code');
  assert.equal((await readLog(root)).filter(e => e.type === 'send' && e.status === 'sending').length, 1);
  await voice.close();
});

test('review 1: a send whose record could not be saved is never handed over', async () => {
  const root = await tempRoot('record-fails');
  const k = fakeRooms({sessions: {r1: room('r1', '甲房')}});
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  await voice.ready();
  // After loading, the log path becomes a directory, so the 'sending' record cannot be appended.
  await mkdir(logFile(root), {recursive: true});
  const result = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '存不了'}});
  assert(result.error, 'reported as an error');
  assert.equal(k.sent.length, 0);
  await voice.close();
});

test('review 6: a message steered into the running turn does not end the relay tracking', async () => {
  const root = await tempRoot('steer');
  const state = {title: '甲', busy: false, status: 'completed', messages: []};
  const k = fakeRooms({
    sessions: {r1: room('r1', '甲')},
    states: {r1: state},
    send: data => {
      state.messages.push(user(1, data.text, {turnId: 't1', source: 'local'}));
      Object.assign(state, {busy: true, status: 'working'});
      return {sent: true};
    }
  });
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const sent = await voice.tool({name: 'room_send', args: {threadId: 'r1', text: '幫我查'}});
  state.messages.push(reply(2, '先看一下', {turnId: 't1'}));
  // GPT steer ("立即送入"): a person's message in the same turn while the room stays busy.
  state.messages.push(user(3, '順便看乙', {turnId: 't1', source: 'steer'}));
  voice.observe('r1', () => state);
  await settle();
  assert.equal((await readLog(root)).filter(e => e.type === 'trackEnd').length, 0, 'still the same turn');
  assert.match((await voice.tool({name: 'room_read', args: {threadId: 'r1'}})).lastSend.note, /還在處理/);
  state.messages.push(reply(4, '甲乙都查好了', {turnId: 't1'}));
  Object.assign(state, {busy: false, status: 'completed'});
  voice.observe('r1', () => state);
  await settle();
  const report = (await readLog(root)).find(e => e.type === 'report');
  assert.equal(report.code, sent.code);
  assert.equal(report.text, '甲乙都查好了');
  // A person's message in a new turn still ends it (the earlier turn's last reply is the answer).
  const {replyAfterMarker} = await import('../src/voice-secretary.mjs');
  const next = replyAfterMarker(
    {busy: true, status: 'working', messages: [user(1, '#m', {turnId: 'a'}), reply(2, '答', {turnId: 'a'}), user(3, '新的', {turnId: 'b'})]},
    '#m'
  );
  assert.equal(next.ended, true);
  assert.equal(next.reply.text, '答');
  await voice.close();
});

test('review 8: identical transcript parts arriving together are merged once', async () => {
  const root = await tempRoot('race-log');
  const voice = createVoiceSecretary({root, rooms: fakeRooms().rooms});
  await voice.ready();
  const part = {callId: 'call-race-0001', seq: 0, role: 'owner', text: 'hello'};
  await Promise.all([voice.log(part), voice.log(part)]);
  assert.deepEqual((await voice.entries()).entries.map(e => e.text), ['hello'], 'not doubled');
  await Promise.all([voice.log({...part, text: 'hello world'}), voice.log({...part, text: 'hello world'})]);
  assert.equal((await readLog(root)).length, 2, 'the first part and one supplement');
  const {entries} = await voice.entries();
  assert.deepEqual(entries.map(e => e.text), ['hello world']);
  await voice.close();
  // Rebuilt from the file, the text is the same.
  const again = createVoiceSecretary({root, rooms: fakeRooms().rooms});
  assert.deepEqual((await again.entries()).entries.map(e => e.text), ['hello world']);
  await again.close();
});

test('review 7/9: an uncertain segment is kept and labelled; labels are locked in the token', async () => {
  const root = await tempRoot('uncertain');
  const voice = createVoiceSecretary({root, rooms: fakeRooms().rooms});
  await voice.log({callId: 'call-unc-0001', seq: 0, role: 'owner', text: '幫我'});
  assert.equal((await voice.log({callId: 'call-unc-0001', seq: 0, role: 'owner', text: '幫我', uncertain: true})).saved, true);
  await assert.rejects(voice.log({callId: 'call-unc-0001', seq: 0, role: 'owner', text: 'x', uncertain: 'yes'}), /格式無效/);
  const {entries} = await voice.entries();
  assert.equal(entries[0].uncertain, true);
  assert(VOICE_FIELD_MASK.split(',').includes('labels'));
  await voice.close();
});
