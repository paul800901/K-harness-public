// Second batch of the voice secretary (docs/voice-secretary-design-20261106.md, 第二批：艾瑪、開新房、簡繁轉換).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createVoiceSecretary, relayMarker, NEW_ROOM_PERMISSIONS, taiwanText} from '../src/voice-secretary.mjs';
import {SECRETARY_NAME, SECRETARY_TITLE} from '../shared/voice-secretary-name.mjs';
import {createConversationController} from '../src/conversation-controller.mjs';
import {saveMainSession, listMainSessions} from '../src/main-sessions.mjs';
import {scratchBase} from './scratch.mjs';

const tempRoot = name => mkdtemp(path.join(scratchBase, `emma-${name}-`));
const logFile = root => path.join(root, '.runtime/voice-secretary.jsonl');
const readLog = async root =>
  (await readFile(logFile(root), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

const MODELS = [
  {
    model: 'gpt-6.1-sol',
    displayName: 'GPT-6.1 Sol',
    provider: 'codex',
    supportedReasoningEfforts: [{reasoningEffort: 'medium'}, {reasoningEffort: 'high'}]
  },
  {
    model: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    provider: 'claude',
    supportedReasoningEfforts: [{reasoningEffort: 'high'}]
  },
  {model: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', provider: 'gemini', supportedReasoningEfforts: []},
  {
    model: 'gpt-old',
    displayName: 'Old',
    provider: 'codex',
    available: false,
    supportedReasoningEfforts: [{reasoningEffort: 'high'}]
  }
];
const WORKSPACES = [
  {path: 'D:\\K-harness', name: 'K-harness'},
  {path: 'D:\\Notes', name: 'Notes'},
  {path: 'E:\\Notes', name: 'Notes'},
  {path: 'D:\\Old', name: 'Old', archived: true},
  {path: 'D:\\ExampleApps\\ExampleAudio'}
];

// A fake K with a scripted room creation; created rooms join the sessions so room_send and tracking see them.
function fakeK({create, send} = {}) {
  const created = [],
    sent = [],
    notes = [],
    sessions = {},
    states = {};
  let n = 0;
  return {
    created,
    sent,
    notes,
    sessions,
    states,
    rooms: {
      list: async () =>
        Object.values(sessions).map(s => ({
          threadId: s.threadId,
          title: s.title,
          workspace: s.workspace,
          status: 'idle'
        })),
      session: async id => sessions[id] ?? null,
      read: async id => states[id] ?? {messages: []},
      peek: id => states[id] ?? null,
      send: async data => {
        sent.push(data);
        return send ? send(data) : {sent: true};
      },
      note: async (id, text) => notes.push({id, text}),
      workspaces: async () => WORKSPACES,
      models: async () => MODELS,
      create: async data => {
        created.push(data);
        if (create) return create(data);
        const threadId = `new-${++n}`;
        sessions[threadId] = {threadId, title: '', model: data.model, workspace: data.workspace};
        return {threadId, title: ''};
      }
    }
  };
}
const good = {
  workspace: 'K-harness',
  model: 'gpt-6.1-sol',
  effort: 'high',
  permission: 'danger-full-access',
  text: '幫我看一下測試'
};
const createTool = (voice, args) => voice.tool({name: 'room_create', args});

test('room_create requires all five settings and accepts only real workspaces, models, efforts and permissions', async () => {
  const root = await tempRoot('validate');
  const k = fakeK();
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  for (const key of Object.keys(good)) {
    const args = {...good};
    delete args[key];
    assert.match((await createTool(voice, args)).error, /五項都必填/, `missing ${key}`);
  }
  assert.match((await createTool(voice, {...good, accessMode: 'x'})).error, /五項都必填/);
  assert.match(
    (await createTool(voice, {...good, effort: undefined})).error,
    /五項都必填/,
    'undefined effort is not null'
  );
  const bad = [
    [{workspace: 'Nowhere'}, /找不到已登記、未封存的工作區「Nowhere」。可選的有：K-harness（D:\\K-harness）/],
    [{workspace: 'Old'}, /找不到已登記、未封存/],
    [{workspace: 'D:\\Old'}, /找不到已登記、未封存/],
    [{workspace: 'Notes'}, /對到不只一個/],
    [{workspace: ''}, /請指定工作區/],
    [{model: 'gpt-9'}, /沒有可用的型號「gpt-9」/],
    [{model: 'gpt-old'}, /沒有可用的型號/],
    [{effort: 'ultra'}, /不支援推理程度「ultra」；可選：medium（中）、high（高）/],
    [{effort: null}, /請指定推理程度/],
    [{effort: ''}, /請指定推理程度/],
    [{model: 'gemini-3.8-flash', effort: 'high', permission: 'read-only'}, /沒有推理程度設定，effort 要傳 null/],
    [{permission: 'claude-manual'}, /GPT 的新聊天室沒有「claude-manual」這個權限/],
    [{model: 'claude-opus-5-5', permission: 'danger-full-access'}, /Claude 的新聊天室沒有/],
    [{model: 'gemini-3.8-flash', effort: null, permission: 'auto-review'}, /Gemini 的新聊天室沒有/],
    [{permission: ''}, /請指定權限/],
    [{text: '  '}, /1–4000/],
    [{text: 'x'.repeat(4001)}, /1–4000/]
  ];
  for (const [change, pattern] of bad)
    assert.match((await createTool(voice, {...good, ...change})).error ?? '', pattern, JSON.stringify(change));
  assert.equal(k.created.length, 0, 'nothing was created');
  assert.equal(k.sent.length, 0);
  await voice.close();
  await assert.rejects(readFile(logFile(root)), {code: 'ENOENT'}, 'nothing was recorded');
});

test('room_create makes the room, relays the first sentence with a code and tracks its reply', async () => {
  const root = await tempRoot('create');
  const k = fakeK();
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  // Names, paths, display names and Chinese labels resolve to the native values.
  const result = await createTool(voice, {
    workspace: 'd:\\k-harness\\',
    model: 'GPT-6.1 Sol',
    effort: '高',
    permission: '完整存取權',
    text: '  幫我看一下測試  '
  });
  assert.equal(result.created, 'created');
  assert.equal(result.status, 'sent');
  assert.deepEqual(k.created, [
    // The room is named after the first sentence, not after the relay marker.
    {workspace: 'D:\\K-harness', model: 'gpt-6.1-sol', effort: 'high', accessMode: 'danger-full-access', title: '幫我看一下測試'}
  ]);
  assert.equal(k.sent.length, 1);
  assert.equal(k.sent[0].threadId, 'new-1');
  assert.equal(k.sent[0].text, `${relayMarker(result.code)}\n幫我看一下測試`);
  assert.equal(result.sentText, k.sent[0].text);
  assert.equal(result.title, '新聊天室（K-harness）');
  assert.match(result.message, /已在「K-harness」開了新聊天室/);
  // A model without efforts takes null; a workspace without a name uses its folder name.
  const flash = await createTool(voice, {
    workspace: 'ExampleAudio',
    model: 'gemini-3.8-flash',
    effort: null,
    permission: 'read-only',
    text: '寫一篇'
  });
  assert.equal(flash.status, 'sent');
  assert.deepEqual(k.created[1], {
    workspace: 'D:\\ExampleApps\\ExampleAudio',
    model: 'gemini-3.8-flash',
    effort: null,
    accessMode: 'read-only',
    title: '寫一篇'
  });
  // K writes the creation and the send; the creation carries every setting.
  const events = await readLog(root);
  const first = events.filter(e => e.code === result.code);
  assert.deepEqual(
    first.map(e => [e.type, e.status]),
    [
      ['create', 'creating'],
      ['create', 'created'],
      ['send', 'sending'],
      ['send', 'sent']
    ]
  );
  assert.equal(first[0].workspaceName, 'K-harness');
  assert.equal(first[0].modelName, 'GPT-6.1 Sol');
  assert.equal(first[0].effort, 'high');
  assert.equal(first[0].permissionName, '完整存取權');
  const {entries} = await voice.entries();
  const made = entries.find(e => e.kind === 'create' && e.code === result.code);
  assert.equal(made.status, 'created');
  assert.equal(made.threadId, 'new-1');
  assert(entries.indexOf(made) < entries.findIndex(e => e.kind === 'send' && e.code === result.code));
  // The reply to the first sentence is reported like any relay.
  k.states['new-1'] = {
    status: 'completed',
    busy: false,
    title: '測試檢查',
    messages: [
      {role: 'user', text: k.sent[0].text},
      {role: 'assistant', text: '測試都過了'}
    ]
  };
  voice.observe('new-1', () => k.states['new-1']);
  await settle();
  const report = (await voice.entries()).entries.find(e => e.kind === 'report');
  assert.equal(report.code, result.code);
  assert.equal(report.text, '測試都過了');
  // A later room_send of the same words to the new room is deduplicated against the first sentence.
  const again = await voice.tool({name: 'room_send', args: {threadId: 'new-1', text: '幫我看一下測試'}});
  assert.equal(again.duplicate, true);
  assert.equal(k.sent.length, 2);
  await voice.close();
});

test('the same room_create within ten minutes creates once, also when two arrive together', async () => {
  const root = await tempRoot('dedupe');
  let clock = new Date('2026-11-06T10:00:00Z');
  const k = fakeK();
  const voice = createVoiceSecretary({root, rooms: k.rooms, now: () => clock});
  const [a, b] = await Promise.all([createTool(voice, good), createTool(voice, good)]);
  assert.equal(k.created.length, 1, 'created once');
  assert.equal(k.sent.length, 1, 'first sentence sent once');
  assert.equal([a, b].filter(r => r.duplicate).length, 1);
  assert.equal(a.code, b.code);
  const c = await createTool(voice, good);
  assert.equal(c.duplicate, true);
  assert.equal(c.created, 'created');
  assert.equal(c.status, 'sent');
  assert.match(c.message, /沒有再開一次/);
  // Any different setting is a different request.
  await createTool(voice, {...good, effort: 'medium'});
  assert.equal(k.created.length, 2);
  clock = new Date('2026-11-06T10:11:00Z');
  await createTool(voice, good);
  assert.equal(k.created.length, 3, 'after ten minutes it is a new request');
  await voice.close();
});

test('a failed creation sends nothing; an unknown one is never retried; a failed first sentence is not resent', async () => {
  const root = await tempRoot('failures');
  let mode = 'not-created';
  const k = fakeK({
    create: () => {
      if (mode === 'not-created') throw Object.assign(Error('請先在 K 登入 Claude 訂閱。'), {notCreated: true});
      if (mode === 'uncertain') throw Error('連線中斷');
      if (mode === 'half') throw Object.assign(Error('討論載入失敗'), {createdThreadId: 'half-1'});
      if (mode === 'bad-id') return {threadId: '../x'};
      k.sessions['ok-1'] = {threadId: 'ok-1', title: '', workspace: 'D:\\K-harness'};
      return {threadId: 'ok-1', title: ''};
    },
    send: () => {
      throw Error('送出時連線中斷');
    }
  });
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const a = await createTool(voice, good);
  assert.equal(a.created, 'not-created');
  assert.equal(a.status, 'not-sent');
  assert.match(a.message, /確定沒有建立/);
  assert.equal(k.sent.length, 0);
  // Nothing was made, so the same request may be made again.
  const b = await createTool(voice, good);
  assert.equal(b.duplicate, undefined);
  assert.equal(k.created.length, 2);
  mode = 'uncertain';
  const c = await createTool(voice, {...good, text: '第二件'});
  assert.equal(c.created, 'uncertain');
  assert.equal(c.status, 'uncertain');
  assert.match(c.message, /沒有重開/);
  const c2 = await createTool(voice, {...good, text: '第二件'});
  assert.equal(c2.duplicate, true);
  assert.equal(c2.created, 'uncertain');
  assert.equal(k.created.length, 3, 'an unknown creation is not repeated');
  mode = 'half';
  const d = await createTool(voice, {...good, text: '第三件'});
  assert.equal(d.created, 'uncertain');
  assert.equal(d.threadId, 'half-1', 'the room id that is known is reported');
  mode = 'bad-id';
  assert.equal((await createTool(voice, {...good, text: '第四件'})).created, 'uncertain');
  assert.equal(k.sent.length, 0, 'no first sentence without a confirmed room');
  // Created, but the first sentence has an unknown outcome: a note in the new room, never resent.
  mode = 'ok';
  const e = await createTool(voice, {...good, text: '第五件'});
  assert.equal(e.created, 'created');
  assert.equal(e.status, 'uncertain');
  assert.equal(k.sent.length, 1);
  assert.equal(k.notes.length, 1);
  assert.equal(k.notes[0].id, 'ok-1');
  assert.match(k.notes[0].text, /送出狀態不明、未重送/);
  const e2 = await createTool(voice, {...good, text: '第五件'});
  assert.equal(e2.duplicate, true);
  assert.equal(e2.status, 'uncertain');
  assert.equal(k.sent.length, 1);
  const statuses = (await voice.entries()).entries.filter(x => x.kind === 'create').map(x => x.status);
  assert.deepEqual(statuses, ['not-created', 'not-created', 'uncertain', 'uncertain', 'uncertain', 'created']);
  await voice.close();
});

test('a restart marks an unfinished creation unknown and a never-sent first sentence not sent, without retrying', async () => {
  const root = await tempRoot('restart');
  await mkdir(path.dirname(logFile(root)), {recursive: true});
  const at = '2026-11-06T10:00:00.000Z';
  await writeFile(
    logFile(root),
    [
      {
        type: 'create',
        code: 'aaaaaa',
        workspace: 'D:\\K-harness',
        workspaceName: 'K-harness',
        model: 'gpt-6.1-sol',
        modelName: 'GPT-6.1 Sol',
        effort: 'high',
        permission: 'read-only',
        permissionName: '唯讀',
        text: '甲',
        hash: 'h1',
        status: 'creating',
        startedAt: at,
        at
      },
      {
        type: 'create',
        code: 'bbbbbb',
        workspace: 'D:\\K-harness',
        workspaceName: 'K-harness',
        model: 'gpt-6.1-sol',
        modelName: 'GPT-6.1 Sol',
        effort: 'high',
        permission: 'read-only',
        permissionName: '唯讀',
        text: '乙',
        hash: 'h2',
        status: 'creating',
        startedAt: at,
        at
      },
      {type: 'create', code: 'bbbbbb', status: 'created', threadId: 'made-1', title: '新聊天室（K-harness）', at}
    ]
      .map(row => JSON.stringify(row))
      .join('\n') + '\n'
  );
  const k = fakeK();
  k.sessions['made-1'] = {threadId: 'made-1', title: '', workspace: 'D:\\K-harness'};
  const voice = createVoiceSecretary({root, rooms: k.rooms});
  const {entries} = await voice.entries();
  assert.deepEqual(
    entries.map(e => [e.kind, e.code, e.status]),
    [
      ['create', 'aaaaaa', 'uncertain'],
      ['create', 'bbbbbb', 'created'],
      ['send', 'bbbbbb', 'not-sent']
    ]
  );
  assert.equal(k.created.length + k.sent.length, 0, 'nothing was made or sent again');
  await voice.close();
});

test('the browser cannot write a room creation or a send', async () => {
  const root = await tempRoot('forge');
  const voice = createVoiceSecretary({root, rooms: fakeK().rooms});
  for (const forged of [
    {type: 'create', callId: 'call-forge-0001', seq: 0, role: 'secretary', text: '開了新房'},
    {kind: 'create', callId: 'call-forge-0001', seq: 0, role: 'secretary', text: 'x'},
    {callId: 'call-forge-0001', seq: 0, role: 'k', text: '艾瑪開了新房'},
    {callId: 'call-forge-0001', seq: 0, role: 'secretary', text: 'x', status: 'created', threadId: 'r1'}
  ])
    await assert.rejects(voice.log(forged), /格式無效/, JSON.stringify(forged));
  assert.deepEqual((await voice.entries()).entries, []);
  await voice.close();
});

test('transcripts read back in Taiwan traditional Chinese; the file keeps what arrived', async () => {
  assert.equal(taiwanText('然后你试试看'), '然後你試試看');
  assert.equal(taiwanText('喂，听得到吗'), '喂，聽得到嗎');
  assert.equal(taiwanText('软件内存打印'), '軟體記憶體列印', 'Taiwan wording, not just characters');
  for (const same of ['我們今天的頭髮很乾淨', '幫我查帳，看一下這個著作', 'Oi? Eu não estou', ''])
    assert.equal(taiwanText(same), same);
  const root = await tempRoot('convert');
  const k = fakeK();
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
      k.tokenBody = JSON.parse(options.body);
      return new Response(JSON.stringify({name: 'auth_tokens/x'}), {status: 200});
    }
  });
  await voice.log({callId: 'call-cn-000001', seq: 0, role: 'owner', text: '然后你试试看'});
  await voice.log({callId: 'call-cn-000001', seq: 1, role: 'secretary', text: '好的，我来试试'});
  const {entries} = await voice.entries();
  assert.deepEqual(
    entries.map(e => e.text),
    ['然後你試試看', '好的，我來試試']
  );
  const raw = await readLog(root);
  assert.deepEqual(
    raw.map(e => e.text),
    ['然后你试试看', '好的，我来试试'],
    'the original JSONL is unchanged'
  );
  await voice.token();
  const instruction = k.tokenBody.bidiGenerateContentSetup.systemInstruction.parts[0].text;
  // The model's history keeps what arrived (review P4): conversion is for the person's page only.
  assert(instruction.includes('本人逐字稿：然后你试试看'));
  assert(instruction.includes(`${SECRETARY_NAME}逐字稿：好的，我来试试`));
  assert(!instruction.includes('然後你試試看'));
  await voice.close();
  // Old records written before this change convert the same way.
  const again = createVoiceSecretary({root, rooms: k.rooms});
  assert.equal((await again.entries()).entries[0].text, '然後你試試看');
  await again.close();
});

test('the instruction names Emma, reads every setting back before sending and asks for anything unsaid', async () => {
  const root = await tempRoot('instruction');
  let body;
  const k = fakeK();
  k.sessions.r1 = {threadId: 'r1', title: '甲房', workspace: 'D:\\K-harness'};
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
  await createTool(voice, good);
  await voice.token();
  const text = body.bidiGenerateContentSetup.systemInstruction.parts[0].text;
  assert.equal(SECRETARY_NAME, '艾瑪');
  assert.equal(SECRETARY_TITLE, '艾瑪 · K 語音秘書');
  assert.match(text, /名字叫「艾瑪」（英文 Emma）/);
  assert.match(text, /room_send 或 room_create 之前，先把你聽懂的內容完整複述/);
  assert.match(text, /交給哪個房（開新房就說在哪個工作區開）、用什麼模型、推理程度、權限，以及要說的話/);
  assert.match(text, /「這樣對嗎？可以送嗎？」/);
  assert.match(text, /本人改口，就照新的內容重新完整複述/);
  assert.match(text, /本人沒講到的任何一項，你都必須主動問本人；不可以自己挑，也不可以套用預設值/);
  assert.match(text, /不構成這次送出的授權/);
  assert.match(text, /不要自己再送或再開一次/);
  assert.match(text, /可以開新聊天室的工作區：\["K-harness","Notes","Notes","ExampleAudio"\]/);
  // Emma's own room creation is in the history as a K record, with every setting.
  assert.match(
    text,
    /K 紀錄：艾瑪開了新聊天室 #\w{6}（工作區「K-harness」、模型 GPT-6.1 Sol、推理程度 高、權限 完整存取權）：已建立/
  );
  assert(!/付費|Free tier|免費額度/u.test(text), 'no paid-tier reminder');
  // room_list carries the workspaces; options_list the models, efforts and permissions.
  const list = await voice.tool({name: 'room_list', args: {}});
  assert.deepEqual(
    list.workspaces.map(w => w.name),
    ['K-harness', 'Notes', 'Notes', 'ExampleAudio']
  );
  const options = await voice.tool({name: 'options_list', args: {}});
  assert.deepEqual(
    options.models.map(m => [m.model, m.provider, m.efforts?.map(e => e.value) ?? null]),
    [
      ['gpt-6.1-sol', 'GPT', ['medium', 'high']],
      ['claude-opus-5-5', 'Claude', ['high']],
      ['gemini-3.8-flash', 'Gemini', null]
    ]
  );
  assert.deepEqual(Object.keys(options.permissions), ['GPT', 'Claude', 'Gemini']);
  assert.deepEqual(
    options.permissions.Gemini.map(p => p.value),
    ['workspace-write', 'danger-full-access', 'read-only']
  );
  assert.match((await voice.tool({name: 'options_list', args: {x: 1}})).error, /不接受參數/);
  await voice.close();
});

test('the secretary offers exactly the permissions of K’s new-chat picker', async () => {
  const source = (
    await readFile(fileURLToPath(new URL('../frontend/permission-picker.jsx', import.meta.url)), 'utf8')
  ).replace(/\r\n/gu, '\n');
  const table = name => {
    const start = source.indexOf(`export const ${name} = {`),
      block = source.slice(start, source.indexOf('\n};', start));
    return [...block.matchAll(/^ {2}'([\w-]+)': \{\n {4}name: '([^']+)'|^ {2}'([\w-]+)': \{name: '([^']+)'/gmu)].map(
      m => (m[1] ? [m[1], m[2]] : [m[3], m[4]])
    );
  };
  assert.deepEqual(NEW_ROOM_PERMISSIONS.codex, table('permissionModes'));
  assert.deepEqual(NEW_ROOM_PERMISSIONS.claude, table('claudePermissionModes'));
  assert.deepEqual(NEW_ROOM_PERMISSIONS.gemini, table('geminiPermissionModes'));
  assert.deepEqual(NEW_ROOM_PERMISSIONS.grok, table('grokPermissionModes'));
  assert.deepEqual(NEW_ROOM_PERMISSIONS.deepseek, table('deepseekPermissionModes'));
  // Self-hosted rooms spread the Codex table.
  assert.match(source, /export const selfHostPermissionModes = \{\n {2}\.\.\.permissionModes,/u);
  assert.deepEqual(NEW_ROOM_PERMISSIONS.gemma, NEW_ROOM_PERMISSIONS.codex);
});

test('the conversation controller creates the room in the background and relays the first sentence', async () => {
  const root = await tempRoot('controller');
  await saveMainSession(root, {threadId: 'room-shown', title: '我在看的房', model: 'gpt-6.1-sol', workspace: root});
  const controllers = [];
  let n = 0,
    failOpen = false;
  const cc = createConversationController({
    root,
    sessionFactory: ({onChange}) => {
      const c = {
        state: {
          provider: 'codex',
          status: 'ready',
          workspace: root,
          threadId: null,
          title: '',
          model: 'gpt-6.1-sol',
          busy: false,
          messages: []
        },
        opened: null,
        async models() {
          return {
            models: [
              {
                model: 'gpt-6.1-sol',
                displayName: 'GPT-6.1 Sol',
                provider: 'codex',
                supportedReasoningEfforts: [{reasoningEffort: 'high'}]
              }
            ]
          };
        },
        async usage() {
          return {};
        },
        async selectWorkspace({path: folder}) {
          this.state.workspace = folder;
          return {workspace: folder};
        },
        async open(data) {
          this.opened = data;
          if (failOpen && !data.threadId) throw Error('原生建立失敗');
          const threadId = data.threadId ?? `created-${++n}`;
          if (!data.threadId)
            await saveMainSession(root, {threadId, title: '', model: data.model, workspace: this.state.workspace});
          this.state.threadId = threadId;
          this.state.title = data.threadId ? '我在看的房' : '';
          return {threadId};
        },
        async send(data) {
          this.state.messages.push({
            id: `u${this.state.messages.length}`,
            role: 'user',
            text: data.text,
            createdAt: new Date().toISOString()
          });
          this.state.busy = true;
          this.state.status = 'working';
          onChange();
          return {sent: true};
        },
        async workers() {
          return [];
        },
        async metadata({threadId, title}) {
          this.state.title = title;
          await saveMainSession(root, {threadId, title, model: this.state.model, workspace: this.state.workspace});
          return {threadId, title};
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
    await cc.open({threadId: 'room-shown', model: 'gpt-6.1-sol'});
    assert.equal(cc.state.threadId, 'room-shown');
    const list = await cc.voice.tool({name: 'room_list', args: {}});
    assert.deepEqual(
      list.workspaces.map(w => w.path),
      [root]
    );
    const result = await cc.voice.tool({
      name: 'room_create',
      args: {
        workspace: path.basename(root),
        model: 'gpt-6.1-sol',
        effort: 'high',
        permission: 'danger-full-access',
        text: '新工作'
      }
    });
    assert.equal(result.created, 'created', JSON.stringify(result));
    assert.equal(result.status, 'sent');
    const made = controllers.find(c => c.state.threadId === result.threadId);
    assert(made, 'a new room controller exists');
    assert.deepEqual(made.opened, {
      workspace: root,
      model: 'gpt-6.1-sol',
      effort: 'high',
      accessMode: 'danger-full-access',
      permissionConfirmed: true
    });
    assert.equal(made.state.workspace, root);
    assert.equal(made.state.title, '新工作', 'named after the first sentence before it was sent');
    assert(made.state.messages[0].text.startsWith(relayMarker(result.code)));
    assert.equal(cc.state.threadId, 'room-shown', 'the shown room did not change');
    assert.equal(cc.state.connectionOpening, false, 'no pending view was shown');
    assert((await listMainSessions(root)).sessions.some(s => s.threadId === result.threadId));
    made.finish('新工作做好了');
    await settle();
    const {entries} = await cc.voice.entries();
    assert.equal(entries.find(e => e.kind === 'report')?.text, '新工作做好了');
    // A creation that fails before the room has an id is definitely not created; the shown room stays.
    failOpen = true;
    const before = (await listMainSessions(root)).sessions.length;
    const failed = await cc.voice.tool({
      name: 'room_create',
      args: {workspace: root, model: 'gpt-6.1-sol', effort: 'high', permission: 'read-only', text: '另一件'}
    });
    assert.equal(failed.created, 'not-created', JSON.stringify(failed));
    assert.match(failed.error, /原生建立失敗/);
    assert.equal(cc.state.threadId, 'room-shown');
    assert.equal((await listMainSessions(root)).sessions.length, before);
  } finally {
    await cc.close();
  }
});
