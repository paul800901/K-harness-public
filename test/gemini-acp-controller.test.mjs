import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs, {mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createGeminiController} from '../src/gemini-controller.mjs';
import {commonMemoryPath, globalRulesPath, readCommonMemory, readGlobalRules} from '../src/common-memory.mjs';
import {identifyBrowserServer} from '../src/browser-mcp-config.mjs';
import {scratchBase} from './scratch.mjs';

const models = ['gemini-3.8-flash-low', 'gemini-3.8-flash-high'];
const loginFactory = () => ({status: async () => ({available: true, models, version: '1.5.9-fixture'})});

const finish = async c => {
  for (let i = 0; c.state.busy && i < 400; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(c.state.busy, false);
};

const until = async (check, label) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`timed out: ${label}`);
};

async function createTempRoot() {
  await mkdir(scratchBase, {recursive: true});
  return mkdtemp(path.join(scratchBase, 'gemini-acp-ctrl-'));
}

function ruleAcpFixture(root, onPrompt) {
  const sessionId = randomUUID();
  const requests = [];
  const c = createGeminiController({
    root,
    geminiExecutable: 'fixture',
    loginFactory,
    openAgent: async opts => ({
      pid: 7130,
      exited: false,
      closed: Promise.resolve(),
      async request(method, params) {
        requests.push({method, params});
        if (method === 'session/new') return {sessionId};
        if (method !== 'session/prompt') return {};
        return onPrompt(params, update => opts.onNotification({method: 'session/update', params: {sessionId, update}}));
      },
      notify() {},
      async close() {
        this.exited = true;
      }
    })
  });
  return {c, requests, sessionId};
}

test('per-turn ACP lifecycle runs initialize -> session/new (saved immediately) -> set_model/mode -> prompt -> close, then session/resume on turn 2', async () => {
  const root = await createTempRoot();
  const rules = globalRulesPath(root);
  const opened = [];
  let savedDuringPrompt = null;
  let threadId;

  const c = createGeminiController({
    root,
    env: {
      LOCALAPPDATA: path.join(root, 'local'),
      SystemRoot: process.env.SystemRoot ?? root,
      TEMP: path.join(root, 'host-temp')
    },
    loginFactory,
    stopGraceMs: 25,
    browserConfig: async input =>
      identifyBrowserServer(
        {url: 'http://127.0.0.1:44444/mcp', headers: {Authorization: 'Bearer test-secret'}},
        input.conversationId
      ),
    closeBrowser: async () => {},
    openAgent: async opts => {
      const requests = [];
      let sessionId = null;
      let closeCalls = 0;
      const entry = {args: opts.args, env: opts.env, requests, get closeCalls() { return closeCalls; }};
      opened.push(entry);
      return {
        pid: 9000 + opened.length,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method, params) {
          requests.push({method, params: structuredClone(params)});
          if (method === 'session/new') {
            sessionId = randomUUID();
            return {sessionId};
          }
          if (method === 'session/resume') {
            sessionId = params.sessionId;
            return {};
          }
          if (method === 'session/prompt') {
            if (opened.length === 1) {
              savedDuringPrompt = JSON.parse(
                await readFile(path.join(root, '.runtime/gemini-sessions', `${threadId}.json`), 'utf8')
              );
            }
            opts.onNotification?.({
              method: 'session/update',
              params: {
                sessionId,
                update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: `reply ${opened.length}`}}
              }
            });
            return {stopReason: 'end_turn', usage: {totalTokens: 15, inputTokens: 10, outputTokens: 5}};
          }
          return {};
        },
        notify() {},
        async close() {
          closeCalls++;
          this.exited = true;
        }
      };
    }
  });

  try {
    await mkdir(path.dirname(rules), {recursive: true});
    await writeFile(rules, '- 合成全域工作規則');
    ({threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'workspace-write'}));
    await c.send({text: 'turn one'});
    await finish(c);

    assert.equal(opened.length, 1);
    assert.deepEqual(
      opened[0].requests.map(r => r.method),
      ['session/new', 'session/set_model', 'session/set_mode', 'session/prompt']
    );
    assert.ok(savedDuringPrompt?.nativeSessionId, 'nativeSessionId saved before session/prompt');
    assert.equal(opened[0].requests[2].params.modeId, 'default');
    assert.equal(opened[0].closeCalls, 1);
    const globalRef = path.join(opened[0].env.USERPROFILE, '.gemini/config/rules/k-global-rules.md');
    assert.ok((await readFile(globalRef, 'utf8')).includes(rules));
    assert.deepEqual(opened[0].requests[3].params.prompt, [{type: 'text', text: 'turn one'}]);
    assert.equal(opened[0].env.TEMP, path.join(root, 'agent-home/gemini/main', threadId, 'tmp'));
    const newMcp = opened[0].requests[0].params.mcpServers;
    assert.deepEqual(newMcp, [
      {
        type: 'http',
        name: 'k_browser',
        url: 'http://127.0.0.1:44444/mcp',
        headers: [{name: 'Authorization', value: 'Bearer test-secret'}]
      }
    ]);

    await rm(rules);
    const learn = '/learn 保留原文\n第二輪';
    await c.send({text: learn});
    await finish(c);

    assert.equal(opened.length, 2);
    assert.deepEqual(
      opened[1].requests.map(r => r.method),
      ['session/resume', 'session/set_model', 'session/set_mode', 'session/prompt']
    );
    assert.equal(opened[1].requests[0].params.sessionId, savedDuringPrompt.nativeSessionId);
    const resumed = opened[1].requests[3].params;
    assert.equal(resumed.sessionId, savedDuringPrompt.nativeSessionId);
    assert.equal(resumed.prompt.length, 1);
    assert.match(resumed.prompt[0].text, /^\/learn .*\n[\s\S]*目前未啟用（檔案不存在[\s\S]*均已失效/);
    assert.ok(resumed.prompt[0].text.endsWith(learn.slice('/learn'.length)));
    assert.equal(c.state.messages.findLast(m => m.role === 'user').text, learn);
    await assert.rejects(readFile(globalRef), {code: 'ENOENT'});
    assert.equal(opened[1].closeCalls, 1);
    assert.equal(c.state.messages.filter(m => m.role === 'assistant').map(m => m.text).join('|'), 'reply 1|reply 2');

    await writeFile(rules, Buffer.from([0x80]));
    await c.send({text: 'turn three'});
    await finish(c);
    assert.equal(opened[2].requests[0].method, 'session/resume');
    assert.equal(opened[2].requests[0].params.sessionId, resumed.sessionId);
    const unreadable = opened[2].requests[3].params.prompt;
    assert.match(unreadable[0].text, /K 跨模型全域工作規則目前無法讀取[\s\S]*先前附上的全域工作規則目前無法確認/);
    assert.deepEqual(unreadable.slice(1), [{type: 'text', text: 'turn three'}]);
  } finally {
    await c.close();
  }
});

test('steer() persists before RPC, survives early P1 end_turn, keeps lease/stdin/workers held until P2 finishes, and rejects closing turns with notSent', async () => {
  const root = await createTempRoot();
  const events = [];
  const released = [];
  let promptCalls = 0;
  let resolveP1, resolveP2;
  let notifyFn;
  let closeCalls = 0;
  let bridgeEmit;
  const sessionId = randomUUID();

  const accounts = {
    inspect: fn => fn(),
    acquire: async () => ({
      accountId: 'a'.repeat(32),
      release: async info => released.push(info)
    })
  };

  const bridgeFactory = async params => {
    const records = new Map();
    bridgeEmit = record => {
      records.set(record.requestId, record);
      params.onChange(structuredClone(record));
    };
    return {
      async start(args) {
        const rec = {
          requestId: args.requestId,
          parentId: params.parentId,
          provider: 'codex',
          model: args.model,
          status: 'running',
          settled: false,
          output: '',
          workspace: params.workspace
        };
        bridgeEmit(rec);
        return rec;
      },
      async list() {
        return [...records.values()];
      },
      async inspect({requestId}) {
        return records.get(requestId);
      },
      async wait({requestId}) {
        return records.get(requestId);
      },
      async cancel({requestId}) {
        bridgeEmit({...records.get(requestId), status: 'cancelled', settled: true});
        return records.get(requestId);
      },
      async reconcile() {},
      async accounts() {
        return {};
      },
      async close() {}
    };
  };

  let gatewayRef;
  const gatewayFactory = async ({bridge}) => {
    gatewayRef = bridge;
    return {
      mcpConfig: {mcpServers: {k_luna: {url: 'http://127.0.0.1:49999/mcp', headers: {Authorization: 'Bearer x'}}}},
      async close() {}
    };
  };

  const workerCatalog = async () => ({
    models: [{model: 'gpt-6.1-sol', supportedReasoningEfforts: [{reasoningEffort: 'high'}]}]
  });

  const c = createGeminiController({
    root,
    loginFactory,
    accounts,
    bridgeFactory,
    gatewayFactory,
    workerCatalog,
    stopGraceMs: 25,
    openAgent: async opts => {
      notifyFn = opts.onNotification;
      const runIdx = events.length;
      events.push({turn: runIdx, prompts: []});
      return {
        pid: 8080 + runIdx,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method, params) {
          if (method === 'session/new') return {sessionId};
          if (method === 'session/resume') return {};
          if (method === 'session/prompt') {
            promptCalls++;
            events[runIdx].prompts.push(params.prompt.map(b => b.text).join(''));
            if (runIdx === 0 && promptCalls === 1) {
              notifyFn({
                method: 'session/update',
                params: {
                  sessionId,
                  update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'before tool'}}
                }
              });
              // Confirm tool starts running during P1.
              notifyFn({
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: 'tool_call',
                    toolCallId: 'slow-1',
                    name: 'run_command',
                    kind: 'execute',
                    status: 'in_progress'
                  }
                }
              });
              return new Promise(resolve => (resolveP1 = resolve));
            }
            if (runIdx === 0 && promptCalls === 2) {
              // Assert the steered user message is already saved on disk before P2 RPC runs.
              const persisted = JSON.parse(
                await readFile(path.join(root, '.runtime/gemini-sessions', `${c.state.threadId}.json`), 'utf8')
              );
              assert.ok(persisted.messages.some(m => m.role === 'user' && m.text === 'mid-turn steer'));
              return new Promise(resolve => (resolveP2 = resolve));
            }
            notifyFn({
              method: 'session/update',
              params: {
                sessionId,
                update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'worker noticed'}}
              }
            });
            return {stopReason: 'end_turn'};
          }
          return {};
        },
        notify() {},
        async close() {
          if (runIdx === 0) closeCalls++;
          this.exited = true;
        }
      };
    }
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await gatewayRef.start({requestId: 'w-early', model: 'gpt-6.1-sol', effort: 'high', task: 'background'});
    await c.send({text: 'first prompt'});
    await until(() => typeof resolveP1 === 'function', 'P1 started');

    // Finish the K worker while P1 is running, then steer P2 and finish P1 early.
    bridgeEmit({requestId: 'w-early', parentId: c.state.threadId, status: 'completed', settled: true, output: 'done'});
    await assert.rejects(c.steer({text: 'stopped before ACP', automatic: true, canDeliver: () => false}), {
      notSent: true
    });
    assert.equal(resolveP2, undefined);
    assert.equal(c.state.messages.some(message => message.text === 'stopped before ACP'), false);
    const steerRes = await c.steer({text: 'mid-turn steer'});
    assert.deepEqual(steerRes, {steered: true});
    await until(() => typeof resolveP2 === 'function', 'P2 sent to ACP');

    // P1 resolves early (mirroring agy acp returning end_turn for P1 while P2 + slow tool run).
    resolveP1({stopReason: 'end_turn'});
    await new Promise(r => setTimeout(r, 30));

    assert.equal(c.state.busy, true, 'early P1 end_turn must keep room busy while P2 is in flight');
    assert.equal(closeCalls, 0, 'early P1 end_turn must NOT close stdin');
    assert.equal(released.length, 0, 'early P1 end_turn must NOT release account lease');
    assert.equal(events.length, 1, 'K worker notice must wait until entire steered turn completes');
    assert.equal(c.state.tools[0].status, 'running', 'running tool remains running across early P1 resolve');
    const firstReply = c.state.messages.find(m => m.text === 'before tool');
    assert.ok(firstReply.completedAt && !firstReply.partial && !firstReply.streaming);

    // Now finish tool and emit P2 assistant response.
    notifyFn({
      method: 'session/update',
      params: {sessionId, update: {sessionUpdate: 'tool_call_update', toolCallId: 'slow-1', status: 'completed'}}
    });
    notifyFn({
      method: 'session/update',
      params: {sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'both done'}}}
    });
    resolveP2({stopReason: 'end_turn'});

    await until(() => events.length === 2 && !c.state.busy, 'worker completion notice turn also finished');
    assert.equal(closeCalls, 1);
    assert.equal(released[0].settled, true);
    const secondReply = c.state.messages.find(m => m.text === 'both done');
    assert.ok(secondReply.completedAt && !secondReply.partial && !secondReply.streaming);
    assert.notEqual(firstReply.groupId, secondReply.groupId);
    assert.equal(c.state.tools[0].status, 'completed');

    // Verify steering once closing/idle fails cleanly with notSent = true.
    await assert.rejects(
      c.steer({text: 'too late'}),
      err => err.notSent === true && /執行中/.test(err.message)
    );
  } finally {
    resolveP1?.({stopReason: 'cancelled'});
    resolveP2?.({stopReason: 'cancelled'});
    await c.close();
  }
});

test('Gemini steer refreshes active-process rules, preserving the exact user text and deduping notices', async () => {
  const root = await createTempRoot();
  const memory = commonMemoryPath(root);
  const rules = globalRulesPath(root);
  const sessionId = randomUUID();
  const started = Promise.withResolvers();
  const first = Promise.withResolvers();
  const prompts = [];
  const homes = [];
  let rejectNext = false;
  const c = createGeminiController({
    root,
    executable: 'fixture',
    loginFactory,
    openAgent: async ({env}) => {
      homes.push(env.USERPROFILE);
      return {
        pid: 7120,
        exited: false,
        closed: Promise.resolve(),
        async request(method, params) {
          if (method === 'session/new') return {sessionId};
          if (method !== 'session/prompt') return {};
          if (rejectNext) {
            rejectNext = false;
            throw Object.assign(Error('fixture not sent'), {notSent: true});
          }
          prompts.push(params);
          if (prompts.length === 1) {
            started.resolve();
            return first.promise;
          }
          return {stopReason: 'end_turn'};
        },
        notify() {},
        async close() {
          this.exited = true;
        }
      };
    }
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: '第一輪'});
    await started.promise;
    assert.deepEqual(prompts[0].prompt, [{type: 'text', text: '第一輪'}]);
    const rulesDir = path.join(homes[0], '.gemini/config/rules');
    const globalRef = path.join(rulesDir, 'k-global-rules.md');
    await assert.rejects(readFile(globalRef), {code: 'ENOENT'});
    await mkdir(path.dirname(rules), {recursive: true});
    await writeFile(rules, '- 主房合成新規則');
    await writeFile(memory, '- 主房合成新偏好');

    rejectNext = true;
    await assert.rejects(c.steer({text: '未送達'}), {notSent: true});
    assert.equal(c.state.messages.some(item => item.text === '未送達'), false);

    const changed = '  原始插話\n保留換行😀  ';
    const unchanged = '  未變更時原樣送出\n';
    const outcomes = await Promise.all([c.steer({text: changed}), c.steer({text: unchanged})]);
    assert.deepEqual(outcomes, [{steered: true}, {steered: true}]);
    assert.deepEqual(prompts[1].prompt.slice(1), [{type: 'text', text: changed}]);
    const notice = prompts[1].prompt[0].text;
    assert.ok(notice.includes(`K 共同記憶已更新至版本 ${readCommonMemory(root).version}`));
    assert.ok(notice.includes(`K 跨模型全域工作規則已更新至版本 ${readGlobalRules(root).version}`));
    assert.ok(notice.includes(memory) && notice.includes(rules));
    assert.doesNotMatch(notice, /主房合成新規則|主房合成新偏好/);
    assert.deepEqual(prompts[2].prompt, [{type: 'text', text: unchanged}]);
    assert.ok((await readFile(path.join(rulesDir, 'k-common-memory.md'), 'utf8')).includes(`@[K 共同記憶](${memory})`));
    assert.ok((await readFile(globalRef, 'utf8')).includes(`@[K 跨模型全域工作規則](${rules})`));
    assert.deepEqual(c.state.messages.filter(item => item.source === 'steer').map(item => item.text), [changed, unchanged]);

    await rm(rules);
    const learn = '/learn 請記住測試句';
    await c.steer({text: learn});
    await assert.rejects(readFile(globalRef), {code: 'ENOENT'});
    assert.equal(prompts[3].prompt.length, 1);
    assert.match(prompts[3].prompt[0].text, /^\/learn .*\n[\s\S]*目前未啟用（檔案不存在[\s\S]*均已失效/);
    assert.ok(prompts[3].prompt[0].text.endsWith(' 請記住測試句'));
    assert.equal(c.state.messages.findLast(item => item.source === 'steer').text, learn);
    assert.equal(homes.length, 1);
    assert.ok(prompts.every(prompt => prompt.sessionId === sessionId));
  } finally {
    first.resolve({stopReason: 'end_turn'});
    await finish(c);
    await c.close();
  }
});

test('a queued Gemini steer delivers the rule update after an immediate pre-write rejection', {timeout: 10000}, async t => {
  const root = await createTempRoot(), rules = globalRulesPath(root);
  const first = Promise.withResolvers(), pausedRefresh = Promise.withResolvers(), releaseRefresh = Promise.withResolvers();
  const secondSave = Promise.withResolvers();
  const {c, requests} = ruleAcpFixture(root, ({prompt}) => {
    const text = prompt.at(-1).text;
    if (text === 'first turn') return first.promise;
    if (text === 'unsent steer') throw Object.assign(Error('stdin closed pre-write'), {notSent: true});
    return {stopReason: 'end_turn'};
  });
  const rename = fs.rename;
  let pause = false, secondStarted = false;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (pause && path.basename(to) === 'k-global-rules.md') {
      pause = false;
      pausedRefresh.resolve();
      await releaseRefresh.promise;
    }
    await rename(from, to);
    if (secondStarted && path.basename(to) === `${c.state.threadId}-current.json`) secondSave.resolve();
  });
  syncBuiltinESMExports();

  let rejected, delivered;
  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: 'first turn'});
    await until(() => requests.some(item => item.method === 'session/prompt'), 'first prompt reached ACP');
    await mkdir(path.dirname(rules), {recursive: true});
    await writeFile(rules, '- 合成新規則');

    pause = true;
    rejected = assert.rejects(c.steer({text: 'unsent steer'}), {notSent: true});
    await pausedRefresh.promise;
    secondStarted = true;
    delivered = c.steer({text: 'next steer'});
    // Let the second steer finish any save that occurs before joining the rule queue.
    await Promise.race([secondSave.promise, new Promise(resolve => setTimeout(resolve, 250))]);
    await new Promise(resolve => setImmediate(resolve));
    releaseRefresh.resolve();
    assert.deepEqual(await delivered, {steered: true});
    await rejected;

    const prompts = requests.filter(item => item.method === 'session/prompt').map(item => item.params.prompt);
    assert.equal(prompts.length, 3);
    assert.ok(prompts[2][0].text.includes(`K 跨模型全域工作規則已更新至版本 ${readGlobalRules(root).version}`));
    assert.deepEqual(prompts[2].slice(1), [{type: 'text', text: 'next steer'}]);
    assert.deepEqual(c.state.messages.filter(item => item.source === 'steer').map(item => item.text), ['next steer']);
  } finally {
    releaseRefresh.resolve();
    first.resolve({stopReason: 'end_turn'});
    await Promise.allSettled([rejected, delivered]);
    mocked.mock.restore();
    syncBuiltinESMExports();
    await c.close();
  }
});

test('Gemini ordinary turns in a held process send both changes once and retry context after a pre-write rejection', async () => {
  const root = await createTempRoot();
  const memory = commonMemoryPath(root), rules = globalRulesPath(root);
  let first = true, rejectNext = false;
  const {c, requests, sessionId} = ruleAcpFixture(root, (params, update) => {
    if (rejectNext) {
      rejectNext = false;
      throw Object.assign(Error('fixture not sent'), {notSent: true});
    }
    update({sessionUpdate: 'user_message_chunk', content: {type: 'text', text: params.prompt.at(-1).text}});
    update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'native reply'}});
    if (first) {
      first = false;
      update({sessionUpdate: 'tool_call', toolCallId: 'background', name: 'run_command', kind: 'execute', status: 'in_progress'});
    }
    return {stopReason: 'end_turn'};
  });
  const prompts = () => requests.filter(item => item.method === 'session/prompt').map(item => item.params.prompt);
  const send = async text => {
    await c.send({text});
    await finish(c);
  };

  try {
    await mkdir(path.dirname(rules), {recursive: true});
    await writeFile(memory, '- 合成共同記憶初版');
    await writeFile(rules, '- 合成全域規則初版');
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await send('留背景程序');
    assert.equal(c.state.workers.find(w => w.kind === 'command')?.status, 'running');

    await writeFile(memory, '- 合成共同記憶第二版');
    await rm(rules);
    const learn = '/learn 保留使用者原文';
    await send(learn);
    assert.equal(prompts()[1].length, 1);
    const notice = prompts()[1][0].text;
    assert.match(notice, /^\/learn /u);
    assert.ok(notice.includes(`K 共同記憶已更新至版本 ${readCommonMemory(root).version}`));
    assert.match(notice, /全域工作規則目前未啟用（檔案不存在[\s\S]*均已失效/u);
    assert.ok(notice.endsWith(learn.slice('/learn'.length)));
    assert.equal(c.state.messages.findLast(m => m.role === 'user').text, learn);
    await send('兩份正本皆未變');
    assert.deepEqual(prompts()[2], [{type: 'text', text: '兩份正本皆未變'}]);

    await writeFile(memory, '- 合成共同記憶第三版');
    rejectNext = true;
    await send('這輪在寫入前遭拒');
    assert.equal(c.state.status, 'failed');
    await send('下一筆新訊息');
    assert.ok(prompts()[4][0].text.includes(`K 共同記憶已更新至版本 ${readCommonMemory(root).version}`));
    assert.deepEqual(prompts()[4].slice(1), [{type: 'text', text: '下一筆新訊息'}]);
    assert.equal(requests.filter(item => item.method === 'session/new').length, 1);
    assert.equal(requests.some(item => item.method === 'session/resume'), false);
    assert.ok(requests.filter(item => item.method === 'session/prompt').every(item => item.params.sessionId === sessionId));
  } finally {
    await c.close();
  }
});

async function checkExpiredSteerRule(t, reopen, {rollbackFailures = 0, metadataOutcome, closedAction} = {}) {
  const root = await createTempRoot(), rules = globalRulesPath(root);
  const nextRoot = reopen && process.platform === 'win32' ? root.toUpperCase() : root;
  const first = Promise.withResolvers();
  const oldRefresh = Promise.withResolvers(), releaseOld = Promise.withResolvers();
  const newPreparation = Promise.withResolvers(), newReference = Promise.withResolvers();
  const historyLoaded = Promise.withResolvers(), finishOpening = Promise.withResolvers();
  let promptCount = 0, pauseOld = false, preparingNext = false;
  const {c, requests} = ruleAcpFixture(root, (_params, update) => {
    update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'native reply'}});
    return ++promptCount === 1 ? first.promise : {stopReason: 'end_turn'};
  });
  const nextController = reopen ? ruleAcpFixture(nextRoot, () => assert.fail('open only prepares rules')).c : c;
  const hasExpiredSteer = messages => messages.some(item => item.text === 'expired steer');
  const rollbackError = {code: 'EIO', message: 'fixture Gemini history rename failed'};
  let staleRemovals = 0, rollbackFailuresRemaining = rollbackFailures;
  const remove = fs.rm;
  const mockedRemove = t.mock.method(fs, 'rm', async (file, options) => {
    if (preparingNext && path.basename(file) === 'k-global-rules.md') staleRemovals++;
    return remove(file, options);
  });
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    const name = path.basename(to);
    if (pauseOld && name === 'k-common-memory.md') {
      pauseOld = false;
      oldRefresh.resolve();
      await releaseOld.promise;
    }
    if (
      preparingNext &&
      rollbackFailuresRemaining &&
      path.basename(path.dirname(to)) === 'gemini-sessions' &&
      JSON.parse(await readFile(from, 'utf8')).title === 'first turn'
    ) {
      rollbackFailuresRemaining--;
      throw Object.assign(Error(rollbackError.message), {code: rollbackError.code});
    }
    await rename(from, to);
    if (preparingNext && name === 'k-learned-rules.md') newPreparation.resolve();
    if (preparingNext && name === 'k-global-rules.md') newReference.resolve();
  });
  syncBuiltinESMExports();

  let rejectedSteer, next, closedUpdate, historyAfterMetadata, historyReads = 0;
  try {
    await mkdir(path.dirname(rules), {recursive: true});
    await writeFile(rules, '- 合成原規則');
    const {threadId} = await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    const ref = path.join(root, 'agent-home/gemini/main', threadId, '.gemini/config/rules/k-global-rules.md');
    const historyFile = path.join(root, '.runtime/gemini-sessions', `${threadId}.json`);
    await c.send({text: 'first turn'});
    await until(() => promptCount === 1, 'first prompt reached ACP');

    await rm(rules);
    pauseOld = true;
    rejectedSteer = assert.rejects(c.steer({text: 'expired steer'}), {notSent: true});
    await oldRefresh.promise;
    first.resolve({stopReason: 'end_turn'});
    await finish(c);
    if (reopen) await c.close();

    await writeFile(rules, '- 合成新規則');
    preparingNext = true;
    const reopenRoom = {threadId, model: 'gemini-3.8-flash', effort: 'low'};
    const metadata = {threadId, title: 'later title', pinned: true};
    const previousHistory = rollbackFailures === 2 ? await readFile(historyFile, 'utf8') : null;
    if (closedAction === 'metadata') closedUpdate = c.metadata(metadata);
    next = reopen
      ? nextController.open(
          reopenRoom,
          {
            async onHistory() {
              historyReads++;
              historyLoaded.resolve();
              await finishOpening.promise;
            }
          }
        )
      : c.send({text: 'next turn'});
    if (!reopen) await newPreparation.promise;
    const advancedEarly = await Promise.race([
      (reopen ? historyLoaded : newReference).promise.then(() => true),
      ...(closedUpdate ? [closedUpdate.then(() => true)] : []),
      new Promise(resolve => setTimeout(resolve, 250, false))
    ]);
    releaseOld.resolve();
    await rejectedSteer;
    finishOpening.resolve();
    if (rollbackFailures === 2) {
      await assert.rejects(next, rollbackError);
      assert.equal(historyReads, 0);
      assert.equal(nextController.state.threadId, null);
      assert.equal(await readFile(historyFile, 'utf8'), previousHistory);
      assert.equal(rollbackFailuresRemaining, 0);
      if (metadataOutcome) {
        assert.equal(hasExpiredSteer(JSON.parse(previousHistory).messages), true);
        if (metadataOutcome === 'rejected') {
          rollbackFailuresRemaining = 1;
          await assert.rejects(nextController.metadata(metadata), rollbackError);
          assert.equal(rollbackFailuresRemaining, 0);
          assert.equal(await readFile(historyFile, 'utf8'), previousHistory);
        } else {
          const updated = await nextController.metadata(metadata);
          assert.deepEqual([updated.title, updated.pinned], ['later title', true]);
          historyAfterMetadata = JSON.parse(await readFile(historyFile, 'utf8'));
        }
      }
      await nextController.open(reopenRoom);
    } else await next;
    await finish(nextController);

    if (closedUpdate) {
      const updated = await closedUpdate;
      assert.deepEqual([updated.title, updated.pinned], ['later title', true]);
      assert.equal(c.state.title, 'first turn');
    }
    assert.equal(rollbackFailuresRemaining, 0);
    assert.equal(staleRemovals, 0);
    const reference = await readFile(ref, 'utf8');
    assert.ok(reference.includes(`版本 ${readGlobalRules(nextRoot).version}`));
    assert.ok(reference.includes(`@[K 跨模型全域工作規則](${globalRulesPath(nextRoot)})`));
    assert.equal(requests.filter(item => item.method === 'session/prompt').length, reopen ? 1 : 2);
    assert.equal(hasExpiredSteer(c.state.messages), false);
    if (reopen) {
      if (closedAction === 'close') {
        const updated = await nextController.metadata(metadata);
        assert.deepEqual([updated.title, updated.pinned], ['later title', true]);
        const beforeClose = await readFile(historyFile, 'utf8');
        await c.close();
        assert.equal(await readFile(historyFile, 'utf8'), beforeClose);
      }
      const saved = JSON.parse(await readFile(historyFile, 'utf8'));
      assert.deepEqual([hasExpiredSteer(nextController.state.messages), hasExpiredSteer(saved.messages)], [false, false]);
      if (metadataOutcome || closedAction) {
        const expected = metadataOutcome === 'rejected' ? ['first turn', false] : ['later title', true];
        assert.equal(nextController.state.title, expected[0]);
        assert.deepEqual([saved.title, saved.pinned], expected);
      }
      if (historyAfterMetadata) {
        assert.deepEqual([historyAfterMetadata.title, historyAfterMetadata.pinned], ['later title', true]);
        assert.equal(hasExpiredSteer(historyAfterMetadata.messages), false);
      }
    }
    assert.equal(advancedEarly, false);
  } finally {
    first.resolve({stopReason: 'end_turn'});
    releaseOld.resolve();
    finishOpening.resolve();
    await Promise.allSettled([rejectedSteer, next, closedUpdate]);
    mocked.mock.restore();
    mockedRemove.mock.restore();
    syncBuiltinESMExports();
    if (c.state.status !== 'offline') await c.close();
    if (reopen) await nextController.close();
  }
}

test('an expired Gemini steer cannot remove the next turn’s global rules reference', {timeout: 10000}, t =>
  checkExpiredSteerRule(t, false)
);

test('reopened Gemini waits for expired steer rollback before loading history and refreshing rules', {timeout: 10000}, t =>
  checkExpiredSteerRule(t, true)
);

test('reopened Gemini retries a failed expired steer rollback save before reading history', {timeout: 10000}, t =>
  checkExpiredSteerRule(t, true, {rollbackFailures: 1})
);

test('reopened Gemini rejects a failed expired steer rollback save retry and can reopen later', {timeout: 10000}, t =>
  checkExpiredSteerRule(t, true, {rollbackFailures: 2})
);

test('Gemini metadata on an unopened room survives a pending steer rollback and reopen', {timeout: 10000}, t =>
  checkExpiredSteerRule(t, true, {rollbackFailures: 2, metadataOutcome: 'saved'})
);

test('Gemini metadata on an unopened room rejects a failed rollback save and leaves it retryable', {timeout: 10000}, t =>
  checkExpiredSteerRule(t, true, {rollbackFailures: 2, metadataOutcome: 'rejected'})
);

test('closed Gemini metadata waits in the room queue and survives a pending steer rollback and reopen', {timeout: 10000}, t =>
  checkExpiredSteerRule(t, true, {rollbackFailures: 1, closedAction: 'metadata'})
);

test('closed Gemini metadata can retry after a failed rename and reopen the room', async t => {
  const root = await createTempRoot();
  const {c} = ruleAcpFixture(root, () => assert.fail('open only prepares rules'));
  const room = {model: 'gemini-3.8-flash', effort: 'low'};
  const {threadId} = await c.open(room);
  await c.close();
  const history = path.join(root, '.runtime/gemini-sessions', `${threadId}.json`);
  const previous = await readFile(history, 'utf8');
  const metadata = {threadId, title: 'later title', pinned: true};
  const failure = {code: 'EIO', message: 'fixture Gemini metadata rename failed'};
  const rename = fs.rename;
  let failNext = true;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === history && failNext) {
      failNext = false;
      throw Object.assign(Error(failure.message), {code: failure.code});
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(c.metadata(metadata), failure);
    assert.equal(failNext, false);
    assert.equal(await readFile(history, 'utf8'), previous);
    const updated = await c.metadata(metadata);
    assert.deepEqual([updated.title, updated.pinned], ['later title', true]);
    assert.equal(c.state.status, 'offline');
    assert.equal(c.state.title, JSON.parse(previous).title ?? '');
    await c.open({...room, threadId});
    const saved = JSON.parse(await readFile(history, 'utf8'));
    assert.equal(c.state.title, 'later title');
    assert.deepEqual([saved.title, saved.pinned], ['later title', true]);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    if (c.state.status !== 'offline') await c.close();
  }
});

test('repeated close of an old Gemini controller preserves metadata saved by the reopened room', {timeout: 10000}, t =>
  checkExpiredSteerRule(t, true, {rollbackFailures: 1, closedAction: 'close'})
);

test('Gemini does not append text to a steered prompt that settles before the original prompt', async () => {
  const root = await createTempRoot();
  const sessionId = randomUUID();
  const pending = [];
  let notify;
  const c = createGeminiController({
    root,
    loginFactory,
    openAgent: async ({onNotification}) => {
      notify = text =>
        onNotification({
          method: 'session/update',
          params: {sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text}}}
        });
      return {
        pid: 777,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === 'session/new') return {sessionId};
          if (method === 'session/prompt') return new Promise(resolve => pending.push(resolve));
          return {};
        },
        async close() {
          this.exited = true;
        }
      };
    }
  });
  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: 'first'});
    await until(() => pending.length === 1, 'first prompt');
    notify('Before tool. ');
    await c.steer({text: 'steer'});
    await until(() => pending.length === 2, 'steered prompt');
    await c.steer({text: 'another steer'});
    await until(() => pending.length === 3, 'second steered prompt');
    pending[1]({stopReason: 'end_turn'});
    await new Promise(resolve => setImmediate(resolve));
    notify('After tool.');
    pending[0]({stopReason: 'end_turn'});
    await new Promise(resolve => setImmediate(resolve));
    notify('Incomplete last reply.');
    pending[2]({});
    await finish(c);
    assert.equal(c.state.status, 'failed');
    const replies = c.state.messages.filter(m => m.role === 'assistant');
    assert.deepEqual(replies.map(m => m.text), ['Before tool. After tool.', 'Incomplete last reply.']);
    assert.ok(replies[0].completedAt && !replies[0].partial && !replies[0].streaming);
    assert.ok(replies[1].partial && !replies[1].completedAt && !replies[1].streaming);
    assert.equal(replies[0].groupId, c.state.messages[0].groupId);
  } finally {
    for (const resolve of pending) resolve({stopReason: 'cancelled'});
    await c.close();
  }
});

test('steer() marks room uncertain without notSent when connection drops after write, and marks notSent when rejected pre-write', async () => {
  const root = await createTempRoot();
  const sessionId = randomUUID();
  let resolveP1, rejectP2, notify;
  let promptCalls = 0;

  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 25,
    openAgent: async ({onNotification}) => ({
      pid: 777,
      exited: false,
      closed: Promise.resolve(),
      initialize: {protocolVersion: 1},
      async request(method) {
        if (method === 'session/new') {
          notify = text => onNotification({
            method: 'session/update',
            params: {sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text}}}
          });
          return {sessionId};
        }
        if (method === 'session/prompt') {
          promptCalls++;
          if (promptCalls === 1) return new Promise(resolve => (resolveP1 = resolve));
          // Second prompt simulates post-write disconnect (e.g., EPIPE/processEnded).
          return new Promise((_, reject) => (rejectP2 = reject));
        }
        return {};
      },
      notify() {},
      async close() {
        this.exited = true;
      }
    })
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: 'p1'});
    await until(() => typeof resolveP1 === 'function', 'P1 pending');
    notify('completed P1');

    const steered = await c.steer({text: 'p2 written then lost'});
    assert.deepEqual(steered, {steered: true});
    await until(() => typeof rejectP2 === 'function', 'P2 pending');

    resolveP1({stopReason: 'end_turn'});
    await until(() => c.state.messages.some(m => m.text === 'completed P1' && m.completedAt), 'P1 completed');
    notify('unconfirmed P2');
    const dropped = Object.assign(Error('Gemini 程序已結束（code=1）。'), {processEnded: true});
    rejectP2(dropped);
    await finish(c);

    assert.equal(c.state.status, 'uncertain');
    assert.match(c.state.error, /未重送/);
    assert.equal(promptCalls, 2, 'must never replay after disconnect');
    const replies = c.state.messages.filter(m => m.role === 'assistant');
    assert.deepEqual(replies.map(m => [m.text, !!m.partial, !!m.completedAt]), [
      ['completed P1', false, true],
      ['unconfirmed P2', true, false]
    ]);

    // Now test pre-write rejection where transport throws notSent: true immediately.
    let rejectHung;
    const c2 = createGeminiController({
      root: await createTempRoot(),
      loginFactory,
      stopGraceMs: 25,
      openAgent: async () => ({
        pid: 778,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === 'session/new') return {sessionId: randomUUID()};
          if (method === 'session/prompt') {
            if (this._count === 1) throw Object.assign(Error('stdin already closed'), {notSent: true});
            this._count = 1;
            return new Promise((_, reject) => (rejectHung = reject));
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
          rejectHung?.(Object.assign(Error('closed'), {processEnded: true}));
        }
      })
    });
    try {
      await c2.open({model: 'gemini-3.8-flash', effort: 'low'});
      await c2.send({text: 'run'});
      await until(() => c2.state.busy, 'busy');
      await assert.rejects(
        c2.steer({text: 'blocked pre-write'}),
        err => err.notSent === true
      );
      assert.equal(
        c2.state.messages.some(m => m.text === 'blocked pre-write'),
        false,
        'rolled back pre-write unsent user message'
      );
    } finally {
      await c2.close();
    }
  } finally {
    resolveP1?.({stopReason: 'end_turn'});
    await c.close();
  }
});

test('stop() sends session/cancel and escalates to killAcpTree after grace period; unconfirmed exit keeps settled: false', async () => {
  const root = await createTempRoot();
  const notifications = [];
  const released = [];
  const killedPids = [];
  let allowClose = false;
  let promptStarted;
  const started = new Promise(r => (promptStarted = r));

  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 30,
    accounts: {
      inspect: fn => fn(),
      acquire: async () => ({accountId: 'a'.repeat(32), release: async info => released.push(info)})
    },
    killTree: async pid => {
      killedPids.push(pid);
      if (!allowClose) throw Error('taskkill timeout');
    },
    openAgent: async () => ({
      pid: 9876,
      exited: false,
      closed: Promise.resolve(),
      initialize: {protocolVersion: 1},
      async request(method) {
        if (method === 'session/new') return {sessionId: randomUUID()};
        if (method === 'session/prompt') {
          promptStarted();
          return new Promise(() => {}); // Hung prompt ignores session/cancel
        }
        return {};
      },
      notify(method, params) {
        notifications.push({method, params});
      },
      async close({graceMs} = {}) {
        if (!allowClose) throw Error(`tree still alive after grace=${graceMs}`);
        this.exited = true;
      }
    })
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: 'hung turn'});
    await started;
    await c.stop();

    assert.ok(notifications.some(n => n.method === 'session/cancel'), 'session/cancel sent first');
    assert.equal(c.state.status, 'uncertain', 'unconfirmed stop leaves room uncertain');
    assert.equal(released[0].settled, false, 'account lease must NOT be marked settled when PID exit is unconfirmed');

    allowClose = true;
    await c.stop();
    assert.deepEqual(killedPids, [9876]);
    assert.equal(c.state.status, 'interrupted');
  } finally {
    allowClose = true;
    await c.close();
  }
});

test('read-only permission rejection records Chinese explanation and surfaces it when turn ends with empty text', async () => {
  const root = await createTempRoot();
  const responses = [];

  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 25,
    openAgent: async opts => ({
      pid: 6543,
      exited: false,
      closed: Promise.resolve(),
      initialize: {protocolVersion: 1},
      async request(method, params) {
        if (method === 'session/new') return {sessionId: randomUUID()};
        if (method === 'session/prompt') {
          const perm = await opts.onRequest({
            method: 'session/request_permission',
            params: {
              sessionId: params.sessionId,
              toolCall: {
                toolCallId: 'w-1',
                name: 'write_to_file',
                kind: 'edit',
                rawInput: {TargetFile: path.join(root, 'blocked.txt')}
              },
              options: [
                {optionId: 'allow_once', kind: 'allow_once', name: 'Allow'},
                {optionId: 'reject_once', kind: 'reject_once', name: 'Reject'}
              ]
            }
          });
          responses.push(perm);
          return {stopReason: 'end_turn'};
        }
        return {};
      },
      notify() {},
      async close() {
        this.exited = true;
      }
    })
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'read-only'});
    await c.send({text: 'write a file'});
    await finish(c);

    assert.deepEqual(responses, [{outcome: {outcome: 'selected', optionId: 'reject_once'}}]);
    assert.equal(c.state.status, 'failed');
    assert.match(c.state.error, /唯讀模式擋下了寫檔/);
  } finally {
    await c.close();
  }
});

test('goal mode disallows steer() while slash rules keep /learn unprefixed and non-learn slash commands guarded', async () => {
  const root = await createTempRoot();
  const prompts = [];
  let releaseGoal;

  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 25,
    openAgent: async opts => {
      const sid = randomUUID();
      return {
        pid: 5555,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method, params) {
          if (method === 'session/new' || method === 'session/resume') return {sessionId: sid};
          if (method === 'session/prompt') {
            prompts.push(structuredClone(params.prompt));
            const joined = params.prompt.map(b => b.text).join('');
            if (joined.startsWith('/goal ')) {
              return new Promise(resolve => {
                releaseGoal = () => {
                  opts.onNotification?.({
                    method: 'session/update',
                    params: {
                      sessionId: sid,
                      update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'done'}}
                    }
                  });
                  resolve({stopReason: 'end_turn'});
                };
              });
            }
            opts.onNotification?.({
              method: 'session/update',
              params: {
                sessionId: sid,
                update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'ok'}}
              }
            });
            return {stopReason: 'end_turn'};
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
        }
      };
    }
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.goal({objective: 'run loop'});
    await until(() => typeof releaseGoal === 'function', 'goal turn active');

    await assert.rejects(
      c.steer({text: 'try steer during goal'}),
      err => err.notSent === true && /目標模式回合不支援立即送入/.test(err.message)
    );
    assert.equal(prompts.length, 1);

    releaseGoal();
    await finish(c);

    await c.send({text: '/learn keep rules concise'});
    await finish(c);
    await c.send({text: '/compact'});
    await finish(c);

    assert.deepEqual(prompts[0], [{type: 'text', text: '/goal run loop'}]);
    assert.equal(prompts[1].length, 1);
    assert.match(prompts[1][0].text, /^\/learn .*\n[\s\S]*目前未啟用（檔案不存在/u);
    assert.ok(prompts[1][0].text.endsWith(' keep rules concise'));
    assert.match(prompts[2][0].text, /^K 跨模型全域工作規則目前未啟用/u);
    assert.deepEqual(prompts[2].slice(1), [{type: 'text', text: '/compact'}]);
  } finally {
    releaseGoal?.();
    await c.close();
  }
});

test('controller enforces exact project MCP rules without prefix widening', async () => {
  const root = await createTempRoot();
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(root, '.runtime'), {recursive: true});
  await mkdir(workspace, {recursive: true});
  await writeFile(
    path.join(root, '.runtime/gemini-mcp.json'),
    JSON.stringify([
      {
        workspace,
        mcpServers: {
          demo: {command: 'node', args: ['demo.mjs']},
          demo_admin: {command: 'node', args: ['admin.mjs']}
        },
        allowReadOnly: ['mcp(demo/get_record)'],
        allowWrite: []
      }
    ])
  );

  const decisions = [];
  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 25,
    openAgent: async opts => ({
      pid: 7101,
      exited: false,
      closed: Promise.resolve(),
      initialize: {protocolVersion: 1},
      async request(method, params) {
        if (method === 'session/new') return {sessionId: randomUUID()};
        if (method === 'session/prompt') {
          const ask = async toolCall =>
            opts.onRequest({
              method: 'session/request_permission',
              params: {
                sessionId: params.sessionId,
                toolCall,
                options: [
                  {optionId: 'allow_once', kind: 'allow_once'},
                  {optionId: 'reject_once', kind: 'reject_once'}
                ]
              }
            });
          decisions.push({
            getFlat: await ask({name: 'mcp_demo_get_record', kind: 'other'}),
            getCall: await ask({name: 'call_mcp_tool', kind: 'other', rawInput: {ServerName: 'demo', ToolName: 'get_record'}}),
            delFlat: await ask({name: 'mcp_demo_delete_record', kind: 'other'}),
            delCall: await ask({name: 'call_mcp_tool', kind: 'other', rawInput: {ServerName: 'demo', ToolName: 'delete_record'}}),
            adminFlat: await ask({name: 'mcp_demo_admin_wipe', kind: 'other'})
          });
          opts.onNotification?.({
            method: 'session/update',
            params: {sessionId: params.sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'done'}}}
          });
          return {stopReason: 'end_turn'};
        }
        return {};
      },
      notify() {},
      async close() {
        this.exited = true;
      }
    })
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'read-only'});
    await c.selectWorkspace({path: workspace});
    await c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'read-only'});
    await c.send({text: 'check mcp'});
    await finish(c);

    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0].getFlat, {outcome: {outcome: 'selected', optionId: 'allow_once'}});
    assert.deepEqual(decisions[0].getCall, {outcome: {outcome: 'selected', optionId: 'allow_once'}});
    assert.deepEqual(decisions[0].delFlat, {outcome: {outcome: 'selected', optionId: 'reject_once'}});
    assert.deepEqual(decisions[0].delCall, {outcome: {outcome: 'selected', optionId: 'reject_once'}});
    assert.deepEqual(decisions[0].adminFlat, {outcome: {outcome: 'selected', optionId: 'reject_once'}});
  } finally {
    await c.close();
  }
});

test('controller blocks google_ops_worker/.venv writes and workspace-escaping junctions in workspace-write', async () => {
  const root = await createTempRoot();
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await mkdir(path.join(root, '.runtime'), {recursive: true});
  await mkdir(path.join(workspace, 'google_ops_worker'), {recursive: true});
  await mkdir(path.join(workspace, '.venv', 'Scripts'), {recursive: true});
  await mkdir(outside, {recursive: true});
  await writeFile(path.join(workspace, 'google_ops_worker', 'google_ops_client.py'), '# client\n');
  await writeFile(path.join(workspace, '.venv', 'Scripts', 'python.exe'), '');
  await writeFile(path.join(root, '.runtime/google-ops.json'), JSON.stringify({directory: workspace}));
  await symlink(outside, path.join(workspace, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');

  const decisions = {};
  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 25,
    openAgent: async opts => ({
      pid: 7102,
      exited: false,
      closed: Promise.resolve(),
      initialize: {protocolVersion: 1},
      async request(method, params) {
        if (method === 'session/new') return {sessionId: randomUUID()};
        if (method === 'session/prompt') {
          const askEdit = async targetPath =>
            opts.onRequest({
              method: 'session/request_permission',
              params: {
                sessionId: params.sessionId,
                toolCall: {name: 'write_to_file', kind: 'edit', rawInput: {TargetFile: targetPath}},
                options: [
                  {optionId: 'allow_once', kind: 'allow_once'},
                  {optionId: 'reject_once', kind: 'reject_once'}
                ]
              }
            });
          decisions.opsWorker = await askEdit('google_ops_worker/server.py');
          decisions.venv = await askEdit(path.join(workspace, '.venv', 'lib', 'site.py'));
          decisions.junction = await askEdit('escape-link/nested/secret.txt');
          decisions.normal = await askEdit('notes.txt');
          opts.onNotification?.({
            method: 'session/update',
            params: {sessionId: params.sessionId, update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'checked'}}}
          });
          return {stopReason: 'end_turn'};
        }
        return {};
      },
      notify() {},
      async close() {
        this.exited = true;
      }
    })
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'workspace-write'});
    await c.selectWorkspace({path: workspace});
    await c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'workspace-write'});
    await c.send({text: 'test protected paths'});
    await finish(c);

    assert.deepEqual(decisions.opsWorker, {outcome: {outcome: 'selected', optionId: 'reject_once'}});
    assert.deepEqual(decisions.venv, {outcome: {outcome: 'selected', optionId: 'reject_once'}});
    assert.deepEqual(decisions.junction, {outcome: {outcome: 'selected', optionId: 'reject_once'}});
    assert.deepEqual(decisions.normal, {outcome: {outcome: 'selected', optionId: 'allow_once'}});
  } finally {
    await c.close();
  }
});

test('late permission requests after stop/session mismatch return cancelled, and only allow_once/reject_once options are accepted', async () => {
  const root = await createTempRoot();
  let capturedOnRequest;
  let capturedSessionId;
  let releasePrompt;
  const optionChecks = {};

  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 25,
    openAgent: async opts => {
      capturedOnRequest = opts.onRequest;
      return {
        pid: 7103,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method, params) {
          if (method === 'session/new') {
            capturedSessionId = randomUUID();
            return {sessionId: capturedSessionId};
          }
          if (method === 'session/prompt') {
            // Mismatched sessionId must be cancelled even while turn is active.
            optionChecks.mismatch = await opts.onRequest({
              method: 'session/request_permission',
              params: {
                sessionId: randomUUID(),
                toolCall: {name: 'read_file', kind: 'read', locations: [{path: path.join(root, 'a.txt')}]},
                options: [{optionId: 'allow_once', kind: 'allow_once'}]
              }
            });
            // allow_always alone must not be accepted when allow_once is absent.
            optionChecks.allowAlwaysOnly = await opts.onRequest({
              method: 'session/request_permission',
              params: {
                sessionId: params.sessionId,
                toolCall: {name: 'read_file', kind: 'read', locations: [{path: path.join(root, 'a.txt')}]},
                options: [{optionId: 'allow_always', kind: 'allow_always'}]
              }
            });
            // reject_always alone must fall back to cancelled when reject_once is absent.
            optionChecks.rejectAlwaysOnly = await opts.onRequest({
              method: 'session/request_permission',
              params: {
                sessionId: params.sessionId,
                toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: path.join(root, 'a.txt')}},
                options: [{optionId: 'reject_always', kind: 'reject_always'}]
              }
            });
            return new Promise(resolve => (releasePrompt = resolve));
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
          releasePrompt?.({stopReason: 'cancelled'});
        }
      };
    }
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'read-only'});
    await c.send({text: 'wait for late permission'});
    await until(() => typeof releasePrompt === 'function', 'prompt running');

    await c.stop();
    const lateAfterStop = await capturedOnRequest({
      method: 'session/request_permission',
      params: {
        sessionId: capturedSessionId,
        toolCall: {name: 'read_file', kind: 'read', locations: [{path: path.join(root, 'a.txt')}]},
        options: [{optionId: 'allow_once', kind: 'allow_once'}]
      }
    });

    assert.deepEqual(optionChecks.mismatch, {outcome: {outcome: 'cancelled'}});
    assert.deepEqual(optionChecks.allowAlwaysOnly, {outcome: {outcome: 'cancelled'}});
    assert.deepEqual(optionChecks.rejectAlwaysOnly, {outcome: {outcome: 'cancelled'}});
    assert.deepEqual(lateAfterStop, {outcome: {outcome: 'cancelled'}});
  } finally {
    releasePrompt?.({stopReason: 'cancelled'});
    await c.close();
  }
});

test('stop() unblocks hung pre-prompt init RPCs (session/new, session/set_model) when close() fails, preserving unresolvedPid and settled: false', async () => {
  for (const hangOn of ['session/new', 'session/set_model']) {
    const root = await createTempRoot();
    const released = [];
    const killed = [];
    let allowClose = false;
    let initRpcReached;
    const reached = new Promise(resolve => (initRpcReached = resolve));

    const c = createGeminiController({
      root,
      loginFactory,
      stopGraceMs: 25,
      accounts: {
        inspect: fn => fn(),
        acquire: async () => ({accountId: 'b'.repeat(32), release: async info => released.push(info)})
      },
      killTree: async pid => {
        killed.push(pid);
        if (!allowClose) throw Error('kill timeout');
      },
      openAgent: async () => ({
        pid: 8421,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === hangOn) {
            initRpcReached();
            return new Promise(() => {});
          }
          if (method === 'session/new') return {sessionId: randomUUID()};
          return {};
        },
        notify() {},
        async close() {
          if (!allowClose) throw Error('close failed');
          this.exited = true;
        }
      })
    });

    try {
      await c.open({model: 'gemini-3.8-flash', effort: 'low'});
      await c.send({text: `hang at ${hangOn}`});
      await reached;

      const stopResult = await Promise.race([
        c.stop(),
        new Promise((_, reject) => setTimeout(() => reject(Error(`stop() hung at ${hangOn}`)), 2000))
      ]);
      assert.deepEqual(stopResult, {stopped: false});
      assert.equal(c.backgroundWork, 'Gemini 程序停止待確認');
      assert.equal(c.state.busy, false);
      assert.equal(c.state.status, 'uncertain');
      assert.equal(released.length, 1);
      assert.equal(released[0].settled, false);

      allowClose = true;
      await c.stop();
      assert.deepEqual(killed, [8421]);
      assert.equal(c.state.status, 'interrupted');
    } finally {
      allowClose = true;
      await c.close();
    }
  }
});

test('pre-write notSent steer error rejects only steer() without failing P1 or blocking worker completion delivery', async () => {
  const root = await createTempRoot();
  let resolveP1;
  let promptCalls = 0;
  let bridgeEmit;
  const sessionId = randomUUID();
  const turns = [];

  const bridgeFactory = async params => {
    const records = new Map();
    bridgeEmit = record => {
      records.set(record.requestId, record);
      params.onChange(structuredClone(record));
    };
    return {
      async start(args) {
        const rec = {
          requestId: args.requestId,
          parentId: params.parentId,
          provider: 'codex',
          model: args.model,
          status: 'running',
          settled: false,
          output: '',
          workspace: params.workspace
        };
        bridgeEmit(rec);
        return rec;
      },
      async list() {
        return [...records.values()];
      },
      async inspect({requestId}) {
        return records.get(requestId);
      },
      async wait({requestId}) {
        return records.get(requestId);
      },
      async cancel({requestId}) {
        bridgeEmit({...records.get(requestId), status: 'cancelled', settled: true});
        return records.get(requestId);
      },
      async reconcile() {},
      async accounts() {
        return {};
      },
      async close() {}
    };
  };

  let gatewayRef;
  const gatewayFactory = async ({bridge}) => {
    gatewayRef = bridge;
    return {
      mcpConfig: {mcpServers: {k_luna: {url: 'http://127.0.0.1:49998/mcp', headers: {Authorization: 'Bearer y'}}}},
      async close() {}
    };
  };

  const c = createGeminiController({
    root,
    loginFactory,
    bridgeFactory,
    gatewayFactory,
    workerCatalog: async () => ({
      models: [{model: 'gpt-6.1-sol', supportedReasoningEfforts: [{reasoningEffort: 'high'}]}]
    }),
    stopGraceMs: 25,
    openAgent: async opts => {
      const turnIndex = turns.length;
      turns.push(turnIndex);
      return {
        pid: 7500 + turnIndex,
        exited: false,
        closed: Promise.resolve(),
        initialize: {protocolVersion: 1},
        async request(method) {
          if (method === 'session/new') return {sessionId};
          if (method === 'session/resume') return {};
          if (method === 'session/prompt') {
            promptCalls++;
            if (turnIndex === 0 && promptCalls === 1) {
              return new Promise(resolve => {
                resolveP1 = () => {
                  opts.onNotification?.({
                    method: 'session/update',
                    params: {
                      sessionId,
                      update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'p1 ok'}}
                    }
                  });
                  resolve({stopReason: 'end_turn'});
                };
              });
            }
            if (turnIndex === 0 && promptCalls === 2) {
              throw Object.assign(Error('stdin closed pre-write'), {notSent: true});
            }
            opts.onNotification?.({
              method: 'session/update',
              params: {
                sessionId,
                update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'worker noticed'}}
              }
            });
            return {stopReason: 'end_turn'};
          }
          return {};
        },
        notify() {},
        async close() {
          this.exited = true;
        }
      };
    }
  });

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await gatewayRef.start({requestId: 'w-notsent', model: 'gpt-6.1-sol', effort: 'high', task: 'bg'});
    await c.send({text: 'run p1'});
    await until(() => typeof resolveP1 === 'function', 'P1 started');

    bridgeEmit({requestId: 'w-notsent', parentId: c.state.threadId, status: 'completed', settled: true, output: 'done'});
    await assert.rejects(
      c.steer({text: 'p2 unsent'}),
      err => err.notSent === true
    );

    resolveP1();
    await finish(c);
    await until(() => turns.length === 2 && !c.state.busy, 'worker completion notice turn finished');

    assert.equal(c.state.status, 'completed');
    assert.equal(c.state.error, null);
    assert.ok(c.state.messages.some(m => m.role === 'assistant' && m.text === 'p1 ok'));
    assert.ok(c.state.messages.some(m => m.role === 'assistant' && m.text === 'worker noticed'));
    assert.equal(c.state.messages.some(m => m.text === 'p2 unsent'), false);
  } finally {
    resolveP1?.();
    await c.close();
  }
});

test('controller blocks writes through google_ops_worker junction pointing to workspace root', async () => {
  const root = await createTempRoot();
  const workspace = path.join(root, 'workspace');
  const junctionPath = path.join(workspace, 'google_ops_worker');
  await mkdir(path.join(root, '.runtime'), {recursive: true});
  await mkdir(path.join(workspace, '.venv', 'Scripts'), {recursive: true});
  await writeFile(path.join(workspace, '.venv', 'Scripts', 'python.exe'), '');
  await symlink(workspace, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(workspace, 'google_ops_client.py'), '# client\n');
  await writeFile(path.join(root, '.runtime/google-ops.json'), JSON.stringify({directory: workspace}));

  let decision = null;
  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 25,
    openAgent: async opts => ({
      pid: 7103,
      exited: false,
      closed: Promise.resolve(),
      initialize: {protocolVersion: 1},
      async request(method, params) {
        if (method === 'session/new') return {sessionId: randomUUID()};
        if (method === 'session/prompt') {
          decision = await opts.onRequest({
            method: 'session/request_permission',
            params: {
              sessionId: params.sessionId,
              toolCall: {
                name: 'write_to_file',
                kind: 'edit',
                rawInput: {TargetFile: 'google_ops_worker/google_ops_client.py'}
              },
              options: [
                {optionId: 'allow_once', kind: 'allow_once'},
                {optionId: 'reject_once', kind: 'reject_once'}
              ]
            }
          });
          opts.onNotification?.({
            method: 'session/update',
            params: {
              sessionId: params.sessionId,
              update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'checked'}}
            }
          });
          return {stopReason: 'end_turn'};
        }
        return {};
      },
      notify() {},
      async close() {
        this.exited = true;
      }
    })
  });

  try {
    await c.selectWorkspace({path: workspace});
    await c.open({model: 'gemini-3.8-flash', effort: 'low', accessMode: 'workspace-write'});
    await c.send({text: 'test junction equal workspace'});
    await finish(c);

    assert.deepEqual(decision, {outcome: {outcome: 'selected', optionId: 'reject_once'}});
  } finally {
    await c.close();
    await rmdir(junctionPath).catch(() => {});
  }
});

test('steer() rolls back user message and title on initial save failure without affecting P1', async t => {
  const root = await createTempRoot();
  let resolveP1;
  let promptCalls = 0;
  const sessionId = randomUUID();

  const c = createGeminiController({
    root,
    loginFactory,
    stopGraceMs: 25,
    openAgent: async opts => ({
      pid: 7600,
      exited: false,
      closed: Promise.resolve(),
      initialize: {protocolVersion: 1},
      async request(method) {
        if (method === 'session/new') return {sessionId};
        if (method === 'session/prompt') {
          promptCalls++;
          if (promptCalls === 1) {
            return new Promise(resolve => {
              resolveP1 = () => {
                opts.onNotification?.({
                  method: 'session/update',
                  params: {
                    sessionId,
                    update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'p1 ok'}}
                  }
                });
                resolve({stopReason: 'end_turn'});
              };
            });
          }
          return {stopReason: 'end_turn'};
        }
        return {};
      },
      notify() {},
      async close() {
        this.exited = true;
      }
    })
  });

  const originalRename = fs.rename;
  let armed = false;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (armed && String(to).endsWith(`${c.state.threadId}.json`)) {
      armed = false;
      throw Object.assign(Error('disk full on steer save'), {code: 'EIO'});
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();

  try {
    await c.open({model: 'gemini-3.8-flash', effort: 'low'});
    await c.send({text: 'run p1'});
    await until(() => typeof resolveP1 === 'function', 'P1 started');

    armed = true;
    await assert.rejects(
      c.steer({text: 'p2 save fail'}),
      err => err.notSent === true && /disk full on steer save/.test(err.message)
    );
    assert.equal(c.state.messages.some(m => m.text === 'p2 save fail'), false);
    assert.equal(c.state.title, 'run p1');
    assert.equal(promptCalls, 1);

    resolveP1();
    await finish(c);

    assert.equal(c.state.status, 'completed');
    assert.equal(c.state.error, null);
    assert.ok(c.state.messages.some(m => m.role === 'assistant' && m.text === 'p1 ok'));
    assert.equal(c.state.messages.some(m => m.text === 'p2 save fail'), false);
    const saved = JSON.parse(await readFile(path.join(root, '.runtime/gemini-sessions', `${c.state.threadId}.json`), 'utf8'));
    assert.equal(saved.messages.some(m => m.text === 'p2 save fail'), false);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    resolveP1?.();
    await c.close();
  }
});
