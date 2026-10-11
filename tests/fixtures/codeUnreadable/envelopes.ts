// RECORDED WIRE SHAPES of the code-graph outage signal (Story MOTIR-8136 · MOTIR-8143).
//
// Copied from motir-ai commit 197b700f (`codeUnreadableEnvelope()` in
// `src/jobs/planningEngine.ts`, the question handlers `askProject` / `debugBug` through
// `outageField()` in `src/llm/codeOutageRule.ts`, and `CodeUnreadableEnvelope` in
// `src/envelope.ts`). They are DATA, not imports of the sender's types: motir-core reads
// this envelope defensively across a network boundary, so the fixture IS the contract
// seam, and a test importing the sender's type would be testing the harness.

const HALT = {
  halt: 'code_unreadable',
  repoRef: 'acme/web',
  repoRefs: ['acme/web'],
  reason: 'snapshot_integrity',
} as const;

/** The plan-writing kinds that can halt, as the envelope names them in `jobKind`. */
export const PLAN_WRITING_KINDS = [
  'generate_tree',
  'draft',
  'expand_item',
  'replan',
  'augment',
  'revise_plan',
] as const;

/** A plan-writing job's halt envelope: an empty delta and the signal, no `turn`. */
export function planWritingHalt(jobKind: string) {
  return {
    envelopeVersion: 'v1',
    jobKind,
    planDelta: { operations: [] },
    summary: 'stopped: the code graph for acme/web could not be read, so no plan was written',
    usage: { inputTokens: 0, outputTokens: 0 },
    codeUnreadable: { ...HALT },
  };
}

/** A halt that also took proposals back off the plan. */
export function planWritingHaltWithdrawn(jobKind: string) {
  return {
    ...planWritingHalt(jobKind),
    codeUnreadable: { ...HALT, withdrawn: 2 },
  };
}

/** An `ask_project` job answered WITHOUT the code: the answer plus the signal. */
export function askAnsweredWithoutCode(answer: string, citations: string[] = []) {
  return {
    envelopeVersion: 'v1',
    jobKind: 'ask_project',
    planDelta: { operations: [] },
    summary: 'answered',
    ask: { intent: 'ask', answer, citations },
    codeUnreadable: { ...HALT },
  };
}

/** The same question with the graph readable: no signal. */
export function askAnswered(answer: string, citations: string[] = []) {
  return {
    envelopeVersion: 'v1',
    jobKind: 'ask_project',
    planDelta: { operations: [] },
    summary: 'answered',
    ask: { intent: 'ask', answer, citations },
  };
}

/** An ordinary planning turn's result (the planner speaking). */
export function ordinaryPlannerTurn(message: string) {
  return { turn: { action: 'draft', message, question: null } };
}

/** Results that carry nothing readable, or the field with the wrong type. */
export const MALFORMED_RESULTS: ReadonlyArray<readonly [string, unknown]> = [
  ['a null result', null],
  ['a string result', 'code_unreadable'],
  [
    'a null signal',
    { turn: { action: 'draft', message: 'a report', question: null }, codeUnreadable: null },
  ],
  [
    'a string signal',
    {
      turn: { action: 'draft', message: 'a report', question: null },
      codeUnreadable: 'code_unreadable',
    },
  ],
  [
    'an array signal',
    { turn: { action: 'draft', message: 'a report', question: null }, codeUnreadable: [HALT] },
  ],
  [
    'another halt',
    {
      turn: { action: 'draft', message: 'a report', question: null },
      codeUnreadable: { halt: 'something_else' },
    },
  ],
];
