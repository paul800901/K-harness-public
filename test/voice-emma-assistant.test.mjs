import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink} from 'node:fs/promises';
import path from 'node:path';
import {EMMA_SETTINGS_FILE, createVoiceSecretary} from '../src/voice-secretary.mjs';
import {FILE_READ_CHARS} from '../src/voice-workspace-read.mjs';
import {scratchBase} from './scratch.mjs';

// Emma as an assistant: read-only rooms and workspace files, plus web search and extra read-only folders only when
// the person writes them into the optional settings file in K's private state.
const tempRoot = name => mkdtemp(path.join(scratchBase, `voice-assist-${name}-`));
const writeSettings = async (root, value) => {
  await mkdir(path.join(root, '.runtime'), {recursive: true});
  await writeFile(path.join(root, EMMA_SETTINGS_FILE), typeof value === 'string' ? value : JSON.stringify(value));
};

async function setup() {
  const root = await tempRoot('state');
  const work = await tempRoot('work');
  const outside = await tempRoot('outside');
  await mkdir(path.join(work, 'docs/notes'), {recursive: true});
  await writeFile(path.join(work, 'docs/plan.md'), '計畫內容');
  await writeFile(path.join(work, 'docs/notes/會議紀錄.txt'), '會議');
  await writeFile(path.join(work, 'long.txt'), '字'.repeat(FILE_READ_CHARS + 5));
  await writeFile(path.join(work, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  await writeFile(path.join(work, '.env.local'), 'KEY=secret');
  await writeFile(path.join(work, '.envrc'), 'export KEY=secret');
  await writeFile(path.join(work, 'service-credentials.json'), '{}');
  await mkdir(path.join(work, '.runtime/agent-home'), {recursive: true});
  await writeFile(path.join(work, '.runtime/agent-home/auth.json'), '{}');
  await mkdir(path.join(work, 'node_modules/pkg'), {recursive: true});
  await writeFile(path.join(work, 'node_modules/pkg/plan.md'), 'dep');
  await writeFile(path.join(outside, 'plan.md'), '外面');
  // A junction to a folder outside the workspace (Windows: no admin rights needed).
  await symlink(outside, path.join(work, 'linked'), 'junction');
  const messages = [
    {role: 'user', text: '第一句'},
    {role: 'assistant', text: '回覆一'},
    {role: 'tool', text: '工具輸出'},
    {role: 'user', text: '第二句'},
    {role: 'assistant', text: '還在寫', partial: true},
    {role: 'assistant', text: '串流中', streaming: true},
    {role: 'assistant', text: '回覆二'}
  ];
  const rooms = {
    list: async () => [{threadId: 'r1', title: '甲房', workspace: work, status: 'idle'}],
    session: async id => (id === 'r1' ? {threadId: 'r1', title: '甲房'} : null),
    read: async () => ({messages}),
    peek: () => null,
    send: async () => ({sent: true}),
    note: async () => {},
    workspaces: async () => [{path: work, name: '工作區'}]
  };
  return {voice: createVoiceSecretary({root, rooms}), work, root};
}

test('Emma reads folders, finds names and pages through text files inside a workspace', async () => {
  const {voice} = await setup();
  const tool = (name, args) => voice.tool({name, args});

  const top = await tool('file_list', {workspace: '工作區'});
  assert.deepEqual(
    top.entries.map(e => e.name),
    ['docs', 'image.png', 'long.txt'],
    'links, K state, dependencies and secret-looking files are not listed'
  );
  assert.deepEqual((await tool('file_list', {workspace: '工作區', path: 'docs'})).entries.map(e => e.name), ['notes', 'plan.md']);

  const found = await tool('file_find', {workspace: '工作區', query: 'plan'});
  assert.deepEqual(found.results, [{path: 'docs/plan.md', type: '檔案'}], 'no match through links, node_modules or K state');
  assert.deepEqual((await tool('file_find', {workspace: '工作區', query: '會議 紀錄'})).results.map(r => r.path), ['docs/notes/會議紀錄.txt']);

  assert.equal((await tool('file_read', {workspace: '工作區', path: 'docs/plan.md'})).text, '計畫內容');
  const first = await tool('file_read', {workspace: '工作區', path: 'long.txt'});
  assert.equal(first.text.length, FILE_READ_CHARS);
  assert.equal(first.nextOffset, FILE_READ_CHARS);
  const rest = await tool('file_read', {workspace: '工作區', path: 'long.txt', offset: first.nextOffset});
  assert.equal(rest.text.length, 5);
  assert.equal(rest.nextOffset, null);
});

test('Emma cannot leave the workspace or read K state, sign-ins, secrets or binary files', async () => {
  const {voice, work} = await setup();
  const read = async p => (await voice.tool({name: 'file_read', args: {workspace: '工作區', path: p}})).error;
  assert.match(await read('../outside.txt'), /工作區外/);
  assert.match(await read(path.join(work, 'docs/plan.md')), /相對路徑/);
  assert.match(await read('docs/plan.md:hidden'), /相對路徑/, 'no NTFS streams');
  assert.match(await read('.runtime::$INDEX_ALLOCATION/agent-home/auth.json'), /相對路徑/);
  assert.match(await read('linked/plan.md'), /工作區外/);
  assert.match(await read('.env.local'), /不能讀/);
  assert.match(await read('.envrc'), /不能讀/);
  assert.match(await read('service-credentials.json'), /不能讀/);
  assert.match(await read('.runtime/agent-home/auth.json'), /不能讀/);
  assert.match(await read('node_modules/pkg/plan.md'), /不能讀/);
  assert.match(await read('image.png'), /不是 UTF-8 純文字檔/);
  await writeFile(path.join(work, 'plain.pdf'), '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  assert.match(await read('plain.pdf'), /不是 UTF-8 純文字檔/, 'ASCII-only PDF is not exposed as readable text');
  await writeFile(path.join(work, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  assert.match(await read('invalid.txt'), /不是 UTF-8 純文字檔/, 'invalid UTF-8 is not silently replaced');
  assert.match(await read('docs'), /不是檔案/);
  assert.match((await voice.tool({name: 'file_read', args: {workspace: '別處', path: 'docs/plan.md'}})).error, /找不到/);
  assert.match((await voice.tool({name: 'file_read', args: {workspace: '工作區', path: 'docs/plan.md', write: true}})).error, /只接受/);
});

test('room_read can add the room\'s recent conversation, finished person and agent messages only', async () => {
  const {voice} = await setup();
  const plain = await voice.tool({name: 'room_read', args: {threadId: 'r1'}});
  assert.equal(plain.recent, undefined);
  const recent = await voice.tool({name: 'room_read', args: {threadId: 'r1', recent: 3}});
  assert.deepEqual(
    recent.recent.map(m => [m.role, m.text]),
    [
      ['主代理', '回覆一'],
      ['本人', '第二句'],
      ['主代理', '回覆二']
    ]
  );
  assert.match((await voice.tool({name: 'room_read', args: {threadId: 'r1', recent: 21}})).error, /1–20/);
});

async function tokenSetup() {
  const root = await tempRoot('state');
  const rooms = {
    list: async () => [],
    session: async () => null,
    read: async () => ({messages: []}),
    peek: () => null,
    send: async () => ({sent: true}),
    note: async () => {},
    workspaces: async () => [],
    models: async () => [{model: 'm', provider: 'codex', supportedReasoningEfforts: []}],
    create: async () => {
      throw Error('must not create');
    }
  };
  const fetchImpl = async (url, options) => {
    fetchImpl.calls = (fetchImpl.calls ?? 0) + 1;
    fetchImpl.body = JSON.parse(options.body);
    return new Response(JSON.stringify({name: 'auth_tokens/fake'}), {status: 200});
  };
  const connections = {
    list: async () => ({connections: [{id: 'a'.repeat(32), baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyConfigured: true}]}),
    credentials: async () => ({key: 'fake'})
  };
  const voice = createVoiceSecretary({root, rooms, connections, fetchImpl});
  const setupBody = () => fetchImpl.body.bidiGenerateContentSetup;
  return {root, voice, fetchImpl, setupBody};
}

test('without the settings file there is no web search and no folder outside the workspaces', async () => {
  const {voice, setupBody} = await tokenSetup();
  await voice.token();
  assert.equal(setupBody().tools.length, 1);
  const instruction = setupBody().systemInstruction.parts[0].text;
  assert.doesNotMatch(instruction, /Google 搜尋/);
  assert.match(instruction, /沒有上網搜尋的工具/);
  assert.doesNotMatch(instruction, /另外只開放讀取/);
  assert.match((await voice.tool({name: 'file_list', args: {workspace: '桌面'}})).error, /找不到/);
});

test('web search and read-only folders follow the person\'s settings file; folders never become a new-room workspace', async () => {
  const {root, voice, setupBody} = await tokenSetup();
  const desk = await tempRoot('desk');
  await writeFile(path.join(desk, '確認.txt'), '桌面上的字');
  await writeSettings(root, {
    googleSearch: true,
    readFolders: [
      {name: '桌面', path: desk},
      {name: '下載', path: path.join(desk, 'missing')}
    ]
  });
  assert.equal((await voice.tool({name: 'file_read', args: {workspace: '桌面', path: '確認.txt'}})).text, '桌面上的字');
  assert.match((await voice.tool({name: 'file_list', args: {workspace: '下載'}})).error, /不存在/);
  const created = await voice.tool({
    name: 'room_create',
    args: {workspace: '桌面', model: 'm', effort: null, permission: 'read-only', text: '開房'}
  });
  assert.match(created.error, /找不到已登記/);
  await voice.token();
  assert.deepEqual(setupBody().tools.slice(1), [{googleSearch: {}}]);
  const instruction = setupBody().systemInstruction.parts[0].text;
  assert.match(instruction, /一定先用 Google 搜尋/);
  assert.match(instruction, /另外只開放讀取.*"桌面","下載"/u);

  // Turning search off again needs no restart.
  await writeSettings(root, {googleSearch: false});
  await voice.token();
  assert.equal(setupBody().tools.length, 1);
  assert.match((await voice.tool({name: 'file_list', args: {workspace: '桌面'}})).error, /找不到/);
});

test('a broken settings file is reported, not guessed around', async () => {
  const {root, voice, fetchImpl} = await tokenSetup();
  for (const [value, pattern] of [
    ['{', /不是有效的 JSON/],
    [{googleSearch: 'yes'}, /googleSearch/],
    [{readFolders: [{name: '桌面', path: 'Desktop'}]}, /完整路徑/],
    [{readFolders: {name: '桌面'}}, /readFolders/]
  ]) {
    await writeSettings(root, value);
    await assert.rejects(voice.token(), pattern);
    assert.match((await voice.tool({name: 'file_list', args: {workspace: '桌面'}})).error, pattern);
  }
  assert.equal(fetchImpl.calls, undefined, 'no token is asked for with a broken settings file');
});
