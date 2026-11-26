import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';

// agy may omit the prompt echo on a retained process. Only move an already
// received reply if the native conversation independently records that exact pair.
export async function restoreGeminiReplyOrder(messages, home, sessionId, onlyUser) {
  const candidates = [];
  for (let i = 1; i < messages.length; i++) {
    const user = messages[i], reply = messages[i - 1];
    if ((!onlyUser || user === onlyUser) && user.role === 'user' && user.text && user.groupId &&
        reply.role === 'assistant' && reply.partial && reply.groupId === user.groupId && reply.text &&
        !messages.some(other => other !== reply && other.role === 'assistant' && other.groupId === user.groupId))
      candidates.push({i, user, reply, text: reply.text, hits: 0, confirmed: false});
  }
  if (!candidates.length || !/^[a-f0-9-]{36}$/i.test(sessionId ?? '')) return;
  const file = path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
  const stream = createReadStream(file, {encoding: 'utf8'});
  try {
    let current = null;
    for await (const line of createInterface({input: stream, crlfDelay: Infinity})) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.type === 'USER_INPUT') {
        current = null;
        if (row.source !== 'USER_EXPLICIT' || row.status !== 'DONE' || typeof row.content !== 'string') continue;
        const time = Date.parse(row.created_at);
        const matching = candidates.filter(({user, reply}) => {
          const input = '<USER_REQUEST>\n' + user.text + '\n</USER_REQUEST>';
          return time >= Math.floor(Date.parse(user.createdAt) / 1000) * 1000 && time <= Date.parse(reply.createdAt) &&
            (row.content === input || row.content.startsWith(input + '\n<ADDITIONAL_METADATA>'));
        });
        for (const candidate of matching) candidate.hits++;
        if (matching.length === 1) current = matching[0];
      } else if (current && row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE') {
        current.confirmed = row.status === 'DONE' && !row.tool_calls?.length && row.content === current.text;
      }
    }
  } catch {
    // Missing, incomplete or unrecognised evidence cannot establish ownership.
    return;
  } finally {
    stream.destroy();
  }
  for (const {i, user, reply, text, hits, confirmed} of candidates) {
    if (hits !== 1 || !confirmed || reply.text !== text || messages[i] !== user || messages[i - 1] !== reply) continue;
    messages[i - 1] = user;
    messages[i] = reply;
    if (onlyUser) return reply;
  }
}
