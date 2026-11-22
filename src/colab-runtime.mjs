// Lifecycle owner for the one Colab runtime K itself creates for self-hosted
// main agents. It never lists, reuses or deletes a runtime it did not create,
// never re-sends an inference, and only touches Colab when a real request asks
// for inference or the owner asks for status/stop (listing/opening/selecting is
// local only).
//
// Side effects are journaled BEFORE they are sent, in a private file holding only
// {name, phase, account} (no token):
//   create-sent  create_runtime was sent; until K reads the runtime back it may
//                still appear. Never re-sent. Not finding it once does not prove
//                the create ended, so this phase stays (blocking new creates)
//                until K sees the runtime or the owner clears it.
//   owned        K saw the runtime; a first delete may be sent.
//   delete-sent  delete_runtime was sent. Never re-sent: K only reads back and
//                clears the record once a well-formed list no longer has it.
// A journal that cannot be read, parsed or validated blocks every Colab action
// (it is never treated as "no record"); neither is a different consenting
// Google account allowed to read back or settle what another account created.
// `run: 'unsettled'` marks an inference whose result was not confirmed.
//
// Inference that may have run but whose result was lost is never sent again by
// K, and a request from the same native turn (identified by the room's native
// thread and turn, `caller`) is refused instead of re-running it on a new
// runtime: only a later turn reconciles it, by closing and reading back the old
// runtime before anything new is created.
//
// Rooms share the one runtime. A room whose native turn has used it holds it
// until K reports that turn over (`release`); while another room holds it, a
// room may reuse it as it is but can neither stop, replace nor recreate it.
//
// Creating a runtime spends Colab compute units and needs the owner's explicit,
// separate approval (`allowCreate`, private configuration bound to an account).
// Completing OAuth consent alone never permits a create.
//
// `client` is the Colab control adapter (colab-adapter.mjs). Contract:
//   authState()                    -> 'no-client'|'signed-out'|'signed-in'|'unknown' (local)
//   ready()                        -> void; throws (definitive) when sign-in is needed
//   account()                      -> email of the current authorization (no consent page)
//   planRuntime({source, contextWindow, signal}) -> plan (read-only; optional)
//   createRuntime({runtimeId, source, contextWindow, plan}) -> {name}
//                                     (error.definitive: refused before running, from a
//                                      structured transport/protocol outcome; any other
//                                      failure, whatever its wording, is unknown)
//   getRuntime(name, {signal})     -> {name}|null (null only on a well-formed listing without it)
//   deleteRuntime(name)            -> void
//   serve({name, model, source, contextWindow, signal}) -> {respond(bodyText, signal) -> Response}
//   endpoint({name, model, signal}) -> {respond} for an already serving runtime
//   close()                        -> void (optional)

import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {appendFile, mkdir, rm} from 'node:fs/promises';
import {atomicWrite} from './atomic-write.mjs';
import {redactSecrets, redactValue} from './secret-redact.mjs';

const NAME = /^runtimes\/k-[a-f0-9]{16}$/u;
const PHASES = new Set(['create-sent', 'owned', 'delete-sent']);
const PAUSED =
  'K 不會重送建立或關閉，也不會建立新的 runtime；下次送出或 colab_stop 時只讀回確認。仍確認不了時，請本人到 Colab 網頁核對。';
export const NOT_APPROVED =
  '本人尚未允許 K 建立 Colab runtime（開卡）。完成 Google 授權只代表 K 可以查詢與關閉，不代表同意開卡；未建立 runtime、未消耗運算單元、未送出推論。';

function failure(code, message, diagnostic, extra = {}) {
  const error = new Error(redactSecrets(message));
  error.code = code;
  if (diagnostic) error.diagnostic = redactValue(diagnostic);
  return Object.assign(error, extra);
}
const text = error => redactSecrets(error?.message ?? error);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// The private journal as read at K start: null (no file), {record} or {error}.
function fromJournal(journal) {
  if (!journal) return {slot: null, blocked: null};
  if (journal.error) return {slot: null, blocked: `K 的 Colab runtime 紀錄無法讀取（${journal.error}）`};
  const record = journal.record;
  const phase = record?.phase === 'creating' ? 'create-sent' : record?.phase;
  if (
    !record ||
    typeof record.name !== 'string' ||
    !NAME.test(record.name) ||
    !PHASES.has(phase) ||
    !(record.account === undefined || record.account === null || typeof record.account === 'string') ||
    !(record.run === undefined || record.run === 'unsettled')
  )
    return {slot: null, blocked: 'K 的 Colab runtime 紀錄格式無效'};
  return {
    slot: {
      name: record.name,
      phase,
      account: record.account ?? null,
      ready: false,
      carried: true,
      ...(record.run === 'unsettled'
        ? {carriedRun: true, runUnsettled: callerOf(record.caller) ?? {thread: null, turn: null}}
        : {})
    },
    blocked: null
  };
}
// The native room/turn of a request or tool call: {thread, turn} or null.
function callerOf(value) {
  return typeof value?.thread === 'string' && value.thread && typeof value?.turn === 'string' && value.turn
    ? {thread: value.thread, turn: value.turn}
    : null;
}

export function createColabRuntime({
  client = null,
  diagnosticsFile,
  stateFile,
  journal = null,
  allowCreate = false,
  account: expectedAccount = null
} = {}) {
  // slot: the single runtime K is responsible for, or null when K knows it holds
  // none. `ready` means this K served it; `runUnsettled` that an inference on it
  // was not confirmed; `reason` explains an unconfirmed phase.
  let {slot, blocked} = fromJournal(journal);
  if (blocked) blocked += `；${PAUSED}保留該私有紀錄，須先查明原有工作結果。`;
  else if (slot)
    slot.reason = slot.carriedRun
      ? `上次 K 在 Colab runtime ${slot.name} 上的推論結果未確認，runtime 尚未確認關閉`
      : `上次 K 留下 Colab runtime ${slot.name} 的紀錄（${slot.phase}），尚未確認關閉`;
  // Native thread -> turn of each room whose turn uses the runtime (see `release`).
  const holders = new Map();
  // A room other than `who` holds the runtime (any room when `who` is unknown).
  const heldByOther = who => [...holders.keys()].some(thread => thread !== who?.thread);
  const OTHER_ROOM =
    '另一個聊天室的回合正在使用這個 Colab runtime；K 不關閉、不更換也不重建它。請待該回合結束，或在該聊天室按停止。';
  let busy = false,
    starting = null,
    stopping = false,
    closing = null,
    drained = null,
    drain = null;
  const closeAbort = new AbortController();

  const finishOperation = () => {
    busy = false;
    drain?.();
    drain = null;
  };
  const reserve = () => {
    busy = true;
    drained = new Promise(resolve => (drain = resolve));
  };
  const unknown = (reason, diagnostic) => {
    if (slot) slot.reason = reason;
    return failure('k_selfhost_state_unknown', `${reason}；${PAUSED}`, diagnostic, {readback: 'unknown'});
  };
  const signals = signal => (signal ? AbortSignal.any([signal, closeAbort.signal]) : closeAbort.signal);

  // Persist only name, phase and consenting account; no token or connection detail.
  async function record(value) {
    if (!stateFile) return;
    if (value) await atomicWrite(stateFile, JSON.stringify({version: 1, ...value, at: new Date().toISOString()}));
    else await rm(stateFile, {force: true});
  }
  const persist = phase =>
    record({
      name: slot.name,
      phase,
      account: slot.account,
      ...(slot.runUnsettled
        ? {run: 'unsettled', ...(callerOf(slot.runUnsettled) ? {caller: slot.runUnsettled} : {})}
        : {})
    });
  async function forget() {
    slot = null;
    // If this fails the file keeps the last phase; the next K then only reads back.
    await record(null).catch(() => {});
  }
  async function note(reason, runtime) {
    if (!diagnosticsFile) return;
    await mkdir(path.dirname(diagnosticsFile), {recursive: true})
      .then(() =>
        appendFile(
          diagnosticsFile,
          JSON.stringify({at: new Date().toISOString(), event: 'colab-runtime-left', runtime, reason}) + '\n'
        )
      )
      .catch(() => {});
  }

  // The consenting account must be the one that created the journaled runtime:
  // another account's listing can never show it, so it proves nothing.
  async function checkAccount() {
    let current;
    try {
      current = await client.account();
    } catch (error) {
      throw unknown(`無法確認目前的 Colab 授權帳號，未讀回或關閉 ${slot.name}`, {error: text(error)});
    }
    if (!same(slot.account, current))
      throw unknown(
        `Colab runtime ${slot.name} 由 ${slot.account ?? '未記錄的帳號'} 建立，與目前授權帳號 ${current ?? '（未知）'} 不同；K 不以此帳號讀回、關閉或建立`
      );
  }
  async function present(name, signal) {
    try {
      return !!(await client.getRuntime(name, {signal}));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw unknown(`讀回 Colab runtime ${name} 失敗`, {error: text(error)});
    }
  }
  async function markOwned() {
    slot.phase = 'owned';
    // A failed write leaves create-sent on disk: the next K only reads back.
    await persist('owned').catch(() => {});
  }
  // Read-only confirmation after a delete was sent; never sends another delete.
  async function confirmGone(name, why) {
    if (await present(name)) throw unknown(`${why}；讀回時 Colab runtime ${name} 仍存在。K 不重送關閉`);
    await forget();
    return name;
  }
  // First (and only) delete of the runtime K owns, journaled before it is sent.
  async function removeOwned() {
    const name = slot.name;
    try {
      await persist('delete-sent');
    } catch (error) {
      throw failure(
        'k_selfhost_state_unknown',
        `無法寫入 Colab 關閉紀錄；K 未送出關閉命令，runtime ${name} 仍由 K 持有`,
        {error: text(error)},
        {readback: 'not-attempted'}
      );
    }
    slot.phase = 'delete-sent';
    stopping = true;
    try {
      try {
        await client.deleteRuntime(name);
      } catch (error) {
        if (error?.definitive === true) {
          // Refused before running: the runtime is still K's and still there.
          slot.phase = 'owned';
          await persist('owned').catch(() => {});
          throw failure('k_selfhost_stop_refused', `Colab 拒絕關閉 ${name}（未執行）：${text(error)}`, null, {
            readback: 'refused'
          });
        }
        return await confirmGone(name, `關閉 Colab runtime ${name} 的結果不明`);
      }
      return await confirmGone(name, '已送出關閉命令');
    } finally {
      stopping = false;
    }
  }
  // Bring K's slot to "none", or throw while leaving what is unconfirmed recorded.
  async function settle(signal) {
    if (blocked) throw failure('k_selfhost_state_unknown', blocked, null, {readback: 'unknown'});
    if (!slot) return [];
    await checkAccount();
    const name = slot.name;
    if (slot.phase === 'create-sent') {
      if (!(await present(name, signal)))
        throw unknown(`建立 Colab runtime ${name} 的結果仍未確認：目前查無此 runtime，但這不能證明建立已終止`);
      await markOwned();
      slot.ready = false;
    }
    if (slot.phase === 'delete-sent') return [await confirmGone(name, '先前送出的關閉尚未確認')];
    return [await removeOwned()];
  }

  return {
    // Local evidence only; never calls Colab.
    status(model, source) {
      const sourceKey = source === undefined ? undefined : JSON.stringify(source);
      const auth = client?.authState?.();
      if (!client || auth === 'no-client') return {state: 'unconfigured'};
      if (closing || stopping) return {state: 'stopping'};
      if (blocked) return {state: 'unknown', reason: blocked};
      if (starting) {
        if (starting.model === model && (sourceKey === undefined || starting.sourceKey === sourceKey))
          return {state: 'starting'};
      } else if (slot?.phase === 'create-sent')
        return {state: 'unknown', reason: slot.reason ?? `建立 ${slot.name} 的結果待確認`};
      if (slot?.phase === 'delete-sent')
        return {state: 'stop-unconfirmed', reason: slot.reason ?? `關閉 ${slot.name} 待確認`};
      if (slot?.runUnsettled) return {state: 'unknown', reason: slot.reason};
      if (slot?.phase === 'owned' && !slot.ready && !starting)
        return {state: 'stop-unconfirmed', reason: slot.reason ?? `Colab runtime ${slot.name} 尚未確認關閉`};
      const sameSource = sourceKey === undefined || slot?.sourceKey === sourceKey;
      if (slot?.ready && slot.model === model && sameSource) return {state: 'ready'};
      if (auth === 'signed-out') return {state: 'signin-required'};
      return {state: 'idle'};
    },
    runtimeName: () => slot?.name ?? null,
    policy: () => ({createAllowed: allowCreate === true, account: expectedAccount}),

    // A native turn that used the runtime is over (completed, failed,
    // interrupted, or its room closed): that room no longer holds it.
    release(caller) {
      const thread = typeof caller?.thread === 'string' ? caller.thread : null;
      if (thread && (caller.turn === undefined || holders.get(thread) === caller.turn)) holders.delete(thread);
    },

    async acquire({model, source, contextWindow, signal, caller} = {}) {
      if (!client || client.authState?.() === 'no-client')
        throw failure(
          'k_selfhost_colab_unconfigured',
          'Colab 尚未設定 OAuth 用戶端；未開啟授權頁、未建立 runtime、未消耗運算單元、未送出推論。'
        );
      if (closing) throw failure('k_selfhost_busy', 'K 正在關閉 Colab 連線；未建立 runtime、未送出推論。');
      if (busy)
        throw failure('k_selfhost_busy', 'Colab 模型目前忙碌中，未建立佇列、未送出推論；請待目前工作結束後再送出。');
      reserve();
      let leaseActive = false;
      const ops = signals(signal);
      const who = callerOf(caller);
      try {
        signal?.throwIfAborted();
        if (typeof model !== 'string' || !model || !source) throw new TypeError('model 與 source 必須提供');
        // The same native turn asking again after its inference result was lost
        // (e.g. the native core retrying) would re-run that inference: refused
        // without calling Colab. A request that cannot show its turn is refused too.
        const lost = slot?.runUnsettled;
        if (lost && (!who || !callerOf(lost) || (who.thread === lost.thread && who.turn === lost.turn)))
          throw failure(
            'k_selfhost_inference_unknown',
            `這個回合送到 Colab 的推論結果不明（可能已在 runtime ${slot.name} 上執行）；K 不重送、不建立新的 runtime，本回合結束。要再試請本人重新送出：K 會先關閉並讀回舊 runtime 再處理。`,
            null,
            {readback: 'unknown'}
          );
        // Sign-in comes first: no record, runtime or units before Colab accepts K.
        await client.ready();
        ops.throwIfAborted();
        if (blocked) throw failure('k_selfhost_state_unknown', blocked);

        let transport = null;
        const sourceKey = JSON.stringify(source);
        if (
          slot?.phase === 'owned' &&
          slot.ready &&
          !slot.runUnsettled &&
          slot.model === model &&
          slot.sourceKey === sourceKey
        ) {
          // Reuse only after reading back that K's own runtime still exists and serves.
          await checkAccount();
          let here;
          try {
            here = await present(slot.name, ops);
          } catch (error) {
            if (ops.aborted) throw error;
            throw failure('k_selfhost_prepare_failed', 'Colab runtime 讀回失敗；未送出推論。', error.diagnostic);
          }
          // A runtime K saw is no longer listed (e.g. Colab reclaimed it).
          if (!here) await forget();
          else
            try {
              transport = await client.endpoint({name: slot.name, model, signal: ops});
            } catch (error) {
              // Another room's turn is using it: leave it to that room.
              if (heldByOther(who)) {
                ops.throwIfAborted();
                throw failure('k_selfhost_prepare_failed', `Colab 模型服務檢查失敗；${OTHER_ROOM}未送出推論。`, {
                  error: text(error)
                });
              }
              // Health failed or was cancelled: the single exit closes and reads back.
              await removeOwned();
              ops.throwIfAborted();
            }
        }

        if (!transport) {
          // Everything below settles, replaces or creates the runtime.
          if (heldByOther(who)) throw failure('k_selfhost_busy', `${OTHER_ROOM}未建立 runtime、未送出推論。`);
          if (slot) await settle(ops);
          ops.throwIfAborted();
          if (closing) throw failure('k_selfhost_busy', 'K 正在關閉 Colab 連線；未建立 runtime、未送出推論。');
          if (allowCreate !== true)
            throw failure(
              'k_selfhost_colab_not_approved',
              `${NOT_APPROVED}登入與資格可請任一主代理用 colab_status 工具唯讀查詢，不會喚起自架模型。`
            );
          let account;
          try {
            account = await client.account();
          } catch (error) {
            throw failure('k_selfhost_prepare_failed', '無法確認 Colab 授權帳號；未建立 runtime。', {
              error: text(error)
            });
          }
          if (!account || (expectedAccount && !same(account, expectedAccount)))
            throw failure(
              'k_selfhost_colab_not_approved',
              `目前 Colab 授權帳號 ${account ?? '（未知）'} 不是本人允許開卡的帳號；未建立 runtime。`
            );
          let plan;
          if (client.planRuntime)
            try {
              plan = await client.planRuntime({source, contextWindow, signal: ops});
            } catch (error) {
              if (ops.aborted || /^k_selfhost_/u.test(error?.code ?? '')) throw error;
              throw failure('k_selfhost_prepare_failed', `Colab 規格查詢失敗；未建立 runtime。${text(error)}`);
            }
          ops.throwIfAborted();
          const name = `runtimes/k-${randomBytes(8).toString('hex')}`;
          try {
            await record({name, phase: 'create-sent', account});
          } catch (error) {
            throw failure('k_selfhost_prepare_failed', '無法記錄 Colab runtime 名稱；未建立 runtime。', {
              error: text(error)
            });
          }
          slot = {name, phase: 'create-sent', account, ready: false};
          starting = {model, sourceKey};
          let created;
          try {
            // Let this one create finish even if the caller stops: aborting the
            // HTTP call would not prove that Colab did not assign a runtime.
            created = await client.createRuntime({
              runtimeId: name.slice('runtimes/'.length),
              source,
              contextWindow,
              plan
            });
          } catch (error) {
            starting = null;
            if (error?.definitive === true) {
              await forget();
              throw failure(
                'k_selfhost_prepare_failed',
                `Colab 拒絕建立 runtime（未執行）；未送出推論。${text(error)}`
              );
            }
            // A tool error is no proof that Colab did not accept the create, and a
            // listing without the runtime is no proof that it ended: create-sent
            // stays recorded (no new create) until K sees it or the owner clears it.
            throw unknown(`建立 Colab runtime ${name} 的結果不明`, {error: text(error)});
          }
          if (created?.name !== name) {
            starting = null;
            throw unknown(`Colab 未回傳預期的 runtime 名稱 ${name}`, {
              readbackType: created === null ? 'null' : Array.isArray(created) ? 'array' : typeof created
            });
          }
          await markOwned();
          try {
            ops.throwIfAborted();
            if (closing) throw failure('k_selfhost_busy', 'K 正在關閉 Colab 連線；未送出推論。');
            transport = await client.serve({name, model, source, contextWindow, signal: ops});
            if (typeof transport?.respond !== 'function') throw new Error('Colab 模型服務未提供傳輸');
            ops.throwIfAborted();
          } catch (error) {
            starting = null;
            // Starting failed or was cancelled: release the runtime this request created.
            await removeOwned();
            throw signal?.aborted
              ? (signal.reason ?? error)
              : closing
                ? failure('k_selfhost_busy', 'K 正在關閉 Colab 連線；已關閉本次建立的 runtime，未送出推論。')
                : failure('k_selfhost_prepare_failed', 'Colab 模型準備失敗；已關閉本次建立的 runtime，未送出推論。', {
                    error: text(error),
                    ...(error?.step ? {step: error.step} : {})
                  });
          }
          starting = null;
          Object.assign(slot, {model, sourceKey, ready: true});
        }
        signal?.throwIfAborted();
        if (closing) throw failure('k_selfhost_busy', 'K 正在關閉 Colab 連線；未送出推論。');

        // Write ahead: a crash or a failed later journal write must not erase
        // the fact that the request may have reached inference.
        try {
          await record({
            name: slot.name,
            phase: slot.phase,
            account: slot.account,
            run: 'unsettled',
            ...(who ? {caller: who} : {})
          });
        } catch (error) {
          throw failure('k_selfhost_prepare_failed', '無法記錄 Colab 推論；未送出推論。', {error: text(error)});
        }
        ops.throwIfAborted();
        leaseActive = true;
        if (who) holders.set(who.thread, who.turn);
        let finished = false;
        return {
          model,
          upstream: transport,
          async finish({settled = true, cancelled = false} = {}) {
            if (finished) return;
            finished = true;
            try {
              // An aborted request does not prove remote inference stopped.
              // Release our runtime and read it back before accepting more work,
              // unless another room's turn is using it: then it stays, unsettled.
              if (cancelled && slot?.phase === 'owned' && !heldByOther(who)) await removeOwned();
              else if ((!settled || cancelled) && slot) {
                slot.runUnsettled = who ?? {thread: null, turn: null};
                slot.reason = '上一次 Colab 推論結果未確認';
                await persist(slot.phase).catch(() => {});
              } else if (slot) await persist(slot.phase).catch(() => {});
            } finally {
              leaseActive = false;
              finishOperation();
            }
          }
        };
      } catch (error) {
        if (
          (closing || (signal?.aborted && !heldByOther(who))) &&
          slot?.phase === 'owned' &&
          slot.ready &&
          !slot.runUnsettled
        )
          await removeOwned().catch(() => {});
        throw error;
      } finally {
        if (!leaseActive) finishOperation();
        starting = null;
      }
    },

    // Owner-requested stop (colab_stop tool) from the room/turn `caller`. Never
    // interrupts another room's active request or turn; the result reflects
    // K's own readback.
    async stop(caller) {
      if (!client)
        return {
          stopped: false,
          runtime: null,
          readback: 'none',
          message: 'Colab 控制尚未接通；K 沒有建立任何 runtime。'
        };
      if (closing) {
        await closing;
        const left = blocked ?? slot?.reason;
        return {
          stopped: !blocked && !slot,
          runtime: slot?.name ?? null,
          readback: blocked || slot ? 'unknown' : 'gone',
          message: left ?? 'K 已在關閉流程中處理自己的 Colab runtime。'
        };
      }
      if (busy)
        return {
          stopped: false,
          busy: true,
          runtime: slot?.name ?? null,
          readback: 'not-attempted',
          message: '另一個請求正在使用或啟動 Colab；K 沒有關閉 runtime。請待它結束，或在該聊天室按停止。'
        };
      if (heldByOther(callerOf(caller)))
        return {
          stopped: false,
          busy: true,
          runtime: slot?.name ?? null,
          readback: 'not-attempted',
          message: OTHER_ROOM
        };
      reserve();
      try {
        if (!blocked && !slot)
          return {
            stopped: true,
            runtime: null,
            readback: 'none',
            message: 'K 目前沒有自己建立的 Colab runtime；沒有需要關閉的項目，未呼叫 Colab。'
          };
        const names = await settle();
        return {
          stopped: true,
          runtime: names.at(-1),
          readback: 'gone',
          message: `已關閉 K 建立的 Colab runtime ${names.join('、')}，並讀回確認已不存在。`
        };
      } catch (error) {
        return {
          stopped: false,
          runtime: slot?.name ?? null,
          readback: error?.readback ?? 'unknown',
          message: text(error)
        };
      } finally {
        finishOperation();
      }
    },

    // Normal K shutdown: settle only K's own runtime (read first for unknown ones).
    // Whatever K could not confirm stays recorded for the next K and the owner.
    close() {
      if (closing) return closing;
      // Every bridge closes its own requests. Wait for their lease (including a
      // late create result), cancel read-only checks and model preparation, and
      // reject new acquire calls from this point on.
      closing = (async () => {
        closeAbort.abort(failure('k_selfhost_busy', 'K 正在關閉 Colab 連線。'));
        if (busy) await drained;
        if (!client) return;
        try {
          if (blocked || slot) await settle();
        } catch (error) {
          await note(text(error), slot?.name ?? null);
        } finally {
          client.close?.();
        }
      })();
      return closing;
    }
  };
}
