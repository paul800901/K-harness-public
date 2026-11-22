// Explicit local acceptance probe: existing Codex executable + new empty homes.
// Models, OAuth helper, browser opener and Colab are fake. No external requests.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';
import {loadGemmaConnections} from '../src/gemma-main.mjs';
import {openCodexHost} from '../src/codex-host.mjs';
import {createDesktopController} from '../src/desktop-controller.mjs';
import {createLunaGateway} from '../src/luna-gateway.mjs';
import {openGemmaResponses} from '../src/gemma-responses.mjs';
import {createColabAuth} from '../src/colab-auth.mjs';
import {createColabAdapter} from '../src/colab-adapter.mjs';

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable))
  throw new Error('Pass the existing native Codex executable explicitly');
const rows = [],
  source = {
    repository: 'pub/repo',
    revision: 'c'.repeat(40),
    quantization: 'BF16',
    files: [{path: 'm.gguf', bytes: 1, sha256: 'd'.repeat(64)}]
  };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return {promise, resolve};
};
async function bound(p) {
  let timer;
  return Promise.race([
    p,
    new Promise(
      (_, reject) =>
        (timer = setTimeout(() => reject(new Error('native mock window expired; inspect before any retry')), 30000))
    )
  ]).finally(() => clearTimeout(timer));
}
const response = output =>
  Response.json({id: 'resp_' + Math.random().toString(16).slice(2), status: 'completed', output});
const message = () => [
  {
    id: 'msg_done',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{type: 'output_text', text: 'Mock completed.', annotations: []}]
  }
];
const functionCall = (request, suffix, args = {}) => {
  const tool = request.tools.find(t => t.name?.endsWith(suffix));
  assert(tool, suffix);
  return [
    {
      type: 'function_call',
      id: 'fc_' + suffix,
      call_id: 'call_' + Math.random().toString(16).slice(2),
      name: tool.name,
      arguments: JSON.stringify(args),
      status: 'completed'
    }
  ];
};

async function fixture(mode) {
  const root = await mkdtemp(path.join(scratchBase, 'colab-native-final-'));
  await mkdir(path.join(root, '.runtime'));
  const approvals = [],
    controllers = [],
    hosts = [],
    gates = [],
    trace = [],
    calls = {A: 0, B: 0, main: 0};
  let creates = 0,
    present = false;
  const held = deferred(),
    release = deferred();
  let fakeSignedIn = false,
    loginPages = 0,
    readonlyCalls = 0;
  const auth = createColabAuth({
    root,
    account: 'o@example.com',
    openUrl: async url => {
      loginPages++;
      const q = new URL(url).searchParams;
      await fetch(`${q.get('redirect_uri')}?state=${q.get('state')}&code=FAKE_CODE`);
    },
    execImpl: async (exe, args) => {
      const op = args[args.indexOf('-Operation') + 1];
      if (op === 'exchange') {
        fakeSignedIn = true;
        return {stdout: JSON.stringify({accessToken: 'ya29.FAKE_ONLY', expiresIn: 3600, email: 'o@example.com'})};
      }
      if (op === 'status')
        return {
          stdout: JSON.stringify({
            client: true,
            clientId: 'fake.apps.googleusercontent.com',
            signedIn: fakeSignedIn,
            email: fakeSignedIn ? 'o@example.com' : null
          })
        };
      return {
        stdout: JSON.stringify(
          fakeSignedIn
            ? {accessToken: 'ya29.FAKE_ONLY', expiresIn: 3600, email: 'o@example.com'}
            : {error: 'signed_out'}
        )
      };
    }
  });
  const adminClient = createColabAdapter({
    auth,
    mcp: {
      async call(name) {
        readonlyCalls++;
        assert(['get_subscription', 'list_runtime_specs'].includes(name));
        return name === 'get_subscription' ? {tier: 'SUBSCRIPTION_TIER_PRO'} : {runtimeSpecs: []};
      }
    }
  });
  const fakeModel = async body => {
    const request = JSON.parse(body),
      who = JSON.stringify(request.input).includes('ROOM_A') ? 'A' : 'B';
    calls[who]++;
    trace.push(`model:${who}:${calls[who]}`);
    if (mode === 'unknown') throw new Error('FAKE inference was accepted; result lost');
    if (who === 'A' && calls.A === 1) return response(functionCall(request, 'colab_status'));
    if (who === 'B') return response(functionCall(request, 'colab_stop'));
    return response(message());
  };
  const client =
    mode === 'admin'
      ? adminClient
      : {
          authState: () => 'signed-in',
          account: async () => 'o@example.com',
          ready: async () => {},
          async createRuntime({runtimeId}) {
            creates++;
            present = true;
            trace.push('create');
            return {name: `runtimes/${runtimeId}`};
          },
          async getRuntime(name) {
            trace.push('get');
            return present ? {name} : null;
          },
          async deleteRuntime() {
            trace.push('delete');
            present = false;
          },
          serve: async () => ({respond: fakeModel}),
          endpoint: async () => ({respond: fakeModel}),
          describe: async () => ({auth: {state: 'signed-in'}})
        };
  await writeFile(path.join(root, '.runtime/colab-oauth-client.json'), '{}');
  await writeFile(
    path.join(root, '.runtime/gemma-main.json'),
    JSON.stringify({
      colab: {account: 'o@example.com', allowRuntimeCreation: mode !== 'admin'},
      selfHosted: [
        {id: 'test', label: 'Mock', location: 'colab', model: 'm', source},
        {id: 'other', label: 'Other', location: 'colab', model: 'other', source}
      ]
    })
  );
  const connections = await loadGemmaConnections(root, {
      colabClientFactory: () => client,
      fetchImpl: async () => {
        throw new Error('no external network');
      }
    }),
    connection = connections.find(c => c.slot === 'selfhost-test');
  await connection.prepare();
  let mainBridge;
  if (mode === 'admin')
    mainBridge = await openGemmaResponses('http://unused.invalid', {
      acquireModel: async () => ({
        model: 'm',
        upstream: {
          respond: async body => {
            const request = JSON.parse(body);
            calls.main++;
            return response(
              calls.main === 1
                ? functionCall(request, 'colab_login')
                : calls.main === 2
                  ? functionCall(request, 'colab_status', {live: true})
                  : message()
            );
          }
        },
        finish: async () => {}
      })
    });
  async function room(label, conn = connection) {
    const home = path.join(root, 'home-' + label);
    await mkdir(path.join(home, 'AppData', 'Local'), {recursive: true});
    await writeFile(path.join(home, 'config.toml'), '[windows]\nsandbox="unelevated"\n');
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
      if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, {
      CODEX_HOME: home,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      OTEL_SDK_DISABLED: 'true'
    });
    const terminals = [],
      waiters = [],
      stops = [];
    let c;
    c = createDesktopController({
      root,
      executable,
      selfHosted: mode === 'admin' ? undefined : conn,
      colabAdmin: connection.colabAdmin,
      workerCatalog: async () => ({models: []}),
      onChange: state => {
        for (const q of state.questions) {
          if (q.kind === 'approval' && q.server === 'k_gemini' && !approvals.some(x => x.id === q.id)) {
            approvals.push({id: q.id, server: q.server});
            queueMicrotask(() => c.answer({id: q.id, accept: true}));
          }
        }
      },
      hostFactory: opts => {
        let overrides = conn.configOverrides();
        if (mode === 'admin')
          overrides = overrides.map(x =>
            x.startsWith('model_providers.k_gemma=')
              ? `model_providers.k_gemma={name="mock main",base_url=${JSON.stringify(mainBridge.baseUrl)},wire_api="responses",requires_openai_auth=false,supports_websockets=false,http_headers={Authorization=${JSON.stringify(mainBridge.headers.Authorization)}}}`
              : x
          );
        const h = openCodexHost({
          ...opts,
          executable,
          env,
          configOverrides: [...(opts.configOverrides ?? []), ...overrides],
          onEvent: e => {
            opts.onEvent?.(e);
            if (e.method === 'turn/completed') {
              terminals.push(e.params);
              waiters.shift()?.(e.params);
            }
          }
        });
        hosts.push(h);
        // Normal main path has a simulated subscription account, never a real login.
        const request = h.request.bind(h);
        h.request = (method, ...args) => {
          if (method === 'turn/start') {
            assert.equal(args[0].approvalPolicy, 'on-request');
            assert.deepEqual(args[0].sandboxPolicy, {type: 'readOnly'});
          }
          return mode === 'admin' && method === 'account/read'
            ? Promise.resolve({account: {type: 'chatgpt'}})
            : request(method, ...args);
        };
        return h;
      },
      gatewayFactory: async opts => {
        if (mode === 'shared' && label === 'A') {
          const status = opts.colab.status;
          opts.colab.status = async (...args) => {
            held.resolve();
            await release.promise;
            return status(...args);
          };
        }
        if (opts.colab?.stop) {
          const stop = opts.colab.stop;
          opts.colab.stop = async (...args) => {
            const result = await stop(...args);
            stops.push(result);
            return result;
          };
        }
        const g = await createLunaGateway({
          ...opts,
          bridge: {
            start() {
              throw new Error('no workers');
            },
            wait() {},
            inspect() {},
            cancel() {},
            list: async () => [],
            workerPolicy: {model: 'auto'}
          }
        });
        gates.push(g);
        return g;
      }
    });
    controllers.push(c);
    await c.open({model: mode === 'admin' ? 'm' : conn.model, accessMode: 'read-only'});
    return {
      c,
      stops,
      async send(text) {
        const n = terminals.length;
        const done = new Promise(resolve => waiters.push(resolve));
        await c.send({text});
        return bound(terminals.length > n ? Promise.resolve(terminals[n]) : done);
      }
    };
  }
  return {
    room,
    connection,
    connections,
    held,
    release,
    trace,
    calls,
    approvals,
    get creates() {
      return creates;
    },
    get loginPages() {
      return loginPages;
    },
    get readonlyCalls() {
      return readonlyCalls;
    },
    async close() {
      release.resolve();
      for (const c of controllers) await c.close();
      for (const h of hosts) await h.close();
      for (const g of gates) await g.close();
      await mainBridge?.close();
      await Promise.all(connections.map(c => c.close()));
    }
  };
}
for (const mode of ['unknown', 'shared', 'admin']) {
  const f = await fixture(mode);
  try {
    if (mode === 'unknown') {
      const a = await f.room('A');
      const end = await a.send('ROOM_A work');
      assert.equal(end.turn.status, 'failed');
      assert.equal(f.calls.A, 1);
      assert.equal(f.creates, 1);
      rows.push({mode, passed: true, inferences: f.calls.A, creates: f.creates});
    }
    if (mode === 'shared') {
      const a = await f.room('A');
      const aDone = a.send('ROOM_A status then finish');
      await bound(f.held.promise);
      const alt = await f.room(
        'ALT',
        f.connections.find(c => c.slot === 'selfhost-other')
      );
      assert.equal((await alt.send('ROOM_OTHER replace model')).turn.status, 'failed');
      assert.equal(f.creates, 1);
      const b = await f.room('B');
      await b.send('ROOM_B end');
      assert.equal(b.stops[0].readback, 'not-attempted');
      assert.equal(a.c.state.busy, true);
      f.release.resolve();
      await aDone;
      await b.send('ROOM_B end after A completed');
      assert.equal(b.stops[1].readback, 'gone');
      assert.equal(f.creates, 1);
      assert(f.approvals.length >= 2);
      rows.push({
        mode,
        passed: true,
        creates: f.creates,
        stopWhileOtherBusy: b.stops[0].readback,
        stopAfterOtherDone: b.stops[1].readback,
        approvals: f.approvals.length
      });
    }
    if (mode === 'admin') {
      const main = await f.room('main');
      assert.equal((await main.send('Read Colab status and sign in using the mock only')).turn.status, 'completed');
      assert.equal(f.loginPages, 1);
      assert(f.readonlyCalls >= 2);
      assert.equal(f.creates, 0);
      assert.equal(f.calls.A + f.calls.B, 0);
      assert(f.approvals.length >= 1, 'login keeps the native one-shot tool approval');
      rows.push({
        mode,
        passed: true,
        fakeConsentPages: f.loginPages,
        readonlyCalls: f.readonlyCalls,
        colabCreates: f.creates,
        colabInferences: 0,
        approvals: f.approvals.length,
        approvalPolicy: 'on-request',
        sandboxPolicy: 'readOnly'
      });
    }
  } finally {
    await f.close();
  }
}
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      scope: 'real native Codex with production DesktopController, fresh homes, local fake services only',
      rows
    },
    null,
    2
  )
);
