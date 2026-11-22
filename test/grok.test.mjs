import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createGrokController} from '../src/grok-controller.mjs';
import {createGrokWorker} from '../src/grok-worker.mjs';
import {commonMemoryPath, globalRulesPath} from '../src/common-memory.mjs';
import {grokEnvironment, grokModelsFrom, grokQuotaFrom} from '../src/grok-acp.mjs';
import {modelProvider} from '../shared/model-provider.mjs';
import {availableWorkerModels, validateWorkerPolicy, workerPolicyConfig} from '../src/worker-policy.mjs';
import {officialCoreRelease, downloadCoreRelease} from '../src/core-updates.mjs';
import {createLunaBridge} from '../src/luna-bridge.mjs';
import {listMainSessions} from '../src/main-sessions.mjs';
import {scratchBase} from './scratch.mjs';

// The shape grok 1.0.70 returned in the live ACP probe (initialize._meta.modelState).
const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {loadSession: true, promptCapabilities: {image: true}},
  _meta: {
    agentVersion: '1.0.70',
    modelState: {
      currentModelId: 'grok-4.7',
      availableModels: [
        {
          modelId: 'grok-4.7',
          name: 'Grok 4.7',
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: 'high',
            reasoningEfforts: ['xhigh', 'high', 'medium', 'low'].map(value => ({value, default: value === 'high'}))
          }
        },
        {
          modelId: 'grok-4.5',
          name: 'Grok 4.5',
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: 'high',
            reasoningEfforts: ['high', 'medium', 'low'].map(value => ({value, default: value === 'high'}))
          }
        }
      ]
    }
  }
};
const MODELS = grokModelsFrom(INITIALIZE);

// A scripted stand-in for `grok agent stdio`. Each prompt runs the next script step,
// which may stream updates, ask K for permission and return a stop reason.
function fakeGrok({scripts = []} = {}) {
  const calls = [],
    agents = [];
  const openAgent = async ({onNotification, onRequest, env, cwd}) => {
    let exited = false,
      cancelled = null;
    const agent = {
      pid: 4242,
      env,
      cwd,
      initialize: INITIALIZE,
      get exited() {
        return exited;
      },
      async request(method, params) {
        calls.push({method, params});
        if (method === 'session/new') return {sessionId: randomUUID()};
        if (method === 'session/resume' || method === 'session/load' || method === 'session/set_config_option')
          return {};
        if (method === 'session/prompt') {
          const step = scripts.shift() ?? (async () => ({stopReason: 'end_turn'}));
          const update = value =>
            onNotification({method: 'session/update', params: {sessionId: params.sessionId, update: value}});
          const ask = toolCall =>
            onRequest({
              method: 'session/request_permission',
              params: {
                sessionId: params.sessionId,
                toolCall,
                options: [
                  {optionId: 'allow-always', kind: 'allow_always'},
                  {optionId: 'allow-once', kind: 'allow_once'},
                  {optionId: 'reject-once', kind: 'reject_once'}
                ]
              }
            });
          return step({update, ask, params, cancelled: () => cancelled});
        }
        throw Error(`unexpected ${method}`);
      },
      notify(method, params) {
        calls.push({method, params});
        if (method === 'session/cancel') cancelled?.resolve?.();
      },
      waitForCancel() {
        let resolve;
        const promise = new Promise(r => (resolve = r));
        cancelled = {resolve};
        return promise;
      },
      async close() {
        exited = true;
        calls.push({method: 'close'});
      }
    };
    agents.push(agent);
    return agent;
  };
  return {calls, agents, openAgent};
}

async function fixture(scripts, extra = {}) {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'grok-controller-'));
  const fake = fakeGrok({scripts});
  const loginFactory = () => ({models: async () => MODELS, status: async () => ({available: true, models: MODELS})});
  const opts = {
    root,
    env: {SystemRoot: process.env.SystemRoot, XAI_API_KEY: 'must-not-inherit'},
    grokExecutable: path.join(root, 'grok.exe'),
    openAgent: fake.openAgent,
    loginFactory,
    ...extra
  };
  return {root, fake, opts, controller: createGrokController(opts)};
}
// A K worker gateway for this room, so k_luna is a registered MCP server.
const gatewayOptions = (hooks = {}) => ({
  gatewayFactory: async ({bridge}) => {
    hooks.bridge = bridge;
    return {
      mcpConfig: {mcpServers: {k_luna: {url: 'http://127.0.0.1:9/mcp', headers: {Authorization: 'Bearer fake'}}}},
      close: async () => {}
    };
  },
  bridgeFactory: async options => {
    hooks.bridgeOptions = options;
    return {
      list: async () => hooks.records ?? [],
      start: async args => ({requestId: args.requestId, parentId: options.parentId, status: 'running', settled: false}),
      cancel: async () => ({}),
      wait: async () => ({settled: true}),
      inspect: async () => ({settled: true}),
      close: async () => {}
    };
  }
});
const settled = async controller => {
  for (let i = 0; i < 200 && controller.state.busy; i++) await new Promise(r => setTimeout(r, 5));
};
const writeCall = (root, name) => ({
  toolCallId: randomUUID(),
  kind: 'edit',
  title: `Write ${name}`,
  rawInput: {file_path: path.join(root, name), content: 'HI'},
  content: [{type: 'diff', path: path.join(root, name), oldText: '', newText: 'HI'}],
  _meta: {'x.ai/tool': {name: 'write', label: 'Write'}}
});
const commandCall = command => ({
  toolCallId: randomUUID(),
  kind: 'execute',
  title: `Execute ${command}`,
  rawInput: {command},
  _meta: {'x.ai/tool': {name: 'run_terminal_command', label: 'Run Command'}}
});

test('grok catalog, quota and environment come from native data only', () => {
  assert.deepEqual(
    MODELS.map(m => [
      m.model,
      m.defaultReasoningEffort,
      m.supportedReasoningEfforts.map(e => e.reasoningEffort).join('/')
    ]),
    [
      ['grok-4.7', 'high', 'xhigh/high/medium/low'],
      ['grok-4.5', 'high', 'high/medium/low']
    ]
  );
  assert.equal(MODELS[0].provider, 'grok');
  assert.deepEqual(MODELS[0].inputModalities, ['text', 'image']);
  const quota = grokQuotaFrom({
    config: {
      currentPeriod: {type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-07T15:56:03.277+00:00'},
      creditUsagePercent: 1
    },
    subscription_tier: 'SuperGrok Lite'
  });
  assert.equal(quota.plan, 'SuperGrok Lite');
  assert.deepEqual(quota.windows, [
    {key: 'weekly', label: '每週', minutes: 10080, remainingPercent: 99, resetsAt: 1794066963}
  ]);
  // A weekly reset date alone supplies no measurement of the remaining percentage.
  const fresh = grokQuotaFrom({
    config: {currentPeriod: {type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-07T15:56:03Z'}}
  });
  assert.equal(fresh.windows[0].remainingPercent, null);
  assert.equal(fresh.windows[0].resetsAt, 1794066963);
  assert.equal(fresh.status, 'partial');
  // Without an official weekly period, or with an explicit null, nothing is assumed.
  const partial = grokQuotaFrom({config: {}});
  assert.equal(partial.windows[0].remainingPercent, null);
  assert.match(partial.note, /未提供已用百分比/);
  assert.equal(
    grokQuotaFrom({config: {currentPeriod: {type: 'USAGE_PERIOD_TYPE_WEEKLY'}, creditUsagePercent: null}}).windows[0]
      .remainingPercent,
    null
  );
  const env = grokEnvironment({XAI_API_KEY: 'x', GROK_DEPLOYMENT_KEY: 'y', GROK_CONFIG: '{}', PATH: 'p'}, 'H:\\home');
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_DEPLOYMENT_KEY, undefined);
  assert.equal(env.GROK_CONFIG, undefined);
  assert.equal(env.GROK_HOME, 'H:\\home');
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH, '1');
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, '1');
  assert.equal(env.GROK_CLAUDE_HOOKS_ENABLED, '0');
  assert.equal(env.PATH, 'p');
  assert.equal(modelProvider('grok-4.7'), 'grok');
  assert.equal(modelProvider('gpt-6.1-sol'), 'codex');
});

test('a Grok room creates one native session, streams the reply and records workspace edits', async () => {
  const f = await fixture([
    async ({update}) => {
      update({sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: 'thinking'}});
      update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'Hello '}});
      const call = writeCall(f.root, 'notes.md');
      update({sessionUpdate: 'tool_call', ...call});
      update({sessionUpdate: 'tool_call_update', ...call, status: 'completed'});
      update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'done'}});
      return {stopReason: 'end_turn'};
    }
  ]);
  const {threadId} = await f.controller.open({model: 'grok-4.7', effort: 'low', accessMode: 'workspace-write'});
  assert.match(threadId, /^grok-/);
  assert.equal(f.controller.state.provider, 'grok');
  assert.deepEqual(f.controller.state.efforts, ['xhigh', 'high', 'medium', 'low']);
  assert.deepEqual(await f.controller.send({text: '寫筆記'}), {sent: true});
  await settled(f.controller);
  assert.equal(f.controller.state.status, 'completed');
  const replies = f.controller.state.messages.filter(m => m.role === 'assistant');
  assert.deepEqual(replies.map(m => m.text), ['Hello done']);
  assert.ok(!replies[0].partial && !replies[0].streaming);
  assert.equal(f.controller.state.capabilities.steer, false);
  assert.deepEqual(f.controller.state.artifacts, ['notes.md']);
  // Grok has no thought text to show; its tool calls are grouped under the turn.
  assert.deepEqual(f.controller.state.reasoning, []);
  assert.equal(f.controller.state.capabilities.thoughts, false);
  assert.equal(f.controller.state.tools[0].groupId, f.controller.state.messages.at(-1).groupId);
  const created = f.fake.calls.find(c => c.method === 'session/new');
  assert.equal(created.params.cwd, f.root);
  assert.match(created.params._meta.rules, /目前權限：要求核准/);
  assert.match(created.params._meta.rules, /K 模型與派工協定/);
  const configs = f.fake.calls
    .filter(c => c.method === 'session/set_config_option')
    .map(c => [c.params.configId, c.params.value]);
  assert.deepEqual(configs, [
    ['model', 'grok-4.7'],
    ['reasoning_effort', 'low']
  ]);
  // K's environment never hands an API key to grok.
  assert.equal(f.fake.agents[0].env.XAI_API_KEY, undefined);
  assert.equal(f.fake.agents[0].env.GROK_HOME, path.join(f.root, 'agent-home', 'grok'));
  const saved = JSON.parse(await readFile(path.join(f.root, '.runtime/grok-sessions', `${threadId}.json`), 'utf8'));
  assert.match(saved.nativeSessionId, /^[0-9a-f-]{36}$/u);
  assert.equal(saved.nativeStarted, true);
  assert.deepEqual(saved.messages.filter(m => m.role === 'assistant'), replies);
  const listed = (await listMainSessions(f.root, {threadId})).sessions[0];
  assert.equal(listed.provider, 'grok');
  await f.controller.close();
});

test('K decides every Grok permission prompt by access mode and never grants more than once', async () => {
  const outcomes = [];
  const f = await fixture(
    [
      async ({ask}) => {
        outcomes.push((await ask(writeCall(f.root, 'inside.txt'))).outcome.optionId);
        // grok 1.0.70 dispatches MCP tools through use_tool; K's own gateway passes without a card.
        outcomes.push(
          (
            await ask({
              toolCallId: randomUUID(),
              kind: 'other',
              title: 'k_luna__luna_start',
              rawInput: {variant: 'UseTool', tool_name: 'k_luna__luna_start', tool_input: {}},
              _meta: {'x.ai/tool': {name: 'use_tool'}}
            })
          ).outcome.optionId
        );
        outcomes.push((await ask(commandCall('npm test'))).outcome.optionId);
        return {stopReason: 'end_turn'};
      },
      async ({ask}) => {
        outcomes.push((await ask(writeCall(path.dirname(f.root), 'outside.txt'))).outcome.optionId);
        return {stopReason: 'cancelled'};
      },
      async ({ask}) => {
        outcomes.push((await ask(writeCall(f.root, 'ro.txt'))).outcome.optionId);
        outcomes.push((await ask(commandCall('dir'))).outcome.optionId);
        return {stopReason: 'cancelled'};
      },
      async ({ask}) => {
        outcomes.push((await ask(commandCall('rm -rf build'))).outcome.optionId);
        return {stopReason: 'end_turn'};
      }
    ],
    gatewayOptions()
  );
  await f.controller.open({model: 'grok-4.7', accessMode: 'workspace-write'});
  const registered = f.fake.calls.length;
  assert.equal(registered, 0);
  await f.controller.send({text: 'one'});
  // The inside edit passes; the command waits for the person.
  for (let i = 0; i < 100 && !f.controller.state.questions.length; i++) await new Promise(r => setTimeout(r, 5));
  const question = f.controller.state.questions[0];
  assert.equal(question.provider, 'grok');
  assert.equal(question.details.command, 'npm test');
  await f.controller.answer({id: question.id, accept: true});
  await settled(f.controller);
  assert.deepEqual(outcomes, ['allow-once', 'allow-once', 'allow-once']);
  await f.controller.send({text: 'two'});
  for (let i = 0; i < 100 && !f.controller.state.questions.length; i++) await new Promise(r => setTimeout(r, 5));
  await f.controller.answer({id: f.controller.state.questions[0].id, accept: false});
  await settled(f.controller);
  assert.equal(outcomes[3], 'reject-once');
  assert.equal(f.controller.state.status, 'interrupted');
  assert.match(f.controller.state.error, /未獲核准/);
  await f.controller.send({text: 'three', accessMode: 'read-only'});
  await settled(f.controller);
  assert.deepEqual(outcomes.slice(4, 6), ['reject-once', 'reject-once']);
  await assert.rejects(f.controller.send({text: 'four', accessMode: 'danger-full-access'}), /明確確認 Grok 完整存取權/);
  await f.controller.send({text: 'four', accessMode: 'danger-full-access', permissionConfirmed: true});
  await settled(f.controller);
  assert.equal(outcomes[6], 'allow-once');
  assert.ok(!outcomes.includes('allow-always'));
  await assert.rejects(f.controller.open({model: 'grok-4.7', accessMode: 'auto-review'}), /未提供代我核准/);
  await f.controller.close();
});

test('stopping cancels the native turn; reopening resumes the same native session', async () => {
  const f = await fixture([
    async ({update}) => {
      update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'partial'}});
      await f.fake.agents.at(-1).waitForCancel();
      return {stopReason: 'cancelled'};
    }
  ]);
  const rules = globalRulesPath(f.root);
  await mkdir(path.dirname(rules), {recursive: true});
  await writeFile(rules, '- Grok 合成舊規則');
  const {threadId} = await f.controller.open({model: 'grok-4.7'});
  await f.controller.send({text: 'long'});
  for (let i = 0; i < 100 && !f.controller.state.messages.some(m => m.role === 'assistant'); i++)
    await new Promise(r => setTimeout(r, 5));
  await f.controller.stop();
  assert.equal(f.controller.state.status, 'interrupted');
  assert.ok(f.fake.calls.some(c => c.method === 'session/cancel'));
  assert.equal(f.controller.state.messages.at(-1).partial, true);
  const nativeSessionId = f.fake.calls.find(c => c.method === 'session/cancel').params.sessionId;
  await f.controller.close();
  await rm(rules);
  const again = createGrokController(f.opts);
  await again.open({threadId, model: 'grok-4.7'});
  await again.send({text: 'continue'});
  await settled(again);
  const resumed = f.fake.calls.filter(c => c.method === 'session/resume');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].params.sessionId, nativeSessionId);
  assert.equal(f.fake.calls.filter(c => c.method === 'session/new').length, 1);
  const prompts = f.fake.calls.filter(c => c.method === 'session/prompt').map(c => c.params.prompt);
  assert.match(prompts[0][0].text, /<k_global_rules>[\s\S]*Grok 合成舊規則/);
  assert.match(prompts[1][0].text, /<k_global_rules>[\s\S]*目前未啟用（檔案不存在[\s\S]*均已失效/);
  assert.deepEqual(prompts[1].slice(1), [{type: 'text', text: 'continue'}]);
  await again.close();
});

test('a Grok worker answers its own permission prompts, never delegates and reports written files', async () => {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'grok-worker-'));
  const fake = fakeGrok({
    scripts: [
      async ({update, ask}) => {
        const call = writeCall(root, 'out.md');
        update({sessionUpdate: 'tool_call_update', ...call});
        assert.equal((await ask(call)).outcome.optionId, 'allow-once');
        // The completed update carries no kind, as observed live.
        update({sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'completed'});
        assert.equal((await ask(commandCall('curl x'))).outcome.optionId, 'reject-once');
        update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'worker done'}});
        return {stopReason: 'end_turn'};
      }
    ]
  });
  const worker = createGrokWorker({
    root,
    workspace: root,
    accessMode: 'workspace-write',
    env: {},
    executable: path.join(root, 'grok.exe'),
    openAgent: fake.openAgent
  });
  const result = await worker.run({task: '寫檔', model: 'grok-4.7', effort: 'medium'});
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'worker done');
  assert.deepEqual(result.outputFiles, ['out.md']);
  assert.deepEqual(result.deniedTools, ['Execute curl x']);
  assert.equal(fake.agents[0].env.GROK_SUBAGENTS, '0');
  const created = fake.calls.find(c => c.method === 'session/new');
  assert.deepEqual(created.params.mcpServers, []);
  assert.match(created.params._meta.rules, /不再派工/);
  await assert.rejects(worker.run({task: 'x', model: 'grok-4.5', effort: 'xhigh'}), /推理程度目前不可用/);
});

test('a Grok worker refreshes private rules across parent answers in the same native session', {timeout: 3000}, async () => {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'grok-worker-'));
  const rules = globalRulesPath(root);
  await mkdir(path.dirname(rules), {recursive: true});
  await writeFile(commonMemoryPath(root), '- ACP 合成偏好');
  await writeFile(rules, '- ACP 合成規則甲');
  const step =
    text =>
    async ({update}) => {
      update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text}});
      return {stopReason: 'end_turn'};
    };
  const fake = fakeGrok({
    scripts: [
      step('{"k_worker_question":" 哪一份文件？ "}'),
      step('{"k_worker_question":" 新版？ "}'),
      step('{"k_worker_question":" 已移除？ "}'),
      step('{"k_worker_question":" 繼續？ "}'),
      step('完成。還有疑問？')
    ]
  });
  let asked, reply;
  const question = new Promise(resolve => (asked = resolve));
  const response = new Promise(resolve => (reply = resolve));
  const worker = createGrokWorker({
    root,
    workspace: root,
    executable: path.join(root, 'grok.exe'),
    openAgent: fake.openAgent
  });
  const run = worker.run({
    task: 't',
    model: 'grok-4.7',
    effort: 'low',
    askParent: async text => {
      if (text === '哪一份文件？') {
        asked(text);
        return response;
      }
      if (text === '新版？') {
        await writeFile(rules, '- ACP 合成規則乙');
        return '改用新版';
      }
      if (text === '已移除？') {
        await rm(rules);
        return '已移除';
      }
      assert.equal(text, '繼續？');
      return '繼續';
    }
  });
  assert.equal(await question, '哪一份文件？');
  assert.equal(fake.calls.filter(call => call.method === 'session/prompt').length, 1);
  reply('內部文件');
  assert.equal((await run).output, '完成。還有疑問？');
  const prompts = fake.calls.filter(call => call.method === 'session/prompt').map(call => call.params);
  assert.equal(prompts.length, 5);
  assert.equal(new Set(prompts.map(prompt => prompt.sessionId)).size, 1);
  assert.match(prompts[0].prompt[0].text, /^<k_common_memory>[\s\S]*ACP 合成偏好[\s\S]*<k_global_rules>[\s\S]*ACP 合成規則甲/);
  assert.match(prompts[0].prompt.at(-2).text, /k_worker_question/);
  assert.equal(prompts[1].prompt.length, 1);
  assert.match(prompts[1].prompt[0].text, /\{"answer":"內部文件"\}/);
  assert.match(prompts[2].prompt[0].text, /<k_global_rules>[\s\S]*ACP 合成規則乙/);
  assert.doesNotMatch(prompts[2].prompt[0].text, /ACP 合成規則甲/);
  assert.match(prompts[2].prompt[1].text, /\{"answer":"改用新版"\}/);
  assert.match(prompts[3].prompt[0].text, /<k_global_rules>[\s\S]*目前未啟用（檔案不存在[\s\S]*均已失效/);
  assert.match(prompts[3].prompt[1].text, /\{"answer":"已移除"\}/);
  assert.equal(prompts[4].prompt.length, 1);
  assert.match(prompts[4].prompt[0].text, /\{"answer":"繼續"\}/);
  assert.equal(fake.agents.length, 1);
});

test('Grok workers are offered through K process gateways and the bridge routes them to the Grok worker', async () => {
  const catalog = [...MODELS, {model: 'gpt-6.1-sol', supportedReasoningEfforts: []}];
  assert.deepEqual(
    availableWorkerModels(catalog).map(m => m.model),
    ['gpt-6.1-sol']
  );
  assert.ok(availableWorkerModels(catalog, {geminiGateway: true}).some(m => m.model === 'grok-4.7'));
  assert.ok(availableWorkerModels(catalog, {provider: 'grok'}).some(m => m.model === 'grok-4.7'));
  assert.throws(() => validateWorkerPolicy({model: 'grok-4.7', effort: 'high'}, catalog), /gateway/);
  const config = workerPolicyConfig({model: 'auto', effort: 'auto'}, {models: catalog, provider: 'grok'});
  assert.match(config.developer_instructions, /k_luna \/ luna_start/);
  assert.match(config.developer_instructions, /Native Grok subagents/);
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'grok-bridge-'));
  const runs = [];
  const bridge = await createLunaBridge({
    root,
    workspace: root,
    parentId: 'grok-parent',
    geminiOnly: true,
    workerPolicy: {model: 'auto', effort: 'auto'},
    grokFactory: options => ({
      run: async args => {
        runs.push({options, args});
        return {status: 'completed', settled: true, output: 'ok', outputFiles: []};
      }
    })
  });
  try {
    await bridge.start({requestId: 'grok-job-1', task: 'do it', model: 'grok-4.7', effort: 'low'});
    const done = await bridge.wait({requestId: 'grok-job-1', timeoutMs: 5000});
    assert.equal(done.provider, 'grok');
    assert.equal(done.status, 'completed');
    assert.equal(runs[0].args.model, 'grok-4.7');
    assert.equal(runs[0].options.workspace, root);
  } finally {
    await bridge.close();
  }
});

test('the Grok core update uses the official channel and requires the X Corp. signature', async () => {
  const request = async url => {
    assert.equal(url, 'https://x.ai/cli/stable');
    return {text: async () => '1.0.70\n'};
  };
  const release = await officialCoreRelease('grok', {request, signal: AbortSignal.timeout(5000)});
  assert.deepEqual(release, {
    version: '1.0.70',
    url: 'https://x.ai/cli/grok-1.0.70-windows-x86_64.exe',
    algorithm: 'authenticode',
    signer: 'X Corp.',
    file: 'grok.exe'
  });
  await mkdir(scratchBase, {recursive: true});
  const dir = await mkdtemp(path.join(scratchBase, 'grok-core-'));
  const body = () => new Response('binary').body;
  const signed = async (_ps, _args, options) => ({
    stdout: JSON.stringify({status: 'Valid', subject: 'CN=X Corp., O=X Corp., C=US'}),
    options
  });
  const file = await downloadCoreRelease(release, dir, {request: async () => ({body: body()}), run: signed});
  assert.equal(path.basename(file), 'grok.exe');
  const dir2 = await mkdtemp(path.join(scratchBase, 'grok-core-'));
  const forged = async () => ({stdout: JSON.stringify({status: 'Valid', subject: 'CN=Someone Else'})});
  await assert.rejects(
    downloadCoreRelease(release, dir2, {request: async () => ({body: body()}), run: forged}),
    /發行者不符/
  );
});

// ---- Regressions from the Astra xhigh review (2026-11-01) ----

test('a permission prompt arriving after stop is rejected, even with full access', async () => {
  let late;
  const f = await fixture([
    async ({ask}) => {
      await f.fake.agents.at(-1).waitForCancel();
      late = (await ask(commandCall('echo after-stop'))).outcome.optionId;
      return {stopReason: 'cancelled'};
    }
  ]);
  await f.controller.open({model: 'grok-4.7', accessMode: 'danger-full-access', permissionConfirmed: true});
  await f.controller.send({text: 'go'});
  await new Promise(r => setTimeout(r, 20));
  await f.controller.stop();
  assert.equal(late, 'reject-once');
  assert.equal(f.controller.state.questions.length, 0);
  await f.controller.close();
});

test('an unregistered K-looking tool name is never auto-approved', async () => {
  const f = await fixture([
    async ({ask}) => {
      const forged = commandCall('echo fake');
      forged.rawInput.tool_name = 'k_luna__luna_start';
      await ask(forged);
      await ask({
        toolCallId: randomUUID(),
        kind: 'other',
        title: 'k_luna__luna_start',
        rawInput: {variant: 'UseTool', tool_name: 'k_luna__luna_start', tool_input: {}},
        _meta: {'x.ai/tool': {name: 'use_tool'}}
      });
      return {stopReason: 'end_turn'};
    }
  ]);
  await f.controller.open({model: 'grok-4.7', accessMode: 'workspace-write'});
  await f.controller.send({text: 'go'});
  for (let i = 0; i < 100 && !f.controller.state.questions.length; i++) await new Promise(r => setTimeout(r, 5));
  // Not use_tool: the name stays the native command tool, so the person decides.
  assert.equal(f.controller.state.questions[0].details.toolName, 'run_terminal_command');
  await f.controller.answer({id: f.controller.state.questions[0].id, accept: false});
  for (let i = 0; i < 100 && !f.controller.state.questions.length; i++) await new Promise(r => setTimeout(r, 5));
  // use_tool for k_luna, but this room registered no K gateway: still a card.
  assert.equal(f.controller.state.questions[0].details.toolName, 'k_luna__luna_start');
  await f.controller.answer({id: f.controller.state.questions[0].id, accept: false});
  await settled(f.controller);
  await f.controller.close();
});

test('Grok delivers a live clarification while a Gemini scheduling receipt is held', async () => {
  const hooks = {};
  const f = await fixture([], gatewayOptions(hooks));
  try {
    const {threadId} = await f.controller.open({model: 'grok-4.7', accessMode: 'workspace-write'});
    const running = await hooks.bridge.start({requestId: 'clarify-job', task: 'clarify', model: 'grok-4.7', effort: 'low'});
    const pendingQuestion = {id: randomUUID(), text: 'Use sample A?'};
    const emit = record => {
      hooks.records = [record];
      hooks.bridgeOptions.onChange(record);
    };
    const prompts = () => f.fake.calls
      .filter(call => call.method === 'session/prompt')
      .map(call => call.params.prompt.map(block => block.text).join(''));
    const waitForPrompt = async count => {
      for (let i = 0; i < 200 && (prompts().length < count || f.controller.state.busy); i++)
        await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(prompts().length, count);
    };
    hooks.bridgeOptions.onGeminiHandoff({
      parentId: threadId,
      requestIds: [],
      queryIds: ['held-gemini-query'],
      status: 'blocked'
    });
    emit({...running, pendingQuestion});
    await waitForPrompt(1);
    assert.match(prompts()[0], /(?:^|<\/k_global_rules>)K 工人提問/);
    assert.ok(prompts()[0].includes(pendingQuestion.id));
    assert.doesNotMatch(prompts()[0], /held-gemini-query/);

    emit({...running, settled: true, status: 'completed'});
    await waitForPrompt(2);
    assert.match(prompts()[1], /held-gemini-query/);
    assert.match(prompts()[1], /K 工人完成通知/);
  } finally {
    await f.controller.close();
  }
});

test('a worker completion during stop never opens a new native turn', async () => {
  let releaseBrowser;
  const hooks = {};
  const f = await fixture([async () => ({stopReason: 'end_turn'})], {
    ...gatewayOptions(hooks),
    browserConfig: async () => ({url: 'http://127.0.0.1:9/browser', headers: {}}),
    closeBrowser: () => new Promise(resolve => (releaseBrowser = resolve))
  });
  const {threadId} = await f.controller.open({model: 'grok-4.7', accessMode: 'workspace-write'});
  await f.controller.send({text: 'start a worker'});
  await settled(f.controller);
  const answer = {requestId: 'w1', questionId: randomUUID(), answer: 'Use sample A'};
  await assert.rejects(hooks.bridge.answer(answer), /沒有可回覆/);
  assert.equal(hooks.bridgeOptions, undefined);
  await hooks.bridge.start({requestId: 'w1', task: 't', model: 'grok-4.7', effort: 'low'});
  const originalBridge = hooks.bridgeOptions;
  const stopping = f.controller.stop();
  await assert.rejects(hooks.bridge.answer(answer), /沒有可回覆/);
  hooks.bridgeOptions.onChange({
    requestId: 'w1',
    parentId: threadId,
    status: 'completed',
    settled: true,
    outputFiles: []
  });
  await new Promise(r => setTimeout(r, 30));
  releaseBrowser();
  assert.deepEqual(await stopping, {stopped: true});
  await assert.rejects(hooks.bridge.answer(answer), /沒有可回覆/);
  assert.equal(hooks.bridgeOptions, originalBridge);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.fake.calls.filter(c => c.method === 'session/prompt').length, 1);
  assert.equal(f.controller.state.busy, false);
  await f.controller.close();
});

test('stop reaches a process whose session setup hangs, and an unconfirmed close blocks new work', async () => {
  const kills = [];
  const hanging = fakeGrok();
  let failClose = false;
  const openAgent = async options => {
    const agent = await hanging.openAgent(options);
    let reject;
    const request = agent.request.bind(agent);
    agent.request = (method, params) =>
      method === 'session/new' ? new Promise((_, r) => (reject = r)) : request(method, params);
    agent.close = async () => {
      if (failClose) throw Error('kill failed');
      reject?.(Object.assign(Error('ended'), {processEnded: true}));
      hanging.calls.push({method: 'close'});
    };
    return agent;
  };
  const f = await fixture([], {openAgent, stopGraceMs: 20, killTree: async pid => kills.push(pid)});
  await f.controller.open({model: 'grok-4.7'});
  void f.controller.send({text: 'one'}).catch(() => {});
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(await f.controller.stop(), {stopped: true});
  assert.ok(hanging.calls.some(c => c.method === 'close'));
  assert.equal(f.controller.state.busy, false);
  // A failed setup whose process cannot be confirmed stopped blocks the room until stop ends it.
  failClose = true;
  const f2 = await fixture([], {
    openAgent: async options => {
      const agent = await openAgent(options);
      agent.request = async method => {
        if (method === 'session/new') throw Error('setup failed');
        return {};
      };
      return agent;
    },
    killTree: async pid => kills.push(pid)
  });
  await f2.controller.open({model: 'grok-4.7'});
  await assert.rejects(f2.controller.send({text: 'one'}), /kill failed/);
  await assert.rejects(f2.controller.send({text: 'two'}), /查明目前 Grok 工作/);
  failClose = false;
  await f2.controller.stop();
  assert.deepEqual(kills, [4242]);
  await f.controller.close();
  await f2.controller.close();
});

test('a Grok worker that ignores cancel is closed; a failure keeps its partial output', async () => {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'grok-worker-'));
  const fake = fakeGrok();
  const promptStarted = Promise.withResolvers();
  const openAgent = async options => {
    const agent = await fake.openAgent(options);
    const request = agent.request.bind(agent);
    let reject;
    agent.request = (method, params) => {
      if (method !== 'session/prompt') return request(method, params);
      fake.calls.push({method, params});
      promptStarted.resolve();
      return new Promise((_, r) => (reject = r));
    };
    agent.close = async () => {
      fake.calls.push({method: 'close'});
      reject?.(Object.assign(Error('ended'), {processEnded: true}));
    };
    return agent;
  };
  const worker = createGrokWorker({
    root,
    workspace: root,
    env: {},
    executable: path.join(root, 'grok.exe'),
    openAgent,
    stopGraceMs: 20
  });
  const abort = new AbortController();
  const run = worker.run({task: 't', model: 'grok-4.7', effort: 'low', signal: abort.signal});
  await promptStarted.promise;
  abort.abort();
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.ok(fake.calls.some(c => c.method === 'session/cancel'));
  assert.ok(fake.calls.some(c => c.method === 'close'));
  const failing = fakeGrok({
    scripts: [
      async ({update}) => {
        update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'partial'}});
        throw Object.assign(Error('process ended'), {processEnded: true});
      }
    ]
  });
  const broken = createGrokWorker({
    root,
    workspace: root,
    env: {},
    executable: path.join(root, 'grok.exe'),
    openAgent: failing.openAgent
  });
  const error = await broken.run({task: 't', model: 'grok-4.7', effort: 'low'}).catch(e => e);
  assert.equal(error.workerResult.output, 'partial');
  assert.match(error.workerResult.nativeSessionId, /^[0-9a-f-]{36}$/u);
});

test('version queries carry no provider credentials and use the K Grok home; unknown quota stays unknown', async () => {
  const {versionEnvironment} = await import('../src/core-updates.mjs');
  const env = versionEnvironment(
    {XAI_API_KEY: 'k', GROK_DEPLOYMENT_KEY: 'd', OPENAI_API_KEY: 'o', PATH: 'p'},
    {GROK_HOME: 'H:\\grok'}
  );
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_DEPLOYMENT_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GROK_HOME, 'H:\\grok');
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH, '1');
  assert.equal(env.PATH, 'p');
  for (const value of [null, '', '5', 150, -1])
    assert.equal(grokQuotaFrom({config: {creditUsagePercent: value}}).windows[0].remainingPercent, null);
});

// ---- Regressions from the second Astra xhigh review (2026-11-01) ----

test('switching the model of an open Grok room applies the new model and effort', async () => {
  const f = await fixture([async () => ({stopReason: 'end_turn'})]);
  const {threadId} = await f.controller.open({model: 'grok-4.7', effort: 'xhigh'});
  assert.deepEqual(await f.controller.selectModel({threadId, model: 'grok-4.5', effort: 'low'}), {
    threadId,
    model: 'grok-4.5',
    effort: 'low'
  });
  assert.deepEqual(f.controller.state.efforts, ['high', 'medium', 'low']);
  await f.controller.send({text: 'go'});
  await settled(f.controller);
  const configs = f.fake.calls.filter(c => c.method === 'session/set_config_option').map(c => c.params.value);
  assert.deepEqual(configs, ['grok-4.5', 'low']);
  await f.controller.close();
});

test('the K Grok home comes from the launcher, beside the other K core homes', async () => {
  const {grokHome} = await import('../src/grok-acp.mjs');
  assert.equal(grokHome('C:\\state', {K_GROK_HOME: 'D:\\k\\agent-home\\grok'}), 'D:\\k\\agent-home\\grok');
  assert.equal(grokHome('C:\\state', {K_GROK_HOME: 'relative'}), path.join('C:\\state', 'agent-home', 'grok'));
  assert.equal(grokEnvironment({K_GROK_HOME: 'x'}, 'h').K_GROK_HOME, undefined);
});

test('a stop during initialize whose process cannot be ended reports the PID instead of waiting', async () => {
  const {openGrokAgent} = await import('../src/grok-acp.mjs');
  const {PassThrough} = await import('node:stream');
  const {EventEmitter} = await import('node:events');
  const child = Object.assign(new EventEmitter(), {
    pid: 777,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  });
  const abort = new AbortController();
  const opening = openGrokAgent({
    executable: 'grok.exe',
    env: {},
    spawnImpl: () => child,
    killTree: async () => {
      throw Error('kill failed');
    },
    signal: abort.signal
  });
  setTimeout(() => abort.abort(), 10);
  const error = await opening.catch(e => e);
  assert.equal(error.unresolvedPid, 777);
  assert.match(error.message, /停止未確認/);
});

test('a Grok worker whose stop fails during setup, or whose startup cleanup is unconfirmed, stays unsettled', async () => {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'grok-worker-'));
  const hanging = fakeGrok();
  const openAgent = async options => {
    const agent = await hanging.openAgent(options);
    const request = agent.request.bind(agent);
    agent.request = (method, params) => (method === 'session/new' ? new Promise(() => {}) : request(method, params));
    agent.close = async () => {
      throw Error('kill failed');
    };
    return agent;
  };
  const worker = createGrokWorker({
    root,
    workspace: root,
    env: {},
    executable: path.join(root, 'grok.exe'),
    openAgent,
    stopGraceMs: 10
  });
  const abort = new AbortController();
  const run = worker.run({task: 't', model: 'grok-4.7', effort: 'low', signal: abort.signal});
  await new Promise(r => setTimeout(r, 10));
  abort.abort();
  const error = await run.catch(e => e);
  assert.equal(error.settled, false);
  assert.match(error.message, /停止未確認/);
  assert.deepEqual(error.workerResult.outputFiles, []);
  const started = [];
  const unresolved = createGrokWorker({
    root,
    workspace: root,
    env: {},
    executable: path.join(root, 'grok.exe'),
    openAgent: async () => {
      throw Object.assign(Error('startup stop unconfirmed'), {unresolvedPid: 888});
    }
  });
  const failed = await unresolved
    .run({task: 't', model: 'grok-4.7', effort: 'low', onStart: pid => started.push(pid)})
    .catch(e => e);
  assert.equal(failed.settled, false);
  assert.deepEqual(started, [888]);
});
