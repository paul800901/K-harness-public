import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, lstat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createDesktopController} from '../src/desktop-controller.mjs';
import {createClaudeController} from '../src/claude-controller.mjs';
import {globalRulesPath} from '../src/common-memory.mjs';
import {scratchBase} from './scratch.mjs';

const catalog = [
  {
    model: 'gpt-6-luna',
    displayName: 'GPT-6 Luna',
    hidden: false,
    supportedReasoningEfforts: [{reasoningEffort: 'high'}],
    defaultReasoningEffort: 'high',
    inputModalities: ['text']
  }
];

for (const [provider, useRules] of [
  ['codex', false],
  ['codex', true],
  ['claude', false],
  ['claude', true]
])
  test(`${provider} without experimental knowledge capture (${useRules ? 'with' : 'without'} private global rules)`, async () => {
    const base = scratchBase;
    await mkdir(base, {recursive: true});
    const root = await mkdtemp(path.join(base, 'no-shared-knowledge-'));
    if (useRules) {
      const file = globalRulesPath(root);
      await mkdir(path.dirname(file), {recursive: true});
      await writeFile(file, '- 合成全域工作規則內容');
    }
    let hooks, started;
    const calls = [];
    const hostFactory = options => {
      if (options.onEvent || options.onMessage) hooks = options;
      let close;
      return {
        closed: new Promise(resolve => {
          close = resolve;
        }),
        notify() {},
        waitForMcp: async () => {},
        interrupt: async () => {},
        close: async () => close(),
        start: async content => {
          started = content;
        },
        request: async (method, params) => {
          calls.push({method, params});
          if (method === 'account/read') return {account: {type: 'chatgpt'}};
          if (method === 'model/list') return {data: catalog};
          if (method === 'thread/start') return {thread: {id: 'plain-thread'}};
          if (method === 'thread/goal/get') return {goal: null};
          if (method === 'thread/backgroundTerminals/list') return {data: [], nextCursor: null};
          if (method === 'turn/start') return {turn: {id: 'plain-turn'}};
          return {};
        }
      };
    };
    const options = {root, executable: 'fixture', hostFactory, browserConfig: async () => null};
    const controller =
      provider === 'codex'
        ? createDesktopController(options)
        : createClaudeController({
            ...options,
            commandSpec: {command: 'fixture', argsPrefix: []},
            gatewayFactory: async () => ({mcpConfig: {mcpServers: {}}, close: async () => {}})
          });
    const text = '請記住：這是本輪假資料的發布決定。';
    const answer = '原生回覆\n<K_KNOWLEDGE_OBSERVATIONS>[]</K_KNOWLEDGE_OBSERVATIONS>';
    try {
      await controller.open(provider === 'codex' ? {model: 'gpt-6-luna'} : {});
      await controller.send({text});
      if (provider === 'codex') {
        const config = calls.find(row => row.method === 'thread/start').params;
        assert.doesNotMatch(
          config.developerInstructions ?? '',
          /K_KNOWLEDGE_OBSERVATIONS|K maintains local, project-scoped shared knowledge/
        );
        assert.deepEqual(calls.find(row => row.method === 'turn/start').params.input, [{type: 'text', text}]);
        const context = calls.find(row => row.method === 'turn/start').params.additionalContext;
        assert.deepEqual(Object.keys(context), ['k_common_memory', 'k_global_rules']);
        if (useRules) assert.match(context.k_global_rules.value, /合成全域工作規則內容/);
        else assert.match(context.k_global_rules.value, /目前未啟用（檔案不存在[\s\S]*均已失效/);
        assert.ok(config.developerInstructions.includes(globalRulesPath(root)));
        assert.doesNotMatch(config.developerInstructions, /合成全域工作規則內容/);
        hooks.onEvent({
          method: 'item/started',
          params: {
            threadId: 'plain-thread',
            turnId: 'plain-turn',
            item: {id: 'plain-answer', type: 'agentMessage', text: answer}
          }
        });
        hooks.onEvent({
          method: 'turn/completed',
          params: {threadId: 'plain-thread', turn: {id: 'plain-turn', status: 'completed'}}
        });
      } else {
        assert.equal(hooks.sharedKnowledgeInstructions, undefined);
        assert.match(started[0].text, /^<k_common_memory>/);
        if (useRules) assert.match(started[0].text, /<k_global_rules>[\s\S]*合成全域工作規則內容/);
        else assert.match(started[0].text, /<k_global_rules>\nK 跨模型全域工作規則目前未啟用（檔案不存在/);
        assert.deepEqual(started.slice(1), [{type: 'text', text}]);
        hooks.onMessage({type: 'assistant', uuid: 'plain-answer', message: {content: [{type: 'text', text: answer}]}});
        hooks.onMessage({type: 'result', is_error: false});
      }
      assert.equal(controller.state.status, 'completed');
      assert.equal(controller.state.messages.findLast(row => row.role === 'assistant').text, answer);
      assert.equal(controller.state.sharedKnowledge, undefined);
      await controller.close();
      await assert.rejects(lstat(path.join(root, '.runtime/shared-knowledge')), {code: 'ENOENT'});
    } finally {
      await controller.close();
    }
  });
