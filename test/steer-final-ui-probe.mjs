// Built UI: synthetic SSE transitions and persisted-history reload. No real model or business writes.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {launchProbeBrowser, probeEvidenceDir} from './ui-probe.mjs';
import {preview} from 'vite';
const out = probeEvidenceDir('steer-final-ui');
await mkdir(out, {recursive: true});
const server = await preview({preview: {host: '127.0.0.1', port: 0}});
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const first = 'FIRST_COMPLETED_REPLY',
  second = 'SECOND_COMPLETED_REPLY';
let browser;
const checks = [],
  errors = [];
const models = {
  claude: 'claude-opus-5-5',
  codex: 'gpt-6.1-sol',
  gemma: 'gemma-local/gemma-4-12b-it-qat',
  gemini: 'gemini-3.8-flash'
};
try {
  browser = await launchProbeBrowser();
  for (const [provider, model] of Object.entries(models))
    for (const width of [1440, 390]) {
      const page = await browser.newPage({viewport: {width, height: 900}}),
        posts = [];
      page.on('pageerror', e => errors.push(e.message));
      if (width === 390) await page.addInitScript(() => { window.KApp = {nativeQuoteMenu: () => true}; });
      await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
        value: {writeText: async text => { window.copiedReply = text; }}
      }));
      let current = {
        threadId: 'fake-steer-room',
        workspace: process.cwd(),
        provider,
        model,
        status: 'working',
        busy: true,
        accessMode: 'read-only',
        capabilities: {},
        questions: [],
        notices: [],
        tools: [],
        workers: [],
        artifacts: [],
        progress: {},
        messages: [
          {id: 'root', role: 'user', groupId: 'same', text: 'Fake work request'},
          {id: 'process', role: 'assistant', groupId: 'same', text: 'PROCESS_ONLY', partial: true}
        ]
      };
      await page.addInitScript(initial => {
        window.EventSource = class {
          constructor() {
            window.emitTestState = s => {
              sessionStorage.setItem('steerSnapshot', JSON.stringify(s));
              this.onopen?.();
              this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: s})});
            };
            setTimeout(
              () => window.emitTestState(JSON.parse(sessionStorage.getItem('steerSnapshot') ?? 'null') ?? initial),
              0
            );
          }
          close() {}
        };
      }, current);
      await page.route('**/api/**', route => {
        const req = route.request(),
          p = new URL(req.url()).pathname;
        if (req.method() === 'POST') posts.push(p);
        return route.fulfill({
          json:
            p === '/api/state'
              ? current
              : p === '/api/projects'
                ? {projects: []}
                : p === '/api/sessions'
                  ? {sessions: []}
                  : p === '/api/models'
                    ? {models: []}
                    : p.endsWith('/auth')
                      ? {available: false}
                      : {}
        });
      });
      const push = async () => page.evaluate(s => window.emitTestState(s), current);
      await page.goto(origin);
      await page.locator('.assistant-response-content').filter({hasText: 'PROCESS_ONLY'}).waitFor();
      current.messages.splice(1, 0, {
        id: 'untimed-history',
        role: 'assistant',
        groupId: 'same',
        text: 'UNTIMED_HISTORY_PROCESS'
      });
      current.messages.push(
        {id: 'steer1', role: 'user', groupId: 'same', source: 'steer', text: 'Fake first interruption'},
        {id: 'steer2', role: 'user', groupId: 'same', source: 'steer', text: 'Fake second interruption'},
        {id: 'first', role: 'assistant', groupId: 'same', text: first, completedAt: '2026-10-09T00:00:01Z'}
      );
      current.busy = false;
      current.status = 'completed';
      await push();
      await page.locator('.assistant-response-content').filter({hasText: first}).waitFor();
      current.messages.push({
        id: 'next-process',
        role: 'assistant',
        groupId: 'same',
        text: 'NEXT_IN_PROGRESS',
        partial: true,
        streaming: true
      });
      current.busy = true;
      current.status = 'working';
      await push();
      await page.locator('.assistant-response-content').filter({hasText: 'NEXT_IN_PROGRESS'}).waitFor();
      assert.equal(
        await page.locator('.assistant-response-content').filter({hasText: first}).count(),
        1,
        'a following partial must not hide a completed reply'
      );
      current.messages.at(-1).streaming = false;
      current.messages.at(-1).text = second;
      delete current.messages.at(-1).partial;
      current.messages.at(-1).completedAt = '2026-10-09T00:00:02Z';
      current.busy = false;
      current.status = 'completed';
      await push();
      await page.locator('.assistant-response-content').filter({hasText: second}).waitFor();
      const assertReplies = async (texts, conclusions, untimed) => {
        for (const text of texts) {
          const reply = page
            .locator('.assistant-message')
            .filter({has: page.locator('.assistant-response-content').filter({hasText: text})});
          assert.equal(await reply.count(), 1);
          assert.equal(
            await reply.locator('.assistant-response-content').getAttribute('data-aui-quote-selectable'),
            'true'
          );
          assert.equal(await reply.getByRole('button', {name: '複製', exact: true}).count(), 1);
          assert.equal(await reply.locator('time').count(), text === untimed ? 0 : 1);
          assert.equal(
            await reply.getByRole('button', {name: '分支', exact: true}).count(),
            conclusions.includes(text) ? 1 : 0,
            'only the selected group conclusion may branch'
          );
        }
      };
      await assertReplies([first, second], [second]);
      assert.equal(
        await page.locator('.assistant-response-content').filter({hasText: 'UNTIMED_HISTORY_PROCESS'}).count(),
        0,
        'historical commentary without an actual completion timestamp stays in details'
      );
      assert.equal(await page.locator('.turn-process').count(), 1);
      await page.locator('.turn-process summary').click();
      const details = page.locator('.turn-process-content');
      await details.waitFor();
      assert.match(await details.textContent(), /PROCESS_ONLY/);
      assert.match(await details.textContent(), /UNTIMED_HISTORY_PROCESS/);
      assert.doesNotMatch(
        await details.textContent(),
        /FIRST_COMPLETED_REPLY|SECOND_COMPLETED_REPLY/,
        'completed replies do not duplicate in collapsed process details'
      );
      await page.locator('.turn-process summary').click();
      await page.reload();
      await page.locator('.assistant-response-content').filter({hasText: second}).waitFor();
      await assertReplies([first, second], [second]);
      assert.equal(posts.length, 0, 'display and reload never replay work');
      checks.push({provider, width, midWork: true, bothCompleted: true, reload: true, posts: 0});
      await page.screenshot({path: path.join(out, `${provider}-${width}.png`)});

      if (provider !== 'gemini') {
        const groupId = 'multi-part',
          root = 'MULTI_PART_REQUEST',
          steer = 'MULTI_PART_STEER',
          replies = ['PUBLIC_TEXT_A', 'PUBLIC_TEXT_B', 'PUBLIC_TEXT_C', 'PUBLIC_TEXT_D'];
        const snapshot = index =>
          provider === 'claude' ? {nativeUuid: `native-${index}`} : {nativeSnapshot: true};
        const reply = (index, fields) => ({
          id: `reply-${index}`,
          groupId,
          role: 'assistant',
          text: replies[index],
          ...fields
        });
        const text = value => page.locator('.assistant-response-content').filter({hasText: value});
        const assertTranscript = async expected => {
          const items = await page.locator('.user-bubble, .assistant-response-content').allTextContents();
          assert.deepEqual(
            items.map(value => value.trim()).filter(value => [root, steer, ...replies].includes(value)),
            expected
          );
        };

        current.messages.push(
          {id: root, role: 'user', groupId, text: root},
          reply(0, {partial: true, ...snapshot(0)})
        );
        current.tools = [{id: 'tool-a', name: 'Read', status: 'completed', output: 'TOOL_RESULT_A', groupId}];
        current.busy = true;
        current.status = 'working';
        await push();
        await text(replies[0]).waitFor();

        current.messages.push(
          {id: steer, role: 'user', groupId, text: steer, source: 'steer', delivery: 'received'},
          reply(1, {partial: true, streaming: true})
        );
        await push();
        await text(replies[1]).waitFor();
        await assertTranscript([root, replies[0], steer, replies[1]]);
        for (const pending of replies.slice(0, 2))
          assert.equal(await text(pending).getAttribute('data-aui-quote-selectable'), 'false');

        current.messages[current.messages.length - 1] = reply(1, {partial: true, ...snapshot(1)});
        current.tools.push({id: 'tool-b', name: 'Read', status: 'completed', output: 'TOOL_RESULT_B', groupId});
        current.messages.push(reply(2, {partial: true, ...snapshot(2)}));
        const inProgress = [root, replies[0], steer, replies[1], replies[2]];
        await push();
        await text(replies[2]).waitFor();
        await assertTranscript(inProgress);

        current.messages.splice(
          -2,
          2,
          ...[1, 2, 3].map(index => reply(index, {...snapshot(index), completedAt: '2026-10-09T00:00:03Z'}))
        );
        const openingReply = current.messages.find(m => m.id === 'reply-0');
        delete openingReply.partial;
        openingReply.completedAt = '2026-10-09T00:00:03Z';
        current.busy = false;
        current.status = 'completed';
        const finished = [...inProgress, replies[3]];
        await push();
        await text(replies[3]).waitFor();
        await assertTranscript(finished);
        await assertReplies(replies, [replies[3]]);
        const process = page.locator('.assistant-message').filter({has: text(replies[3])}).locator('.turn-process');
        await process.locator('summary').click();
        const details = await process.locator('.turn-process-content').textContent();
        assert.match(details, /TOOL_RESULT_A/);
        assert.match(details, /TOOL_RESULT_B/);
        assert.doesNotMatch(details, /PUBLIC_TEXT_/);
        // Native Codex history may prove reply completion without a recorded wall-clock time.
        if (provider !== 'claude') {
          delete openingReply.completedAt;
          await push();
        }
        await page.reload();
        await text(replies[3]).waitFor();
        await assertTranscript(finished);
        await assertReplies(replies, [replies[3]], provider === 'claude' ? undefined : replies[0]);
        const earlier = text(replies[0]);
        const select = locator => locator.evaluate(el => {
          const range = document.createRange();
          range.selectNodeContents(el.querySelector('p') ?? el);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        });
        const nativeAdd = () => page.evaluate(() => window.dispatchEvent(new Event('k-add-selection')));
        if (width === 390) {
          await process.locator('summary').click();
          await select(process.locator('pre').filter({hasText: 'TOOL_RESULT_A'}));
          await nativeAdd();
          assert.equal(await page.evaluate(() => sessionStorage.getItem('k-response-annotations:fake-steer-room')), null);
          await process.locator('summary').click();
        }
        await page.locator('.assistant-message').filter({has: earlier}).getByRole('button', {name: '複製', exact: true}).click();
        assert.equal(await page.evaluate(() => window.copiedReply), replies[0]);
        await earlier.scrollIntoViewIfNeeded();
        await select(earlier);
        if (width === 390) await nativeAdd();
        else await page.getByRole('button', {name: '加入聊天', exact: true}).click();
        await page.locator('[data-response-comment-popover="true"]').waitFor();
        const [quote] = await page.evaluate(() => JSON.parse(sessionStorage.getItem('k-response-annotations:fake-steer-room')));
        assert.deepEqual([quote.sourceMessageId, quote.text], ['reply-0', replies[0]]);
        if (provider === 'claude') {
          // Old projections proved visibility with a UUID but timed only the last reply.
          for (const row of current.messages.filter(m => ['reply-0', 'reply-1', 'reply-2'].includes(m.id))) {
            row.partial = true;
            delete row.completedAt;
          }
          await push();
          await page.reload();
          await text(replies[3]).waitFor();
          await assertTranscript(finished);
          for (const value of replies.slice(0, 3)) {
            assert.equal(await text(value).getAttribute('data-aui-quote-selectable'), 'false');
            assert.equal(await page.locator('.assistant-message').filter({has: text(value)})
              .getByRole('button', {name: '複製', exact: true}).count(), 0);
          }
        }
        assert.equal(posts.length, 0);
        checks.push({provider, width, multiPart: true, toolDetails: true, reopen: true});
      } else {
        const groupId = 'first-prompt',
          nextGroup = 'steered-prompt',
          completedAt = '2026-10-09T00:00:03Z';
        current.messages = [
          {id: 'p1', role: 'user', groupId, text: 'First prompt'},
          {id: 'r1', role: 'assistant', groupId, text: 'FIRST_ACP_REPLY', completedAt},
          {id: 'wake', role: 'assistant', groupId, text: 'BACKGROUND_ACP_REPLY', streaming: true},
          {id: 'p2', role: 'user', groupId: nextGroup, source: 'steer', text: 'Steered prompt'},
          {id: 'r2', role: 'assistant', groupId: nextGroup, text: 'STEERED_ACP_REPLY', streaming: true}
        ];
        current.tools = [{id: 'acp-tool', name: 'run_command', status: 'completed', output: 'ACP_TOOL', groupId}];
        current.busy = true;
        current.status = 'working';
        await push();
        const wake = page.locator('.assistant-response-content').filter({hasText: 'BACKGROUND_ACP_REPLY'});
        assert.equal(await wake.getAttribute('data-aui-quote-selectable'), 'false');
        for (const row of current.messages.filter(m => m.streaming)) {
          delete row.streaming;
          row.completedAt = completedAt;
        }
        current.busy = false;
        current.status = 'completed';
        await push();
        await page.reload();
        await wake.waitFor();
        await assertReplies(
          ['FIRST_ACP_REPLY', 'BACKGROUND_ACP_REPLY', 'STEERED_ACP_REPLY'],
          ['BACKGROUND_ACP_REPLY', 'STEERED_ACP_REPLY']
        );
        const process = page.locator('.assistant-message').filter({has: wake}).locator('.turn-process');
        await process.locator('summary').click();
        const details = await process.locator('.turn-process-content').textContent();
        assert.match(details, /ACP_TOOL/);
        assert.doesNotMatch(details, /_ACP_REPLY/);
        assert.equal(posts.length, 0);
        checks.push({provider, width, separatePromptGroups: true, previousGroupWake: true, reopen: true});
      }
      await page.close();
    }
  // Optional local-only acceptance of the reported saved reply, without rewriting its projection.
  if (process.env.K_INCIDENT_PROJECTION) {
    const saved = JSON.parse(await readFile(process.env.K_INCIDENT_PROJECTION, 'utf8')),
      target = saved.messages.find(m => m.id === process.env.K_INCIDENT_MESSAGE_ID);
    assert(target);
    const same = saved.messages.filter(m => m.groupId === target.groupId);
    const page = await browser.newPage({viewport: {width: 1440, height: 900}}),
      current = {
        threadId: 'local-history-readback',
        provider: 'claude',
        model: 'claude-opus-5-5',
        workspace: process.cwd(),
        status: 'completed',
        busy: false,
        capabilities: {},
        questions: [],
        notices: [],
        workers: [],
        tools: [],
        artifacts: [],
        progress: {},
        messages: same.map((m, index) => ({
          ...m,
          text:
            m.id === target.id
              ? m.text
              : m.role === 'user'
                ? 'History user message'
                : `History assistant ${index}.`
        }))
      };
    await page.addInitScript(initial => {
      window.EventSource = class {
        constructor() {
          setTimeout(() => this.onmessage?.({data: JSON.stringify({type: 'snapshot', state: initial})}), 0);
        }
        close() {}
      };
    }, current);
    await page.route('**/api/**', route => {
      const p = new URL(route.request().url()).pathname;
      return route.fulfill({
        json:
          p === '/api/state'
            ? current
            : p === '/api/projects'
              ? {projects: []}
              : p === '/api/sessions'
                ? {sessions: []}
                : p === '/api/models'
                  ? {models: []}
                  : p.endsWith('/auth')
                    ? {available: false}
                    : {}
      });
    });
    await page.goto(origin);
    const markers = (process.env.K_HISTORY_MARKERS ?? 'PERF-20261008-001,PERF-20261008-002').split(',');
    const reply = page.locator('.assistant-response-content').filter({hasText: markers[0]});
    await reply.waitFor();
    const displayed = await reply.innerText();
    for (const marker of markers) assert.equal(displayed.includes(marker), true);
    for (const message of current.messages) {
      if (message.id === target.id || message.role !== 'assistant' || !message.nativeUuid || message.streaming) continue;
      assert.equal(await page.locator('.assistant-response-content').filter({hasText: message.text}).count(), 1);
    }
    checks.push({existingHistory: true, targetId: target.id, savedContentDisplayed: true, projectionModified: false});
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({checks, errors}, null, 2));
  console.log(JSON.stringify({passed: true, checks}));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
