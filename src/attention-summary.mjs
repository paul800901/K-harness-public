// The small status the phone app's ongoing notification needs: which rooms have an
// unread completion (with their titles) and how many are working (main agent or sub-agents). Derived from the
// same live state the desktop taskbar badge reads; nothing is stored.
export function attentionSummary(state) {
  const rooms = new Map((state?.conversationActivity ?? []).map(room => [room.threadId, room]));
  const attention = state?.completionAttention;
  return {
    sequence: Number.isFinite(attention?.sequence) ? attention.sequence : 0,
    unread: (Array.isArray(attention?.unread) ? attention.unread : []).map(item => ({
      threadId: item.threadId,
      sequence: item.sequence,
      kind: item.kind === 'attention' ? 'attention' : 'completed',
      title: rooms.get(item.threadId)?.title || '未命名聊天室'
    })),
    // A room whose main agent waits while its sub-agents still run is not idle.
    working: [...rooms.values()].filter(room => room.busy || room.pendingWorkers > 0 || room.backgroundWork).length
  };
}
