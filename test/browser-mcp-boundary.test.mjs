import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {restrictedBrowserTransport} from '../src/browser-mcp-stdio.mjs';

test('browser_reload is exposed, reloads the selected same tab, and retains cancellation fail-closed behavior', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'k-browser-reload-tool-'));
  const sent = [],
    reloads = [];
  let failClosed = 0,
    ended = 0,
    started = 0,
    blockReload = false,
    resolveReload;
  const liveSession = {
    beginAiCall() {
      started++;
      return true;
    },
    endAiCall() {
      ended++;
    },
    async reloadPageAtIndex(index) {
      reloads.push(index);
      if (blockReload) await new Promise(resolve => (resolveReload = resolve));
    },
    async failClosed() {
      failClosed++;
    }
  };
  const raw = {
    async start() {},
    async send(message) {
      sent.push(message);
    },
    async close() {}
  };
  const transport = restrictedBrowserTransport(raw, root, liveSession);
  await transport.start();
  let currentIndex = 1;
  transport.onmessage = message => {
    if (
      message.method === 'tools/call' &&
      message.params?.name === 'browser_tabs' &&
      message.params?.arguments?.action === 'list'
    )
      void transport.send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            {
              type: 'text',
              text: `- ${currentIndex}: (current) [selected](https://fixture.invalid/${currentIndex === 1 ? 'two' : 'one'})`
            }
          ]
        }
      });
  };
  await raw.onmessage({jsonrpc: '2.0', id: 1, method: 'tools/list'});
  await transport.send({
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [
        {
          name: 'browser_tabs',
          description: 'Manage tabs',
          inputSchema: {type: 'object', properties: {action: {type: 'string'}}}
        },
        {
          name: 'browser_take_screenshot',
          description: 'Capture a page',
          inputSchema: {
            type: 'object',
            properties: {filename: {type: 'string', description: 'File name resolved against workspace root.'}}
          }
        }
      ]
    }
  });
  const listed = sent.at(-1).result.tools;
  assert(listed.some(tool => tool.name === 'browser_reload'));
  const screenshot = listed.find(tool => tool.name === 'browser_take_screenshot');
  assert.match(screenshot.description, /conversation and selected browser mode output directory/);
  assert.match(screenshot.description, /Without a filename, the image is returned inline/);
  assert.match(screenshot.description, /in formal K this is the same conversation/);
  assert.match(
    screenshot.inputSchema.properties.filename.description,
    /conversation and selected browser mode output directory/
  );
  assert.match(screenshot.inputSchema.properties.filename.description, /returned inline/);
  assert.match(screenshot.inputSchema.properties.filename.description, /In formal K this is the same conversation/);
  await raw.onmessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {name: 'browser_tabs', arguments: {action: 'select', index: 1}}
  });
  await transport.send({jsonrpc: '2.0', id: 2, result: {content: [{type: 'text', text: 'selected'}]}});
  await raw.onmessage({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'browser_reload', arguments: {}}});
  assert.deepEqual(
    reloads,
    [1],
    'reload follows upstream current-tab readback rather than inferred tab-management intent'
  );
  assert.equal(sent.at(-1).id, 3);
  assert.match(sent.at(-1).result.content[0].text, /same tab remains selected/);
  assert.equal(started, 2);
  assert.equal(ended, 2);

  blockReload = true;
  const pending = raw.onmessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {name: 'browser_reload', arguments: {}}
  });
  while (!resolveReload) await new Promise(resolve => setTimeout(resolve, 0));
  await raw.onmessage({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 4}});
  await new Promise(resolve => setImmediate(resolve));
  resolveReload();
  await pending;
  assert.equal(failClosed, 1);
  assert.deepEqual(reloads, [1, 1], 'cancellation does not replay the selected page reload');
  assert(!sent.some(message => message.id === 4), 'cancelled reload is not reported as a successful replay');
});

test('browser_close ends the live session so the next browser_session opens a fresh one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'k-browser-close-'));
  const sent = [],
    forwarded = [];
  let failClosed = 0,
    ended = 0,
    holdClose = null;
  const liveSession = {
    beginAiCall: () => true,
    endAiCall() {
      ended++;
    },
    async failClosed() {
      failClosed++;
      if (holdClose) await holdClose;
    }
  };
  const raw = {
    async start() {},
    async send(message) {
      sent.push(message);
    },
    async close() {}
  };
  const transport = restrictedBrowserTransport(raw, root, liveSession);
  await transport.start();
  transport.onmessage = message => forwarded.push(message);
  await raw.onmessage({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'browser_close', arguments: {}}});
  assert.equal(forwarded.length, 1);
  assert.equal(failClosed, 0, 'nothing closes before the upstream close finished');
  await transport.send({jsonrpc: '2.0', id: 7, result: {content: [{type: 'text', text: 'No open tabs.'}]}});
  assert.equal(failClosed, 1);
  assert.equal(ended, 1);
  assert.match(sent.at(-1).result.content.at(-1).text, /Call browser_session again/);

  // A failed close leaves the session as it was.
  await raw.onmessage({jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 'browser_close', arguments: {}}});
  await transport.send({jsonrpc: '2.0', id: 8, result: {isError: true, content: [{type: 'text', text: 'x'}]}});
  assert.equal(failClosed, 1);
  // So does a JSON-RPC error, which keeps its own shape.
  await raw.onmessage({jsonrpc: '2.0', id: 9, method: 'tools/call', params: {name: 'browser_close', arguments: 5}});
  await transport.send({jsonrpc: '2.0', id: 9, error: {code: -32602, message: 'bad arguments'}});
  assert.equal(failClosed, 1);
  assert.deepEqual(sent.at(-1), {jsonrpc: '2.0', id: 9, error: {code: -32602, message: 'bad arguments'}});

  // A cancellation arriving while the session closes gets no success reply.
  let release;
  holdClose = new Promise(resolve => (release = resolve));
  await raw.onmessage({jsonrpc: '2.0', id: 10, method: 'tools/call', params: {name: 'browser_close', arguments: {}}});
  const replying = transport.send({jsonrpc: '2.0', id: 10, result: {content: [{type: 'text', text: 'No open tabs.'}]}});
  await new Promise(resolve => setImmediate(resolve));
  await raw.onmessage({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 10}});
  release();
  await replying;
  await new Promise(resolve => setImmediate(resolve));
  assert(!sent.some(message => message.id === 10), 'a cancelled close is not reported as successful');
});

test('an upload outside the browser directory names the directory to copy into', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'k-browser-upload-'));
  const sent = [];
  const raw = {
    async start() {},
    async send(message) {
      sent.push(message);
    },
    async close() {}
  };
  const transport = restrictedBrowserTransport(raw, root, null);
  await transport.start();
  transport.onmessage = () => assert.fail('a denied upload is not forwarded');
  await raw.onmessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {name: 'browser_file_upload', arguments: {paths: [os.tmpdir()]}}
  });
  assert.equal(sent.at(-1).result.isError, true);
  assert.ok(sent.at(-1).result.content[0].text.includes(`Copy the file into ${await realpath(root)} first.`));
});
