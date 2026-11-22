const MAX_QUESTION_LENGTH = 8000;

export const WORKER_QUESTION_GUIDANCE =
  '如缺少只有主代理能提供的資訊，且確實等到答覆才能繼續，請以單一 JSON 物件 {"k_worker_question":"請在此寫具體問題及必要上下文"} 結束本回合。完整回覆只能有這個 JSON 物件，最多 8000 字元的問題，不加 Markdown 或其他文字。一般成果與無須等待的疑問照常回報。收到答覆後從目前成果繼續，不重做已完成或結果未確認的工作。';

export function workerQuestionFrom(output) {
  // Require exactly one serialized field, including when JSON.parse would accept duplicate keys.
  if (typeof output !== 'string' || !/^\s*\{\s*"k_worker_question"\s*:\s*"(?:[^"\\]|\\[\s\S])*"\s*\}\s*$/u.test(output))
    return null;
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const question = typeof parsed?.k_worker_question === 'string' ? parsed.k_worker_question.trim() : '';
  return question && question.length <= MAX_QUESTION_LENGTH ? question : null;
}

export async function askWorkerParent(askParent, question, signal) {
  signal?.throwIfAborted();
  let abort;
  try {
    const stopped = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, {once: true});
    });
    const answer = await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return askParent(question);
      })
    ]);
    signal?.throwIfAborted();
    if (typeof answer !== 'string' || !answer.trim() || answer.trim().length > MAX_QUESTION_LENGTH)
      throw Error('主代理答覆無效，未送入子代理。');
    return `以下是主代理對剛才問題的答覆。沿用原任務和既定權限，據此接續工作。\n${JSON.stringify({answer: answer.trim()})}`;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
