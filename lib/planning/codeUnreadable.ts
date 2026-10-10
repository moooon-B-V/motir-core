// The CONSUMING half of motir-ai's code-graph outage signal (Story MOTIR-8136 ·
// MOTIR-8141): reading, off a job result, whether the job met an UNREADABLE code graph.
//
// Same posture as `askResult.ts` and `plannerTurn.ts` beside it, for the same reason: the
// field crosses a network boundary from a separately deployed service, every branch of it
// becomes a persisted column, and a result that carries nothing readable is not an error —
// it is a job with no outage to report. So the read is TOTAL over any input (an arbitrary
// JSON value is a legitimate argument and yields `null`, never a throw), and the default for
// anything malformed is the ORDINARY turn.
//
// WHAT IT READS, AND WHAT IT DELIBERATELY DOES NOT. The render contract
// (`design/code-context/design-notes.md` §17.6) is exactly two facts: the turn KIND and the
// PRESENCE of the signal. The signal motir-ai sets is `codeUnreadable: { halt:
// 'code_unreadable', repoRef, repoRefs, reason, … }`; the repository and the reason are the
// operator's, never the person's, so they are not read here at all.
//
// The kind is told by the result's own unit, as motir-ai documents it: a question job
// (`ask_project` / `debug_bug`) carries an `ask` / `debugBug` unit and was ANSWERED; a
// plan-writing job carries neither and was HALTED, writing no plan.

/** How the outage touched the turn — the stored face. */
export type CodeUnreadableFace = 'declined' | 'answered';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `'declined'` — a plan-writing job halted on the outage and wrote no plan.
 * `'answered'` — a question job (`ask` or `debugBug` unit) was answered without the code.
 * `null` — no outage signal, or one that is not the `code_unreadable` halt.
 */
export function readCodeUnreadable(result: unknown): CodeUnreadableFace | null {
  if (!isRecord(result)) return null;
  const signal = result['codeUnreadable'];
  if (!isRecord(signal) || signal['halt'] !== 'code_unreadable') return null;
  const isQuestion = isRecord(result['ask']) || isRecord(result['debugBug']);
  return isQuestion ? 'answered' : 'declined';
}
