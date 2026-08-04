import { z } from 'zod';
import type { SprintDto, SprintStateDto } from '@/lib/dto/sprints';

// The v1 SPRINT resource, declared once (Story 11.3 · Subtask 11.3.4 —
// MOTIR-2061). Every sprint response in 11.3 — the project's sprint list, the
// single read, the write pair, the lifecycle moves — returns a shape defined
// HERE (ADR Amendment 2: 11.3 owns its resource schemas, 11.4 assembles).
//
// ── A v1 response is a SCHEMA's output, never a service DTO ──────────────────
// `SprintDto` is internal and changes when a page needs it to; the mapper below
// shapes FIELD BY FIELD and never spreads.
//
// ── The sprint id IS a cuid on the wire, and that is a DECISION ──────────────
// ADR §7's key-only rule governs WORK ITEMS: a work item has a `MOTIR-<n>` key,
// so naming it by cuid would freeze the primary key as contract when a stable
// public name already exists. A sprint has no such key — there is nothing else
// to call it, and a client that cannot name a sprint cannot add an item to one.
// `lib/api/v1/workItems/schema.ts` records the identical exception for the
// `sprintId` it carries.
//
// ── NULLABILITY IS CONTRACT ─────────────────────────────────────────────────
// `committedPoints` / `committedIssueCount` are the IMMUTABLE activation
// baseline `startSprint` snapshots. Both are `null` on a sprint that has never
// been started, and `committedPoints` is ALSO null on a started sprint that was
// wholly unestimated. Those are three genuinely different states and the
// response preserves them:
//
//   • `committedIssueCount: null` — never started. There is no baseline.
//   • `committedIssueCount: 0`    — started, and it was empty at activation.
//   • `committedPoints: null`     — never started, OR started unestimated.
//
// Coercing a null to `0` would collapse "no baseline exists" into "the baseline
// was zero", which is the difference between a sprint that has not begun and one
// that began with nothing in it. Under §8 nullability cannot be changed later
// without a new major, so it is declared correctly now and the mapper never
// substitutes a number for an absent one.

/** `true` only when `Union` is fully covered by `Covered`; otherwise `never`. */
type AssertTotal<Union, Covered> = [Exclude<Union, Covered>] extends [never] ? true : never;

/**
 * The sprint lifecycle vocabulary, kept TOTAL over `SprintStateDto` by two
 * COMPILE errors: `satisfies` rejects a member that is not a real DTO value,
 * `AssertTotal` rejects a DTO value missing from the tuple. A state added to the
 * union breaks the build HERE rather than shipping as a response the schema
 * rejects at runtime.
 */
const SPRINT_STATES = [
  'planned',
  'active',
  'complete',
] as const satisfies readonly SprintStateDto[];
const _sprintStatesTotal: AssertTotal<SprintStateDto, (typeof SPRINT_STATES)[number]> = true;
void _sprintStatesTotal;

const sprintStateSchema = z.enum(SPRINT_STATES);
const isoDateTimeSchema = z.string().datetime();

/**
 * The v1 sprint resource.
 *
 * `state` is what answers "which sprint is active?" — there is deliberately no
 * separate `/sprints/active` path, because the row already says so and a second
 * endpoint returning a subset of this one is a second thing to keep correct.
 */
export const sprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string().nullable(),
  state: sprintStateSchema,
  /** The planned or actual window. Null on a planned sprint with no dates set. */
  startDate: isoDateTimeSchema.nullable(),
  endDate: isoDateTimeSchema.nullable(),
  /** Stamped by `completeSprint`; null until then. */
  completedAt: isoDateTimeSchema.nullable(),
  /** The project-scoped display ordinal. */
  sequence: z.number().int(),
  /** The sprint's CURRENT non-archived member count — live, not the baseline. */
  issueCount: z.number().int(),
  /** The activation baseline. See the nullability note above. */
  committedPoints: z.number().nullable(),
  committedIssueCount: z.number().int().nullable(),
});
export type V1Sprint = z.infer<typeof sprintSchema>;

/**
 * Map a `SprintDto` to the wire resource — field by field, never a spread.
 *
 * Every nullable field is passed THROUGH, never defaulted: see the nullability
 * note above for why `committedPoints ?? 0` would be a silent lie rather than a
 * convenience.
 */
export function presentSprint(sprint: SprintDto): V1Sprint {
  return {
    id: sprint.id,
    name: sprint.name,
    goal: sprint.goal,
    state: sprint.state,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    completedAt: sprint.completedAt,
    sequence: sprint.sequence,
    issueCount: sprint.issueCount,
    committedPoints: sprint.committedPoints,
    committedIssueCount: sprint.committedIssueCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST schemas (Story 11.3 · Subtask 11.3.5 — MOTIR-2062)
// ─────────────────────────────────────────────────────────────────────────────
//
// Beside the response schema deliberately: Story 11.4 emits the OpenAPI
// operations from this module, and an operation is a request shape AND a
// response shape. Splitting them puts half an operation in each of two places.
//
// ⚠️ ABSENT vs NULL is the whole of the PATCH contract, so it is spelled out
// rather than left to zod's defaults. `sprintsService.updateSprint` reads
// `patch.goal !== undefined` to decide whether to touch the column at all, so:
// an ABSENT key leaves the field unchanged, an explicit `null` CLEARS it, a
// value sets it. `.optional()` models the first and `.nullable()` the second,
// and the pairing is what keeps them distinguishable.
//
// ⚠️ Dates are validated by the SERVICE, not here. `parseNullableDate` +
// `assertWindow` own "does it parse" and "is `endDate` ≥ `startDate`", and
// re-checking either at the route would be a second implementation of a rule
// that already has one — the first place the API and the product start
// disagreeing about what a valid sprint window is. The schema only asserts the
// wire TYPE (a string, or null).

/** `POST /api/v1/projects/{projectKey}/sprints`. Every field is optional. */
export const createSprintBodySchema = z
  .object({
    // Omitted → the service names it `"Sprint <n>"` from the project's max
    // sequence. NOT defaulted here: the ordinal is derived inside the write, and
    // a route guessing at it would race every concurrent create.
    name: z.string().optional(),
    goal: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
  })
  .strict();
export type CreateSprintBody = z.infer<typeof createSprintBodySchema>;

/**
 * `PATCH /api/v1/sprints/{sprintId}` — rename, edit the goal, adjust the window.
 *
 * `.strict()`: an unknown property is a 422, not a silent no-op. A client that
 * misspells a field name has a bug, and telling them beats pretending the write
 * succeeded.
 */
export const updateSprintBodySchema = z
  .object({
    name: z.string().optional(),
    goal: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
  })
  .strict();
export type UpdateSprintBody = z.infer<typeof updateSprintBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The LIFECYCLE actions (Story 11.3 · Subtask 11.3.6 — MOTIR-2063)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/sprints/{sprintId}/start`.
 *
 * Every field optional: `startDate` defaults to now, and `name` / `goal` are the
 * inline edits the shipped start dialog performs INSIDE the activation
 * transaction (so Start is one atomic write, never a pre-start PATCH). `goal`
 * keeps the tri-state — absent leaves it, explicit `null` clears it.
 */
export const startSprintBodySchema = z
  .object({
    name: z.string().optional(),
    goal: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
  })
  .strict();
export type StartSprintBody = z.infer<typeof startSprintBodySchema>;

/**
 * `POST /api/v1/sprints/{sprintId}/complete`.
 *
 * `carryOverTo` defaults to `'backlog'`. The union is the shipped
 * `CarryOverDestination`: the literal string, or an object naming an existing
 * PLANNED sprint in the same project. Declared as a union rather than two
 * optional fields so an impossible request ("both") cannot be expressed.
 */
export const completeSprintBodySchema = z
  .object({
    carryOverTo: z
      .union([z.literal('backlog'), z.object({ sprintId: z.string().min(1) }).strict()])
      .optional(),
  })
  .strict();
export type CompleteSprintBody = z.infer<typeof completeSprintBodySchema>;
