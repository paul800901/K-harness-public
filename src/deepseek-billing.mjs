import path from 'node:path';
import {readdir, readFile, stat} from 'node:fs/promises';
import {zstdDecompressSync} from 'node:zlib';

// DeepSeek bills the human's API balance. K shows two separate reference points that need not match:
// the account balance (official, exact) and a per-room estimate (official token counts × the official
// price page). Nothing here changes billing; a failed lookup is shown as unknown, never guessed.
const DAY_MS = 12 * 60 * 60 * 1000;
// Each lookup ends on its own: opening a room or finishing a turn never waits on a stalled network.
const timeout = () => AbortSignal.timeout(15000);
export const BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const PRICE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
export const FX_URL = 'https://open.er-api.com/v6/latest/CNY';

export async function deepseekBalance(apiKey, {fetchImpl = fetch, signal = timeout()} = {}) {
  const response = await fetchImpl(BALANCE_URL, {headers: {Authorization: `Bearer ${apiKey}`}, signal});
  if (response.status === 401) throw Error('DeepSeek API 金鑰無效或已撤銷。');
  if (!response.ok) throw Error(`DeepSeek 餘額查詢失敗（${response.status}）。`);
  const data = await response.json(),
    rows = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const amount = currency => {
    const row = rows.find(r => r?.currency === currency),
      value = Number(row?.total_balance);
    return row && Number.isFinite(value) ? value : null;
  };
  return {available: data?.is_available === true, cny: amount('CNY'), usd: amount('USD')};
}

// One public daily rate (no key, nothing personal sent). Only used to show an approximate NT$ beside
// the balance; the official balance stays in its own currency.
export async function cnyRates({fetchImpl = fetch, signal = timeout()} = {}) {
  const response = await fetchImpl(FX_URL, {signal});
  if (!response.ok) throw Error(`匯率查詢失敗（${response.status}）。`);
  const data = await response.json(),
    twd = Number(data?.rates?.TWD),
    usd = Number(data?.rates?.USD);
  if (data?.result !== 'success' || !(twd > 0) || !(usd > 0)) throw Error('匯率資料無效。');
  return {twdPerCny: twd, usdPerCny: usd, updatedAt: data.time_last_update_utc ?? null, source: 'ExchangeRate-API'};
}

const cells = html =>
  html
    .replace(/<(?:td|th)\b[^>]*>/giu, '\u0001')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .split('\u0001')
    .map(text => text.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
const yuan = text => {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*元$/u.exec(text ?? '');
  return match ? Number(match[1]) : NaN;
};
// Parses the official Chinese price page: per model, CNY per million tokens for cache-hit input,
// cache-miss input and output, each at off-peak and peak; plus web search / fetch per request.
export function parseDeepseekPrices(html) {
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/giu)].map(m => cells(m[0]));
  const main = tables.find(t => t.includes('模型') && t.some(c => c.includes('百万tokens输出')));
  if (!main) throw Error('官方價格頁格式已改變。');
  const models = [];
  for (let i = main.indexOf('模型') + 1; i < main.length && /^deepseek-/u.test(main[i]); i++)
    models.push(main[i].replace(/\s*\(\d+\)$/u, ''));
  if (!models.length) throw Error('官方價格頁找不到模型。');
  const row = label => {
    const at = main.findIndex(c => c.replace(/\s/gu, '').includes(label));
    const read = period => {
      const index = main.indexOf(period, at);
      return models.map((_, k) => yuan(main[index + 1 + k]));
    };
    return at < 0 ? null : {offPeak: read('空闲时段'), peak: read('高峰时段')};
  };
  const hit = row('输入（缓存命中）'),
    miss = row('输入（缓存未命中）'),
    out = row('百万tokens输出');
  const prices = {};
  models.forEach((model, k) => {
    const pick = r => ({offPeak: r?.offPeak?.[k], peak: r?.peak?.[k]});
    prices[model] = {cacheHit: pick(hit), cacheMiss: pick(miss), output: pick(out)};
  });
  for (const [model, p] of Object.entries(prices))
    for (const kind of Object.values(p))
      if (!(kind.offPeak >= 0) || !(kind.peak >= 0)) throw Error(`官方價格頁的 ${model} 單價無法辨識。`);
  // Retired names the page itself lists as billed at a current price ("旧模型名 … 按 Flash 价格计费").
  const aliases = {},
    text = html.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' '),
    note = /旧模型名([^。]{0,400}?)按\s*([A-Za-z]+)\s*价格计费/u.exec(text);
  const target = note && models.find(model => model === `deepseek-${note[2].toLowerCase()}`);
  if (target) for (const name of note[1].match(/deepseek-[\w.-]*[\w]/gu) ?? []) aliases[name] = target;
  return {models: prices, aliases};
}

// The price page: Beijing time, Monday–Friday 9:00–12:00 and 14:00–18:00 are peak. China's public
// holidays are not known to K, so a holiday weekday is priced as peak (the estimate may run high).
export function deepseekPeak(time) {
  const beijing = new Date(time + 8 * 60 * 60 * 1000),
    day = beijing.getUTCDay(),
    minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return day >= 1 && day <= 5 && ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080));
}

// Only an official model name, or a retired name the page lists, has a price; anything else stays unknown.
const priceFor = (prices, model) => prices.models[model] ?? prices.models[prices.aliases?.[model]] ?? null;

// Native DSH session log: one JSONL record per event, zstd-compressed, appended as DSH works. Only usage
// numbers, model names, times, turn / goal / background-job boundaries and web tool calls are read;
// message text is never kept.
export async function dshSessionFolder(home, nativeSessionId) {
  if (!/^[0-9a-f-]{36}$/iu.test(nativeSessionId ?? '')) return null;
  // Only a path that does not exist means 'no log yet'; any other failure (permissions, I/O) is reported.
  const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
  const sessions = path.join(home, 'sessions');
  let workspaces;
  try {
    workspaces = await readdir(sessions);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  for (const workspace of workspaces) {
    const folder = path.join(sessions, workspace, nativeSessionId);
    try {
      await readdir(folder);
      return folder;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return null;
}
// The last log read, reused while the file is unchanged (state and usage read the same log).
let cached = null;
async function sessionLog(home, nativeSessionId) {
  const folder = await dshSessionFolder(home, nativeSessionId);
  if (!folder) return null;
  let best = null;
  for (const name of await readdir(folder)) {
    const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/u.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (!best || version > best.version) best = {file: path.join(folder, name), version, zstd: !!match[2]};
  }
  if (!best) return null;
  const info = await stat(best.file);
  if (cached?.file === best.file && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.text;
  const bytes = await readFile(best.file);
  const text = (best.zstd ? zstdDecompressSync(bytes) : bytes).toString('utf8');
  cached = {file: best.file, size: info.size, mtimeMs: info.mtimeMs, text};
  return text;
}
const events = (text, needles) =>
  text
    .split('\n')
    .filter(line => needles.some(needle => line.includes(needle)))
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/**
 * Whether DSH is still working on its own, from its log: an open turn, a turn queued by a goal round or a
 * finished background job (spliced into the inbox and not yet started), or a background job still running.
 * Also the current goal and running jobs, for display.
 */
export async function dshSessionState(home, nativeSessionId, {afterSeq = -Infinity} = {}) {
  const text = await sessionLog(home, nativeSessionId);
  if (text === null) return null;
  let open = false,
    queued = false,
    openAt = -1,
    queuedAt = -1,
    lastSeq = -1,
    goal = null;
  const jobs = new Map();
  for (const event of events(text, ['"turn/', '"agent/inbox/spliced"', '"goal/change"', '"job/'])) {
    const data = event.data ?? {};
    const at = Number.isFinite(event.seq) ? event.seq : -1;
    if (event.type === 'turn/start') {
      open = true;
      openAt = at;
      queued = false;
    } else if (event.type === 'turn/end') open = false;
    else if (event.type === 'agent/inbox/spliced' && data.target === 'next-turn' && data.inserted?.length && !open) {
      queued = true;
      queuedAt = at;
    }
    else if (event.type === 'goal/change')
      goal =
        data.operation === 'clear' || !data.goal
          ? null
          : {
              objective: String(data.goal.objective ?? ''),
              status: String(data.goal.phase ?? 'unknown'),
              rounds: Number(data.roundsStarted) || 0,
              maxRounds: Number(data.goal.maxGoalRounds) || null
            };
    else if (event.type === 'job/registered' && data.jobId)
      jobs.set(data.jobId, {label: String(data.label ?? data.kind ?? ''), at});
    else if (event.type === 'job/settled') jobs.delete(data.jobId);
  }
  // DSH appends in sequence: the last record carries the latest sequence number.
  // An empty log, or one holding only DSH's session header, has none (-1); an unreadable last record leaves
  // it unknown (NaN), never 'from the start'.
  const tail = text.trimEnd();
  if (tail)
    try {
      const last = JSON.parse(tail.slice(tail.lastIndexOf('\n') + 1));
      lastSeq = last.type === 'session' && !tail.includes('\n') ? -1 : Number(last.seq);
    } catch {
      lastSeq = NaN;
    }
  // Turns and jobs from before this process took the session were ended with their process.
  const live = [...jobs].filter(([, job]) => job.at > afterSeq);
  open &&= openAt > afterSeq;
  queued &&= queuedAt > afterSeq;
  return {
    lastSeq,
    running: open || queued || live.length > 0,
    open,
    queued,
    jobs: live.map(([id, job]) => ({id, label: job.label.slice(0, 200)})),
    goal
  };
}
/**
 * The permission DSH will actually use for this session. DSH pins sandbox mode and approval policy in the
 * session log, and on resume the logged values outrank the process's DSH_PERMISSION_MODE; ACP offers no
 * way to change them. Returns the matching K access mode, 'custom' for any other combination, or null when
 * the log has no permission record yet (the process setting then applies).
 */
export async function dshSessionAccess(home, nativeSessionId) {
  const text = await sessionLog(home, nativeSessionId);
  if (text === null) return null;
  let sandbox = null,
    approval = null;
  for (const event of events(text, ['"sandbox/mode"', '"approval/policy"']))
    if (event.type === 'sandbox/mode') sandbox = event.data?.mode ?? null;
    else if (event.type === 'approval/policy') approval = event.data?.policy ?? null;
  if (sandbox === null && approval === null) return null;
  const expected = {'read-only': 'ask', 'workspace-write': 'ask', 'danger-full-access': 'never'};
  return sandbox in expected && approval === expected[sandbox] ? sandbox : 'custom';
}
export async function dshSessionUsage(home, nativeSessionId) {
  const text = await sessionLog(home, nativeSessionId);
  if (text === null) return null;
  const steps = [];
  let searches = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') && !line.includes('"tool/call"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event?.data ?? {};
    if (event.type === 'assistant/message' && data.usage && typeof data.message?.source?.model === 'string')
      steps.push({
        time: event.time,
        model: data.message.source.model,
        input: Number(data.usage.inputTokens) || 0,
        cacheRead: Number(data.usage.cacheReadTokens) || 0,
        output: Number(data.usage.outputTokens) || 0
      });
    else if (event.type === 'tool/call' && data.name === 'web_search') searches++;
  }
  return {steps, searches};
}

// DSH's latest event sequence in the log, or -1 when there is none yet.
// No log yet: -1. A log that cannot be read or whose last record has no sequence: an error.
export async function dshLastSeq(home, nativeSessionId) {
  const state = await dshSessionState(home, nativeSessionId);
  if (!state) return -1;
  if (!Number.isFinite(state.lastSeq)) throw Error('DeepSeek 原生紀錄的最後一筆無法讀取；未使用這個程序，未送出。');
  return state.lastSeq;
}

/**
 * Room totals and the CNY estimate of model tokens. Steps whose model has no official price stay uncounted and
 * are reported. Web searches are only counted: one search may be several billed requests plus a model call,
 * which DSH's log does not record, so their cost is reported as not included rather than guessed.
 */
export function deepseekRoomCost(usage, prices) {
  const tokens = {input: 0, cacheRead: 0, output: 0};
  let cny = 0,
    priced = 0,
    unpriced = 0;
  for (const step of usage?.steps ?? []) {
    tokens.input += step.input;
    tokens.cacheRead += step.cacheRead;
    tokens.output += step.output;
    const price = prices && priceFor(prices, step.model);
    if (!price) {
      unpriced++;
      continue;
    }
    priced++;
    const period = deepseekPeak(step.time) ? 'peak' : 'offPeak';
    cny +=
      (step.input * price.cacheMiss[period] +
        step.cacheRead * price.cacheHit[period] +
        step.output * price.output[period]) /
      1e6;
  }
  return {
    tokens,
    cny: !prices || (unpriced && !priced) ? null : cny,
    pricesAvailable: !!prices,
    unpriced,
    searches: usage?.searches ?? 0
  };
}

/** A small cache for the daily lookups; a failure keeps the last good value with its own date. */
export function createDailyCache(load, {ttl = DAY_MS} = {}) {
  let value = null,
    at = 0,
    pending = null;
  return async () => {
    if (value && Date.now() - at < ttl) return value;
    pending ??= load()
      .then(result => {
        value = result;
        at = Date.now();
        return result;
      })
      .catch(error => {
        if (value) return value;
        throw error;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
export async function fetchDeepseekPrices({fetchImpl = fetch, signal = timeout()} = {}) {
  const response = await fetchImpl(PRICE_URL, {signal, headers: {'User-Agent': 'Mozilla/5.0'}});
  if (!response.ok) throw Error(`官方價格頁讀取失敗（${response.status}）。`);
  return {...parseDeepseekPrices(await response.text()), checkedAt: new Date().toISOString(), source: PRICE_URL};
}
