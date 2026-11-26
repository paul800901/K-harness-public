import {createAcpController} from './acp-controller.mjs';
import {openGrokAgent, grokEnvironment, grokExecutable, grokHome, ensureGrokHome, killGrokTree} from './grok-acp.mjs';
import {createGrokLogin} from './grok-login.mjs';

// grok 1.0.70 routes MCP calls through its `use_tool` dispatcher; the real
// `server__tool` name is in rawInput.tool_name (live probe).
function toolName(toolCall = {}) {
  const meta = toolCall._meta?.['x.ai/tool'] ?? {};
  if (meta.name === 'use_tool' && typeof toolCall.rawInput?.tool_name === 'string') return toolCall.rawInput.tool_name;
  return String(meta.name ?? toolCall.title ?? 'tool');
}

// Windows has no Grok OS sandbox (grok 1.0.70: Landlock/Seatbelt only), so K answers every
// native permission prompt itself. Grok's own auto-review mode is fixed per native session,
// so it is not offered: a later stricter K mode could not be guaranteed.
export const GROK_PROFILE = {
  provider: 'grok',
  label: 'Grok',
  idPrefix: 'grok',
  sessionsDir: 'grok-sessions',
  initialQuota: {status: 'unavailable', windows: [], note: '尚未取得 Grok 官方額度。'},
  hasQuota: quota => !!quota?.windows?.length,
  accessError: 'Grok 提供唯讀、要求核准或完整存取權；未提供代我核准。',
  accessGuidance: {
    'read-only':
      '目前權限：唯讀。可讀取、搜尋與執行 Grok 內建的唯讀指令；寫檔、修改與其他命令都會被 K 拒絕（拒絕會結束本回合）。需要寫入時先說明，由本人改權限。',
    'workspace-write':
      '目前權限：要求核准。編輯工作區內檔案由 K 直接放行；工作區外的寫入、執行命令與其他外部工具會請本人逐項核准，本人拒絕時本回合結束。Windows 上沒有 Grok 沙盒，不要宣稱有作業系統隔離。',
    'danger-full-access': '目前權限：完整存取。可在任務授權範圍內讀寫檔案、執行命令與使用已接通的工具。'
  },
  missingBinary: '找不到 Grok Build；請在設定頁按 Grok「更新」下載官方核心，重開 K。',
  executable: grokExecutable,
  home: grokHome,
  ensureHome: ensureGrokHome,
  environment: (env, home) => grokEnvironment(env, home),
  openAgent: openGrokAgent,
  loginFactory: createGrokLogin,
  killTree: killGrokTree,
  toolName,
  toolLabel: update => update._meta?.['x.ai/tool']?.label,
  // grok takes K's rules as session metadata and can reload a session it cannot resume.
  metaRules: true,
  loadFallback: true,
  // 1.0.92 loads persisted sessions from the supplied workspace; another cwd returns FS_NOT_FOUND.
  resumeSameDirectory: true,
  processPerAccessMode: false,
  notification(method, update, state) {
    if (
      method !== '_x.ai/session_notification' ||
      update.sessionUpdate !== 'turn_completed' ||
      !Number.isFinite(update.usage?.totalTokens)
    )
      return false;
    state.progress.tokenUsage = {
      last: {
        totalTokens: update.usage.totalTokens,
        inputTokens: update.usage.inputTokens,
        outputTokens: update.usage.outputTokens
      }
    };
    return true;
  }
};

/** Grok Build main entry: the shared ACP controller with Grok's profile. */
export const createGrokController = ({grokExecutable: executable, ...options} = {}) =>
  createAcpController(GROK_PROFILE, {...options, executable});
