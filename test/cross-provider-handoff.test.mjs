import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createLunaBridge, lunaResult} from '../src/luna-bridge.mjs';
import {scratchBase} from './scratch.mjs';

const testDir = path.join(scratchBase, 'cross-provider-handoff', randomUUID()),
  workspace = path.join(testDir, 'workspace');
await mkdir(workspace, {recursive: true});

function makeBridge({
  parentId = 'room-main',
  geminiRunner,
  claudeRunner,
  accessMode = 'read-only'
} = {}) {
  return createLunaBridge({
    root: testDir,
    workspace,
    parentId,
    geminiOnly: true,
    accessMode,
    geminiFactory: () => ({
      run: async options => {
        options.onStart?.(1001);
        if (geminiRunner) return geminiRunner(options);
        return {status: 'completed', settled: true, output: `gemini output for ${options.task}`};
      }
    }),
    claudeFactory: () => ({
      run: async options => {
        options.onStart?.(2001);
        if (claudeRunner) return claudeRunner(options);
        return {status: 'completed', settled: true, output: `claude output for ${options.task}`};
      }
    })
  });
}

test('positive: confirmed settled Claude worker can be handed off to Gemini Flash, target model preserved, original record unchanged', async () => {
  const bridge = await makeBridge({
    claudeRunner: async () => {
      // Original Claude ticket failed with 5h quota exhaustion, settled: true
      const err = new Error('5h quota exhausted');
      err.settled = true;
      err.workerResult = {output: 'partial analysis before quota limit', outputFiles: ['partial.txt']};
      throw err;
    },
    geminiRunner: async options => {
      return {
        status: 'completed',
        settled: true,
        output: `Finished remainder: ${options.task}`,
        outputFiles: ['final.txt']
      };
    }
  });

  try {
    const claudeJob = {
      requestId: 'claude-quota-predecessor',
      task: 'Review context evidence with Claude',
      model: 'claude-sonnet-4-6',
      effort: 'medium'
    };
    await bridge.start(claudeJob);
    const claudeRecord = await bridge.wait({requestId: claudeJob.requestId, timeoutMs: 1000});
    assert.equal(claudeRecord.provider, 'claude');
    assert.equal(claudeRecord.model, 'claude-sonnet-4-6');
    assert.equal(claudeRecord.effort, 'medium');
    assert.equal(claudeRecord.status, 'failed');
    assert.equal(claudeRecord.settled, true);
    assert.equal(claudeRecord.output, 'partial analysis before quota limit');
    assert.deepEqual(claudeRecord.outputFiles, ['partial.txt']);

    const geminiJob = {
      requestId: 'gemini-review-remaining-20261030',
      task: 'Review remaining context evidence with Flash',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'claude-quota-predecessor'
    };

    await bridge.start(geminiJob);
    const geminiRecord = await bridge.wait({requestId: geminiJob.requestId, timeoutMs: 1000});
    assert.equal(geminiRecord.provider, 'gemini');
    assert.equal(geminiRecord.model, 'gemini-3.8-flash');
    assert.equal(geminiRecord.effort, 'high');
    assert.equal(geminiRecord.status, 'completed');
    assert.equal(geminiRecord.settled, true);
    assert.equal(geminiRecord.handoffFrom, claudeJob.requestId);
    assert.equal(geminiRecord.output, 'Finished remainder: Review remaining context evidence with Flash');
    assert.deepEqual(geminiRecord.outputFiles, ['final.txt']);

    // Verify original Claude record is NOT overwritten or mutated
    const claudeInspect = await bridge.inspect({requestId: claudeJob.requestId});
    assert.equal(claudeInspect.provider, 'claude');
    assert.equal(claudeInspect.model, 'claude-sonnet-4-6');
    assert.equal(claudeInspect.effort, 'medium');
    assert.equal(claudeInspect.status, 'failed');
    assert.equal(claudeInspect.settled, true);
    assert.equal(claudeInspect.output, 'partial analysis before quota limit');
    assert.deepEqual(claudeInspect.outputFiles, ['partial.txt']);

    // Verify persisted files on disk are separate and intact
    const dir = path.join(testDir, '.runtime', 'luna-bridge', 'room-main');
    const claudeDisk = JSON.parse(await readFile(path.join(dir, `${claudeJob.requestId}.json`), 'utf8'));
    assert.equal(claudeDisk.provider, 'claude');
    assert.equal(claudeDisk.status, 'failed');
    assert.equal(claudeDisk.settled, true);

    const geminiDisk = JSON.parse(await readFile(path.join(dir, `${geminiJob.requestId}.json`), 'utf8'));
    assert.equal(geminiDisk.provider, 'gemini');
    assert.equal(geminiDisk.model, 'gemini-3.8-flash');
    assert.equal(geminiDisk.effort, 'high');
    assert.equal(geminiDisk.handoffFrom, claudeJob.requestId);
    assert.equal(geminiDisk.status, 'completed');
    assert.equal(geminiDisk.settled, true);
  } finally {
    await bridge.close();
  }
});

test('positive: original Gemini to Gemini handoff remains fully functional', async () => {
  const bridge = await makeBridge({
    geminiRunner: async options => {
      if (options.task === 'step 1') {
        const err = new Error('5h quota exhausted');
        err.settled = true;
        throw err;
      }
      return {status: 'completed', settled: true, output: `completed ${options.task}`};
    }
  });

  try {
    const job1 = {
      requestId: 'gemini-step-1',
      task: 'step 1',
      model: 'gemini-3.8-flash',
      effort: 'high'
    };
    await bridge.start(job1);
    const record1 = await bridge.wait({requestId: job1.requestId, timeoutMs: 1000});
    assert.equal(record1.provider, 'gemini');
    assert.equal(record1.status, 'failed');
    assert.equal(record1.settled, true);

    const job2 = {
      requestId: 'gemini-step-2',
      task: 'step 2 remaining',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'gemini-step-1'
    };
    await bridge.start(job2);
    const record2 = await bridge.wait({requestId: job2.requestId, timeoutMs: 1000});
    assert.equal(record2.provider, 'gemini');
    assert.equal(record2.model, 'gemini-3.8-flash');
    assert.equal(record2.effort, 'high');
    assert.equal(record2.status, 'completed');
    assert.equal(record2.settled, true);
    assert.equal(record2.handoffFrom, 'gemini-step-1');
  } finally {
    await bridge.close();
  }
});

test('negative: Claude predecessor still running (settled=false) rejects handoff and does not start new job', async () => {
  let finishClaude;
  const bridge = await makeBridge({
    claudeRunner: async () => {
      await new Promise(resolve => {
        finishClaude = resolve;
      });
      return {status: 'completed', settled: true, output: 'eventually done'};
    }
  });

  try {
    const claudeJob = {
      requestId: 'claude-still-running',
      task: 'Claude long task',
      model: 'claude-sonnet-4-6',
      effort: 'medium'
    };
    await bridge.start(claudeJob);

    const geminiJob = {
      requestId: 'gemini-attempt-too-early',
      task: 'Hand off too early',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'claude-still-running'
    };

    await assert.rejects(
      bridge.start(geminiJob),
      /原 Claude 工作尚未確認停止，不能接手或重播。/
    );

    // Verify new job was NOT created
    const inspectNew = await bridge.inspect({requestId: 'gemini-attempt-too-early'});
    assert.equal(inspectNew, null);
  } finally {
    finishClaude?.();
    await bridge.close();
  }
});

test('negative: Gemini predecessor still running (settled=false) rejects handoff with Gemini label', async () => {
  let finishGemini;
  const bridge = await makeBridge({
    geminiRunner: async () => {
      await new Promise(resolve => {
        finishGemini = resolve;
      });
      return {status: 'completed', settled: true, output: 'eventually done'};
    }
  });

  try {
    const geminiJob1 = {
      requestId: 'gemini-still-running',
      task: 'Gemini running task',
      model: 'gemini-3.8-flash',
      effort: 'high'
    };
    await bridge.start(geminiJob1);

    const geminiJob2 = {
      requestId: 'gemini-attempt-too-early',
      task: 'Hand off too early',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'gemini-still-running'
    };

    await assert.rejects(
      bridge.start(geminiJob2),
      /原 Gemini 工作尚未確認停止，不能接手或重播。/
    );

    const inspectNew = await bridge.inspect({requestId: 'gemini-attempt-too-early'});
    assert.equal(inspectNew, null);
  } finally {
    finishGemini?.();
    await bridge.close();
  }
});

test('negative: missing / nonexistent predecessor rejects with standard stop error and does not start job', async () => {
  const bridge = await makeBridge();

  try {
    const geminiJob = {
      requestId: 'gemini-missing-predecessor',
      task: 'Task with nonexistent predecessor',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'does-not-exist-12345'
    };

    await assert.rejects(
      bridge.start(geminiJob),
      /原工作尚未確認停止，不能接手或重播。/
    );

    const inspectNew = await bridge.inspect({requestId: 'gemini-missing-predecessor'});
    assert.equal(inspectNew, null);
  } finally {
    await bridge.close();
  }
});

test('negative: same ID (handoffFrom === requestId) rejects with explicit new ID error', async () => {
  const bridge = await makeBridge();

  try {
    const geminiJob = {
      requestId: 'same-id-job',
      task: 'Self handoff task',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'same-id-job'
    };

    await assert.rejects(
      bridge.start(geminiJob),
      /接手必須使用新的工作 ID。/
    );

    const inspectNew = await bridge.inspect({requestId: 'same-id-job'});
    assert.equal(inspectNew, null);
  } finally {
    await bridge.close();
  }
});

test('negative: predecessor from a different room / chamber (parentId) cannot authorize handoff', async () => {
  const bridgeA = await makeBridge({parentId: 'chamber-alpha'});
  const bridgeB = await makeBridge({parentId: 'chamber-beta'});

  try {
    // Start and settle a Claude job in Chamber Alpha
    const claudeJobAlpha = {
      requestId: 'claude-in-alpha',
      task: 'Work in chamber alpha',
      model: 'claude-sonnet-4-6',
      effort: 'medium'
    };
    await bridgeA.start(claudeJobAlpha);
    const alphaRecord = await bridgeA.wait({requestId: claudeJobAlpha.requestId, timeoutMs: 1000});
    assert.equal(alphaRecord.settled, true);

    // In Chamber Beta, try to hand off from Chamber Alpha's ticket
    const geminiJobBeta = {
      requestId: 'gemini-in-beta',
      task: 'Work in chamber beta trying to hand off from alpha',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'claude-in-alpha'
    };

    await assert.rejects(
      bridgeB.start(geminiJobBeta),
      /原工作尚未確認停止，不能接手或重播。/
    );

    const inspectBeta = await bridgeB.inspect({requestId: 'gemini-in-beta'});
    assert.equal(inspectBeta, null);
  } finally {
    await bridgeA.close();
    await bridgeB.close();
  }
});

test('negative: recovered executionUnowned predecessor cannot authorize handoff', async () => {
  const parentId = 'room-unowned-test';
  const directory = path.join(testDir, '.runtime', 'luna-bridge', parentId);
  await mkdir(directory, {recursive: true});

  // Write an unresolved, unsettled historical record to simulate K restart recovery
  await writeFile(
    path.join(directory, 'unsettled-claude-predecessor.json'),
    JSON.stringify({
      requestId: 'unsettled-claude-predecessor',
      parentId,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      status: 'running',
      settled: false,
      task: 'historical unowned task',
      workspace,
      output: '',
      outputFiles: []
    }),
    'utf8'
  );

  const bridge = await makeBridge({parentId});

  try {
    // Inspect confirms it was recovered as executionUnowned
    const inspectOld = await bridge.inspect({requestId: 'unsettled-claude-predecessor'});
    assert.equal(inspectOld.executionUnowned, true);
    assert.equal(inspectOld.status, 'unresolved');

    // Attempting to hand off from this executionUnowned record must be rejected
    const geminiJob = {
      requestId: 'gemini-hand-from-unowned',
      task: 'Trying to hand off from unowned record',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'unsettled-claude-predecessor'
    };

    await assert.rejects(
      bridge.start(geminiJob),
      /原工作尚未確認停止，不能接手或重播。/
    );

    const inspectNew = await bridge.inspect({requestId: 'gemini-hand-from-unowned'});
    assert.equal(inspectNew, null);
  } finally {
    await bridge.close();
  }
});

test('negative: same-requestId deduplication and conflict rejection with handoffFrom', async () => {
  const bridge = await makeBridge({
    claudeRunner: async () => ({status: 'completed', settled: true, output: 'done'})
  });

  try {
    const claudeJob = {
      requestId: 'claude-predecessor-dedup',
      task: 'Claude task',
      model: 'claude-sonnet-4-6',
      effort: 'medium'
    };
    await bridge.start(claudeJob);
    await bridge.wait({requestId: claudeJob.requestId, timeoutMs: 1000});

    const geminiJob = {
      requestId: 'gemini-dedup-test',
      task: 'Handoff task',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'claude-predecessor-dedup'
    };

    // Identical concurrent start deduplicates
    const [op1, op2] = await Promise.all([bridge.start(geminiJob), bridge.start(geminiJob)]);
    assert.equal(op1.requestId, geminiJob.requestId);
    assert.equal(op2.requestId, geminiJob.requestId);

    // Conflicting parameters on same requestId rejected
    await assert.rejects(
      bridge.start({...geminiJob, task: 'Conflicting task text'}),
      /相同 requestId 已綁定不同 task、帳號或模型設定；拒絕重送。/
    );

    await assert.rejects(
      bridge.start({...geminiJob, model: 'gemini-3.7-flash'}),
      /相同 requestId 已綁定不同 task、帳號或模型設定；拒絕重送。/
    );

    await assert.rejects(
      bridge.start({...geminiJob, handoffFrom: 'different-handoff'}),
      /相同 requestId 已綁定不同 task、帳號或模型設定；拒絕重送。/
    );
  } finally {
    await bridge.close();
  }
});

test('negative: corrupted predecessor JSON file throws inspect parse error directly and does not start job', async () => {
  const parentId = 'room-corrupted-json';
  const directory = path.join(testDir, '.runtime', 'luna-bridge', parentId);
  await mkdir(directory, {recursive: true});

  await writeFile(
    path.join(directory, 'corrupted-predecessor.json'),
    '{ invalid json content here: syntax error',
    'utf8'
  );

  const bridge = await makeBridge({parentId});

  try {
    const geminiJob = {
      requestId: 'gemini-hand-from-corrupted',
      task: 'Trying to hand off from corrupted predecessor',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'corrupted-predecessor'
    };

    await assert.rejects(
      bridge.start(geminiJob),
      SyntaxError
    );

    // Verify new job was NOT created
    const inspectNew = await bridge.inspect({requestId: 'gemini-hand-from-corrupted'});
    assert.equal(inspectNew, null);
  } finally {
    await rm(path.join(directory, 'corrupted-predecessor.json'), {force: true});
    await bridge.close();
  }
});

test('negative: predecessor record with mismatched room identity (parentId) throws directly and does not start job', async () => {
  const parentId = 'room-identity-test';
  const directory = path.join(testDir, '.runtime', 'luna-bridge', parentId);
  await mkdir(directory, {recursive: true});

  await writeFile(
    path.join(directory, 'mismatched-identity-predecessor.json'),
    JSON.stringify({
      requestId: 'mismatched-identity-predecessor',
      parentId: 'different-room-id',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      status: 'completed',
      settled: true,
      task: 'settled in wrong room',
      workspace,
      output: 'ok',
      outputFiles: []
    }),
    'utf8'
  );

  const bridge = await makeBridge({parentId});

  try {
    const geminiJob = {
      requestId: 'gemini-hand-from-mismatched',
      task: 'Trying to hand off from mismatched room record',
      model: 'gemini-3.8-flash',
      effort: 'high',
      handoffFrom: 'mismatched-identity-predecessor'
    };

    await assert.rejects(
      bridge.start(geminiJob),
      /Luna 工作紀錄身分不符。/
    );

    // Verify new job was NOT created
    const inspectNew = await bridge.inspect({requestId: 'gemini-hand-from-mismatched'});
    assert.equal(inspectNew, null);
  } finally {
    await rm(path.join(directory, 'mismatched-identity-predecessor.json'), {force: true});
    await bridge.close();
  }
});
