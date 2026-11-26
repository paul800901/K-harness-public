import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {openAcpAgent} from '../src/acp-agent.mjs';
import {openGrokAgent} from '../src/grok-acp.mjs';

test('ACP replies preserve handler numeric error codes and default ordinary errors to internal error', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 777,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  });
  const replies = [];
  child.stdin.on('data', chunk => {
    const message = JSON.parse(String(chunk));
    if (message.method === 'initialize')
      child.stdout.write(JSON.stringify({id: message.id, result: {protocolVersion: 1}}) + '\n');
    else replies.push(message);
  });
  child.stdin.on('finish', () => child.emit('exit', 0));
  const codes = [
    [-32601, -32601], [-32602, -32602], [-32000, -32000], [42, 42],
    [-2147483648, -2147483648], [2147483647, 2147483647],
    [undefined, -32603], ['ENOENT', -32603], ['-32601', -32603], [NaN, -32603], [Infinity, -32603],
    [-32000.5, -32603], [-2147483649, -32603], [2147483648, -32603]
  ];
  const agent = await openAcpAgent({
    executable: 'fixture',
    args: [],
    label: 'ACP',
    spawnImpl: () => child,
    onRequest: async message => {
      throw Object.assign(Error('fixture failure'), {code: codes[message.id][0]});
    }
  });
  try {
    codes.forEach((_, id) => child.stdout.write(JSON.stringify({id, method: 'client/request'}) + '\n'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(
      replies.map(r => r.error),
      codes.map(([, expected]) => ({code: expected, message: 'fixture failure'}))
    );
  } finally {
    await agent.close({graceMs: 0});
  }
});

test('the shared Grok launch used by rooms, workers and catalog queries disables the leader', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 778,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  });
  child.stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk));
    child.stdout.write(JSON.stringify({id: request.id, result: {protocolVersion: 1}}) + '\n');
  });
  child.stdin.on('finish', () => child.emit('exit', 0));
  let launched;
  const agent = await openGrokAgent({
    executable: 'grok.exe',
    spawnImpl: (exe, args) => {
      launched = [exe, args];
      return child;
    }
  });
  try {
    assert.deepEqual(launched, ['grok.exe', ['agent', '--no-leader', 'stdio']]);
  } finally {
    await agent.close({graceMs: 0});
  }
});
