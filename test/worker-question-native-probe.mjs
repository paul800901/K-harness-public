// 手動驗收，不納入 npm test。從工作樹執行下列其中一項。
// node test/worker-question-native-probe.mjs preflight <codex|claude>
// node test/worker-question-native-probe.mjs run <codex|claude>
// node test/worker-question-native-probe.mjs fixture
// preflight 只讀原生訂閱與目錄，run 每次只派一張真實訂閱工單。
// fixture 只測跨磁碟寫檔與 Git HTTP 機制，不聯絡模型。
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {inspectClaude, openClaudeHost} from '../src/claude-host.mjs';
import {openCodexHost} from '../src/codex-host.mjs';
import {selectedCoreExecutables} from '../src/core-updates.mjs';
import {isolatedLauncherPaths} from '../src/isolated-launcher.mjs';
import {createLunaBridge} from '../src/luna-bridge.mjs';
import {createLunaGateway} from '../src/luna-gateway.mjs';
import {listMainModels, reasoningEfforts} from '../src/main-models.mjs';
import {redactSecrets} from '../src/secret-redact.mjs';
import {createTemporaryScratch, scratchBase} from './scratch.mjs';

const [mode, provider, ...extra] = process.argv.slice(2);
const models = {codex: 'gpt-6.2-sol', claude: 'claude-opus-5-5'};
assert(
  (mode === 'fixture' && provider === undefined) ||
    (['preflight', 'run'].includes(mode) && Object.hasOwn(models, provider) && extra.length === 0),
  '用法：node test/worker-question-native-probe.mjs <preflight|run> <codex|claude>，或傳 fixture'
);
const model = models[provider],
  effort = 'high',
  questionMarker = 'WORKER_PROBE_NONCE',
  runFile = promisify(execFile);
const log = (stage, fields = {}) => console.log(JSON.stringify({stage, provider, model, effort, ...fields}));
const digest = value => createHash('sha256').update(value).digest('hex');

async function checkUnder(root, target, expectDirectory = false) {
  const actualRoot = await realpath(root),
    actual = await realpath(target),
    relative = path.relative(actualRoot, actual);
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  const metadata = await stat(actual);
  assert(expectDirectory ? metadata.isDirectory() : metadata.isFile());
  return actual;
}

async function configuration() {
  const workspace = path.join(scratchBase, 'workspace-a');
  await mkdir(workspace);
  if (mode === 'fixture') return {workspace};
  const repoRoot = path.dirname(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      windowsHide: true
    }).trim()
  );
  const candidate = isolatedLauncherPaths(
    process.env.K_CANDIDATE_ROOT || path.join(repoRoot, '.runtime', 'workbench')
  );
  const cores = await selectedCoreExecutables(candidate.trustedProviders, {
    codex: candidate.executable,
    claude: candidate.claudeCommand
  });
  const executable = await checkUnder(candidate.trustedProviders, cores[provider]);
  const agentHome = await checkUnder(candidate.root, candidate.agentHome, true);
  const homeKey = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const home = await checkUnder(agentHome, path.join(agentHome, provider === 'codex' ? '.codex' : '.claude'), true);
  const env = {...process.env};
  for (const key of Object.keys(env))
    if (
      /^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|DEEPSEEK_API_KEY|XAI_API_KEY|GROK_DEPLOYMENT_KEY|CODEX_HOME|CLAUDE_CONFIG_DIR)$/iu.test(
        key
      )
    )
      delete env[key];
  env[homeKey] = home;
  log('啟動路徑', {executable, workspace, scratchBase});
  return {executable, env, workspace};
}

function gitEnvironment(config) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(git_|(?:https?|all|no)_proxy$)/iu.test(key))
    ),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  };
}

// The Git CGI serves only the disposable bare repository over our loopback listener.
async function gitHttpBackend(req, res, target, root, env) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) return res.writeHead(413).end();
    chunks.push(chunk);
  }
  const response = await new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['http-backend'],
      {
        cwd: root,
        encoding: 'buffer',
        timeout: 15000,
        windowsHide: true,
        env: {
          ...env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: req.method,
          PATH_INFO: target.pathname,
          QUERY_STRING: target.search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(bytes),
          HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? ''
        }
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
    child.stdin.on('error', reject);
    child.stdin.end(Buffer.concat(chunks));
  });
  const separator = '\r\n\r\n';
  const split = response.indexOf(separator);
  assert(split !== -1, 'Git CGI 缺少 HTTP 標頭');
  let status = 200;
  for (const line of response.subarray(0, split).toString('ascii').split('\r\n')) {
    const colon = line.indexOf(':');
    assert(colon > 0, 'Git CGI 標頭格式錯誤');
    const key = line.slice(0, colon),
      value = line.slice(colon + 1).trim();
    if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
    else res.setHeader(key, value);
  }
  res.writeHead(status).end(response.subarray(split + separator.length));
}

async function preflight({executable, env, workspace}) {
  let host, catalog, version;
  try {
    if (provider === 'codex') {
      host = openCodexHost({executable, env, cwd: workspace});
      const init = await host.request('initialize', {
        clientInfo: {name: 'k_worker_question_probe', version: '0.1.0'},
        capabilities: {experimentalApi: true}
      });
      version = /\bcodex(?:-app-server)?[ /](\d+\.\d+\.\d+(?:-[\w.]+)?)\b/u.exec(init?.userAgent ?? '')?.[1];
      host.notify({method: 'initialized', params: {}});
      const account = await host.request('account/read', {refreshToken: false});
      assert.equal(account?.account?.type, 'chatgpt', 'Codex 未確認 ChatGPT 訂閱登入');
      catalog = await listMainModels(host);
    } else {
      const options = {env, cwd: workspace, commandSpec: {command: executable, argsPrefix: []}};
      const inspected = await inspectClaude(options);
      assert(inspected.available, inspected.reason);
      version = inspected.version;
      host = await openClaudeHost({
        ...options,
        worker: true,
        workerAccessMode: 'danger-full-access',
        accessMode: 'claude-bypassPermissions',
        model,
        effort
      });
      catalog = host.models;
    }
    const selected = catalog.find(row => row.model === model && row.available !== false);
    assert(selected && reasoningEfforts(selected).includes(effort), '指定模型與推理程度未出現在原生目錄');
    log('訂閱與模型已確認', {version});
  } finally {
    await host?.close();
  }
}

async function run({executable, env, workspace}) {
  const root = path.join(scratchBase, 'state'),
    externalWorkspace = createTemporaryScratch(),
    artifact = path.join(externalWorkspace, 'answer.txt'),
    bareRepo = path.join(externalWorkspace, 'remote.git'),
    gitConfig = path.join(scratchBase, 'empty-git.config'),
    gitEnv = gitEnvironment(gitConfig),
    ref = 'refs/heads/probe',
    requestId = `probe-${provider}-${randomUUID()}`,
    receipts = [];
  const [sourceDrive, externalDrive] = (await Promise.all([realpath(workspace), realpath(externalWorkspace)])).map(
    directory => path.parse(directory).root.toUpperCase()
  );
  log('跨磁碟測試槽', {workspace, externalWorkspace, sourceDrive, externalDrive});
  assert.deepEqual([sourceDrive, externalDrive], ['D:\\', 'C:\\']);
  await Promise.all([mkdir(root), writeFile(gitConfig, '', {flag: 'wx'})]);
  const git = (cwd, ...args) => runFile('git', args, {cwd, env: gitEnv, windowsHide: true, timeout: 15000});
  await Promise.all([
    git(workspace, 'init', '--quiet', '--initial-branch=probe'),
    git(externalWorkspace, 'init', '--quiet', '--bare', '--initial-branch=probe', 'remote.git')
  ]);
  await git(bareRepo, 'config', 'http.receivepack', 'true');
  const attempt = {posts: 0, gitWrites: 0};
  const nativeClaude = {};
  let nonce,
    nativeHost,
    bridge,
    gateway,
    primaryError,
    rpcId = 0;
  const outputServer = createServer(async (req, res) => {
    try {
      const target = new URL(req.url, 'http://127.0.0.1');
      const advertised = req.method === 'GET' && target.pathname === '/remote.git/info/refs';
      const gitRead = req.method === 'POST' && target.pathname === '/remote.git/git-upload-pack';
      const gitWrite = req.method === 'POST' && target.pathname === '/remote.git/git-receive-pack';
      if (gitWrite) {
        attempt.gitWrites++;
        if (!nonce) return res.writeHead(400).end();
      }
      if (advertised || gitRead || gitWrite) return await gitHttpBackend(req, res, target, externalWorkspace, gitEnv);
      if (req.method !== 'POST' || target.pathname !== '/receipt') return res.writeHead(404).end();
      attempt.posts++;
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 128) return res.writeHead(413).end();
      }
      if (nonce === undefined || body !== nonce) return res.writeHead(400).end();
      if (receipts.length) return res.writeHead(409).end();
      receipts.push(body);
      await writeFile(path.join(root, 'http-receipt.txt'), body, {flag: 'wx'});
      res.writeHead(201).end('receipt saved');
    } catch (error) {
      log('本機測試伺服器失敗', {message: redactSecrets(error.message)});
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  outputServer.requestTimeout = 15000;
  await new Promise((resolve, reject) => {
    outputServer.once('error', reject);
    outputServer.listen(0, '127.0.0.1', resolve);
  });
  try {
    const baseUrl = `http://127.0.0.1:${outputServer.address().port}`,
      receiptUrl = `${baseUrl}/receipt`,
      remoteUrl = `${baseUrl}/remote.git`;
    await writeFile(
      path.join(workspace, 'accept-answer.mjs'),
      `
      import assert from 'node:assert/strict';
      import {execFileSync} from 'node:child_process';
      import {realpath, writeFile} from 'node:fs/promises';
      import {fileURLToPath} from 'node:url';
      assert.equal(await realpath(process.cwd()), await realpath(fileURLToPath(new URL('.', import.meta.url))));
      const [value] = process.argv.slice(2);
      assert(/^[0-9a-f]{32}$/u.test(value));
      const env = (${gitEnvironment.toString()})(${JSON.stringify(gitConfig)});
      const git = (...args) => execFileSync('git', args, {env, stdio: 'pipe', timeout: 15000, windowsHide: true});
      await writeFile(${JSON.stringify(artifact)}, value, {flag: 'wx'});
      await writeFile('answer.txt', value, {flag: 'wx'});
      git('add', '--', 'answer.txt');
      git('-c', 'user.name=K Probe', '-c', 'user.email=probe@localhost', 'commit', '--quiet', '-m', 'Worker answer');
      git('push', ${JSON.stringify(remoteUrl)}, '${ref}:${ref}');
      const response = await fetch(${JSON.stringify(receiptUrl)}, {
        method: 'POST', body: value, signal: AbortSignal.timeout(10000)
      });
      assert.equal(response.status, 201);
    `,
      'utf8'
    );
    async function verifyArtifacts() {
      assert.equal(await readFile(artifact, 'utf8'), nonce);
      assert.equal(await readFile(path.join(root, 'http-receipt.txt'), 'utf8'), nonce);
      assert.deepEqual(receipts, [nonce]);
      assert.equal(attempt.posts, 1);
      assert.equal(attempt.gitWrites, 1);
      const localSha = (await git(workspace, 'rev-parse', ref)).stdout.trim();
      assert.match(localSha, /^[0-9a-f]{40,64}$/u);
      const advertised = (await git(workspace, 'ls-remote', '--exit-code', remoteUrl, ref)).stdout.trim();
      assert.equal(advertised, `${localSha}\t${ref}`);
      assert.equal((await git(bareRepo, 'show', `${ref}:answer.txt`)).stdout, nonce);
      return {
        sourceDrive,
        externalDrive,
        outsideFile: true,
        httpPosts: attempt.posts,
        gitHttpPushes: attempt.gitWrites,
        remoteSha: localSha,
        receiptSha256: digest(nonce)
      };
    }
    if (mode === 'fixture') {
      nonce = randomBytes(16).toString('hex');
      await runFile(process.execPath, ['accept-answer.mjs', nonce], {
        cwd: workspace,
        windowsHide: true,
        timeout: 45000
      });
      return await verifyArtifacts();
    }
    const geminiOnly = provider === 'claude',
      prefix = geminiOnly ? 'gemini' : 'luna';
    bridge = await createLunaBridge({
      root,
      workspace,
      parentId: `parent-${randomUUID()}`,
      accessMode: 'danger-full-access',
      geminiOnly,
      ...(provider === 'codex'
        ? {
            executable,
            hostFactory: options => {
              nativeHost = openCodexHost({
                ...options,
                env,
                cwd: workspace,
                onRequest: message => {
                  const {tool, namespace, threadId, turnId} = message.params ?? {};
                  log('原生請求', {requestId, method: message.method, tool, namespace, threadId, turnId});
                  return options.onRequest?.(message);
                }
              });
              return {
                ...nativeHost,
                async request(method, params, timeoutMs) {
                  try {
                    return await nativeHost.request(method, params, timeoutMs);
                  } catch (error) {
                    if (method === 'thread/read')
                      log('原生 thread/read 失敗', {
                        requestId,
                        threadId: params?.threadId,
                        message: redactSecrets(error.protocolMessage ?? error.message)
                      });
                    throw error;
                  }
                }
              };
            }
          }
        : {
            claudeOptions: {
              env,
              commandSpec: {command: executable, argsPrefix: []},
              hostFactory: async options => {
                nativeClaude.launchedSession = options.sessionId;
                nativeHost = await openClaudeHost({
                  ...options,
                  onMessage: message => {
                    if (!message.isReplay && message.type === 'assistant') {
                      const question = message.message?.content?.find(
                        block => block.type === 'tool_use' && block.name === 'AskUserQuestion'
                      );
                      if (question) {
                        nativeClaude.questionSession = message.session_id;
                        nativeClaude.toolUseId = question.id;
                        log('Claude 原生工具', {
                          requestId,
                          tool: question.name,
                          sessionId: message.session_id,
                          toolUseId: question.id
                        });
                      }
                    }
                    if (message.type === 'control_request' && message.request?.tool_name === 'AskUserQuestion') {
                      nativeClaude.questionRequestId = message.request_id;
                      log('Claude 原生提問控制請求', {requestId, nativeRequestId: message.request_id});
                    }
                    if (!message.isReplay && message.type === 'result') {
                      nativeClaude.resultSession = message.session_id;
                      log('Claude 原生結果', {requestId, sessionId: message.session_id, subtype: message.subtype});
                    }
                    options.onMessage?.(message);
                  }
                });
                return nativeHost;
              }
            }
          })
    });
    gateway = await createLunaGateway({bridge, geminiOnly});
    const {url, headers} = gateway.mcpConfig.mcpServers[`k_${prefix}`];
    async function rpc(method, params, signal = AbortSignal.timeout(30000)) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream'},
        body: JSON.stringify({jsonrpc: '2.0', id: ++rpcId, method, params}),
        signal
      });
      assert(response.ok, `MCP HTTP ${response.status}`);
      const text = await response.text();
      const sse = text
        .split(/\r?\n/u)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim());
      const payload = JSON.parse(sse.join('\n') || text);
      assert(!payload.error, `MCP ${method} 錯誤 ${payload.error?.code}`);
      return payload.result;
    }
    async function tool(name, args = {}, signal) {
      const result = await rpc('tools/call', {name: `${prefix}_${name}`, arguments: {requestId, ...args}}, signal);
      assert(
        !result.isError,
        `${prefix}_${name}：${redactSecrets(result.content?.[0]?.text, [headers.Authorization])}`
      );
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    }
    async function waitUntil(record, predicate) {
      const deadline = AbortSignal.timeout(4 * 60 * 1000);
      while (!predicate(record)) {
        assert(
          !record.settled && !['unresolved', 'failed', 'not-started'].includes(record.status),
          `工單提前停止，status=${record.status}。詳見本次暫存工單。`
        );
        record = await tool('wait', {timeoutMs: null}, deadline);
      }
      return record;
    }
    const catalog = await rpc('tools/list');
    assert(
      catalog.tools.some(tool => tool.name === `${prefix}_answer`),
      '候選尚未提供主代理 answer 工具，未派工'
    );
    const question = `請提供這次唯一的隨機值 ${questionMarker}。`;
    const task = [
      `這是一項隔離的 K 工人問答驗收。第一個動作就要${provider === 'codex' ? '呼叫 k_ask_parent，以 question 欄位送出' : '呼叫原生 AskUserQuestion，向上層取得自由文字回答，送出這一個問題'}「${question}」`,
      '隨機值尚未產生。等工具回傳答案再執行下一步。禁止自行猜測、預先執行、用普通文字代替工具提問或重跑有副作用的指令。',
      `取得回答中的 32 位小寫十六進位值後，確保終端機在工作區甲 ${workspace}，呼叫一次 node accept-answer.mjs <收到的值>，尖括號請以實際收到的值替代。`,
      `此隔離測試腳本會使用工作區甲的拋棄式 Git repo，將該值實際寫入另一顆磁碟的工作區乙 ${externalWorkspace}，透過 ${remoteUrl} 推送一次測試 commit，再送一次 loopback HTTP POST 收據。本人授權上述測試命令、工作區乙和本機 TCP 測試服務。完成後回報成功或具體錯誤。`
    ].join('\n');
    log('派一次工單', {requestId});
    const started = await tool('start', {model, effort, task});
    log('工單已接件', {requestId, status: started.status, threadId: started.threadId, turnId: started.turnId});
    const pending = await waitUntil(started, row => !!row.pendingQuestion);
    const questionId = pending.pendingQuestion.id;
    assert(typeof questionId === 'string' && questionId.length > 0, '缺少問題識別碼');
    assert(pending.pendingQuestion.text.includes(questionMarker), '問題內容缺少探針標記');
    const inspected = await tool('inspect');
    assert.deepEqual(inspected.pendingQuestion, pending.pendingQuestion);
    assert.equal(pending.settled, false);
    await assert.rejects(stat(artifact), {code: 'ENOENT'});
    assert.equal(attempt.posts, 0);
    assert.equal(attempt.gitWrites, 0);
    assert.equal((await git(bareRepo, 'for-each-ref', '--format=%(objectname)', ref)).stdout, '');
    log('待回答，暫無外部副作用', {requestId, questionId, threadId: pending.threadId, turnId: pending.turnId});

    nonce = randomBytes(16).toString('hex');
    await tool('answer', {questionId, answer: nonce});
    log('主代理已回覆', {requestId, questionId, answerTool: `${prefix}_answer`});
    const finished = await waitUntil(await tool('inspect'), row => row.settled || !!row.pendingQuestion);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.settled, true);
    assert.equal(finished.pendingQuestion, undefined);
    for (const key of ['requestId', 'threadId', 'provider', 'model', 'effort'])
      assert.equal(finished[key], pending[key], `工單原生身分變動：${key}`);
    if (provider === 'codex') {
      assert(pending.turnId, '缺少 Codex 原生 turn ID');
      assert.equal(finished.turnId, pending.turnId);
    } else {
      assert(nativeClaude.questionRequestId && nativeClaude.toolUseId, '缺少 Claude 原生提問證據');
      assert(pending.threadId, '缺少 Claude 原生 session ID');
      assert.equal(nativeClaude.launchedSession, pending.threadId);
      assert.equal(nativeClaude.questionSession, pending.threadId);
      assert.equal(nativeClaude.resultSession, pending.threadId);
    }
    return {
      requestId,
      questionId,
      answerTool: `${prefix}_answer`,
      threadId: finished.threadId,
      turnId: finished.turnId,
      ...(provider === 'claude' ? {nativeClaude} : {}),
      ...(await verifyArtifacts())
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (gateway) await gateway.close();
      else await bridge?.close();
    } catch (error) {
      log('探針清理失敗', {requestId, message: redactSecrets(error.message)});
      try {
        await nativeHost?.close();
      } catch (hostError) {
        log('測試自有核心關閉未確認', {requestId, message: redactSecrets(hostError.message)});
      }
      // The failed gateway close can retain this probe's local HTTP listener.
      setTimeout(() => process.exit(1), 1000).unref();
      if (!primaryError) throw error;
    } finally {
      outputServer.closeAllConnections();
      await new Promise(resolve => outputServer.close(resolve));
    }
  }
}

try {
  const options = await configuration();
  if (mode === 'preflight') await preflight(options);
  else log(mode === 'fixture' ? '隔離測試通過' : '通過', await run(options));
} catch (error) {
  process.exitCode = 1;
  log('失敗', {message: redactSecrets(error.message), scratchBase});
}
