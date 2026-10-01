import type { TranscriptEvent, TurnEndReason, TurnFailCode } from '@/lib/agentChat/protocol';

// THE TRANSCRIPT, AS ROWS (Story MOTIR-6863 · MOTIR-7017) — `agent-chat.md` Q5's
// seven event kinds folded into what the Chat tab draws
// (`design/my-agents/design-notes.md` § the Chat tab, panels 2–4):
//
//   user         the developer's prompt
//   text         assistant prose; deltas with one id, in one turn, join
//   tool_call    ONE row, which its `tool_result` (same id, same turn) completes
//   turn_end     the marker; it also ends the turn that is running
//   error        an inline notice that does NOT end the turn
//   other        one quiet line naming an event nobody mapped
//
// Pure: no I/O, no logging — the rows live in component state and nowhere else
// (Q10).

export type ToolCallEvent = Extract<TranscriptEvent, { k: 'tool_call' }>;
export type ToolResultEvent = Extract<TranscriptEvent, { k: 'tool_result' }>;

export type ChatRow =
  | { type: 'user'; key: string; text: string }
  | { type: 'text'; key: string; text: string }
  | { type: 'tool'; key: string; call: ToolCallEvent; result: ToolResultEvent | null }
  | { type: 'turn_end'; key: string; reason: TurnEndReason; code?: TurnFailCode }
  | { type: 'error'; key: string; code: string; message?: string }
  | { type: 'other'; key: string; name: string };

export interface Transcript {
  rows: ChatRow[];
  /** The live turn that has not ended, or null. */
  runningTurn: number | null;
  /** `${scope}:${id}` → row index, for text deltas and tool results. */
  index: Readonly<Record<string, number>>;
  /** The history's own turn counter: its events carry no turn number. */
  historyTurn: number;
  /** A monotonic row key. */
  seq: number;
}

export function emptyTranscript(): Transcript {
  return { rows: [], runningTurn: null, index: {}, historyTurn: 0, seq: 0 };
}

/**
 * Fold one event into the transcript. `turn` is the live turn number, or
 * `'history'` for a resume's earlier turns (which the server sends without one).
 */
export function applyEvent(
  t: Transcript,
  turn: number | 'history',
  e: TranscriptEvent,
): Transcript {
  const scope = turn === 'history' ? `h${t.historyTurn}` : `t${turn}`;
  const running = turn === 'history' ? t.runningTurn : turn;
  const key = `r${t.seq}`;
  const push = (row: ChatRow, indexKey?: string): Transcript => ({
    ...t,
    rows: [...t.rows, row],
    runningTurn: running,
    index: indexKey ? { ...t.index, [indexKey]: t.rows.length } : t.index,
    seq: t.seq + 1,
  });
  const replace = (at: number, row: ChatRow): Transcript => {
    const rows = t.rows.slice();
    rows[at] = row;
    return { ...t, rows, runningTurn: running };
  };

  switch (e.k) {
    case 'user':
      return push({ type: 'user', key, text: e.text });
    case 'text': {
      const at = t.index[`${scope}:text:${e.id}`];
      const row = at === undefined ? undefined : t.rows[at];
      if (row && row.type === 'text') return replace(at!, { ...row, text: row.text + e.delta });
      return push({ type: 'text', key, text: e.delta }, `${scope}:text:${e.id}`);
    }
    case 'tool_call': {
      const at = t.index[`${scope}:tool:${e.id}`];
      const row = at === undefined ? undefined : t.rows[at];
      // A call re-announced (an adapter that emits it started, then completed).
      if (row && row.type === 'tool') return replace(at!, { ...row, call: e });
      return push({ type: 'tool', key, call: e, result: null }, `${scope}:tool:${e.id}`);
    }
    case 'tool_result': {
      const at = t.index[`${scope}:tool:${e.id}`];
      const row = at === undefined ? undefined : t.rows[at];
      if (row && row.type === 'tool') return replace(at!, { ...row, result: e });
      // A result with no call: drawn as an `other`-kind row so its output is not lost.
      return push(
        {
          type: 'tool',
          key,
          call: { k: 'tool_call', id: e.id, kind: 'other', name: '', title: '' },
          result: e,
        },
        `${scope}:tool:${e.id}`,
      );
    }
    case 'turn_end': {
      const next = push({
        type: 'turn_end',
        key,
        reason: e.reason,
        ...(e.code ? { code: e.code } : {}),
      });
      return {
        ...next,
        // This turn is over; a different one still running (never, on one agent) stays.
        runningTurn:
          turn === 'history' || (t.runningTurn !== null && t.runningTurn !== turn)
            ? t.runningTurn
            : null,
        historyTurn: turn === 'history' ? t.historyTurn + 1 : t.historyTurn,
      };
    }
    case 'error':
      return push({
        type: 'error',
        key,
        code: e.code,
        ...(e.message !== undefined ? { message: e.message } : {}),
      });
    case 'other':
      return push({ type: 'other', key, name: e.name });
  }
}

/** `+added −removed` from a unified diff (headers excluded). */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/** The number of lines in a text, ignoring one trailing newline. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}
