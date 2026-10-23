// A `log_bug` offer as motir-ai's answering session returns it (MOTIR-9321's
// `AskLogBugOffer`), for the bug-offer suites (Story MOTIR-9220).

export const BUG_REF = 'lib/comments/save.ts';

/** A draft that passes `parseAuthoredBug`, grounded on {@link BUG_REF}. */
export function bugDraft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptionMd: [
      'Saving a comment strips the @mention before it is stored.',
      '',
      '## Acceptance criteria',
      '',
      '- A saved comment keeps its @mention',
      '',
      '## Context refs',
      '',
      `- \`${BUG_REF}\``,
    ].join('\n'),
    explanationMd: 'Mentioned people are never notified.',
    type: 'code',
    executor: 'coding_agent',
    storyPoints: 2,
    estimateMinutes: 45,
    difficulty: 'low',
    contextRefs: [BUG_REF],
    candidateMechanisms: [],
    grounded: true,
    groundingReason: 'indexed',
    ...over,
  };
}

/** The whole offer; `target` defaults to a new bug. */
export function logBugOffer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'log_bug',
    title: 'Saving a comment drops the @mention',
    acceptanceCriteria: ['A saved comment keeps its @mention'],
    draft: bugDraft(),
    target: { kind: 'new', key: null },
    contextRefs: [BUG_REF],
    ...over,
  };
}
