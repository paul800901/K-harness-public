import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {createComponentPreferences} from '../src/component-preferences.mjs';
import {createUnifiedController} from '../src/unified-controller.mjs';
import {workerPolicyConfig} from '../src/worker-policy.mjs';
import {componentIds} from '../shared/components.mjs';

const fresh = () => mkdtemp(path.join(scratchBase, 'selection-'));
test('first opening remains pending across restarts and later sidebar initialization', async () => {
  const root = await fresh();
  assert.equal((await createComponentPreferences(root)).value, null);
  await writeFile(path.join(root, '.runtime/sidebar-preferences.json'), '{}');
  const choices = await createComponentPreferences(root);
  assert.equal(choices.value, null);
  await choices.set(['gemini']);
  assert.deepEqual((await createComponentPreferences(root)).value, ['gemini']);
  await choices.set([]);
  assert.deepEqual((await createComponentPreferences(root)).value, []);
});
test('installation with existing rooms keeps its components and invalid selections preserve the saved choice', async () => {
  const root = await fresh();
  await mkdir(path.join(root, '.runtime/main-sessions'), {recursive: true});
  await writeFile(path.join(root, '.runtime/main-sessions/example.json'), '{}');
  const choices = await createComponentPreferences(root);
  assert.deepEqual(choices.value, componentIds);
  assert.throws(() => choices.set(['android']));
  assert.throws(() => choices.set(['made-up']));
  assert.deepEqual((await createComponentPreferences(root)).value, componentIds);
});
test('malformed component preference stays intact and reports an actionable error', async () => {
  const root = await fresh();
  await mkdir(path.join(root, '.runtime'));
  const file = path.join(root, '.runtime/components.json');
  await writeFile(file, 'broken');
  const choices = await createComponentPreferences(root);
  assert.ok(choices.error);
  assert.equal(await readFile(file, 'utf8'), 'broken');
});
test('Gemini-only catalogs, native workers and usage queries touch only Gemini', async () => {
  const root = await fresh();
  const calls = [];
  let workerCatalog;
  const factory = id => options => {
    workerCatalog = options.workerCatalog;
    return {
      state: {usage: {}, workers: [], questions: [], messages: [], workspace: root},
      models: async () => {
        calls.push([id, 'models']);
        return {models: [{model: id + '-fixture'}]};
      },
      usage: async () => {
        calls.push([id, 'usage']);
      },
      close: async () => {}
    };
  };
  const controller = createUnifiedController({
    root,
    componentEnabled: id => id === 'gemini',
    codexFactory: factory('codex'),
    claudeFactory: factory('claude'),
    grokFactory: factory('grok'),
    deepseekFactory: factory('deepseek'),
    geminiFactory: factory('gemini')
  });
  try {
    assert.deepEqual(
      (await controller.models()).models.map(row => row.provider),
      ['gemini']
    );
    assert.deepEqual(
      (await workerCatalog()).models.map(row => row.provider),
      ['gemini']
    );
    await controller.usage();
    assert.deepEqual(calls, [
      ['gemini', 'models'],
      ['gemini', 'models'],
      ['gemini', 'usage']
    ]);
  } finally {
    await controller.close();
  }
});

test('a deselected room keeps its own model settings without offering the core for new workers', async () => {
  const root = await fresh();
  let catalog, codex;
  const factory = (id, model) => options => {
    catalog = options.workerCatalog;
    const ctl = {
      state: {workspace: root, model, threadId: null, workers: [], messages: [], questions: []},
      models: async () => ({models: [{model}]}),
      close: async () => {}
    };
    if (id === 'codex') codex = ctl;
    return ctl;
  };
  const controller = createUnifiedController({
    root,
    componentEnabled: id => id === 'gemini',
    codexFactory: factory('codex', 'gpt-fixture'),
    geminiFactory: factory('gemini', 'gemini-fixture')
  });
  try {
    codex.state.threadId = 'previous-room';
    const own = await controller.models('gpt-fixture');
    assert.deepEqual(
      own.models.map(row => row.provider),
      ['codex', 'gemini']
    );
    const workers = await catalog();
    assert.deepEqual(
      workers.models.map(row => row.provider),
      ['gemini']
    );
  } finally {
    await controller.close();
  }
});

test('deselecting a saved worker allows the parent room to open and suspends that choice', () => {
  const policy = {model: 'claude-fixture', effort: 'high'};
  const config = workerPolicyConfig(policy, {models: [], componentEnabled: id => id === 'gemini'});
  assert.deepEqual(config.agents, {enabled: false});
  assert.match(config.developer_instructions, /Do not delegate/);
  assert.doesNotMatch(config.developer_instructions, /For every delegated task, choose/);
  assert.deepEqual(policy, {model: 'claude-fixture', effort: 'high'});
});
