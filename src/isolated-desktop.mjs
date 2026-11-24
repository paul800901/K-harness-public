import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {startDesktop} from './desktop-server.mjs';
import {createConversationController} from './conversation-controller.mjs';
import {createUnifiedController} from './unified-controller.mjs';
import {createDesktopController} from './desktop-controller.mjs';
import {createClaudeController} from './claude-controller.mjs';
import {createGeminiController} from './gemini-controller.mjs';
import {createGrokController} from './grok-controller.mjs';
import {createGrokLogin} from './grok-login.mjs';
import {createDeepSeekController} from './dsh-controller.mjs';
import {createDeepSeekLogin} from './dsh-login.mjs';
import {createLunaBridge} from './luna-bridge.mjs';
import {inspectClaude} from './claude-host.mjs';
import {openClaudeHost} from './claude-host.mjs';
import {openCodexHost} from './codex-host.mjs';
import {createClaudeLogin} from './claude-login.mjs';
import {createCodexLogin} from './codex-login.mjs';
import {createGeminiLogin} from './gemini-login.mjs';
import {addProject, listProjects, updateProject} from './projects.mjs';
import {pickWorkspaceDirectory} from './workspace-picker.mjs';
import {validateWorkspace} from './workspaces.mjs';
import {openDiscussionSession} from './discussion-native.mjs';
import {openDiscussionApiSession} from './discussion-api.mjs';
import {createDiscussionApiConnections, createDiscussionKeyVault} from './discussion-api-connections.mjs';
import {loadGemmaConnections} from './gemma-main.mjs';

/** Native desktop composition. Provider permissions remain provider-owned. */
export async function startIsolatedDesktop({
  root,
  workspace,
  port,
  executable,
  commandSpec,
  env,
  browsers,
  readColabBalance,
  coreUpdates,
  selfUpdate,
  allowLogin = false,
  workspaceLabel = '隔離測試工作區',
  startDesktopImpl = startDesktop,
  pickWorkspace = pickWorkspaceDirectory
} = {}) {
  if (!browsers?.session || !browsers?.request || !browsers?.close)
    throw Error('Execution and owner browser services are required.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error('A fixed, network-protected desktop port is required.');
  if (!path.isAbsolute(executable ?? '') || !path.isAbsolute(commandSpec?.command ?? ''))
    throw Error('Explicit trusted provider executables are required.');
  const stateRoot = await realpath(root);
  const gemmaConnections = await loadGemmaConnections(stateRoot, {readColabBalance});
  const colabBalance = gemmaConnections.find(connection => connection.colabAdmin)?.colabAdmin.balance;
  const validateSelectableWorkspace = async requested => {
    const resolved = await validateWorkspace(requested);
    if (resolved.toLowerCase() === stateRoot.toLowerCase())
      throw Error('Candidate state and agent workspace must be separate.');
    return resolved;
  };
  const selected = await validateSelectableWorkspace(workspace);
  const validateRegisteredWorkspace = async requested => {
    const resolved = await validateWorkspace(requested);
    if (resolved.toLowerCase() === stateRoot.toLowerCase()) throw Error('此隔離環境僅允許指定的工作區。');
    const registered = (await listProjects(stateRoot)).projects.some(
      project => project.path.toLowerCase() === resolved.toLowerCase()
    );
    if (!registered) throw Error('此隔離環境僅允許指定的工作區。');
    return resolved;
  };
  const hosts = {
    codex: options => openCodexHost({...options, env}),
    claude: options => openClaudeHost({...options, env})
  };
  const inspect = ({signal} = {}) => inspectClaude({commandSpec, cwd: selected, env, signal});
  const codexHost = (options, workspace = selected) => hosts.codex({...options, executable, cwd: workspace});
  const claudeHost = (options, workspace = selected) => hosts.claude({...options, commandSpec, cwd: workspace});
  const geminiLogin = createGeminiLogin({cwd: stateRoot, env});
  const grokLogin = createGrokLogin({cwd: stateRoot, env});
  // The room router hands selection to a provider controller restricted below,
  // so it only needs the move pre-check, made before it loads an unopened room.
  function restrictMove(controller) {
    if (controller.moveWorkspace) {
      const move = controller.moveWorkspace.bind(controller);
      controller.moveWorkspace = async data =>
        move({...data, workspace: await validateRegisteredWorkspace(data?.workspace)});
    }
    return controller;
  }
  function restrictWorkspace(controller) {
    const change = controller.selectWorkspace.bind(controller);
    controller.selectWorkspace = async data => {
      const canonical = await validateRegisteredWorkspace(data?.path);
      return change({path: canonical});
    };
    return restrictMove(controller);
  }
  let conversationController;
  const discussionApi = createDiscussionApiConnections({
    root: stateRoot,
    vault: createDiscussionKeyVault({root: stateRoot, env}),
    isBusy: () => conversationController?.discussionBusy
  });
  // DeepSeek has no subscription: its core uses the human's DeepSeek connection from the discussion API
  // settings (the one at api.deepseek.com). The key goes only into the DSH process environment.
  const deepseekKey = async () => {
    const row = (await discussionApi.list()).connections.find(connection => {
      try {
        return connection.keyConfigured && new URL(connection.baseUrl).hostname === 'api.deepseek.com';
      } catch {
        return false;
      }
    });
    if (!row) throw Error('尚未設定 DeepSeek API 金鑰：請在設定頁「API 連線」新增 DeepSeek（https://api.deepseek.com）連線。');
    return (await discussionApi.credentials(row.id)).key;
  };
  const deepseekLogin = createDeepSeekLogin({cwd: stateRoot, env, apiKey: deepseekKey});
  const workerComponents = options => ({
    componentEnabled: options.componentEnabled,
    browserSession: () => options.componentEnabled?.('browser') === false ? null : browsers.session()
  });
  const controllerFactory = options =>
    (conversationController = restrictMove(
      createConversationController({
        ...options,
        browserRequest: browsers.request,
        discussionApi,
        discussionSessionFactory: opts =>
          opts.selection.route === 'api'
            ? openDiscussionApiSession({...opts, connections: discussionApi})
            : openDiscussionSession({...opts, executable, commandSpec, env}),
        sessionFactory: settings =>
          restrictWorkspace(
            createUnifiedController({
              ...settings,
              gemmaConnections,
              inspect,
              geminiFactory: opts => {
                const browser = browsers.session();
                let current;
                const lunaHostFactory = hostOptions => {
                  const candidate = current?.state.workspace ?? selected;
                  return codexHost(
                    hostOptions,
                    candidate.toLowerCase() === stateRoot.toLowerCase() ? selected : candidate
                  );
                };
                current = createGeminiController({
                  ...opts,
                  env,
                  browserConfig: params => (options.componentEnabled?.('browser') === false ? null : browser.config(params)),
                  closeBrowser: browser.close,
                  bridgeFactory: params =>
                    createLunaBridge({
                      ...params,
                      componentEnabled: options.componentEnabled,
                      executable,
                      hostFactory: lunaHostFactory,
                      claudeOptions: {env, commandSpec},
                      apiOptions: {connections: discussionApi},
                      geminiOptions: {env, officialGeminiAccount: options.officialGeminiAccount, ...workerComponents(options)},
                      grokOptions: {env},
                      deepseekOptions: {env, apiKey: deepseekKey}
                    })
                });
                return current;
              },
              grokFactory: opts => {
                const browser = browsers.session();
                let current;
                const lunaHostFactory = hostOptions => {
                  const candidate = current?.state.workspace ?? selected;
                  return codexHost(
                    hostOptions,
                    candidate.toLowerCase() === stateRoot.toLowerCase() ? selected : candidate
                  );
                };
                current = createGrokController({
                  ...opts,
                  env,
                  loginFactory: () => grokLogin,
                  browserConfig: params => (options.componentEnabled?.('browser') === false ? null : browser.config(params)),
                  closeBrowser: browser.close,
                  bridgeFactory: params =>
                    createLunaBridge({
                      ...params,
                      componentEnabled: options.componentEnabled,
                      executable,
                      hostFactory: lunaHostFactory,
                      claudeOptions: {env, commandSpec},
                      apiOptions: {connections: discussionApi},
                      geminiOptions: {env, officialGeminiAccount: options.officialGeminiAccount, ...workerComponents(options)},
                      grokOptions: {env},
                      deepseekOptions: {env, apiKey: deepseekKey}
                    })
                });
                return current;
              },
              deepseekFactory: opts => {
                const browser = browsers.session();
                let current;
                const lunaHostFactory = hostOptions => {
                  const candidate = current?.state.workspace ?? selected;
                  return codexHost(
                    hostOptions,
                    candidate.toLowerCase() === stateRoot.toLowerCase() ? selected : candidate
                  );
                };
                current = createDeepSeekController({
                  ...opts,
                  env,
                  apiKey: deepseekKey,
                  loginFactory: () => deepseekLogin,
                  browserConfig: params => (options.componentEnabled?.('browser') === false ? null : browser.config(params)),
                  closeBrowser: browser.close,
                  bridgeFactory: params =>
                    createLunaBridge({
                      ...params,
                      componentEnabled: options.componentEnabled,
                      executable,
                      hostFactory: lunaHostFactory,
                      claudeOptions: {env, commandSpec},
                      apiOptions: {connections: discussionApi},
                      geminiOptions: {env, officialGeminiAccount: options.officialGeminiAccount, ...workerComponents(options)},
                      grokOptions: {env},
                      deepseekOptions: {env, apiKey: deepseekKey}
                    })
                });
                return current;
              },
              codexFactory: opts => {
                const browser = browsers.session();
                let current;
                const hostFactory = hostOptions => {
                  const candidate = current?.state.workspace ?? selected;
                  if (opts.selfHosted) {
                    const nativeEnv = {...(env ?? process.env), CODEX_HOME: opts.selfHosted.home};
                    // No inherited API credentials are needed for the owner's loopback endpoint.
                    delete nativeEnv.OPENAI_API_KEY;
                    delete nativeEnv.CODEX_API_KEY;
                    return openCodexHost({
                      ...hostOptions,
                      executable,
                      cwd: candidate.toLowerCase() === stateRoot.toLowerCase() ? selected : candidate,
                      env: nativeEnv,
                      configOverrides: [...(hostOptions.configOverrides ?? []), ...opts.selfHosted.configOverrides()]
                    });
                  }
                  return codexHost(
                    hostOptions,
                    candidate.toLowerCase() === stateRoot.toLowerCase() ? selected : candidate
                  );
                };
                current = createDesktopController({
                  ...opts,
                  hostFactory,
                  bridgeFactory: params =>
                    createLunaBridge({
                      ...params,
                      componentEnabled: options.componentEnabled,
                      ...(opts.selfHosted
                        ? {hostFactory: hostOptions => codexHost(hostOptions, current.state.workspace)}
                        : {}),
                      claudeOptions: {env, commandSpec},
                      apiOptions: {connections: discussionApi},
                      geminiOptions: {env, officialGeminiAccount: options.officialGeminiAccount, ...workerComponents(options)},
                      grokOptions: {env},
                      deepseekOptions: {env, apiKey: deepseekKey}
                    }),
                  browserConfig: params => (options.componentEnabled?.('browser') === false ? null : browser.config(params)),
                  closeBrowser: browser.close,
                  browserRequest: browsers.request
                });
                return current;
              },
              claudeFactory: opts => {
                const browser = browsers.session();
                let current;
                const selectedHostWorkspace = () => {
                  const candidate = current?.state.workspace ?? selected;
                  return candidate.toLowerCase() === stateRoot.toLowerCase() ? selected : candidate;
                };
                const hostFactory = hostOptions => claudeHost(hostOptions, selectedHostWorkspace());
                const lunaHostFactory = hostOptions => codexHost(hostOptions, selectedHostWorkspace());
                current = createClaudeController({
                  ...opts,
                  commandSpec,
                  hostFactory,
                  browserConfig: params => (options.componentEnabled?.('browser') === false ? null : browser.config(params)),
                  closeBrowser: browser.close,
                  bridgeFactory: params =>
                    createLunaBridge({
                      ...params,
                      componentEnabled: options.componentEnabled,
                      executable,
                      hostFactory: lunaHostFactory,
                      claudeOptions: {env, commandSpec},
                      apiOptions: {connections: discussionApi},
                      geminiOptions: {env, officialGeminiAccount: options.officialGeminiAccount, ...workerComponents(options)},
                      grokOptions: {env},
                      deepseekOptions: {env, apiKey: deepseekKey}
                    })
                });
                return current;
              }
            })
          )
      })
    ));
  const loginGate = login =>
    allowLogin
      ? login
      : {
          ...login,
          async start() {
            throw Error('本候選僅供假資料驗證；尚未允許真實帳號登入。');
          },
          async logout() {
            throw Error('本候選僅供假資料驗證；尚未允許真實帳號登出。');
          }
        };
  let app;
  try {
    // The state vault is an implementation directory, never an agent workspace.
    // Keep the existing UI's project list usable without changing global UI.
    const knownWorkspace = (await listProjects(stateRoot)).projects.some(
      project => project.path.toLowerCase() === selected.toLowerCase()
    );
    await addProject(stateRoot, selected);
    await updateProject(stateRoot, {path: stateRoot, archived: true});
    if (!knownWorkspace) await updateProject(stateRoot, {path: selected, name: workspaceLabel, archived: false});
    app = await startDesktopImpl({
      root: stateRoot,
      executable,
      port,
      controllerFactory,
      browserRequest: browsers.request,
      colabBalance,
      coreUpdates,
      selfUpdate,
      discussionApi,
      claudeLoginFactory: () =>
        loginGate(createClaudeLogin({cwd: selected, env, inspect, resolve: async () => commandSpec})),
      codexLoginFactory: () => loginGate(createCodexLogin({cwd: selected, executable, hostFactory: codexHost})),
      geminiLoginFactory: () => loginGate(geminiLogin),
      grokLoginFactory: () => loginGate(grokLogin),
      pickWorkspace,
      validateProjectWorkspace: validateSelectableWorkspace
    });
    await app.controller.selectWorkspace({path: selected});
  } catch (error) {
    await app?.close().catch(() => {});
    await Promise.all(gemmaConnections.map(connection => connection.close?.()));
    await browsers.close().catch(() => {});
    throw error;
  }
  return {
    ...app,
    async close() {
      await app.close();
      await Promise.all(gemmaConnections.map(connection => connection.close?.()));
      await browsers.close();
    }
  };
}
