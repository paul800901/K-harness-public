// Review fixes for the second voice secretary batch (docs/voice-secretary-design-20261106.md, 第二批互審修正).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createVoiceSecretary, relayMarker, NEW_ROOM_PERMISSIONS, taiwanText} from '../src/voice-secretary.mjs';
import {createConversationController} from '../src/conversation-controller.mjs';
import {saveMainSession, listMainSessions} from '../src/main-sessions.mjs';
import {scratchBase} from './scratch.mjs';

const tempRoot = name => mkdtemp(path.join(scratchBase, `emma-review-${name}-`));
const readLog = async root =>
  (await readFile(path.join(root, '.runtime/voice-secretary.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A fake K in memory: rooms made by create join the sessions so room_send can reach them.
function fakeK({create, models} = {}) {
  const created = [],
    sent = [],
    sessions = {};
  return {
    created,
    sent,
    sessions,
    rooms: {
      list: async () => Object.values(sessions).map(s => ({...s, status: 'idle'})),
      session: async id => sessions[id] ?? null,
      read: async () => ({messages: []}),
      peek: () => null,
      send: async data => {
        sent.push(data);
        return {sent: true};
      },
      note: async () => {},
      workspaces: async () => [{path: 'D:\\K-harness', name: 'K-harness'}],
      models: async () =>
        models ?? [
          {
            model: 'gpt-6.1-sol',
            displayName: 'GPT-6.1 Sol',
            provider: 'codex',
            supportedReasoningEfforts: [{reasoningEffort: 'high'}]
          }
        ],
      create: async data => {
        created.push(data);
        return create(data);
      }
    }
  };
}
const good = {workspace: 'K-harness', model: 'gpt-6.1-sol', effort: 'high', permission: 'read-only', text: '幫我看一下測試'};

// Review P1: the real conversation and unified controllers with fake native cores. The Claude core saves the new
// room in K's list, then K starts closing before the unified controller switches to Claude.
async function controllerWithCores(root, {closeAfterSave = false, inspect = async () => ({available: true})} = {}) {
  const opens = [];
  let n = 0,
    cc;
  const factory =
    provider =>
    ({onChange}) => {
      const state = {
        provider,
        status: 'idle',
        workspace: root,
        threadId: null,
        title: '',
        model: null,
        busy: false,
        messages: [],
        questions: [],
        workers: [],
        usage: {}
      };
      return {
        state,
        async models() {
          if (provider === 'codex')
            return {models: [{model: 'gpt-6.1-sol', supportedReasoningEfforts: [{reasoningEffort: 'high'}]}]};
          if (provider === 'claude')
            return {models: [{model: 'claude-opus-5-5', supportedReasoningEfforts: [{reasoningEffort: 'high'}]}]};
          return {models: []};
        },
        async usage() {
          return {};
        },
        async selectWorkspace({path: folder}) {
          state.workspace = folder;
          return {workspace: folder};
        },
        async open(data, {signal} = {}) {
          opens.push({provider, data});
          const threadId = data.threadId ?? `${provider}-${++n}`;
          await saveMainSession(root, {threadId, title: '', model: data.model, workspace: state.workspace});
          Object.assign(state, {threadId, model: data.model, status: 'ready'});
          if (closeAfterSave && !data.threadId) {
            void cc.closing.push(cc.close());
            while (!signal?.aborted) await wait(5);
          }
          onChange(state);
          return {threadId};
        },
        async send(data) {
          state.messages.push({id: `u${state.messages.length}`, role: 'user', text: data.text});
          onChange(state);
          return {sent: true};
        },
        async workers() {
          return [];
        },
        async close() {
          state.status = 'offline';
        }
      };
    };
  cc = createConversationController({
    root,
    codexFactory: factory('codex'),
    claudeFactory: factory('claude'),
    geminiFactory: factory('gemini'),
    grokFactory: factory('grok'),
    deepseekFactory: factory('deepseek'),
    inspect,
    browserRequest: async () => ({available: true, busy: false})
  });
  cc.closing = [];
  return {cc, opens};
}

test('review P1: a room saved before the open failed is not reported as not created and is never opened again', async () => {
  const root = await tempRoot('saved-then-closed');
  await saveMainSession(root, {threadId: 'room-shown', title: '我在看的房', model: 'gpt-6.1-sol', workspace: root});
  const args = {
    workspace: root,
    model: 'claude-opus-5-5',
    effort: 'high',
    permission: 'claude-manual',
    text: '新工作'
  };
  const first = await controllerWithCores(root, {closeAfterSave: true});
  const result = await first.cc.voice.tool({name: 'room_create', args});
  await Promise.all(first.cc.closing);
  const saved = (await listMainSessions(root)).sessions.filter(s => s.threadId !== 'room-shown');
  assert.equal(saved.length, 1, 'the native core saved one new room');
  assert.notEqual(result.created, 'not-created', JSON.stringify(result));
  assert.equal(result.created, 'uncertain');
  // Re-review: a new record in the list is never claimed as this room; without the operation's own id it stays unknown.
  assert.equal(result.threadId, undefined, 'the saved room is not claimed from the list');
  assert.equal(first.opens.filter(o => o.provider === 'claude').length, 1);
  // After a restart the same request is answered from the record, not created again.
  const again = await controllerWithCores(root);
  try {
    const repeat = await again.cc.voice.tool({name: 'room_create', args});
    assert.equal(repeat.duplicate, true, JSON.stringify(repeat));
    assert.equal(repeat.created, 'uncertain');
    assert.equal(again.opens.length, 0, 'nothing was opened');
    assert.equal((await listMainSessions(root)).sessions.length, 2, 'still one new room');
  } finally {
    await again.cc.close();
  }
});

test('review P1: a failure with nothing new in K’s list is still definitely not created', async () => {
  const root = await tempRoot('nothing-saved');
  await saveMainSession(root, {threadId: 'room-shown', title: '我在看的房', model: 'gpt-6.1-sol', workspace: root});
  const {cc, opens} = await controllerWithCores(root, {inspect: async () => ({available: false, reason: '未登入'})});
  try {
    const result = await cc.voice.tool({
      name: 'room_create',
      args: {workspace: root, model: 'claude-opus-5-5', effort: 'high', permission: 'claude-manual', text: '另一件'}
    });
    assert.equal(result.created, 'not-created', JSON.stringify(result));
    assert.match(result.error, /登入 Claude 訂閱/);
    assert.equal(opens.length, 0);
    assert.equal((await listMainSessions(root)).sessions.length, 1);
  } finally {
    await cc.close();
  }
});

test('review P2: a room_send racing the new room’s first sentence sends the text once', async () => {
  const root = await tempRoot('first-sentence-race');
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const k = fakeK({
    create: async data => {
      // The room is already in K's list (room_list shows it) while its creation has not returned yet.
      k.sessions['new-1'] = {threadId: 'new-1', title: '', workspace: data.workspace, model: data.model};
      await gate;
      return {threadId: 'new-1', title: ''};
    }
  });
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const creating = voice.tool({name: 'room_create', args: good});
  while (!k.sessions['new-1']) await wait(5);
  const direct = await voice.tool({name: 'room_send', args: {threadId: 'new-1', text: good.text}});
  assert.equal(direct.status, 'sent', JSON.stringify(direct));
  release();
  const made = await creating;
  assert.equal(made.created, 'created', JSON.stringify(made));
  assert.equal(k.sent.length, 1, 'the same text reached the room once');
  assert(k.sent[0].text.startsWith(relayMarker(direct.code)));
  assert.equal(made.status, 'not-sent');
  assert.equal(made.duplicate, true);
  assert.match(made.message, new RegExp(`#${direct.code}`));
  // Re-review: room_read still follows the relay that went, not the suppressed repeat.
  const read = await voice.tool({name: 'room_read', args: {threadId: 'new-1'}});
  assert.equal(read.lastSend.code, direct.code, JSON.stringify(read.lastSend));
  await voice.close();
  // The first sentence is recorded as not sent with its reason; a restart adds no "K stopped" note and sends nothing.
  const again = createVoiceSecretary({root, rooms: k.rooms});
  await again.ready();
  const log = await readLog(root);
  const firstSentence = log.filter(e => e.type === 'send' && e.code === made.code);
  assert.deepEqual(
    firstSentence.map(e => e.status),
    ['not-sent']
  );
  assert(!log.some(e => /送出第一句話前中斷/.test(e.error ?? '')));
  assert.equal(k.sent.length, 1);
  await again.close();
});

test('review P3: a model is chosen by its native id first and a shared display name is refused', async () => {
  const root = await tempRoot('model-names');
  const models = [
    {model: 'gpt-x', displayName: 'Same', provider: 'codex', supportedReasoningEfforts: [{reasoningEffort: 'high'}]},
    {model: 'gemma:gpt-x', displayName: 'Same', provider: 'gemma', supportedReasoningEfforts: [{reasoningEffort: 'high'}]},
    {model: 'gpt-y', displayName: 'gpt-x', provider: 'codex', supportedReasoningEfforts: [{reasoningEffort: 'high'}]}
  ];
  const k = fakeK({models, create: async () => ({threadId: 'new-1', title: ''})});
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const shared = await voice.tool({name: 'room_create', args: {...good, model: 'same'}});
  assert.match(shared.error ?? '', /對到不只一個/, JSON.stringify(shared));
  assert.match(shared.error, /gpt-x（Same，GPT）/);
  assert.match(shared.error, /gemma:gpt-x（Same，自架）/);
  assert.equal(k.created.length, 0, 'nothing was created for an unclear model');
  const byId = await voice.tool({name: 'room_create', args: {...good, model: 'gpt-x'}});
  assert.equal(byId.created, 'created', JSON.stringify(byId));
  assert.equal(k.created[0].model, 'gpt-x', 'the native id wins over another model’s display name');
  await voice.close();
});

test('review P3: effort and permission names each map to exactly one value', async () => {
  const root = await tempRoot('labels');
  const voice = createVoiceSecretary({root, rooms: fakeK().rooms});
  const {models} = await voice.tool({
    name: 'options_list',
    args: {}
  });
  const efforts = models.flatMap(m => m.efforts ?? []);
  for (const rows of [efforts, ...Object.values(NEW_ROOM_PERMISSIONS).map(r => r.map(([value, name]) => ({value, name})))]) {
    const names = new Map();
    for (const {value, name} of rows) {
      assert(!names.has(name) || names.get(name) === value, `「${name}」maps to two values`);
      names.set(name, value);
    }
    const values = new Set(rows.map(r => r.value));
    for (const name of names.keys()) assert(!values.has(name) || names.get(name) === name, `「${name}」is also another value`);
  }
  await voice.close();
});

test('review P4: technical text and recorded names stay as said; the model history keeps the original', async () => {
  for (const same of [
    '`node src/软件.mjs`',
    'D:\\项目\\软件.mjs',
    'https://example.com/软件/下载',
    '/home/项目/软件',
    './脚本/运行.ps1',
    '```\nconst 软件 = 1;\n```'
  ])
    assert.equal(taiwanText(same), same, same);
  assert.equal(taiwanText('打开 `src/软件.mjs` 看看'), '開啟 `src/软件.mjs` 看看');
  assert.equal(taiwanText('请打开src/软件.mjs，然后运行'), '请打开src/软件.mjs，然後執行');
  assert.equal(taiwanText('然后你试试看'), '然後你試試看', 'plain speech still converts');
  assert.equal(taiwanText('送到开发房间', ['开发']), '送到开发房間', 'a recorded room name is exact');

  const root = await tempRoot('names');
  const k = fakeK();
  k.sessions['room-dev'] = {threadId: 'room-dev', title: '开发', workspace: 'D:\\K-harness'};
  let body;
  const voice = createVoiceSecretary({
    root,
    rooms: k.rooms,
    connections: {
      list: async () => ({
        connections: [
          {id: 'a'.repeat(32), baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyConfigured: true}
        ]
      }),
      credentials: async () => ({key: 'k'})
    },
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({name: 'auth_tokens/x'}), {status: 200});
    }
  });
  await voice.tool({name: 'room_send', args: {threadId: 'room-dev', text: '跑測試'}});
  await voice.log({callId: 'call-names-0001', seq: 0, role: 'owner', text: '送到开发，然后看 `src/软件.mjs`'});
  const transcript = (await voice.entries()).entries.find(e => e.kind === 'transcript');
  assert.equal(transcript.text, '送到开发，然後看 `src/软件.mjs`');
  await voice.token();
  const instruction = body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
  assert(instruction.includes('本人逐字稿：送到开发，然后看 `src/软件.mjs`'), 'the model reads what arrived');
  assert.match(instruction, /逐字稿是語音辨識的原文，可能夾雜簡體字/);
  await voice.close();
});

test('review P5: only the returned page of transcripts is converted', async () => {
  const root = await tempRoot('page');
  const converted = [];
  const voice = createVoiceSecretary({
    root,
    rooms: fakeK().rooms,
    toDisplay: text => {
      converted.push(text);
      return text;
    }
  });
  for (let seq = 0; seq < 400; seq++) await voice.log({callId: 'call-page-00001', seq, role: 'owner', text: `第${seq}句`});
  const {entries, truncated} = await voice.entries();
  assert.equal(entries.length, 300);
  assert.equal(truncated, true);
  assert.equal(converted.length, 300, 'older entries are not converted');
  assert.equal(converted[0], '第100句');
  await voice.close();
});

test('re-review: a room someone else saved during a failed create is not claimed', async () => {
  const root = await tempRoot('other-room');
  await saveMainSession(root, {threadId: 'room-shown', title: '我在看的房', model: 'gpt-6.1-sol', workspace: root});
  // While the secretary's create is checking Claude, the person opens a room with the same settings.
  const {cc, opens} = await controllerWithCores(root, {
    inspect: async () => {
      await saveMainSession(root, {threadId: 'persons-room', title: '本人開的房', model: 'claude-opus-5-5', workspace: root});
      return {available: false, reason: '未登入'};
    }
  });
  try {
    const result = await cc.voice.tool({
      name: 'room_create',
      args: {workspace: root, model: 'claude-opus-5-5', effort: 'high', permission: 'claude-manual', text: '另一件'}
    });
    assert.equal(opens.length, 0);
    assert.equal(result.created, 'uncertain', JSON.stringify(result));
    assert.equal(result.threadId, undefined, 'the person’s room is not taken as the new room');
  } finally {
    await cc.close();
  }
});

test('re-review: an unreadable room record makes a failed create unknown, not "not created"', async () => {
  const root = await tempRoot('unreadable');
  await saveMainSession(root, {threadId: 'room-shown', title: '我在看的房', model: 'gpt-6.1-sol', workspace: root});
  await mkdir(path.join(root, '.runtime/main-sessions'), {recursive: true});
  await writeFile(path.join(root, '.runtime/main-sessions/broken.json'), '{not json');
  const {cc, opens} = await controllerWithCores(root, {inspect: async () => ({available: false, reason: '未登入'})});
  try {
    const result = await cc.voice.tool({
      name: 'room_create',
      args: {workspace: root, model: 'claude-opus-5-5', effort: 'high', permission: 'claude-manual', text: '另一件'}
    });
    assert.equal(opens.length, 0);
    assert.equal(result.created, 'uncertain', JSON.stringify(result));
  } finally {
    await cc.close();
  }
});

test('re-review: relative paths in any script keep their characters', () => {
  // Unspaced Chinese hides where a path starts, so words joined to it stay as said (display only).
  assert.equal(taiwanText('打开项目/软件.mjs 然后'), '打开项目/软件.mjs 然後');
  assert.equal(taiwanText(String.raw`看 项目\软件.mjs 然后`), String.raw`看 项目\软件.mjs 然後`);
  assert.equal(taiwanText(String.raw`打开 D:\项目\软件.mjs`), String.raw`開啟 D:\项目\软件.mjs`);
});
