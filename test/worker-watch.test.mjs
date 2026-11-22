import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkerWatch,
  discardStaleWorkerQuestions,
  workerNeedsAttention,
  workerNoticeCurrent,
  workerNoticeKey,
  workerNoticeText,
  workerObservation
} from '../src/worker-watch.mjs';

test('worker observations separate local ownership, quiet duration and terminal evidence without a fake heartbeat', () => {
  const row = {status: 'running', settled: false, startedAt: 0, lastActivityAt: 100};
  const first = workerObservation(row, {owned: true, now: 200});
  assert.equal(first.execution, 'owned-pending');
  assert.equal(first.activity, 'recent');
  assert.equal(first.quietForMs, 100);
  const quiet = workerObservation(row, {owned: true, now: 300100});
  assert.equal(quiet.activity, 'quiet');
  assert.equal(row.lastActivityAt, 100);
  assert.match(quiet.guidance, /不等於卡死/);
  const unowned = workerObservation({...row, executionUnowned: true}, {now: 300100});
  assert.equal(unowned.execution, 'unconfirmed');
  assert.equal(workerObservation({...row, waitingForApproval: 1}, {owned: true, now: 300100}).activity, 'approval');
  assert.equal(workerObservation({...row, status: 'completed', settled: true}, {now: 300100}).activity, 'terminal');
  assert.equal(workerObservation({status: 'unresolved'}, {now: 1}).quietForMs, null);
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
test('unsettled failure and unresolved records use status-notice identity, not completion identity', () => {
  for (const status of ['failed', 'unresolved']) {
    const queued = {requestId: 'job', status, settled: false};
    assert.equal(workerNeedsAttention(queued), true);
    assert.equal(workerNoticeKey(queued), 'unconfirmed:job');
    assert.match(workerNoticeText([queued]), /不是完成通知/);
    assert.equal(workerNoticeKey({...queued, status: 'completed', settled: true}), 'job');
    assert.equal(workerNoticeText([{...queued, status: 'completed', settled: true}]).includes('狀態通知'), false);
  }
});
test('stale unknown notices are suppressed when the current record settled, became unowned, or disappeared', () => {
  const queued = {requestId: 'job', status: 'unresolved', settled: false};
  assert.equal(workerNoticeCurrent(queued, {...queued}), true);
  assert.equal(workerNoticeCurrent(queued, {...queued, status: 'completed', settled: true}), false);
  assert.equal(workerNoticeCurrent(queued, {...queued, executionUnowned: true}), false);
  assert.equal(workerNoticeCurrent(queued, undefined), false);
});
test('question notices identify the current request and question independently of quiet status and completion', () => {
  const running = {requestId: 'job', parentId: 'parent', status: 'running', settled: false};
  const question = {...running, pendingQuestion: {id: 'first-id', text: 'Which input should I use?'}};
  const following = {...running, pendingQuestion: {id: 'second-id', text: question.pendingQuestion.text}};
  const quiet = {...running, inspection: {noticeId: 'quiet', lastActivityAt: 10}};
  const completed = {...running, settled: true, status: 'completed'};

  assert.equal(workerNeedsAttention(question), true);
  assert.match(workerNoticeKey(question), /^question-[a-f0-9]{64}$/u);
  assert.notEqual(workerNoticeKey(question), workerNoticeKey(following));
  assert.notEqual(workerNoticeKey(question), workerNoticeKey(completed));
  assert.equal(workerNoticeCurrent(question, {...question, lastActivityAt: 42}), true);
  for (const live of [
    running,
    following,
    completed,
    {...question, parentId: 'different-parent'},
    {...question, requestId: 'different-job'},
    {...question, cancelRequested: true},
    {...question, executionUnowned: true},
    undefined
  ])
    assert.equal(workerNoticeCurrent(question, live), false);
  assert.equal(workerNoticeCurrent(quiet, {...quiet, pendingQuestion: question.pendingQuestion}), false);
  const text = workerNoticeText([question], 'gemini_answer');
  assert.match(text, /gemini_answer/);
  assert.match(text, /"questionId":"first-id"/);
  assert.doesNotMatch(text, /狀態通知|完成通知/);

  const batch = [question, completed],
    results = [{requestId: 'job', pendingQuestion: question.pendingQuestion}, {requestId: 'job', settled: true}],
    notifications = Object.fromEntries(batch.map(row => [workerNoticeKey(row), 'delivery-attempted']));
  discardStaleWorkerQuestions(batch, results, [completed], notifications);
  assert.deepEqual(batch, [completed]);
  assert.deepEqual(results, [{requestId: 'job', settled: true}]);
  assert.deepEqual(notifications, {job: 'delivery-attempted'});
});
function setup(t) {
  t.mock.timers.enable({apis: ['setTimeout']});
  let now = 0,
    reads = 0;
  const notices = [],
    records = new Map();
  const watch = createWorkerWatch({
    now: () => now,
    quietMs: 300000,
    inspect: async ({requestId}) => {
      reads++;
      return records.get(requestId);
    },
    publish: (id, inspection) => {
      records.get(id).inspection = inspection;
      notices.push(structuredClone(records.get(id)));
    }
  });
  const add = (id = 'job') => {
    const record = {
      requestId: id,
      parentId: 'parent',
      provider: 'gemini',
      status: 'running',
      settled: false,
      startedAt: 0
    };
    records.set(id, record);
    watch.observe(record);
    return record;
  };
  const tick = async ms => {
    now += ms;
    t.mock.timers.tick(ms);
    await flush();
  };
  t.after(() => watch.clear());
  return {watch, records, notices, add, tick, reads: () => reads};
}
test('runtime checks only after genuine silence and keeps one quiet notice across long commands', async t => {
  const f = setup(t),
    record = f.add();
  await f.tick(299999);
  assert.equal(f.reads(), 0);
  await f.tick(1);
  assert.equal(f.reads(), 1);
  const first = f.notices[0];
  await f.tick(300000);
  assert.equal(f.reads(), 2);
  assert.equal(f.notices.at(-1).inspection.noticeId, first.inspection.noticeId);
  record.lastReadAt = 600000;
  f.watch.observe(record);
  await f.tick(300000);
  assert.equal(f.reads(), 3, 'status/readback clocks are not progress');
  record.lastActivityAt = 900000;
  f.watch.observe(record);
  assert.equal(record.inspection, undefined);
  assert.equal(workerNoticeCurrent(first, record), false);
  await f.tick(300000);
  assert.equal(
    f.notices.at(-1).inspection.noticeId,
    first.inspection.noticeId,
    'new quiet command must not repeatedly wake the LLM'
  );
  assert.equal(
    workerNoticeCurrent(first, record),
    false,
    'old episode queue is invalid even with the same durable notice id'
  );
  record.status = 'unresolved';
  await f.tick(300000);
  assert.notEqual(record.inspection.noticeId, first.inspection.noticeId);
  record.status = 'running';
  record.toolErrors = ['tool failed'];
  await f.tick(300000);
  assert.notEqual(record.inspection.noticeId, first.inspection.noticeId, 'new diagnostic warrants attention');
  record.settled = true;
  f.watch.observe(record);
  assert.equal(workerNoticeCurrent(first, record), false);
  assert.equal(workerNoticeKey(record), 'job');
  const reads = f.reads();
  await f.tick(86400000);
  assert.equal(f.reads(), reads);
});
test('worker clocks are independent and approvals suspend observation', async t => {
  const f = setup(t),
    one = f.add('one');
  await f.tick(100000);
  const two = f.add('two');
  two.lastActivityAt = 100000;
  f.watch.observe(two);
  one.waitingForApproval = true;
  f.watch.observe(one);
  await f.tick(300000);
  assert.deepEqual(
    f.notices.map(x => x.requestId),
    ['two']
  );
  delete one.waitingForApproval;
  one.lastActivityAt = 400000;
  f.watch.observe(one);
  await f.tick(299999);
  assert.equal(
    f.notices.some(x => x.requestId === 'one'),
    false
  );
  await f.tick(1);
  assert.equal(
    f.notices.some(x => x.requestId === 'one'),
    true
  );
});
test('a live question suspends quiet observation until the worker receives an answer', async t => {
  const f = setup(t),
    record = f.add();
  record.pendingQuestion = {id: 'question-id', text: 'Which input?'};
  f.watch.observe(record);
  await f.tick(600000);
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.notices, []);
  delete record.pendingQuestion;
  record.lastActivityAt = 600000;
  f.watch.observe(record);
  await f.tick(300000);
  assert.equal(f.reads(), 1);
  assert.equal(f.notices.length, 1);
});
test('late inspection after forget or clear never publishes, and failed reads stay unknown', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let resolve;
  const notices = [];
  let record = {requestId: 'job', parentId: 'p', provider: 'codex', startedAt: 0, status: 'running'};
  const watch = createWorkerWatch({
    now: () => 0,
    quietMs: 10,
    inspect: () => new Promise(r => (resolve = r)),
    publish: (_, inspection) => notices.push(inspection)
  });
  t.after(() => watch.clear());
  watch.observe(record);
  t.mock.timers.tick(10);
  watch.forget('job');
  resolve(record);
  await flush();
  assert.equal(notices.length, 0);
  watch.observe(record);
  t.mock.timers.tick(10);
  watch.clear();
  resolve(record);
  await flush();
  assert.equal(notices.length, 0);
  const failed = createWorkerWatch({
    now: () => 0,
    quietMs: 10,
    inspect: async () => {
      throw Error('offline');
    },
    publish: (_, inspection) => notices.push(inspection)
  });
  t.after(() => failed.clear());
  failed.observe(record);
  t.mock.timers.tick(10);
  await flush();
  assert.equal(notices.at(-1).statusObserved, 'unresolved');
  assert.match(notices.at(-1).reason, /未停止或重送/);
});

test('quiet notice names an unfinished tool as evidence without changing notice identity', async t => {
  const f = setup(t),
    plain = f.add('plain'),
    waiting = f.add('waiting');
  waiting.activity = {startedAt: 0, lastEventAt: 0, phase: 'active', phaseSince: 0, lastToolName: 'read_file', pendingTool: {name: 'run_command', since: 0}};
  waiting.lastActivityAt = 0;
  f.watch.observe(waiting);
  await f.tick(300000);
  const byId = id => f.notices.find(notice => notice.requestId === id).inspection;
  assert.equal(byId('plain').pendingTool, undefined);
  assert.doesNotMatch(byId('plain').reason, /最後收到的工具/);
  assert.deepEqual(byId('waiting').pendingTool, {name: 'run_command', since: 0});
  assert.match(byId('waiting').reason, /run_command 已約 5 分鐘未結束/);
  assert.match(byId('waiting').reason, /常駐服務/);
  const firstId = byId('plain').noticeId;
  plain.activity = {...waiting.activity};

  await f.tick(300000);
  assert.equal(f.notices.filter(n => n.requestId === 'plain').at(-1).inspection.noticeId, firstId, 'tool evidence alone does not re-wake the parent');
  assert.match(workerNoticeText([waiting]), /pendingTool/);
});
