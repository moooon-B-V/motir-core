import type { GuideAction, GuideActionOutcome, GuideTurnRecord } from '@/lib/ai/guideWorkItem';

// THE NOTES A GUIDE TURN'S REPLY CARRIES (MOTIR-7800 wrote them; MOTIR-7811 moved
// them here) — pure, so the landing that APPENDS them and the rail that must
// recompute them agree byte for byte.
//
// The landing stores `[messageMd, guideFiledNote, guideSkippedNote].join('\n\n')`
// as the reply body: the stored body is what every non-rail reader sees (the next
// guide turn's model context, any thread reader), so it stays unchanged. The RAIL
// draws a filed bug as an outcome line (design MOTIR-7810, decision (a)), so it
// renders the body WITHOUT the filed note and without a duplicate's bullet —
// {@link guideRailBody} strips the EXACT suffix recomputed from the turn record,
// never a pattern match on the prose.

/** The separator the landing joins the reply and its notes with. */
const NOTE_JOIN = '\n\n';

/** The words appended to the reply when an action was skipped, so the turn says
 *  what did not happen and why (A2.4). */
export function guideSkippedNote(outcomes: readonly GuideActionOutcome[]): string | null {
  const skipped = outcomes.filter((o) => o.outcome === 'skipped');
  if (skipped.length === 0) return null;
  return [
    'Some of that did not land:',
    ...skipped.map((o) => `- ${o.type.replace(/_/g, ' ')}: ${o.reason ?? 'refused'}`),
  ].join('\n');
}

/** The words appended to the reply naming each bug the turn FILED, by key and
 *  title (MOTIR-7800). A refused filing is in {@link guideSkippedNote} instead,
 *  with its reason. */
export function guideFiledNote(
  actions: readonly GuideAction[],
  outcomes: readonly GuideActionOutcome[],
): string | null {
  const filed = outcomes.flatMap((o, i) => {
    const action = actions[i];
    return o.type === 'file_bug' &&
      o.outcome === 'landed' &&
      o.workItemKey &&
      action?.type === 'file_bug'
      ? [`- ${o.workItemKey}: ${action.title}`]
      : [];
  });
  if (filed.length === 0) return null;
  return [filed.length === 1 ? 'Filed a bug:' : 'Filed bugs:', ...filed].join('\n');
}

/** The notes the landing appends to a turn's reply, in the order it appends them. */
function replyNotes(
  actions: readonly GuideAction[],
  outcomes: readonly GuideActionOutcome[],
): string[] {
  return [guideFiledNote(actions, outcomes), guideSkippedNote(outcomes)].filter(
    (n): n is string => n !== null,
  );
}

/** The stored reply body: the model's message, then the notes. The landing's
 *  one writer of it. */
export function guideReplyBody(
  messageMd: string,
  actions: readonly GuideAction[],
  outcomes: readonly GuideActionOutcome[],
): string {
  return [messageMd, ...replyNotes(actions, outcomes)].join(NOTE_JOIN);
}

/**
 * The reply body as the RAIL renders it (design MOTIR-7810, decision (a)): a turn
 * that carries a `file_bug` loses the filed note and the duplicate's bullet,
 * because its outcome lines name both; a refusal with no key (the cap, one per
 * turn) stays in the *did not land* note exactly as written.
 *
 * Exact recomputation: the suffix the landing appended is rebuilt from the
 * record and removed only when the body ends with it. A body that does not (an
 * older shape, an edited row) renders untouched. A turn with no `file_bug`
 * renders exactly as stored.
 */
export function guideRailBody(body: string, record: GuideTurnRecord | null | undefined): string {
  if (!record || !record.actions.some((a) => a.type === 'file_bug')) return body;
  const notes = replyNotes(record.actions, record.outcomes);
  if (notes.length === 0) return body;
  const suffix = NOTE_JOIN + notes.join(NOTE_JOIN);
  if (!body.endsWith(suffix)) return body;
  const head = body.slice(0, body.length - suffix.length);
  const keyless = guideSkippedNote(record.outcomes.filter((o) => !o.workItemKey));
  return keyless === null ? head : head + NOTE_JOIN + keyless;
}
