import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createConversationController} from '../src/conversation-controller.mjs';
import {createClaudeController} from '../src/claude-controller.mjs';
import {startConfiguredDesktop} from './configured-desktop.mjs';
import {scratchBase} from './scratch.mjs';

// Event shapes follow Claude Code 2.1.322 (the selected K core): resuming a stopped/failed
// background agent with SendMessage re-registers the same task id. Its task_started carries the
// SendMessage tool_use_id and a fresh run_id, and the later task_notification carries both again.
const claudeModel = 'claude-opus-5-5';
const READY = 'abcdef0123456789abcdef0123456789abcdef01';

async function desktopWithRealClaude() {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'claude-native-resume-'));
  await mkdir(path.join(root, '.local'));
  await writeFile(path.join(root, '.local', 'runtime.json'), JSON.stringify({version: '0'.repeat(40)}));
  await writeFile(path.join(root, '.local', 'update-ready.json'), JSON.stringify({ref: READY}));
  const hosts = [],
    claudes = [],
    requested = [];
  let pool;
  const hostFactory = options => {
    let resolveClosed;
    const host = {
      options,
      closed: new Promise(resolve => (resolveClosed = resolve)),
      startCalls: [],
      async start(content) {
        this.startCalls.push(content);
      },
      async interrupt() {},
      async close() {
        resolveClosed();
      }
    };
    hosts.push(host);
    return host;
  };
  const app = await startConfiguredDesktop({
    root,
    port: 0,
    requireLaunchToken: true,
    controllerFactory: options =>
      (pool = createConversationController({
        ...options,
        root,
        executable: 'fixture',
        commandSpec: {command: 'claude-fixture', argsPrefix: []},
        inspect: async () => ({available: true}),
        claudeFactory: claudeOptions => {
          const claude = createClaudeController({
            ...claudeOptions,
            hostFactory,
            bridgeFactory: async () => ({
              async list() {
                return [];
              },
              async close() {},
              async cancel() {
                return {settled: true};
              },
              async wait() {
                return {settled: true};
              },
              async inspect() {
                return {settled: true};
              }
            }),
            gatewayFactory: async () => ({mcpConfig: {mcpServers: {}}, async close() {}})
          });
          claudes.push(claude);
          return claude;
        }
      })),
    geminiAccounts: {list: async () => ({accounts: []})},
    coreUpdates: {pending: false, async close() {}},
    selfUpdate: {repoRoot: root, request: async ref => requested.push(ref)}
  });
  const boot = await fetch(app.createLaunchUrl(), {redirect: 'manual'}),
    cookie = boot.headers.get('set-cookie').split(';')[0];
  const pressUpdate = async () => {
    const response = await fetch(app.origin + '/api/self-update', {
      method: 'POST',
      headers: {Cookie: cookie, 'Content-Type': 'application/json', 'X-K-Request': '1', Origin: app.origin},
      body: '{}'
    });
    return {status: response.status, body: await response.json()};
  };
  return {app, pool: () => pool, hosts, claudes, requested, pressUpdate};
}

test('background Agent failed, resumed by SendMessage, then completed leaves no pending worker and unblocks the update', async () => {
  const f = await desktopWithRealClaude();
  try {
    const pool = f.pool();
    const room = await pool.open({model: claudeModel});
    await pool.send({...room, text: 'synthetic background agent'});
    const emit = f.hosts.at(-1).options.onMessage;
    const pending = () => pool.state.conversationActivity.find(row => row.threadId === room.threadId).pendingWorkers;
    emit({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent',
            name: 'Agent',
            input: {description: 'resume probe', prompt: 'work', run_in_background: true}
          }
        ]
      }
    });
    emit({
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_agent',
      task_id: 'a-native',
      run_id: '00000000a-0000000a',
      tool_use_id: 'toolu_agent',
      description: 'resume probe',
      is_backgrounded: true
    });
    emit({
      type: 'user',
      tool_use_result: {status: 'async_launched', agentId: 'a-native'},
      message: {content: [{type: 'tool_result', tool_use_id: 'toolu_agent', content: 'launched'}]}
    });
    emit({type: 'result', is_error: false});
    assert.equal(pending(), 1);
    emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a-native',
      run_id: '00000000a-0000000a',
      tool_use_id: 'toolu_agent',
      status: 'failed',
      summary: 'first run failed'
    });
    assert.equal(pending(), 0);
    // The notification starts a follow-up turn that resumes the same agent.
    emit({type: 'system', subtype: 'status', status: 'requesting'});
    emit({
      type: 'assistant',
      message: {
        content: [
          {type: 'tool_use', id: 'toolu_send', name: 'SendMessage', input: {to: 'a-native', message: 'continue'}}
        ]
      }
    });
    emit({
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_agent',
      task_id: 'a-native',
      run_id: '00000000b-0000000b',
      tool_use_id: 'toolu_send',
      description: 'resume probe',
      is_backgrounded: true
    });
    emit({
      type: 'user',
      message: {content: [{type: 'tool_result', tool_use_id: 'toolu_send', content: 'resumed'}]}
    });
    emit({type: 'result', is_error: false});
    assert.equal(pending(), 1, 'the resumed run is live work');
    const blocked = await f.pressUpdate();
    assert.equal(blocked.status, 409);
    assert.ok(blocked.body.busy.some(line => line.includes('子代理執行中')));
    emit({
      type: 'assistant',
      parent_tool_use_id: 'toolu_send',
      uuid: 'child-resumed',
      message: {content: [{type: 'text', text: 'resumed child output'}]}
    });
    emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a-native',
      run_id: '00000000b-0000000b',
      tool_use_id: 'toolu_send',
      status: 'completed',
      summary: 'second run done'
    });
    assert.equal(pending(), 0, 'the resumed completion settles the live run');
    const rows = f.claudes.at(-1).state.workers.filter(row => row.nativeTaskId === 'a-native');
    assert.ok(rows.every(row => row.settled === true));
    assert.ok(rows.some(row => row.status === 'completed' && row.output === 'second run done'));
    const accepted = await f.pressUpdate();
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(f.requested, [READY]);
  } finally {
    await f.app.close();
  }
});
