// motir-ai's `SettledRequirement` contract, mirrored on THIS side of the
// boundary (Story MOTIR-3942 · MOTIR-4172).
//
// ⚠️ THIS FILE IS A FIXTURE, NOT AN IMPLEMENTATION. Nothing in `lib/` imports
// it and nothing should: motir-core is the PRODUCER of `context.requirement`
// and deliberately validates none of it (a partial requirement is a legal
// submit that simply does not settle the planner's first phase). The only
// validator is motir-ai's `buildRequirement`, which runs where a half-answer
// can open a conversation rather than fail a call.
//
// What it IS for is the seam that failed once already (MOTIR-4168): the WHAT's
// producer and consumer named different shapes, and each half would have passed
// its own tests while the feature did not exist. A test that asserts only "the
// object I sent came back" re-creates exactly that — it is true of any object.
// So the assertions here are written against motir-ai's OWN field list and its
// OWN required-non-empty names, copied verbatim below, and a drift on EITHER
// side fails HERE rather than at a planning run in production.
//
// Source, read on `origin/main` at the time of writing:
//   motir-ai `src/jobs/conversation.ts` — `REQUIREMENT_FIELDS`,
//   `REQUIREMENT_REQUIRED_NON_EMPTY`, `buildRequirement`, `SettledRequirement`.

/** motir-ai's `REQUIREMENT_FIELDS`, in ITS order — which is the canonical one. */
export const AI_REQUIREMENT_FIELDS = [
  'outcome',
  'behaviour',
  'scopeEdge',
  'constraints',
  'acceptance',
  'assumptions',
] as const;

/**
 * motir-ai's `REQUIREMENT_REQUIRED_NON_EMPTY` — the three a planning phase
 * cannot finish without. The other three may be the empty string, which says
 * *considered, and there is none*; that is an ANSWER, and a different one from
 * never having asked.
 */
export const AI_REQUIREMENT_REQUIRED_NON_EMPTY = ['outcome', 'behaviour', 'acceptance'] as const;

/**
 * motir-ai's `buildRequirement`, reduced to its VERDICT — does this value
 * satisfy the consumer, yes or no.
 *
 * Deliberately mirrors the original's structure rather than its error strings:
 * a missing KEY is refused for every field, and an empty VALUE is refused only
 * for the three above. Trimming before the presence test would collapse
 * *absent* and *explicitly empty* into one and delete the distinction the field
 * list exists for — so it does not.
 */
export function satisfiesBuildRequirement(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const bag = input as Record<string, unknown>;
  for (const field of AI_REQUIREMENT_FIELDS) {
    const value = bag[field];
    if (typeof value !== 'string') return false;
    if (
      (AI_REQUIREMENT_REQUIRED_NON_EMPTY as readonly string[]).includes(field) &&
      value.trim().length === 0
    ) {
      return false;
    }
  }
  return true;
}

/** A requirement the far side ACCEPTS: all six keys, the three that matter non-empty. */
export function completeRequirement(): Record<string, string> {
  return {
    outcome: 'A dispatched agent that refuses a card can say WHAT is wrong with it.',
    behaviour:
      'A submit carrying a requirement lands it on the envelope; one carrying none is unchanged.',
    scopeEdge: '',
    constraints: 'The producer validates nothing — judging the answer belongs at the far end.',
    acceptance: 'The planner starts at its second phase instead of opening a conversation.',
    assumptions: '',
  };
}
