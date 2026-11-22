import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {
  geminiEnvironment,
  geminiAcpPermissionDecision,
  geminiAcpPromptBlocks
} from '../src/gemini-worker.mjs';
import {scratchBase} from './scratch.mjs';

test('geminiEnvironment isolates TEMP/TMP to home\\tmp only when isolateTemp is true', () => {
  const source = {
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    Temp: 'C:\\Users\\ExampleUser\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\ExampleUser\\AppData\\Local\\Temp',
    PATH: 'C:\\Windows\\System32',
    PATHEXT: '.EXE;.CMD',
    GEMINI_API_KEY: 'secret-must-drop',
    CODEX_HOME: 'C:\\codex'
  };

  const workerEnv = geminiEnvironment(source, 'D:\\k-home');
  assert.equal(workerEnv.Temp, 'C:\\Users\\ExampleUser\\AppData\\Local\\Temp');
  assert.equal(workerEnv.TMP, 'C:\\Users\\ExampleUser\\AppData\\Local\\Temp');
  assert.equal(workerEnv.GEMINI_API_KEY, undefined);
  assert.equal(workerEnv.CODEX_HOME, undefined);

  const acpEnv = geminiEnvironment(source, 'D:\\k-home', {isolateTemp: true});
  assert.deepEqual(acpEnv, {
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32',
    PATHEXT: '.EXE;.CMD',
    TEMP: path.join('D:\\k-home', 'tmp'),
    TMP: path.join('D:\\k-home', 'tmp'),
    USERPROFILE: 'D:\\k-home',
    HOME: 'D:\\k-home',
    LOCALAPPDATA: path.join('D:\\k-home', 'AppData', 'Local'),
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true'
  });
  assert.equal('Temp' in acpEnv, false);
});

test('geminiAcpPermissionDecision read-only denies edits, commands, unallowed MCP and unknown tools with zh-TW messages', () => {
  const workspace = 'D:\\Work\\Project';
  const sharedRule = 'D:\\K-home\\agent-home\\gemini\\shared\\learned-rules.md';

  const editInside = geminiAcpPermissionDecision({
    accessMode: 'read-only',
    workspace,
    writable: [sharedRule],
    allowedMcpRules: ['mcp(k_google_ops/*)'],
    knownMcpServers: ['k_google_ops'],
    toolCall: {
      name: 'write_file',
      kind: 'edit',
      rawInput: {Path: 'D:\\Work\\Project\\notes.txt'}
    },
    platform: 'win32'
  });
  assert.equal(editInside.allow, false);
  assert.equal(editInside.reason, 'read-only-denied');
  assert.match(editInside.message, /^唯讀模式擋下了寫檔.*這回合已停止。$/u);

  const cmd = geminiAcpPermissionDecision({
    accessMode: 'read-only',
    workspace,
    toolCall: {name: 'run_command', kind: 'execute', rawInput: {CommandLine: 'dir'}},
    platform: 'win32'
  });
  assert.equal(cmd.allow, false);
  assert.equal(cmd.reason, 'read-only-denied');
  assert.match(cmd.message, /^唯讀模式擋下了執行命令.*這回合已停止。$/u);

  const unallowedMcp = geminiAcpPermissionDecision({
    accessMode: 'read-only',
    workspace,
    allowedMcpRules: ['mcp(k_google_ops/*)'],
    knownMcpServers: ['k_google_ops', 'k_browser'],
    toolCall: {name: 'mcp_k_browser_browser_click', kind: 'other', rawInput: {target: 'e1'}},
    platform: 'win32'
  });
  assert.equal(unallowedMcp.allow, false);
  assert.equal(unallowedMcp.reason, 'unallowed-mcp');
  assert.match(unallowedMcp.message, /^唯讀模式擋下了未授權工具.*這回合已停止。$/u);

  const callMcpDenied = geminiAcpPermissionDecision({
    accessMode: 'read-only',
    workspace,
    allowedMcpRules: [],
    knownMcpServers: ['k_luna'],
    toolCall: {name: 'call_mcp_tool', kind: 'other', rawInput: {ServerName: 'k_luna', ToolName: 'luna_start'}},
    platform: 'win32'
  });
  assert.equal(callMcpDenied.allow, false);
  assert.equal(callMcpDenied.reason, 'unallowed-mcp');

  const unknownTool = geminiAcpPermissionDecision({
    accessMode: 'read-only',
    workspace,
    toolCall: {name: 'custom_mystery_tool', kind: 'other'},
    platform: 'win32'
  });
  assert.equal(unknownTool.allow, false);
  assert.equal(unknownTool.reason, 'unknown-tool-denied');

  const readTool = geminiAcpPermissionDecision({
    accessMode: 'read-only',
    workspace,
    toolCall: {name: 'read_file', kind: 'read', locations: [{path: 'D:\\Work\\Project\\README.md'}]},
    platform: 'win32'
  });
  assert.equal(readTool.allow, true);
  assert.equal(readTool.message, null);
});

test('geminiAcpPermissionDecision workspace-write enforces workspace, writable, TEMP, commandsAllowed and MCP whitelist', async () => {
  await mkdir(scratchBase, {recursive: true});
  const root = await mkdtemp(path.join(scratchBase, 'acp-perm-'));
  const workspace = path.join(root, 'workspace');
  const sharedDir = path.join(root, 'shared');
  const sharedRule = path.join(sharedDir, 'learned-rules.md');
  const homeTmp = path.join(root, 'home', 'tmp');
  const sysTemp = path.join(root, 'sys-temp');
  const common = {
    accessMode: 'workspace-write',
    workspace,
    writable: [sharedRule],
    allowedMcpRules: ['mcp(k_browser/*)', 'mcp(k_luna/*)'],
    knownMcpServers: ['k_browser', 'k_luna', 'k_evil'],
    temps: [homeTmp, sysTemp]
  };

  assert.equal(
    geminiAcpPermissionDecision({
      ...common,
      commandsAllowed: true,
      toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: path.join(workspace, 'src', 'a.txt')}}
    }).allow,
    true
  );

  // Explicit single-file writable target is allowed, sibling file in same dir is denied.
  assert.equal(
    geminiAcpPermissionDecision({
      ...common,
      commandsAllowed: true,
      toolCall: {name: 'replace_file_content', kind: 'edit', args: {TargetFile: sharedRule}}
    }).allow,
    true
  );
  const siblingShared = geminiAcpPermissionDecision({
    ...common,
    commandsAllowed: true,
    toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: path.join(sharedDir, 'other.md')}}
  });
  assert.equal(siblingShared.allow, false);
  assert.equal(siblingShared.reason, 'outside-workspace-edit');

  // Outside workspace
  const outside = geminiAcpPermissionDecision({
    ...common,
    commandsAllowed: true,
    toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: path.join(root, 'outside.txt')}}
  });
  assert.equal(outside.allow, false);
  assert.equal(outside.reason, 'outside-workspace-edit');
  assert.match(outside.message, /工作區外的寫檔/u);

  // Missing target path fails closed
  const missingTarget = geminiAcpPermissionDecision({
    ...common,
    commandsAllowed: true,
    toolCall: {name: 'write_file', kind: 'edit', rawInput: {}}
  });
  assert.equal(missingTarget.allow, false);
  assert.equal(missingTarget.reason, 'missing-edit-target');

  // TEMP/TMP excluded
  for (const tempTarget of [path.join(homeTmp, 'leak.txt'), path.join(sysTemp, 'leak2.txt'), homeTmp]) {
    const res = geminiAcpPermissionDecision({
      ...common,
      commandsAllowed: true,
      toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: tempTarget}}
    });
    assert.equal(res.allow, false);
    assert.equal(res.reason, 'temp-edit-denied');
  }

  // Commands allowed vs Google connector (commandsAllowed: false) vs BypassSandbox
  assert.equal(
    geminiAcpPermissionDecision({
      ...common,
      commandsAllowed: true,
      toolCall: {name: 'run_command', kind: 'execute', rawInput: {CommandLine: 'npm test'}}
    }).allow,
    true
  );
  const bypassCmd = geminiAcpPermissionDecision({
    ...common,
    commandsAllowed: true,
    toolCall: {name: 'run_command', kind: 'execute', rawInput: {CommandLine: 'dir', BypassSandbox: true}}
  });
  assert.equal(bypassCmd.allow, false);
  assert.equal(bypassCmd.reason, 'bypass-sandbox-denied');

  const disabledCmd = geminiAcpPermissionDecision({
    ...common,
    commandsAllowed: false,
    toolCall: {name: 'run_command', kind: 'execute', rawInput: {CommandLine: 'dir'}}
  });
  assert.equal(disabledCmd.allow, false);
  assert.equal(disabledCmd.reason, 'commands-disabled');
  assert.match(disabledCmd.message, /未開放執行命令/u);

  // MCP whitelist
  assert.equal(
    geminiAcpPermissionDecision({
      ...common,
      commandsAllowed: true,
      toolCall: {name: 'mcp_k_browser_browser_click', kind: 'other'}
    }).allow,
    true
  );
  assert.equal(
    geminiAcpPermissionDecision({
      ...common,
      commandsAllowed: true,
      toolCall: {name: 'call_mcp_tool', kind: 'other', rawInput: {ServerName: 'k_luna', ToolName: 'luna_start'}}
    }).allow,
    true
  );
  const badMcp = geminiAcpPermissionDecision({
    ...common,
    commandsAllowed: true,
    toolCall: {name: 'mcp_k_evil_steal', kind: 'other'}
  });
  assert.equal(badMcp.allow, false);
  assert.equal(badMcp.reason, 'unallowed-mcp');

  const bareMcpPrefix = geminiAcpPermissionDecision({
    ...common,
    commandsAllowed: true,
    toolCall: {name: 'mcp_k_browser', kind: 'other'}
  });
  assert.equal(bareMcpPrefix.allow, false);
  assert.equal(bareMcpPrefix.reason, 'unallowed-mcp');
});

test('geminiAcpPermissionDecision handles Windows case, slashes, .. traversal, relative paths, and multi-target mismatches', () => {
  const base = {
    accessMode: 'workspace-write',
    workspace: 'D:\\Work\\App',
    temps: ['C:\\Users\\ExampleUser\\AppData\\Local\\Temp', 'D:\\K-Home\\tmp'],
    platform: 'win32'
  };

  // Case-insensitive + mixed forward/backward slashes + internal ..
  assert.equal(
    geminiAcpPermissionDecision({
      ...base,
      toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: 'd:/work/APP/sub\\nested/../file.txt'}}
    }).allow,
    true
  );

  // Relative paths staying inside (including filename starting with '..')
  assert.equal(
    geminiAcpPermissionDecision({
      ...base,
      toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: 'sub/../..keep.txt'}}
    }).allow,
    true
  );

  // Relative paths escaping via ..
  for (const escape of ['../outside.txt', 'sub/../../outside.txt', 'a\\b/../../../App2/sibling.txt']) {
    const res = geminiAcpPermissionDecision({
      ...base,
      toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: escape}}
    });
    assert.equal(res.allow, false, `expected ${escape} to be denied`);
    assert.equal(res.reason, 'outside-workspace-edit');
  }

  // Relative path resolving into isolated TEMP
  const relTemp = geminiAcpPermissionDecision({
    ...base,
    toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: '../../K-Home/tmp/a.txt'}}
  });
  assert.equal(relTemp.allow, false);
  assert.equal(relTemp.reason, 'temp-edit-denied');

  // Sibling directory sharing prefix, UNC path, drive-relative path, workspace directory itself
  for (const tricky of ['D:\\Work\\App2\\x.txt', '\\\\server\\share\\x.txt', 'D:relative.txt', 'D:\\Work\\App']) {
    const res = geminiAcpPermissionDecision({
      ...base,
      toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: tricky}}
    });
    assert.equal(res.allow, false, `expected ${tricky} to be denied`);
  }

  // Mixed targets: locations inside, rawInput outside -> must deny
  const mixed = geminiAcpPermissionDecision({
    ...base,
    toolCall: {
      name: 'write_file',
      kind: 'edit',
      locations: [{path: 'D:/Work/App/ok.txt'}],
      rawInput: {Path: 'C:\\Users\\ExampleUser\\AppData\\Local\\Temp\\bad.txt'}
    }
  });
  assert.equal(mixed.allow, false);
  assert.equal(mixed.reason, 'temp-edit-denied');

  // When a temp dir is an ancestor of the workspace itself, workspace writes stay allowed
  const ancestorTemp = geminiAcpPermissionDecision({
    accessMode: 'workspace-write',
    workspace: 'C:\\Users\\ExampleUser\\AppData\\Local\\Temp\\ws',
    temps: ['C:\\Users\\ExampleUser\\AppData\\Local\\Temp'],
    toolCall: {
      name: 'write_file',
      kind: 'edit',
      rawInput: {Path: 'C:\\Users\\ExampleUser\\AppData\\Local\\Temp\\ws\\inside.txt'}
    },
    platform: 'win32'
  });
  assert.equal(ancestorTemp.allow, true);
});

test('geminiAcpPermissionDecision handles danger-full-access and invalid accessMode', () => {
  assert.equal(
    geminiAcpPermissionDecision({
      accessMode: 'danger-full-access',
      workspace: 'D:\\Work',
      toolCall: {name: 'run_command', kind: 'execute', rawInput: {CommandLine: 'echo ok'}}
    }).allow,
    true
  );
  const invalid = geminiAcpPermissionDecision({
    accessMode: 'auto',
    workspace: 'D:\\Work',
    toolCall: {name: 'read_file', kind: 'read'}
  });
  assert.equal(invalid.allow, false);
  assert.equal(invalid.reason, 'invalid-access-mode');
});

test('geminiAcpPromptBlocks keeps owner /learn and goal /goal single-block while protecting all other slash prompts', () => {
  // Allowed native expansion: owner /learn & goal-mode /goal
  assert.deepEqual(geminiAcpPromptBlocks({prompt: '/learn remember this'}), [
    {type: 'text', text: '/learn remember this'}
  ]);
  assert.deepEqual(geminiAcpPromptBlocks({prompt: '/learn'}), [{type: 'text', text: '/learn'}]);
  assert.deepEqual(geminiAcpPromptBlocks({prompt: '/goal check repo', goalObjective: 'check repo'}), [
    {type: 'text', text: '/goal check repo'}
  ]);
  assert.deepEqual(
    geminiAcpPromptBlocks({prompt: '/learn rule\n\n附件：{...}', text: '/learn rule'}),
    [{type: 'text', text: '/learn rule\n\n附件：{...}'}]
  );

  // Protected literal slash inputs (double block with leading "\n")
  for (const input of [
    {prompt: '/compact'},
    {prompt: '/goal do something'},
    {prompt: '/learning something'},
    {prompt: ' /learn with leading space'},
    {prompt: '  /compact'},
    {prompt: '/learn inside internal turn', internal: true},
    {prompt: '/learn inside discussion', discussionTurn: true},
    {prompt: '/compact', isSlashAllowed: false}
  ]) {
    assert.deepEqual(geminiAcpPromptBlocks(input), [
      {type: 'text', text: '\n'},
      {type: 'text', text: input.prompt}
    ]);
  }

  // Ordinary non-slash text stays single block
  assert.deepEqual(geminiAcpPromptBlocks({prompt: 'hello /compact world'}), [
    {type: 'text', text: 'hello /compact world'}
  ]);
  assert.deepEqual(geminiAcpPromptBlocks({prompt: '/compact', isSlashAllowed: true}), [
    {type: 'text', text: '/compact'}
  ]);
});

test('geminiAcpPermissionDecision enforces exact MCP tool rules, rejects ambiguous flat prefixes, and blocks deniedWrites', () => {
  const workspace = 'D:\\Work\\Project';
  const exactCtx = {
    accessMode: 'read-only',
    workspace,
    allowedMcpRules: ['mcp(demo/get_record)'],
    knownMcpServers: ['demo', 'demo_admin']
  };

  assert.equal(
    geminiAcpPermissionDecision({
      ...exactCtx,
      toolCall: {name: 'mcp_demo_get_record', kind: 'other'}
    }).allow,
    true
  );
  assert.equal(
    geminiAcpPermissionDecision({
      ...exactCtx,
      toolCall: {name: 'call_mcp_tool', kind: 'other', rawInput: {ServerName: 'demo', ToolName: 'get_record'}}
    }).allow,
    true
  );

  for (const deniedTool of [
    {name: 'mcp_demo_delete_record', kind: 'other'},
    {name: 'call_mcp_tool', kind: 'other', rawInput: {ServerName: 'demo', ToolName: 'delete_record'}},
    {name: 'mcp_demo_admin_wipe', kind: 'other'},
    {name: 'call_mcp_tool', kind: 'other', rawInput: {ServerName: 'demo_admin', ToolName: 'wipe'}}
  ]) {
    const res = geminiAcpPermissionDecision({...exactCtx, toolCall: deniedTool});
    assert.equal(res.allow, false, `expected ${deniedTool.name} to be denied`);
    assert.equal(res.reason, 'unallowed-mcp');
  }

  // Even when demo/* is allowed, an ambiguous flat name shared with known server demo_admin must be rejected.
  const wildcardAmbiguous = geminiAcpPermissionDecision({
    accessMode: 'workspace-write',
    workspace,
    allowedMcpRules: ['mcp(demo/*)'],
    knownMcpServers: ['demo', 'demo_admin'],
    toolCall: {name: 'mcp_demo_admin_wipe', kind: 'other'}
  });
  assert.equal(wildcardAmbiguous.allow, false);
  assert.equal(wildcardAmbiguous.reason, 'unallowed-mcp');

  // Unknown server list rejects flat names without guessing prefix.
  const noKnown = geminiAcpPermissionDecision({
    accessMode: 'workspace-write',
    workspace,
    allowedMcpRules: ['mcp(demo/*)'],
    knownMcpServers: [],
    toolCall: {name: 'mcp_demo_get_record', kind: 'other'}
  });
  assert.equal(noKnown.allow, false);

  // Protected directories (e.g. google_ops_worker, .venv) inside workspace are denied before workspace allow.
  const opsDenied = geminiAcpPermissionDecision({
    accessMode: 'workspace-write',
    workspace,
    deniedWrites: [`${workspace}\\google_ops_worker`, `${workspace}\\.venv`],
    toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: 'google_ops_worker/server.py'}},
    platform: 'win32'
  });
  assert.equal(opsDenied.allow, false);
  assert.equal(opsDenied.reason, 'protected-edit-denied');
  assert.match(opsDenied.message, /受保護目錄的寫檔/u);

  assert.equal(
    geminiAcpPermissionDecision({
      accessMode: 'workspace-write',
      workspace,
      deniedWrites: [`${workspace}\\google_ops_worker`, `${workspace}\\.venv`],
      toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: 'google_ops_worker_extra/ok.py'}},
      platform: 'win32'
    }).allow,
    true
  );
});

test('geminiAcpPermissionDecision blocks resolved deniedWrites equal to or containing workspace', () => {
  const workspace = 'D:\\Work\\Project';

  const equalDenied = geminiAcpPermissionDecision({
    accessMode: 'workspace-write',
    workspace,
    deniedWrites: [workspace],
    resolvedPaths: {'google_ops_worker/google_ops_client.py': `${workspace}\\google_ops_client.py`},
    toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: 'google_ops_worker/google_ops_client.py'}},
    platform: 'win32'
  });
  assert.equal(equalDenied.allow, false);
  assert.equal(equalDenied.reason, 'protected-edit-denied');

  const ancestorDenied = geminiAcpPermissionDecision({
    accessMode: 'workspace-write',
    workspace,
    deniedWrites: ['D:\\Work'],
    toolCall: {name: 'write_file', kind: 'edit', rawInput: {Path: 'notes.txt'}},
    platform: 'win32'
  });
  assert.equal(ancestorDenied.allow, false);
  assert.equal(ancestorDenied.reason, 'protected-edit-denied');
});
