// The LESSON store's PLAN-PHASE axis — one vocabulary, one alias map, one
// label lookup (Bug MOTIR-4775).
//
// ⚠️ WHY THIS MODULE EXISTS AT ALL. The axis was declared four times over —
// twice as a private `LESSON_PHASES` literal in the two MCP tools, once in the
// published schema, and once more as a bare `string[]` on the DTO — and
// MOTIR-4774 renamed the values underneath all four. A private literal through
// a rename is exactly the drift that produces two vocabularies in one product:
// motir-ai's enum moved and these would not have. So the vocabulary lives HERE,
// and every consumer reads it rather than retyping it.
//
// It is deliberately a LEAF: no imports, so the MCP tools, the DTO, the API-docs
// generator and the settings UI can all reach it without dragging a graph along.

/**
 * The axis, in the words the rest of the planner uses — `lay` while laying a
 * level's children, `author` while writing one card's body.
 *
 * ⚠️ THIS IS A MIRROR, NOT THE AUTHORITY. The column is motir-ai's
 * `LessonPlanPhase` enum (`prisma/schema.prisma`), and this list follows it. So
 * a type derived from this constant is a CLAIM about what the store holds and
 * not a guarantee — which is why `lessonPhaseLabelKey` below has a miss arm
 * rather than an exhaustive switch.
 */
export const LESSON_PHASES = ['lay', 'author'] as const;

export type LessonPlanPhase = (typeof LESSON_PHASES)[number];

/**
 * ⚠️ INBOUND COMPATIBILITY, FOR ONE RELEASE (MOTIR-4774 / MOTIR-4775).
 *
 * The axis was `skeleton` / `deepen` until MOTIR-4774, and on the day this
 * ships two kinds of caller still say so: a hand-run planner following a runbook
 * whose own half (MOTIR-4776) has not merged, and a model that read the old tool
 * description earlier in the same session. Refusing them would turn a vocabulary
 * change into an outage on a search that has a perfectly good answer, so the
 * retired spellings are ACCEPTED and mapped at the tool boundary — never deeper,
 * so nothing downstream has two vocabularies to think about.
 *
 * motir-ai carries the mirror of this map at ITS edge
 * (`src/llm/lessonTools.ts` `RETIRED_LESSON_PHASE_ALIASES`), which is what makes
 * the merge order of the three repositories free. Mapping here as well is not
 * redundant: it means the value motir-core FORWARDS is already canonical, so the
 * upstream's compatibility warning fires only for callers that really are old.
 *
 * ⚠️ SCHEDULED FOR REMOVAL, and the schedule is a card rather than a comment:
 * MOTIR-4776 is the last of the three halves. Delete this map — and the
 * round-trip cases that pin it — once it has shipped.
 */
export const RETIRED_LESSON_PHASE_ALIASES: Readonly<Record<string, LessonPlanPhase>> = {
  skeleton: 'lay',
  deepen: 'author',
};

/**
 * Every spelling a caller may send: the two current values plus the two retired
 * ones. Used only in the REFUSAL text, so a caller who sends a fifth spelling is
 * told all four things that would have worked.
 */
export const LESSON_PHASE_INPUT_VALUES = [
  ...LESSON_PHASES,
  ...(Object.keys(RETIRED_LESSON_PHASE_ALIASES) as ['skeleton', 'deepen']),
] as const;

/** The message a rejected phase value gets — it names every accepted spelling. */
export const LESSON_PHASE_REFUSAL = `A phase must be one of: ${LESSON_PHASE_INPUT_VALUES.join(
  ', ',
)}. "skeleton" and "deepen" are the retired spellings of "lay" and "author" and are still accepted; omit the axis to leave it unconstrained.`;

/**
 * ⚠️ THE COMPATIBILITY LIVES IN A **PREPROCESS**, NOT IN A WIDER ENUM — and the
 * difference is what the PUBLISHED schema says.
 *
 * A `z.enum` of all four spellings would accept the retired ones correctly and
 * then ADVERTISE them: `lib/apiDocs/mcpToolSchemas.ts` is generated from a live
 * handshake, so every one of the enum's members reaches `tools/list`, and an
 * agent reading the surface would go on choosing `skeleton` from a list that
 * offers it. Mapping BEFORE validation instead leaves the enum at `lay` /
 * `author` — so the schema teaches the current vocabulary while the tool still
 * takes the old one, which is the whole point of a one-release grace.
 *
 * Anything that is not an array of strings is handed back untouched, so zod
 * still produces its own type error rather than this function inventing one.
 */
export function preprocessLessonPhases(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((value) =>
    typeof value === 'string' ? (RETIRED_LESSON_PHASE_ALIASES[value] ?? value) : value,
  );
}

/**
 * Canonicalise a list that has already been validated — the belt to the
 * preprocess's braces, for a caller that reaches a service directly.
 *
 * A retired spelling becomes its current one; anything already current passes
 * through. Everything downstream of it, including the request motir-ai receives,
 * speaks only `lay` / `author`.
 */
export function canonicalizeLessonPhases(phases: readonly string[]): LessonPlanPhase[] {
  return phases.map((phase) => RETIRED_LESSON_PHASE_ALIASES[phase] ?? (phase as LessonPlanPhase));
}

/** The `messages` key a phase value renders under, or `null` when nothing labels it. */
export function lessonPhaseLabelKey(value: string): string | null {
  return (LESSON_PHASES as readonly string[]).includes(value)
    ? `aiPlanning.lessons.phase.${value}`
    : null;
}
