import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {
  openDshAgent,
  dshEnvironment,
  dshExecutable,
  dshHome,
  ensureDshHome,
  dshModelOptions,
  dshEfforts,
  DSH_MISSING
} from './dsh-acp.mjs';
import {deepseekBalance, cnyRates, createDailyCache, fetchDeepseekPrices} from './deepseek-billing.mjs';

const MISSING = DSH_MISSING;

/**
 * DeepSeek has no subscription or login: the core runs on the human's API key from K's discussion API
 * settings. "Status" is that key plus the official account balance; the catalog comes from DSH itself.
 */
export function createDeepSeekLogin({cwd, env = process.env, executable, apiKey, open = openDshAgent, fetchImpl = fetch} = {}) {
  const binary = dshExecutable(env, executable),
    home = dshHome(cwd, env);
  const key = async () => {
    if (!apiKey) throw Error('此版本未接通 DeepSeek API 金鑰。');
    return apiKey();
  };
  const rates = createDailyCache(() => cnyRates({fetchImpl})),
    prices = createDailyCache(() => fetchDeepseekPrices({fetchImpl}));
  let catalog = null,
    catalogPending = null,
    statusPending = null;
  // The catalog is DSH's own session config: one probe session in a K-only folder, each model's
  // reasoning levels read after selecting it. Kept until K restarts; a failure is not cached.
  async function loadCatalog() {
    if (!binary) throw Error(MISSING);
    await ensureDshHome(home);
    const folder = path.join(home, 'k-catalog');
    await mkdir(folder, {recursive: true});
    const agent = await open({
      executable: binary,
      env: dshEnvironment(env, home, {accessMode: 'read-only', apiKey: await key()}),
      cwd: folder
    });
    try {
      const created = await agent.request('session/new', {cwd: folder, mcpServers: []});
      const current = created?.configOptions?.find(o => o?.id === 'model')?.currentValue;
      const rows = [];
      for (const option of dshModelOptions(created?.configOptions)) {
        const result = await agent.request('session/set_config_option', {
          sessionId: created.sessionId,
          configId: 'model',
          value: option.nativeValue
        });
        const efforts = dshEfforts(result?.configOptions);
        rows.push({
          ...option,
          provider: 'deepseek',
          available: true,
          inputModalities: ['text'],
          supportedReasoningEfforts: efforts.levels.map(level => ({
            reasoningEffort: level.value,
            description: level.description ?? ''
          })),
          defaultReasoningEffort: efforts.levels.length ? efforts.current : null,
          isDefault: option.nativeValue === current
        });
      }
      await agent.request('session/close', {sessionId: created.sessionId}).catch(() => {});
      if (!rows.length) throw Error('DeepSeek Harness 沒有回報可用模型。');
      return rows;
    } finally {
      await agent.close().catch(() => {});
    }
  }
  async function inspect() {
    const checkedAt = new Date().toISOString();
    let secret;
    try {
      secret = await key();
    } catch (error) {
      return {installed: !!binary, available: false, reason: error.message};
    }
    const [balance, fx] = await Promise.allSettled([deepseekBalance(secret, {fetchImpl}), rates()]);
    if (balance.status === 'rejected')
      return {installed: !!binary, available: !!binary, reason: `DeepSeek 餘額查詢失敗：${balance.reason?.message}`};
    return {
      installed: !!binary,
      available: !!binary,
      quota: {
        status: 'available',
        checkedAt,
        windows: [],
        balance: balance.value,
        fx: fx.status === 'fulfilled' ? fx.value : null,
        note: balance.value.available ? null : 'DeepSeek 回報帳戶目前不可用（可能餘額不足）。'
      },
      reason: binary ? 'DeepSeek 餘額查詢成功。' : MISSING
    };
  }
  return {
    home,
    executable: binary,
    async status() {
      statusPending ??= inspect()
        .catch(error => ({installed: !!binary, available: false, reason: error.message}))
        .finally(() => {
          statusPending = null;
        });
      return statusPending;
    },
    async models() {
      if (catalog) return catalog;
      catalogPending ??= loadCatalog()
        .then(rows => (catalog = rows))
        .finally(() => {
          catalogPending = null;
        });
      return catalogPending;
    },
    prices
  };
}
