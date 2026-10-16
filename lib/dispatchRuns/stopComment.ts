// The card comment a run's STOP report leaves (MOTIR-8722). PURE: the agent's finding and
// its re-plan brief in, markdown out — no I/O, no clock.
//
// A hosted or agent-instance run's agent holds no Motir token, so it cannot comment, move
// the card or submit a re-plan itself. It writes its finding and its brief into
// `$MOTIR_AGENT_REPORT`, and the CLI posts them with the run's own credential
// (`POST /api/v1/dispatch-runs/{id}/stop`). That credential holds no `ai:*` key
// (`HOSTED_RUN_TOKEN_GRANT`), so the re-plan cannot be SUBMITTED from the run: the brief
// is kept here, on the card, for the person who submits it — which is what the comment
// says, so nobody reads a card at Planning as a re-plan already on its way.

/**
 * motir-ai's `SettledRequirement` — the six named fields a re-plan carries, in the
 * canonical order (`REQUIREMENT_FIELDS`; `tests/fixtures/settledRequirement.ts` mirrors it).
 */
export const STOP_REQUIREMENT_FIELDS = [
  'outcome',
  'behaviour',
  'scopeEdge',
  'constraints',
  'acceptance',
  'assumptions',
] as const;

export type StopRequirementField = (typeof STOP_REQUIREMENT_FIELDS)[number];
export type StopRequirement = Partial<Record<StopRequirementField, string>>;

/** The bound on the finding and on each brief field, once trimmed. */
export const RUN_STOP_COMMENT_MAX = 4000;
export const RUN_STOP_FIELD_MAX = 2000;

const FIELD_LABEL: Record<StopRequirementField, string> = {
  outcome: 'Outcome',
  behaviour: 'Behaviour',
  scopeEdge: 'Scope edge',
  constraints: 'Constraints',
  acceptance: 'Acceptance',
  assumptions: 'Assumptions',
};

/**
 * Compose the comment body: the agent's finding verbatim, then — when the card goes to
 * Planning — the re-plan brief and the one line that says it was not submitted.
 */
export function composeStopComment(input: {
  comment: string;
  toPlanning: boolean;
  requirement: StopRequirement | null;
}): string {
  const lines: string[] = [input.comment.trim()];
  if (!input.toPlanning) return lines.join('\n');
  lines.push(
    '',
    '---',
    '',
    '**This run stopped and moved the card to Planning. Its re-plan was NOT submitted:** a ' +
      "run's own credential cannot start planning. Submit the re-plan from this card; the " +
      "agent's brief is below.",
  );
  const fields = STOP_REQUIREMENT_FIELDS.filter(
    (field) => input.requirement?.[field] !== undefined,
  );
  if (fields.length === 0) {
    lines.push('', 'The agent wrote no brief; the finding above is the whole of it.');
    return lines.join('\n');
  }
  lines.push('');
  for (const field of fields) {
    const value = (input.requirement?.[field] ?? '').trim();
    lines.push(`- **${FIELD_LABEL[field]}:** ${value === '' ? '_none_' : value}`);
  }
  return lines.join('\n');
}
