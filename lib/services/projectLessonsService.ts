import { getLesson, getLessons, type RawLesson } from '@/lib/ai/motirAiClient';
import { MotirAiJobNotFoundError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import type {
  LessonInjectionBlock,
  ProjectLessonDTO,
  ProjectLessonsPageDTO,
} from '@/lib/dto/projectLessons';

// The project LESSON LIBRARY service (Subtask MOTIR-3337 · Story MOTIR-3329) —
// the only thing the lessons routes and the settings surface call. It (1) GATES
// on `lesson:view` BEFORE anything crosses the boundary, (2) reaches the store
// ONLY over the 7.1 boundary via the motirAiClient leaf, and (3) maps the raw
// boundary shape to the browser-facing DTO. Same three responsibilities, same
// order, as `aiConventionService`.
//
// ⚠️ AND IT DROPS ANY NON-TENANT ROW, as a SECOND line of defence. motir-ai
// already selects `aiProjectId = <this project>` and never the injection clause
// `scope = 'global' OR aiProjectId = …`, so nothing global should arrive — but
// EITHER END CAN REGRESS ALONE (motir-ai could widen its predicate; core could
// start sending a flag that unions the corpus in "for context"), and one
// assertion at one end proves the boundary held once, in one direction. The
// upstream filter is not made removable by this: `motir-ai`'s own
// `tests/lessonInspectionSurface.test.ts` asserts it against a mixed fixture,
// and `tests/permissions/lessonSeam.integration.test.ts` asserts this half
// against the same one.
//
// ⚠️ THE PERMISSION GUARDS THE DATA, NOT THE CONTROL — and the ORDER is the
// guard. `assertPermission` runs before the fetch, so a caller without the key
// causes NO upstream call and the payload is never assembled. Fetch-then-check
// would leave the lessons in a response the server built, with only a component
// deciding not to render them standing between that and an unauthorised reader
// — which is a rendering decision, not an authorization boundary. Lessons are
// distilled from a project's own planning work and can name specifics of it.
//
// The tests assert this as the STUB'S CALL COUNT rather than as a status code,
// because a route that fetched and then refused would pass a status assertion.

/**
 * Whether a row is one of THIS project's own lessons.
 *
 * `scope` is the field motir-ai stamps; a `global` row is the product's curated
 * corpus and is not a project's to inspect here. Asserted rather than inferred
 * from a null `aiProjectId`, the same belt-and-braces the upstream repository
 * applies in the other direction.
 */
function isTenantRow(raw: RawLesson): boolean {
  return raw.scope === 'tenant';
}

/** The upstream's block values, narrowed. An unknown value degrades to null. */
function toInjectionBlock(raw: string | null): LessonInjectionBlock | null {
  return raw === 'disabled' || raw === 'not_recurred' ? raw : null;
}

/**
 * Map one raw lesson to the DTO.
 *
 * ⚠️ `scope`, `aiProjectId` and `mistakeType` are DELIBERATELY dropped. The
 * upstream already answers only with this project's tenant rows, so echoing an
 * internal project id and a scope that is always `'tenant'` would ship the
 * closed layer's identifiers to a browser for no reader's benefit — and would
 * make the surface look like it could show another scope, which it cannot.
 */
function toLessonDTO(raw: RawLesson): ProjectLessonDTO {
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    why: raw.why,
    howToApply: raw.howToApply,
    kinds: raw.kinds ?? [],
    types: raw.types ?? [],
    phases: raw.phases ?? [],
    sourceRef: raw.sourceRef,
    createdAt: raw.createdAt,
    lastOccurredAt: raw.lastOccurredAt,
    recurrenceCount: raw.recurrenceCount ?? 1,
    injected: raw.injected,
    injectionBlock: toInjectionBlock(raw.injectionBlock),
    // An upstream that predates the field labels nothing "not seen in 0 days":
    // `injectionBlock` is what decides whether a badge renders at all, and a
    // row that IS blocked without a window is a version skew, not a zero-day
    // policy. 0 is the honest placeholder — the badge's own copy is what would
    // read wrong, and it cannot be reached without the block.
    retentionDays: typeof raw.retentionDays === 'number' ? raw.retentionDays : 0,
  };
}

/** The answer when motir-ai cannot be reached — the section, quiet. */
const UNAVAILABLE: ProjectLessonsPageDTO = {
  available: false,
  lessons: [],
  nextCursor: null,
  total: 0,
  applied: 0,
  staleCutoff: null,
  retentionDays: null,
};

export const projectLessonsService = {
  /**
   * One page of the project's lessons, most-recently-relevant first.
   *
   * Refuses BEFORE the boundary call; degrades on a motir-ai outage. Those are
   * the two properties this method exists for, and they are opposite in kind: a
   * missing permission must be LOUD (a 403 the caller sees) and an upstream
   * outage must be QUIET (a section that says so, on a page that still works).
   */
  async listLessons(
    projectId: string,
    ctx: AccessActorContext,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<ProjectLessonsPageDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'lesson:view');
    try {
      const raw = await getLessons({
        coreWorkspaceId: ctx.workspaceId,
        coreProjectId: projectId,
        cursor: opts.cursor,
        limit: opts.limit,
      });
      return {
        available: true,
        // The defensive narrowing described at the top of this file. `filter`
        // rather than a throw: an unexpected global row is a boundary defect to
        // fix upstream, not a reason to blank a customer's own lessons.
        lessons: raw.lessons.filter(isTenantRow).map(toLessonDTO),
        nextCursor: raw.nextCursor,
        total: raw.total,
        applied: raw.applied,
        staleCutoff: raw.staleCutoff,
        retentionDays: raw.retentionDays,
      };
    } catch (err) {
      // ⚠️ ONLY the unavailable arm degrades. A `MotirAiUnauthorizedError` or a
      // `MotirAiBadRequestError` is OUR bug — a mis-configured service token, a
      // query motir-ai rejects — and swallowing it would render as "the section
      // is quiet" for as long as nobody looked at a log. `aiFetch` maps both a
      // transport failure and its 30s deadline to this one type, which is
      // exactly the outage class the card names.
      if (err instanceof MotirAiUnavailableError) return UNAVAILABLE;
      throw err;
    }
  },

  /**
   * One lesson in full.
   *
   * Returns null when motir-ai has no such lesson FOR THIS PROJECT — which is
   * also what it returns for another project's id, because the upstream raises
   * the same `not_found` for both and nothing here tries to tell them apart.
   * Degrades to null on an outage as well: the route maps both to a 404, so a
   * reader is never shown half a lesson.
   *
   * ⚠️ `MotirAiJobNotFoundError` is the type `errorFromProblem` builds for ANY
   * upstream `not_found`, jobs or otherwise — the name is a historical artefact
   * of the code being introduced for `GET /v1/jobs/:id`, not a claim about what
   * was missing. Matching on it here is matching on the wire code.
   */
  async getLesson(
    projectId: string,
    ctx: AccessActorContext,
    lessonId: string,
  ): Promise<ProjectLessonDTO | null> {
    await projectAccessService.assertPermission(projectId, ctx, 'lesson:view');
    try {
      const raw = await getLesson({
        coreWorkspaceId: ctx.workspaceId,
        coreProjectId: projectId,
        lessonId,
      });
      // Same narrowing on the detail read, and it answers `null` — the SAME
      // answer an unknown id gets — because a global lesson is not this
      // project's to inspect and saying so would be a different disclosure.
      return isTenantRow(raw) ? toLessonDTO(raw) : null;
    } catch (err) {
      if (err instanceof MotirAiJobNotFoundError || err instanceof MotirAiUnavailableError) {
        return null;
      }
      throw err;
    }
  },
};
