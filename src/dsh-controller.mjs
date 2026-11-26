import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createAcpController} from './acp-controller.mjs';
import {
  openDshAgent,
  dshEnvironment,
  dshExecutable,
  dshHome,
  ensureDshHome,
  killDshTree,
  dshToolName,
  DSH_EDIT_TOOLS,
  DSH_MISSING
} from './dsh-acp.mjs';
import {createDeepSeekLogin} from './dsh-login.mjs';
import {dshSessionUsage, deepseekRoomCost, dshSessionState, dshSessionFolder, dshLastSeq, dshSessionAccess} from './deepseek-billing.mjs';

// The owner's extra rules for DeepSeek, kept in K's DeepSeek folder and sent once when a chat room starts.
export const DEEPSEEK_EXTRA_RULES = 'DeepSeek額外規則.md';
export async function readDeepSeekExtraRules(home) {
  let text;
  try {
    text = (await readFile(path.join(home, DEEPSEEK_EXTRA_RULES), 'utf8')).replace(/^﻿/u, '').trim();
  } catch {
    return null;
  }
  return text
    ? `<owner_extra_rules source="${DEEPSEEK_EXTRA_RULES}">\n本人給 DeepSeek 的額外規則（在新聊天室開始時提供）：\n${text}\n</owner_extra_rules>`
    : null;
}

// DSH keeps its own Windows sandbox per process (DSH_PERMISSION_MODE): inside it, workspace reads,
// writes and sandboxed commands need no prompt. Only an escalation reaches K as a permission request.
export const DEEPSEEK_PROFILE = {
  provider: 'deepseek',
  extraRules: readDeepSeekExtraRules,
  label: 'DeepSeek',
  idPrefix: 'deepseek',
  sessionsDir: 'deepseek-sessions',
  initialQuota: {status: 'unavailable', windows: [], note: '尚未查詢 DeepSeek 帳戶餘額。'},
  hasQuota: quota => quota?.balance != null,
  accessError: 'DeepSeek 提供唯讀、要求核准或完整存取權；未提供代我核准。',
  accessGuidance: {
    'read-only':
      '目前權限：唯讀。DeepSeek Harness 原生沙盒只允許讀取與唯讀命令；需要寫入或升級權限時 K 一律拒絕（拒絕會結束本回合）。需要寫入時先說明，由本人改權限。',
    'workspace-write':
      '目前權限：要求核准。DeepSeek Harness 原生沙盒允許在工作區內讀寫與執行沙盒命令；超出沙盒的操作（工作區外寫入等）會請本人逐項核准，本人拒絕時本回合結束。',
    'danger-full-access': '目前權限：完整存取。可在任務授權範圍內讀寫檔案、執行命令與使用已接通的工具。'
  },
  missingBinary: DSH_MISSING,
  executable: dshExecutable,
  home: dshHome,
  ensureHome: ensureDshHome,
  openAgent: openDshAgent,
  killTree: killDshTree,
  toolName: dshToolName,
  // DSH sends each committed step's reasoning text; Grok sends none to show.
  thoughts: true,
  editTools: DSH_EDIT_TOOLS,
  // DSH ignores ACP session metadata (live probe), cannot load a session, and fixes its sandbox at launch.
  metaRules: false,
  loadFallback: false,
  resumeSameDirectory: true,
  processPerAccessMode: true,
  // ...but only for a new session: a resumed one keeps the permission pinned in its own log.
  sessionAccess: dshSessionAccess,
  // DSH's session/cancel does not wait for or end its in-process subagents (Astra review, rc.5 source).
  closeOnStop: true,
  // DSH's goal rounds and background jobs keep working after a turn; K follows them in DSH's own log.
  nativeState: dshSessionState,
  nativeFolder: dshSessionFolder,
  nativeLastSeq: dshLastSeq,
  async refreshUsage({home, record, login}) {
    const usage = await dshSessionUsage(home, record.nativeSessionId);
    if (!usage) return null;
    const prices = await login.prices().catch(() => null);
    return {...deepseekRoomCost(usage, prices), pricesCheckedAt: prices?.checkedAt ?? null};
  }
};

/**
 * DeepSeek main entry: the shared ACP controller with DSH's profile. `apiKey` returns the human's
 * DeepSeek key from K's discussion API settings; it is only handed to the DSH process environment.
 */
export function createDeepSeekController({dshExecutable: executable, apiKey, fetchImpl = fetch, ...options} = {}) {
  const profile = {
    ...DEEPSEEK_PROFILE,
    environment: async (env, home, {accessMode}) => dshEnvironment(env, home, {accessMode, apiKey: await apiKey()}),
    loginFactory: opts => createDeepSeekLogin({...opts, apiKey, fetchImpl})
  };
  return createAcpController(profile, {...options, executable});
}
