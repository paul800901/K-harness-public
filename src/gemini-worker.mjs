import {createWorkActivity, geminiWorkActivity} from './work-activity.mjs';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {mkdir, rm, stat} from 'node:fs/promises';
import {googleOpsMcp} from './google-ops-mcp.mjs';
import {geminiProjectMcp} from './gemini-project-mcp.mjs';
import {atomicWrite} from './atomic-write.mjs';
import {writeGeminiCommonRule} from './common-memory.mjs';
import {WORKER_SERVICE_RULE, workerTaskScope} from './worker-policy.mjs';
import {askWorkerParent, workerQuestionFrom, WORKER_QUESTION_GUIDANCE} from './worker-question.mjs';
import {
  isAntigravityModel,
  antigravityNativeModel,
  antigravityModelNames,
  antigravityModelId,
  antigravitySupportsMedia
} from '../shared/antigravity-models.mjs';

const exec = promisify(execFile);

export function geminiExecutable(env = process.env, executable) {
  executable ??= env.K_GEMINI_EXECUTABLE;
  const local = Object.entries(env).find(([key]) => key.toUpperCase() === 'LOCALAPPDATA')?.[1];
  return executable ? path.resolve(executable) : local ? path.resolve(local, 'agy', 'bin', 'agy.exe') : null;
}

export function geminiProfile(workspace, accessMode) {
  if (!path.isAbsolute(workspace ?? '') || !['read-only', 'workspace-write', 'danger-full-access'].includes(accessMode))
    throw Error('Gemini 工作區或權限無效。');
  let canonical = path.resolve(workspace).replaceAll('\\', '/').replace(/\/$/u, '');
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  return createHash('sha256').update(`${accessMode}\n${canonical}`).digest('hex').slice(0, 16);
}
export function geminiSettings(
  workspace,
  accessMode,
  tempDirs = [],
  browserServer = null,
  googleOpsServer = null,
  projectMcp = {allow: []},
  {writable = [], gateway = false, desktop = null} = {}
) {
  geminiProfile(workspace, accessMode);
  const root = path.resolve(workspace);
  // agy 1.0.6 live, workspace outside %TEMP%: the default mode asks (headless: denies)
  // for every write, even in the cwd, but always lets %TEMP% through. A native-path
  // allow opens only the workspace; drive-stripped allow does not match; strict ignores
  // allow entirely. Deny wins over allow, so %TEMP% is denied unless it holds the workspace.
  const inside = (dir, child) => {
    const r = path.relative(path.resolve(dir), child);
    return !r || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  const temps = [...new Set(tempDirs.filter(Boolean).map(dir => path.resolve(dir)))].filter(dir => !inside(dir, root));
  // agy 1.5.3 rejects `unsandboxed(...)` rules as invalid and ignores them, so none are
  // written; read-only closes commands with `command(*)`. workspace-write commands are only
  // allowed together with --sandbox (geminiAccessArgs); a request to leave the sandbox is
  // still auto-denied in headless mode.
  const commands = geminiCommandsAllowed(accessMode, googleOpsServer);
  const settings = {
    ...(accessMode === 'danger-full-access' ? {toolPermission: 'strict'} : {}),
    permissions: {
      // User-authorized web reading; native command/write/interactive permissions remain unchanged.
      allow: [
        'read_url(*)',
        ...(accessMode === 'workspace-write'
          ? [
              `write_file(${root})`,
              ...writable.map(file => `write_file(${path.resolve(file)})`),
              ...(commands ? ['command(*)'] : [])
            ]
          : [])
      ],
      deny:
        accessMode === 'read-only'
          ? ['write_file(*)', 'command(*)', 'mcp(*)']
          : accessMode === 'danger-full-access'
            ? ['mcp(*)']
            : ['mcp(*)', ...temps.map(dir => `write_file(${dir})`), ...(commands ? [] : ['command(*)'])],
      ask: []
    }
  };
  if (browserServer || googleOpsServer || projectMcp.allow.length || gateway || desktop) {
    // Native deny takes precedence over allow. Only the configured K owner
    // endpoint is preapproved; other MCP tools retain native Ask/denial.
    settings.permissions.deny = settings.permissions.deny.filter(rule => rule !== 'mcp(*)');
    settings.permissions.allow.push(...projectMcp.allow);
    if (browserServer) settings.permissions.allow.push('mcp(k_browser/*)');
    if (gateway) settings.permissions.allow.push('mcp(k_luna/*)');
    if (desktop) settings.permissions.allow.push('mcp(k_desktop/*)');
    if (googleOpsServer) {
      settings.permissions.allow.push('mcp(k_google_ops/*)');
      if (accessMode !== 'danger-full-access') {
        const ops = googleOpsServer.args[2];
        // agy compares lexical paths: a selected junction also needs its alias.
        const roots = new Set([ops, path.join(root, path.relative(realpathSync.native(root), ops))]);
        for (const base of roots)
          for (const folder of ['google_ops_worker', '.venv'])
            settings.permissions.deny.push(`write_file(${path.join(base, folder)})`);
      }
    }
  }
  return settings;
}
// The sandbox lets commands write anywhere in the workspace, past the write_file denies that
// protect the Google connector's code and venv; such workspaces keep commands closed.
export const geminiCommandsAllowed = (accessMode, googleOpsServer = null) =>
  accessMode === 'danger-full-access' || (accessMode === 'workspace-write' && !googleOpsServer);
// The only place that maps K access to agy flags: workspace-write commands always run sandboxed.
export const geminiAccessArgs = accessMode =>
  accessMode === 'danger-full-access'
    ? ['--dangerously-skip-permissions']
    : accessMode === 'workspace-write'
      ? ['--sandbox']
      : [];
export const geminiMcpConfig = (
  server,
  googleOpsServer = null,
  projectMcp = {mcpServers: {}},
  gateway = null,
  desktop = null
) => ({
  mcpServers: {
    ...projectMcp.mcpServers,
    ...(server ? {k_browser: {serverUrl: server.url, headers: server.http_headers ?? server.headers}} : {}),
    ...(googleOpsServer ? {k_google_ops: googleOpsServer} : {}),
    ...(gateway ? {k_luna: {serverUrl: gateway.url, headers: gateway.headers}} : {}),
    ...(desktop ? {k_desktop: desktop} : {})
  }
});
export function geminiEnvironment(source, home, {isolateTemp = false} = {}) {
  // A whitelist also excludes all provider keys, K homes, MCP, hooks and Node
  // injection variables. Never read/copy credentials or inherit provider config.
  const env = {};
  // Local PS 5.1/7 probes without PATHEXT lost .exe streams and exit status,
  // while file side effects appeared after the command had returned.
  for (const [key, value] of Object.entries(source))
    if (/^(SystemRoot|WINDIR|PATH|PATHEXT)$/iu.test(key) || (!isolateTemp && /^(TEMP|TMP)$/iu.test(key)))
      env[key] = value;
  // The native background updater can open a Windows terminal even in print mode.
  // agy's Windows terminal sandbox keeps its AppContainer data under LOCALAPPDATA;
  // without it every sandboxed command fails to start. It stays inside this HOME.
  const isolatedTemp = isolateTemp ? path.join(home, 'tmp') : null;
  return {
    ...env,
    ...(isolatedTemp ? {TEMP: isolatedTemp, TMP: isolatedTemp} : {}),
    USERPROFILE: home,
    HOME: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true'
  };
}

const ACP_EDIT_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'edit_file',
  'delete_file'
]);
const ACP_EXECUTE_TOOLS = new Set(['run_command', 'command']);
const ACP_READ_TOOLS = new Set([
  'read_file',
  'view_file',
  'list_dir',
  'find_by_name',
  'grep_search',
  'read_url',
  'read_url_content',
  'search_web'
]);
const ACP_PATH_KEYS = ['Path', 'TargetFile', 'AbsolutePath', 'FilePath', 'file_path', 'path', 'target_file', 'targetFile'];

function isPathWithin(dir, target, {allowEqual = false, platform = process.platform} = {}) {
  if (typeof dir !== 'string' || !dir.trim() || typeof target !== 'string' || !target.trim()) return false;
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  if (!pathImpl.isAbsolute(dir)) return false;
  // Reject Windows drive-relative paths like "C:foo.txt" because their resolution depends on process CWD state.
  if (platform === 'win32' && /^[a-z]:(?![\\/])/iu.test(target.trim())) return false;
  const normalize = value => {
    const resolved = pathImpl.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const base = normalize(dir);
  const resolved = normalize(pathImpl.resolve(dir, target));
  const relative = pathImpl.relative(base, resolved);
  if (!relative) return allowEqual;
  return relative !== '..' && !relative.startsWith(`..${pathImpl.sep}`) && !pathImpl.isAbsolute(relative);
}

export function isAcpEditTool(toolCall = {}) {
  const toolName = String(toolCall?.name ?? '').trim();
  if (toolName.startsWith('mcp_') || toolName === 'call_mcp_tool') return false;
  const kind = String(toolCall?.kind ?? '')
    .trim()
    .toLowerCase();
  return kind === 'edit' || ACP_EDIT_TOOLS.has(toolName);
}

export function acpEditTargets(toolCall = {}) {
  const targets = [],
    seen = new Set();
  const add = value => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    targets.push(trimmed);
  };
  for (const bag of [toolCall.rawInput, toolCall.args])
    if (bag && typeof bag === 'object') for (const key of ACP_PATH_KEYS) add(bag[key]);
  for (const item of toolCall.locations ?? []) add(item?.path);
  for (const item of toolCall.content ?? []) if (item?.type === 'diff') add(item.path);
  return targets;
}

/**
 * Pure host-side decision for `agy acp` `session/request_permission` calls.
 * Rejects writes outside workspace/writable or inside isolated TEMP/TMP or protected paths,
 * enforces read-only and Google-connector command restrictions, and checks exact MCP tool rules.
 */
export function geminiAcpPermissionDecision({
  accessMode,
  workspace,
  writable = [],
  allowedMcpRules = [],
  knownMcpServers = [],
  deniedWrites = [],
  resolvedPaths = null,
  commandsAllowed = true,
  temps = [],
  toolCall = {},
  platform = process.platform
} = {}) {
  const toolName = String(toolCall?.name ?? '').trim();
  const kind = String(toolCall?.kind ?? '')
    .trim()
    .toLowerCase();
  const input = toolCall?.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {};
  const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {};
  const isMcp = toolName.startsWith('mcp_') || toolName === 'call_mcp_tool';
  const category = isMcp
    ? 'mcp'
    : kind === 'edit' || ACP_EDIT_TOOLS.has(toolName)
      ? 'edit'
      : kind === 'execute' || ACP_EXECUTE_TOOLS.has(toolName)
        ? 'execute'
        : ACP_READ_TOOLS.has(toolName) || kind === 'read' || kind === 'search'
          ? 'read'
          : 'other';

  const commandTarget = String(input.CommandLine ?? args.CommandLine ?? input.command ?? args.command ?? toolCall?.title ?? '');
  const mcpServer = toolName === 'call_mcp_tool' ? String(input.ServerName ?? args.ServerName ?? '').trim() : '';
  const mcpTool = toolName === 'call_mcp_tool' ? String(input.ToolName ?? args.ToolName ?? '').trim() : '';
  const editTargets = category === 'edit' ? acpEditTargets(toolCall) : [];
  const defaultTarget =
    category === 'edit'
      ? (editTargets[0] ?? '')
      : category === 'execute'
        ? commandTarget
        : category === 'mcp'
          ? mcpServer && mcpTool
            ? `${mcpServer}/${mcpTool}`
            : toolName
          : String(toolCall?.locations?.[0]?.path ?? toolCall?.title ?? toolName);

  const decide = (allow, reason, target = defaultTarget, message = null) => ({
    allow,
    reason,
    category,
    tool: toolName || category,
    target: String(target ?? '').slice(0, 1000),
    message: allow ? null : message
  });
  const short = value => String(value ?? '').slice(0, 240);
  const modeLabel = accessMode === 'read-only' ? '唯讀模式' : '工作區寫入模式';

  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(accessMode))
    return decide(false, 'invalid-access-mode', defaultTarget, '未知的 Gemini 權限模式，已拒絕工具執行。');
  if (accessMode === 'danger-full-access') return decide(true, 'danger-full-access');

  if (category === 'mcp') {
    const knownServers = new Set(
      (Array.isArray(knownMcpServers) ? knownMcpServers : []).filter(s => typeof s === 'string' && s)
    );
    const serverWildcards = new Set();
    const exactTools = new Map();
    for (const rule of Array.isArray(allowedMcpRules) ? allowedMcpRules : []) {
      if (typeof rule !== 'string') continue;
      const match = /^mcp\(([\w-]+)\/([^()]+)\)$/u.exec(rule.trim());
      if (!match) continue;
      const [, server, tool] = match;
      if (tool === '*') serverWildcards.add(server);
      else {
        let set = exactTools.get(server);
        if (!set) {
          set = new Set();
          exactTools.set(server, set);
        }
        set.add(tool);
      }
    }
    const isRuleAllowed = (server, tool) =>
      knownServers.has(server) && (serverWildcards.has(server) || Boolean(exactTools.get(server)?.has(tool)));
    let resolvedServer = mcpServer;
    let resolvedTool = mcpTool;
    let ok = false;
    if (toolName === 'call_mcp_tool') {
      ok = Boolean(mcpServer && mcpTool && isRuleAllowed(mcpServer, mcpTool));
    } else {
      const matches = [];
      for (const server of knownServers) {
        const prefix = `mcp_${server}_`;
        if (toolName.startsWith(prefix) && toolName.length > prefix.length)
          matches.push({server, tool: toolName.slice(prefix.length)});
      }
      if (matches.length === 1) {
        resolvedServer = matches[0].server;
        resolvedTool = matches[0].tool;
        ok = isRuleAllowed(resolvedServer, resolvedTool);
      }
    }
    const mcpTarget = resolvedServer && resolvedTool ? `${resolvedServer}/${resolvedTool}` : defaultTarget;
    return ok
      ? decide(true, 'allowed-mcp-server', mcpTarget)
      : decide(
          false,
          'unallowed-mcp',
          mcpTarget,
          `${modeLabel}擋下了未授權工具${short(mcpTarget) ? `（${short(mcpTarget)}）` : ''}，這回合已停止。`
        );
  }

  if (category === 'read') return decide(true, 'read-only-tool');

  if (category === 'edit') {
    if (accessMode === 'read-only')
      return decide(
        false,
        'read-only-denied',
        defaultTarget,
        `唯讀模式擋下了寫檔${short(defaultTarget) ? `（${short(defaultTarget)}）` : ''}，這回合已停止。`
      );
    if (!editTargets.length)
      return decide(false, 'missing-edit-target', '', '工作區寫入模式擋下了無法確認位置的寫檔，這回合已停止。');
    const pathImpl = platform === 'win32' ? path.win32 : path.posix;
    const validWorkspace = typeof workspace === 'string' && pathImpl.isAbsolute(workspace);
    const activeTemps = (Array.isArray(temps) ? temps : [])
      .filter(dir => typeof dir === 'string' && pathImpl.isAbsolute(dir))
      .filter(dir => !validWorkspace || !isPathWithin(dir, workspace, {allowEqual: true, platform}));
    const validDeniedWrites = (Array.isArray(deniedWrites) ? deniedWrites : []).filter(
      dir => typeof dir === 'string' && pathImpl.isAbsolute(dir)
    );
    const validWritable = (Array.isArray(writable) ? writable : []).filter(
      item => typeof item === 'string' && pathImpl.isAbsolute(item)
    );
    for (const candidate of editTargets) {
      const denyOutside = () =>
        decide(
          false,
          'outside-workspace-edit',
          candidate,
          `工作區寫入模式擋下了工作區外的寫檔（${short(candidate)}），這回合已停止。`
        );
      let resolvedTarget;
      if (resolvedPaths && Object.hasOwn(resolvedPaths, candidate)) {
        if (typeof resolvedPaths[candidate] !== 'string' || !pathImpl.isAbsolute(resolvedPaths[candidate]))
          return denyOutside();
        resolvedTarget = pathImpl.resolve(resolvedPaths[candidate]);
      } else {
        if (platform === 'win32' && /^[a-z]:(?![\\/])/iu.test(candidate)) return denyOutside();
        if (!validWorkspace && !pathImpl.isAbsolute(candidate)) return denyOutside();
        resolvedTarget = validWorkspace ? pathImpl.resolve(workspace, candidate) : pathImpl.resolve(candidate);
      }
      if (activeTemps.some(dir => isPathWithin(dir, resolvedTarget, {allowEqual: true, platform})))
        return decide(
          false,
          'temp-edit-denied',
          candidate,
          `工作區寫入模式擋下了暫存目錄寫檔（${short(candidate)}），這回合已停止。`
        );
      if (validDeniedWrites.some(dir => isPathWithin(dir, resolvedTarget, {allowEqual: true, platform})))
        return decide(
          false,
          'protected-edit-denied',
          candidate,
          `工作區寫入模式擋下了受保護目錄的寫檔（${short(candidate)}），這回合已停止。`
        );
      const inside =
        (validWorkspace && isPathWithin(workspace, resolvedTarget, {allowEqual: false, platform})) ||
        validWritable.some(item => isPathWithin(item, resolvedTarget, {allowEqual: true, platform}));
      if (!inside) return denyOutside();
    }
    return decide(true, 'inside-workspace-edit');
  }

  if (category === 'execute') {
    if (accessMode === 'read-only')
      return decide(
        false,
        'read-only-denied',
        defaultTarget,
        `唯讀模式擋下了執行命令${short(defaultTarget) ? `（${short(defaultTarget)}）` : ''}，這回合已停止。`
      );
    if (!commandsAllowed)
      return decide(
        false,
        'commands-disabled',
        defaultTarget,
        '目前工作區設定未開放執行命令，已擋下命令執行，這回合已停止。'
      );
    if (input.BypassSandbox === true || args.BypassSandbox === true)
      return decide(
        false,
        'bypass-sandbox-denied',
        defaultTarget,
        '工作區寫入模式不允許繞過沙盒執行命令，這回合已停止。'
      );
    return decide(true, 'sandbox-command-allowed');
  }

  return decide(
    false,
    'unknown-tool-denied',
    defaultTarget,
    `${modeLabel}擋下了未授權操作${short(defaultTarget) ? `（${short(defaultTarget)}）` : ''}，這回合已停止。`
  );
}

/**
 * Pure helper for `agy acp` `session/prompt` content blocks.
 * Only owner `/learn` or K goal-mode `/goal` runs as a single block for native slash expansion;
 * all other slash-prefixed prompts use a leading newline block so `agy` delivers them literally.
 */
export function geminiAcpPromptBlocks({
  prompt = '',
  text = prompt,
  goalObjective = false,
  internal = false,
  discussionTurn = false,
  isSlashAllowed,
  contextNotice = ''
} = {}) {
  const fullPrompt = typeof prompt === 'string' ? prompt : String(prompt ?? '');
  const rawText = typeof text === 'string' ? text : fullPrompt;
  const allowSlash =
    typeof isSlashAllowed === 'boolean'
      ? isSlashAllowed
      : Boolean(goalObjective) || (!internal && !discussionTurn && /^\/learn(\s|$)/u.test(rawText));
  if (contextNotice) {
    // Leave native slash expansion at the start of its single text block.
    const command = allowSlash ? /^\/\S+/u.exec(fullPrompt)?.[0] : null;
    if (command)
      return [
        {
          type: 'text',
          text: `${command} 本輪規則狀態供依循，請勿寫入學習提案。\n${contextNotice}\n\n${fullPrompt.slice(command.length)}`
        }
      ];
    return [{type: 'text', text: `${contextNotice}\n\n`}, {type: 'text', text: fullPrompt}];
  }
  if (!allowSlash && /^\s*\//u.test(fullPrompt))
    return [
      {type: 'text', text: '\n'},
      {type: 'text', text: fullPrompt}
    ];
  return [{type: 'text', text: fullPrompt}];
}
export const GEMINI_TOOL_GUIDANCE =
  '.gsheet 只是連結；有試算表 MCP 時先讀 metadata，再讀所需範圍。背景執行無法向本人要求核准；查不到資料或缺少工具／權限時，回報缺少的能力與未完成範圍，不繞過拒絕、不把未查到當成零。';
export function geminiToolGuidance(accessMode, googleOpsServer = null, {acp = false} = {}) {
  const commands = geminiCommandsAllowed(accessMode, googleOpsServer);
  const permission = {
    'read-only': '唯讀：可用原生檔案工具讀取資料、列目錄與搜尋；不能寫檔或執行命令。',
    'workspace-write': commands
      ? '工作區寫入：可讀取資料、編輯指定工作區內檔案，並在沙盒內執行命令。沙盒內命令只能寫入工作區，不能連網（含本機服務）或改登錄檔；工作區外的寫入與跳出沙盒都會被拒絕。需要這些能力的工作，回報本人改用完整存取。'
      : '工作區寫入：可讀取資料與編輯指定工作區內檔案；此工作區含 Google 連接器，為保護連接器程式不開放命令。需要命令的工作，回報本人改用完整存取。',
    'danger-full-access': '完整存取：可在任務授權範圍內讀寫檔案、執行命令及使用已接通的工具。'
  }[accessMode];
  return `${permission}\n${GEMINI_TOOL_GUIDANCE}${
    commands
      ? acp
        ? '\n本主聊天室用 agy ACP；回覆結束時若仍有原生背景命令，K 會保留同一程序與帳號，下一次訊息沿用原程序，不重播命令。agy 閒置時不保證推送完成結果，也不保證自動喚醒；需要結果的長命令應在本回合等待完成並讀回。不能只因已回覆就宣稱命令已完成。停止或關閉 K 會結束保留的程序；權限或工作區變更須先結束原工作。'
        : '\n目前 K 每回合使用獨立 agy print 程序；自己啟動且仍在執行的背景指令會讓 agy 等它結束才回傳（曾因此等待 9 小時，不保證會被自動取消），回合結束後也不會自動喚醒。需要結果的長指令須在本回合等待完成、讀回檔案後再回覆，不可宣稱稍後會自動接續。'
      : ''
  }`;
}
export const GEMINI_BROWSER_GUIDANCE =
  '使用 k_browser 前先讀取該 MCP 工具目前的定義，不憑記憶猜參數。頁面快照的 [ref=e13] 在 browser_click 的參數是 {"target":"e13"}，不是 {"ref":"e13"} 或 {"target":"ref=e13"}；其他工具依各自定義。';
export const GEMINI_MEDIA_GUIDANCE =
  '圖片、PDF、WAV／MP3／M4A 音訊及 MP4 影片可用原生 view_file 讀取已授權的檔案路徑；PDF 保留圖像與版面，不只抽文字。遇到不支援、超限或讀取失敗就說明，不以檔名、逐字稿或自行抽幀冒充看過／聽過原檔；不自行上傳其他服務或改用 API 計費。';
export function geminiInstruction(
  task,
  accessMode,
  browserServer = null,
  googleOpsServer = null,
  media = true,
  questions = false
) {
  const restriction =
    {
      'read-only': '\n本工作為唯讀，不得寫檔或執行終端機指令。',
      'workspace-write': geminiCommandsAllowed(accessMode, googleOpsServer)
        ? '\n只能寫入指定工作區；命令只在沙盒內執行。'
        : '\n只能寫入指定工作區；不得執行終端機指令。'
    }[accessMode] ?? '';
  return `你是 K HARNESS 的 Antigravity 核心子代理。只執行下列任務，不得再委派子代理。${workerTaskScope(accessMode)}不得修改權限設定或繞過拒絕。${restriction}\n${WORKER_SERVICE_RULE}\n在任務與既定權限內自行選擇方法與工具。除非使用者明確要求互動視窗，背景工作不得開啟可見終端機、黑窗或搶走前景焦點；隱藏視窗不得隱藏錯誤或把失敗說成成功。遇到錯誤先檢查原因與既有結果，不得在沒有新證據或修正下反覆執行相同失敗操作，也不得重送結果未確認的工作。若無法在這些限制內繼續，保留已完成成果，只停止受阻步驟並向主代理回報已做事項、錯誤與剩餘工作；不得擅改系統設定、終止其他工作或繞過核准。\n${geminiToolGuidance(accessMode, googleOpsServer)}\n${media ? GEMINI_MEDIA_GUIDANCE : ''}${browserServer ? `\n${GEMINI_BROWSER_GUIDANCE}` : ''}${questions ? `\n${WORKER_QUESTION_GUIDANCE}` : ''}\n\n<DELEGATED_TASK>\n${task}\n</DELEGATED_TASK>`;
}
export const UNKNOWN_OUTPUT_FILES_NOTE = '成果清單未知，不代表沒有輸出；先讀回任務指定檔案，不得重做。';

// Shared with the main conversation: only completed, error-free native writes are evidence.
export function geminiWriteTarget(step) {
  const info = step?.tool_info;
  if (
    step?.state !== 'DONE' ||
    step.error ||
    info?.error ||
    !['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(info?.name)
  )
    return null;
  const target = info.parameters?.TargetFile ?? info.parameters?.AbsolutePath;
  return typeof target === 'string' && target ? target : null;
}

const errorText = value =>
  typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : '';
const denied = message =>
  /\bpermission(?:s)?\s+(?:was\s+|were\s+|is\s+)?denied\b|\bdenied\s+(?:the\s+)?permission\b|configured deny rule|auto-denied/iu.test(
    message
  );
function targetFrom(info) {
  const p = info.parameters ?? {};
  if (p.ServerName && p.ToolName) return `${p.ServerName}/${p.ToolName}`.slice(0, 1000);
  const value =
    p.TargetFile ??
    p.AbsolutePath ??
    p.FilePath ??
    p.Url ??
    p.CommandLine ??
    p.command ??
    p.target ??
    p.ToolName ??
    p.tool;
  if (typeof value === 'string') return value.slice(0, 1000);
  return (
    errorText(info.error)
      .match(/(?:write_file|read_file|read_url|command|mcp)\(([^\n]+)\)/u)?.[1]
      ?.slice(0, 1000) ?? ''
  );
}

/** Feed arbitrary UTF-8 chunks; retain only the last result and bounded errors. */
export function geminiStream(onEvent = () => {}, onDiagnostic = () => {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '',
    result,
    init;
  const toolErrors = [],
    deniedTools = [],
    seen = new Set(),
    lastTools = new Map(),
    writeTargets = new Set();
  const actions = {
    write_to_file: 'write_file',
    replace_file_content: 'write_file',
    multi_replace_file_content: 'write_file',
    view_file: 'read_file',
    read_url_content: 'read_url',
    run_command: 'command',
    call_mcp_tool: 'mcp'
  };
  function line(text) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    const target = geminiWriteTarget(event.step_update);
    if (target) writeTargets.add(target);
    try {
      onEvent(event);
    } catch (error) {
      onDiagnostic({callbackError: String(error.message)});
    }
    if (event.event === 'result' || event.type === 'result') result = event.result ?? event;
    if (event.event === 'init') init = event.init;
    const step = event.step_update;
    if (!step) return;
    const info = step.tool_info ?? {};
    const name = info.name ?? step.tool_name ?? 'unknown';
    lastTools.set(actions[name] ?? name, {tool: name, target: targetFrom(info)});
    const message = errorText(info.error ?? step.error);
    if (!message) return;
    const entry = {tool: name, target: targetFrom(info), error: message.slice(0, 1000)};
    const key = JSON.stringify(entry);
    if (seen.has(key)) return;
    seen.add(key);
    if (toolErrors.length < 20) toolErrors.push(entry);
    if (denied(message) && deniedTools.length < 20) deniedTools.push({tool: entry.tool, target: entry.target});
    onDiagnostic({toolErrors: structuredClone(toolErrors), deniedTools: structuredClone(deniedTools)});
  }
  function feed(text) {
    pending += text;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      line(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  }
  return {
    write: chunk => feed(decoder.write(chunk)),
    end() {
      feed(decoder.end());
      if (pending) line(pending);
      for (const action of result?.denied_actions ?? []) {
        const entry = lastTools.get(action.action) ?? {
          tool: action.display_name ?? action.action ?? 'unknown',
          target: ''
        };
        if (deniedTools.length < 20 && !deniedTools.some(t => t.tool === entry.tool && t.target === entry.target))
          deniedTools.push(entry);
      }
      return {result, init, toolErrors, deniedTools, writeTargets: [...writeTargets]};
    }
  };
}
export function geminiOutcome(
  {result, toolErrors = [], deniedTools = []},
  {code, stderr = '', reason, cleanupError} = {}
) {
  const output = typeof result?.response === 'string' ? result.response : '';
  const nativeError = [
    result?.error == null ? '' : typeof result.error === 'string' ? result.error : JSON.stringify(result.error),
    stderr
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
  const base = {output, toolErrors, deniedTools, ...(nativeError ? {nativeError} : {})};
  if (cleanupError)
    return {...base, status: 'unresolved', settled: false, failureKind: 'cleanup-unconfirmed', error: cleanupError};
  if (reason)
    return {
      ...base,
      failureKind:
        {timeout: 'k-timeout', cancelled: 'cancelled', 'stderr limit exceeded': 'stderr-limit'}[reason] ?? 'unknown',
      status: reason === 'cancelled' ? 'cancelled' : 'failed',
      settled: true,
      error:
        reason === 'timeout'
          ? 'K 指定的等待時限已到，已停止程序；不是網路或額度耗盡的證據。可能已有檔案成果，須先讀回，不得直接重做。'
          : reason
    };
  const diagnostic = `${errorText(result?.error)}\n${stderr}`;
  let error,
    quotaCheckNeeded = false;
  const noOutput = /no output produced/iu.test(diagnostic),
    permissionBlocked = noOutput && (deniedTools.length > 0 || denied(diagnostic));
  if (permissionBlocked) {
    const labels = {
      view_file: '讀取檔案',
      read_file: '讀取檔案',
      run_command: '執行命令',
      command: '執行命令',
      call_mcp_tool: '呼叫工具'
    };
    const targets = deniedTools
      .slice(-3)
      .map(({tool, target}) => `${labels[tool] ?? tool}${target ? `：${target.slice(0, 240)}` : ''}`);
    error = `Gemini 工具存取被拒絕${targets.length ? `（${targets.join('；')}）` : ''}。目前背景模式無法互動核准，本次未取得最終回答；未重送或變更權限。`;
  } else if (noOutput) error = 'agy no output produced（沒有最終回答；未取得足以確認原因的證據）。';
  else if (/authentication required|not (?:logged|signed) in|unauthenticated|login required/iu.test(diagnostic))
    error = 'agy 未登入；請由使用者操作官方登入。';
  else if (/quota|resource.exhausted|rate.limit|credits?.*(?:exhausted|insufficient)/iu.test(diagnostic)) {
    error = 'agy 額度或速率限制；未重試或換模。';
    quotaCheckNeeded = true;
  } else if (code !== 0) error = `agy 退出碼 ${code ?? 'unknown'}。`;
  else if (result?.status !== 'SUCCESS' || result?.error)
    error = errorText(result?.error).slice(0, 400) || `agy result ${result?.status ?? 'missing'}。`;
  else if (!output.trim()) error = 'agy no output produced（沒有最終回答）。';
  return {
    ...base,
    status: error ? 'failed' : 'completed',
    settled: true,
    ...(error
      ? {
          error,
          failureKind: permissionBlocked
            ? 'permission-denied'
            : code !== 0
              ? 'nonzero-exit'
              : result?.error || result?.status !== 'SUCCESS'
                ? 'native-result-error'
                : !output.trim()
                  ? 'no-output'
                  : 'unknown'
        }
      : {}),
    ...(quotaCheckNeeded ? {quotaCheckNeeded: true} : {})
  };
}

export async function killGeminiTree(pid, {execImpl = exec, platform = process.platform, env = process.env} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('無效的 agy PID，未終止程序。');
  if (platform === 'win32')
    await execImpl(
      path.join(env.SystemRoot ?? env.WINDIR, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {windowsHide: true, timeout: 10000, maxBuffer: 32768}
    );
  else process.kill(-pid, 'SIGKILL');
}

/** Queries may have a deadline; model turns pass 0. Cancellation waits for tree kill and pipe closure. */
export function geminiProcess(
  executable,
  args,
  {
    cwd,
    env,
    signal,
    input,
    timeoutMs = 120000,
    maxStdout = 8 * 1024 * 1024,
    maxStderr = 128 * 1024,
    captureOutput = true,
    spawnImpl = spawn,
    killTree = killGeminiTree,
    onStart = () => {},
    onChunk = () => {}
  }
) {
  if (signal?.aborted) return Promise.resolve({code: null, stdout: '', stderr: '', reason: 'cancelled'});
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? {} : {detached: true})
      });
    } catch (error) {
      reject(Object.assign(error, {failureKind: 'spawn-failed', nativeError: String(error.message).slice(0, 4000)}));
      return;
    }
    let stdout = '',
      stderr = '',
      outBytes = 0,
      errBytes = 0,
      reason,
      killPromise,
      cleanupError,
      ended = false,
      cleanupTimer;
    const finish = async code => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      await killPromise;
      resolve({code, stdout, stderr, reason, cleanupError});
    };
    const stop = why => {
      if (reason || ended) return;
      reason = why;
      killPromise = Promise.resolve()
        .then(() => killTree(child.pid))
        .catch(() => {
          cleanupError = 'agy 整棵程序樹終止未確認；不得重播。';
        });
      cleanupTimer = setTimeout(() => {
        cleanupError = 'agy 終止後仍未確認程序與輸出管線關閉；不得重播。';
        child.stdin?.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref?.();
        void finish(null);
      }, 15000);
    };
    const abort = () => stop('cancelled');
    const timer = timeoutMs > 0 ? setTimeout(() => stop('timeout'), timeoutMs) : null;
    signal?.addEventListener('abort', abort, {once: true});
    child.stdout.on('data', b => {
      outBytes += b.length;
      if (captureOutput && outBytes > maxStdout) {
        stop('stdout limit exceeded');
        return;
      }
      if (captureOutput) stdout += b.toString();
      onChunk(b);
    });
    child.stderr.on('data', b => {
      errBytes += b.length;
      if (errBytes > maxStderr) {
        stop('stderr limit exceeded');
        return;
      }
      stderr += b.toString();
    });
    child.once('error', error => {
      ended = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      reject(
        Object.assign(
          error.code === 'ENOENT' ? Error('找不到 Antigravity（agy）；請在設定頁按 Antigravity「更新」下載官方核心（或先安裝官方 Antigravity CLI），重開 K 後再登入。', {cause: error}) : error,
          {failureKind: 'spawn-failed', nativeError: String(error.message).slice(0, 4000)}
        )
      );
    });
    child.once('close', code => {
      void finish(code);
    });
    if (input !== undefined) {
      child.stdin.on('error', () => stop('stdin delivery unconfirmed'));
      try {
        if (typeof input === 'function') {
          const isOpen = () => !ended && !reason && !signal?.aborted;
          input({
            isOpen,
            write: message => {
              if (!isOpen()) return;
              try {
                if (!child.stdin.writable) throw Error('stdin unavailable');
                child.stdin.write(message);
              } catch {
                stop('stdin delivery unconfirmed');
              }
            },
            end: () => {
              if (!isOpen()) return;
              try {
                child.stdin.end();
              } catch {
                stop('stdin delivery unconfirmed');
              }
            }
          });
        } else child.stdin.end(input);
      } catch {
        stop('stdin delivery unconfirmed');
      }
    }
    try {
      onStart(child.pid);
    } catch {
      stop('start callback failed');
    }
    if (signal?.aborted) abort();
  });
}

// agy print reads one NDJSON message per turn, preserving the same native conversation until stdin ends.
function geminiQuestionExchange(instruction, askParent, signal, refreshAnswer) {
  let input, conversationId, finalResult, error;
  let turn = 1,
    waiting = false;
  const send = content => input.write(JSON.stringify({event: 'user', message: {content}}) + '\n');
  return {
    open(stream) {
      input = stream;
      send(instruction);
    },
    observe(event) {
      if (waiting || finalResult || error || (event.event ?? event.type) !== 'result') return;
      const result = event.result ?? event;
      // An old result is not an acknowledgement of a later answer.
      if (turn > 1 && result.status === 'SUCCESS' && Number.isInteger(result.num_turns) && result.num_turns < turn)
        return;
      const question = result.status === 'SUCCESS' && !result.error && workerQuestionFrom(result.response);
      if (
        (question || (turn > 1 && result.status === 'SUCCESS')) &&
        (result.num_turns !== turn ||
          typeof result.conversation_id !== 'string' ||
          !result.conversation_id ||
          (conversationId && result.conversation_id !== conversationId))
      ) {
        error = Error('agy 未確認原生對話與回合，未再送入答覆。');
        input.end();
        return;
      }
      if (!question) {
        finalResult = result;
        input.end();
        return;
      }
      conversationId = result.conversation_id;
      waiting = true;
      void askWorkerParent(askParent, question, signal)
        .then(async answer => {
          if (!input.isOpen()) return;
          const content = await refreshAnswer(answer);
          if (!input.isOpen()) return;
          turn++;
          waiting = false;
          send(content);
        })
        .catch(failure => {
          error = failure;
          input.end();
        });
    },
    result() {
      if (error) throw error;
      if (!finalResult && (waiting || turn > 1)) throw Error('agy 已結束，無法確認主代理答覆已完成原生回合。');
      return finalResult;
    }
  };
}

export async function geminiGitStatus(workspace) {
  try {
    const {stdout} = await exec(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      {cwd: workspace, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024}
    );
    const entries = stdout.split('\0'),
      files = new Map();
    for (let i = 0; i < entries.length; i++) {
      const row = entries[i];
      if (row.length < 4) continue;
      const name = row.slice(3);
      files.set(name, row.slice(0, 2));
      if (/[RC]/u.test(row.slice(0, 2))) i++;
    }
    return files;
  } catch {
    return null;
  }
}
export function geminiOutputFiles(before, after, workspace) {
  if (!before || !after)
    return {
      outputFiles: [],
      outputFilesNote:
        '無法取得工作區 git status 差異（非 git repo 或查詢失敗）；成果清單未知，不代表沒有輸出。即使工單失敗或取消，也須先讀回任務指定檔案，確認未完成範圍，不能據此重做。'
    };
  const outputFiles = [];
  for (const [name, status] of after) {
    const relative = path.relative(workspace, path.resolve(workspace, name));
    if (
      status !== before.get(name) &&
      relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
      outputFiles.push(relative.replaceAll('\\', '/'));
  }
  return {
    outputFiles,
    outputFilesNote: 'git status 前後差異；無法歸因並行寫入，亦無法辨認原本已 dirty 且狀態相同的內容變更。'
  };
}

export async function collectGeminiOutputFiles(before, after, workspace, targets = []) {
  const git = geminiOutputFiles(before, after, workspace),
    files = new Map();
  const add = (name, source) => {
    const absolute = path.resolve(workspace, name),
      key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const prior = files.get(key);
    files.set(key, {absolute, source: prior && prior.source !== source ? 'both' : source});
  };
  targets.forEach(name => add(name, 'stream'));
  git.outputFiles.forEach(name => add(name, 'git'));
  const outputFileDetails = [];
  for (const {absolute, source} of files.values()) {
    try {
      const info = await stat(absolute);
      if (!info.isFile()) continue;
      const relative = path.relative(workspace, absolute);
      const name =
        relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
          ? relative
          : absolute;
      outputFileDetails.push({
        path: name.replaceAll('\\', '/'),
        size: info.size,
        mtime: info.mtime.toISOString(),
        source
      });
    } catch {
      /* Missing or unreadable targets are not confirmed artifacts. */
    }
  }
  return {
    outputFiles: outputFileDetails.map(file => file.path),
    outputFileDetails,
    outputFilesNote: `已完成且無錯誤的原生寫檔事件與可用 git 差異，逐檔 stat；mtime 僅供觀察。${git.outputFilesNote} 清單可能不完整；空清單不代表沒有輸出，先讀回指定檔案，不得重做。`
  };
}

export function createGeminiWorker({
  root,
  workspace,
  accessMode = 'workspace-write',
  executable,
  env = process.env,
  profileRoot = path.join(root, 'agent-home', 'gemini'),
  spawnImpl = spawn,
  killTree = killGeminiTree,
  timeoutMs = 0,
  gitStatus = geminiGitStatus,
  accounts,
  browserSession
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw Error('Flash timeoutMs 無效。');
  const profile = geminiProfile(workspace, accessMode),
    home = path.join(profileRoot, profile);
  // Resolve before HOME/USERPROFILE overrides. Never discover through a shell.
  const binary = geminiExecutable(env, executable);
  const childEnv = geminiEnvironment(env, home);
  const temps = Object.entries(env)
    .filter(([k]) => /^(TEMP|TMP)$/iu.test(k))
    .map(([, value]) => value);
  let catalog;
  async function prepare(targetHome = home, browserServer = null) {
    if (!binary) throw Error('找不到 Antigravity（agy，LOCALAPPDATA 未設定）；請在設定頁按 Antigravity「更新」下載官方核心，重開 K 後再登入。');
    const googleOps = await googleOpsMcp(workspace, {root});
    const projectMcp = await geminiProjectMcp(root, workspace, accessMode);
    await mkdir(path.join(targetHome, 'AppData', 'Local'), {recursive: true});
    await atomicWrite(
      path.join(targetHome, '.gemini', 'antigravity-cli', 'settings.json'),
      JSON.stringify(geminiSettings(workspace, accessMode, temps, browserServer, googleOps, projectMcp), null, 2)
    );
    await atomicWrite(
      path.join(targetHome, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify(geminiMcpConfig(browserServer, googleOps, projectMcp), null, 2),
      {cleanupOnFailure: true}
    );
    const {key: commonKey} = await writeGeminiCommonRule(targetHome, root);
    return {googleOps, commonKey};
  }
  async function models() {
    if (!catalog)
      catalog = (async () => {
        await prepare();
        // This one shared initialization belongs to the worker, not the first
        // caller's AbortSignal. Cancelling a task must not cancel another task's
        // catalog lookup; cancelled runs wait for this bounded lookup, then stop.
        const result = await geminiProcess(binary, ['models'], {
          cwd: workspace,
          env: childEnv,
          timeoutMs: 30000,
          spawnImpl,
          killTree
        });
        if (result.code !== 0 || result.reason || result.cleanupError) {
          const failure = geminiOutcome({}, {...result, stderr: `${result.stdout}\n${result.stderr}`});
          const message =
            result.reason === 'timeout' && !result.cleanupError
              ? 'K 模型目錄查詢期限已到；未啟動模型工作。'
              : failure.error;
          throw Object.assign(Error(`agy models 無法取得：${message} 未換用其他供應商。`), {
            settled: !result.cleanupError,
            failureKind: failure.failureKind,
            nativeError: failure.nativeError
          });
        }
        const names = new Set(antigravityModelNames(result.stdout));
        if (!names.size) throw Error('agy models 清單為空。');
        return names;
      })();
    return new Set(await catalog);
  }
  const worker = {
    profile,
    home,
    models,
    async run({
      task,
      model = 'gemini-3.8-flash',
      effort,
      signal,
      askParent,
      onStart,
      onActivity = () => {},
      onDiagnostic = () => {},
      onQuotaHint = () => {}
    } = {}) {
      if (
        !isAntigravityModel(model) ||
        !/^[a-z0-9][\w.-]*$/u.test(antigravityNativeModel(model)) ||
        model !== antigravityModelId(antigravityNativeModel(model)) ||
        effort === 'auto' ||
        (effort !== null && typeof effort !== 'string')
      )
        throw Error('Gemini 子代理須指定原生模型與推理程度；未換模。');
      if (typeof task !== 'string' || !task.trim() || task.length > 32000) throw Error('Flash task 無效。');
      const native = antigravityNativeModel(model),
        nativeModel = effort == null ? native : `${native}-${effort}`;
      if (signal?.aborted)
        return {
          status: 'cancelled',
          settled: true,
          failureKind: 'cancelled',
          output: '',
          outputFiles: [],
          outputFilesNote: UNKNOWN_OUTPUT_FILES_NOTE,
          acceptance: 'not-reviewed'
        };
      if (!(await models()).has(nativeModel)) throw Error(`${nativeModel} 目前不可用；未自動換模。`);
      if (signal?.aborted)
        return {
          status: 'cancelled',
          settled: true,
          failureKind: 'cancelled',
          output: '',
          outputFiles: [],
          outputFilesNote: UNKNOWN_OUTPUT_FILES_NOTE,
          acceptance: 'not-reviewed'
        };
      const browser = accessMode === 'read-only' ? null : browserSession?.();
      // Parallel workers each own their MCP endpoints and generated rule files.
      const runId = randomUUID();
      const runHome = path.join(home, 'runs', runId);
      let receipt, parser, parsed, before, nativePid, originalError;
      let nativeSettled = true;
      try {
        const server = await browser?.config({conversationId: `flash-${runId}`, accessMode, provider: 'gemini'});
        const prepared = await prepare(runHome, server);
        before = await gitStatus(workspace);
        const instruction = geminiInstruction(
          task,
          accessMode,
          server,
          prepared.googleOps,
          antigravitySupportsMedia(model),
          Boolean(askParent)
        );
        let commonKey = prepared.commonKey;
        const exchange = askParent
          ? geminiQuestionExchange(instruction, askParent, signal, async answer => {
              const common = await writeGeminiCommonRule(runHome, root, commonKey);
              commonKey = common.key;
              return common.notice ? `${common.notice}\n\n${answer}` : answer;
            })
          : null;
        const telemetry = {},
          activity = createWorkActivity(telemetry);
        parser = geminiStream(event => {
          exchange?.observe(event);
          const previous = telemetry.activity;
          geminiWorkActivity(activity, event);
          if (telemetry.activity !== previous) onActivity(telemetry.activity);
          if (
            ['error', 'result'].includes(event.event ?? event.type) &&
            /quota|resource.exhausted|rate.limit|credits?.*(?:exhausted|insufficient)/iu.test(
              errorText(event.error ?? event.result?.error)
            )
          )
            void Promise.resolve()
              .then(onQuotaHint)
              .catch(() => {});
        }, onDiagnostic);
        const args = [
          '-p',
          exchange ? '' : instruction,
          ...(exchange ? ['--input-format', 'stream-json'] : []),
          '--model',
          nativeModel,
          '--output-format',
          'stream-json',
          '--print-timeout',
          `${Math.ceil(timeoutMs / 1000)}s`,
          '--log-file',
          path.join(runHome, `${runId}.log`),
          '--disable-slash-commands',
          ...geminiAccessArgs(accessMode)
        ];
        // Native turns finish themselves; duration/quiet activity are display-only.
        // Parse the stream without also accumulating a size-limited stdout copy.
        nativeSettled = false;
        const result = await geminiProcess(binary, args, {
          cwd: workspace,
          env: geminiEnvironment(env, runHome),
          signal,
          input: exchange?.open,
          timeoutMs,
          captureOutput: false,
          spawnImpl,
          killTree,
          onStart: pid => {
            nativePid = pid;
            activity.begin();
            onStart?.(pid);
            onActivity(telemetry.activity);
          },
          onChunk: chunk => parser.write(chunk)
        });
        nativeSettled = !result.cleanupError;
        parsed = parser.end();
        if (exchange && result.code === 0 && !result.reason && !result.cleanupError)
          parsed.result = exchange.result() ?? parsed.result;
        receipt = {
          ...geminiOutcome(parsed, result),
          ...(await collectGeminiOutputFiles(before, await gitStatus(workspace), workspace, parsed.writeTargets)),
          acceptance: 'not-reviewed',
          nativeModel,
          profile,
          exitCode: result.code
        };
        return receipt;
      } catch (error) {
        originalError = error;
        if (error.failureKind === 'spawn-failed' && !nativePid) nativeSettled = true;
        parsed ??= parser?.end();
        receipt = {
          ...(await collectGeminiOutputFiles(before, await gitStatus(workspace), workspace, parsed?.writeTargets)),
          output: parsed?.result?.response ?? '',
          acceptance: 'not-reviewed'
        };
        if (error instanceof AggregateError) receipt.nativeError = error.nativeError ??= error.message;
        throw Object.assign(error, {workerResult: receipt});
      } finally {
        let configCleanupError, browserCleanupError;
        if (nativeSettled)
          await rm(path.join(runHome, '.gemini', 'config', 'mcp_config.json'), {force: true}).catch(error => {
            configCleanupError = error;
          });
        try {
          await browser?.close();
        } catch (error) {
          browserCleanupError = error;
        }
        if (configCleanupError || browserCleanupError) {
          const details = [
            browserCleanupError && `Flash 瀏覽器停止尚未確認（${browserCleanupError.message}）。不得重播。`,
            configCleanupError &&
              `Gemini 工單 MCP 設定清理失敗（${configCleanupError.code ?? 'unknown'}，${configCleanupError.message}）。`,
            originalError?.message
          ].filter(Boolean);
          const errors = [originalError, configCleanupError, browserCleanupError].filter(Boolean);
          const diagnostics = [
            ...details,
            receipt?.nativeError ?? originalError?.nativeError,
            browserCleanupError?.nativeError
          ];
          throw Object.assign(new AggregateError(errors, details.join('\n')), {
            settled: browserCleanupError ? false : originalError?.settled,
            failureKind: browserCleanupError ? 'cleanup-unconfirmed' : originalError?.failureKind,
            nativeError: [...new Set(diagnostics.filter(Boolean))].join('\n').slice(0, 4000),
            workerResult: receipt
          });
        }
      }
    }
  };
  if (accounts) {
    const run = worker.run;
    worker.run = async options => {
      let receipt;
      try {
        return await accounts.run(
          {
            accountId: options?.accountId,
            worker: true,
            ...(options?.parentId
              ? {
                  parentId: options.parentId,
                  requestId: options.requestId,
                  onHandoff: options.onHandoff,
                  handoffCurrent: options.handoffCurrent,
                  signal: options.signal
                }
              : {})
          },
          async lease => {
            // Catalog availability may differ across subscriptions; never carry A's
            // cached model catalog into B's worker. The settings home remains shared.
            catalog = null;
            options?.onAccount?.(lease);
            try {
              return (receipt = await run({...options, onQuotaHint: lease.quotaHint}));
            } catch (error) {
              receipt = {...error.workerResult, failureKind: error.failureKind, nativeError: error.nativeError};
              throw error;
            }
          }
        );
      } catch (error) {
        error.workerResult ??= receipt;
        throw error;
      }
    };
  }
  const runWithAccounts = worker.run;
  worker.run = async options => {
    try {
      return await runWithAccounts(options);
    } catch (error) {
      error.failureKind ??=
        error.workerResult?.failureKind ?? (error.settled === false ? 'cleanup-unconfirmed' : 'unknown');
      error.nativeError ??= [error.workerResult?.nativeError, String(error.message)]
        .filter(Boolean)
        .join('\n')
        .slice(0, 4000);
      error.outputFilesNote ??= error.workerResult?.outputFilesNote ?? UNKNOWN_OUTPUT_FILES_NOTE;
      throw error;
    }
  };
  return worker;
}
