import {
  applyLesson,
  createLesson,
  getLesson,
  getLessons,
  reinforceLesson,
  retireLesson,
  searchLessons,
  type RawLesson,
  type RawRankedLesson,
} from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import {
  MotirAiConfigError,
  MotirAiJobNotFoundError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import type {
  LessonHumanOverride,
  LessonInjectionBlock,
  LessonSearchResult,
  ProjectLessonDTO,
  ProjectLessonsPageDTO,
  RankedLessonDTO,
  ReinforcedLessonDTO,
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

/** The upstream's override values, narrowed. An unknown value degrades to null. */
function toHumanOverride(raw: string | null): LessonHumanOverride | null {
  return raw === 'retired' || raw === 'exempt' ? raw : null;
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
    humanOverride: toHumanOverride(raw.humanOverride ?? null),
    humanOverrideAt: raw.humanOverrideAt ?? null,
    humanOverrideBy: raw.humanOverrideBy ?? null,
    // An upstream that predates the field labels nothing "not seen in 0 days":
    // `injectionBlock` is what decides whether a badge renders at all, and a
    // row that IS blocked without a window is a version skew, not a zero-day
    // policy. 0 is the honest placeholder — the badge's own copy is what would
    // read wrong, and it cannot be reached without the block.
    retentionDays: typeof raw.retentionDays === 'number' ? raw.retentionDays : 0,
  };
}

/**
 * Whether this failure means "there is nothing to show here", as opposed to
 * "something is wrong that somebody must fix".
 *
 * TWO classes, and the second is the one that cost a CI round-trip:
 *
 *   * `MotirAiUnavailableError` — motir-ai is CONFIGURED and did not answer (a
 *     transport failure, the 30s deadline, a 5xx). The outage case the card
 *     names.
 *   * `MotirAiConfigError` — motir-ai is NOT CONFIGURED AT ALL. `MOTIR_AI_URL`
 *     unset is the shipped SELF-HOST posture, not a defect: the AI-planning page
 *     has rendered a "Motir AI isn't connected" state off `isMotirAiConfigured()`
 *     since MOTIR-919. Letting this one through made the whole settings page 500
 *     on every deployment without motir-ai — which is most of them, and which is
 *     the exact failure the degradation contract exists to prevent, arriving
 *     through the door nobody thought to hold.
 *
 * ⚠️ `MotirAiUnauthorizedError` and `MotirAiBadRequestError` stay LOUD, and the
 * distinction is not a technicality: those mean motir-ai IS reachable and
 * REFUSED us — a wrong service token, a malformed query. Swallowing them would
 * render as a quiet section for as long as nobody read a log.
 */
function isSectionQuiet(err: unknown): boolean {
  return err instanceof MotirAiUnavailableError || err instanceof MotirAiConfigError;
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

/**
 * Map one ranked row to the teaching DTO.
 *
 * ⚠️ `scope` is KEPT here, unlike `toLessonDTO` which drops it. That one answers an
 * inspection surface whose rows are always `tenant`, so echoing the field would
 * make the surface look like it could show another scope. This read genuinely
 * returns both, and which one a lesson came from is part of what the caller is
 * being told.
 */
function toRankedLessonDTO(raw: RawRankedLesson): RankedLessonDTO {
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    howToApply: raw.howToApply,
    scope: raw.scope,
    kinds: raw.kinds ?? [],
    types: raw.types ?? [],
    phases: raw.phases ?? [],
    distance: raw.distance,
  };
}

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
      if (isSectionQuiet(err)) return UNAVAILABLE;
      throw err;
    }
  },

  /**
   * SEARCH the lesson corpus by meaning — the TEACHING read (Subtask MOTIR-3478
   * · Story MOTIR-3466), and the seam the `search_lessons` MCP tool adapts over.
   *
   * The caller writes a real question in its own words, optionally narrows by
   * the three routing axes, and gets back ranked lessons with enough text to act
   * on. The thin-transport shape the methods above already hold: resolve, assert
   * the key, call ONE upstream method, map typed errors.
   *
   * ⚠️ THE PERMISSION IS ASSERTED BEFORE THE UPSTREAM CALL, and the ORDER is the
   * guard — the same property every method on this service holds, and asserted
   * the same way: as the client double's CALL COUNT, never as a status code,
   * because a read that fetched and then refused would pass a status assertion
   * while having already spent the round trip and assembled a payload for
   * someone who may not read it.
   *
   * ⚠️ IT IS GATED ON `lesson:view`, THE READ KEY — not `lesson:manage`. The
   * two were separated in MOTIR-3336 so a role with read access is expressible,
   * and this is a read: it returns guidance and changes nothing.
   *
   * ⚠️ AND IT DOES NOT DEGRADE THE WAY `listLessons` DOES. That read answers an
   * outage with `{ available: false, lessons: [] }` because a settings page must
   * not 500 over an unrelated service. Here an outage rendered as an empty
   * result would tell an agent the corpus has nothing to say about the work in
   * front of it — the opposite of the truth, and indistinguishable from the
   * honest empty answer. So the OUTCOME is named: `nothing-matched` and
   * `unavailable` are different values, and the write path's non-degrading
   * posture is the closer precedent than the read path's.
   *
   * The unavailable arm still catches rather than throws, because a corpus that
   * cannot be reached is a fact the caller should be TOLD, not an exception it
   * has to handle. `MotirAiUnauthorizedError` / `MotirAiBadRequestError` stay
   * LOUD, exactly as on `listLessons`: those mean motir-ai is reachable and
   * REFUSED us, which is our bug and must not read as an outage.
   */
  async searchLessons(
    projectId: string,
    ctx: AccessActorContext,
    input: {
      query: string;
      kinds?: string[];
      types?: string[];
      phases?: string[];
      limit?: number;
    },
  ): Promise<LessonSearchResult> {
    await projectAccessService.assertPermission(projectId, ctx, 'lesson:view');
    try {
      const raw = await searchLessons({
        coreWorkspaceId: ctx.workspaceId,
        coreProjectId: projectId,
        query: input.query,
        // ⚠️ SPREAD, so an axis the caller omitted stays ABSENT across this hop.
        // The upstream SQL depends on the distinction: absent omits the clause,
        // `[]` renders a filter that matches nothing.
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.types ? { types: input.types } : {}),
        ...(input.phases ? { phases: input.phases } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      // ⚠️ NO `isTenantRow` FILTER HERE, deliberately. It guards the inspection
      // reads because a global row arriving there is a boundary defect; on this
      // read the global corpus is the larger half of the correct answer, and
      // filtering it out would leave a caller reading its own project's lessons
      // over MCP and the shared corpus by grep.
      if (raw.length === 0) return { outcome: 'nothing-matched', lessons: [] };
      return { outcome: 'matched', lessons: raw.map(toRankedLessonDTO) };
    } catch (err) {
      if (isSectionQuiet(err)) return { outcome: 'unavailable', lessons: [] };
      throw err;
    }
  },

  /**
   * ADD one lesson to this project's own store (Story MOTIR-3331 · MOTIR-3360).
   *
   * The write sibling of the two reads above, and the seam the `add_lesson` MCP
   * tool adapts over — the way `add_comment` adapts over `commentsService`. The
   * tool holds no logic of its own, which is what keeps these properties true for
   * the NEXT caller: if the settings surface ever grows an *add a lesson* button,
   * it comes through here and inherits the same check.
   *
   * ⚠️ THE PERMISSION IS ASSERTED BEFORE THE UPSTREAM CALL, and the ORDER is the
   * guard, exactly as it is on the reads. A refusal that has already written a
   * row upstream is not a refusal; it also spends a tenant's budget on a request
   * that was going to be rejected. The tests assert this as the stub's CALL
   * COUNT rather than as a status code, because a service that called and then
   * threw would pass a status assertion.
   *
   * ⚠️ TENANT-SCOPED BY CONSTRUCTION. The acting project is resolved from the
   * caller's context; there is no parameter through which a caller could name
   * another project, and none through which it could ask for a global lesson.
   * That is a property of this SIGNATURE, not of a check inside it — the safest
   * form, because there is nothing to forget to validate.
   *
   * ⚠️ IT DOES NOT DEGRADE, unlike `listLessons`. An outage on a READ means "the
   * section is quiet, the page still works". An outage on a WRITE means the
   * lesson was not recorded, and answering a caller as though it had been is the
   * one thing this must never do. Every upstream failure propagates — including
   * the 409 near-duplicate refusal, which carries the existing lesson's id and
   * title that the caller needs in order to reword or retire.
   */
  async addLesson(
    projectId: string,
    ctx: AccessActorContext,
    input: {
      mistakeType: string;
      title: string;
      body: string;
      why: string;
      howToApply: string;
      kinds?: string[];
      types?: string[];
      phases?: string[];
      sourceRef?: string;
    },
  ): Promise<ProjectLessonDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'lesson:manage');

    // Resolved AFTER the gate, for the same reason the upstream call is: a
    // caller without the permission causes no work at all, not merely no write.
    const { organizationId } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });

    const raw = await createLesson({
      coreOrganizationId: organizationId,
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      mistakeType: input.mistakeType,
      title: input.title,
      body: input.body,
      why: input.why,
      howToApply: input.howToApply,
      ...(input.kinds ? { kinds: input.kinds } : {}),
      ...(input.types ? { types: input.types } : {}),
      ...(input.phases ? { phases: input.phases } : {}),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    });
    return toLessonDTO(raw);
  },

  /**
   * RECORD that an occurrence matched this lesson (Subtask MOTIR-3553 · Bug
   * MOTIR-3547) — the write that closes the loop `search_lessons` opens.
   *
   * ⚠️ GATED ON `lesson:reinforce`, NOT `lesson:manage`, and the gate runs
   * BEFORE the upstream call — the same placement `searchLessons` uses, and for
   * the same reason: a caller without the permission causes no work at all, not
   * merely no write. Its own key because this changes nothing a lesson SAYS;
   * see `canReinforceLessons` for why folding it into `manage` would make a
   * routine run able to retire a lesson in order to record that one applied.
   *
   * ⚠️ IT REACHES GLOBAL ROWS. The upstream resolves over `global OR this
   * tenant` deliberately (MOTIR-3323: the entire curated corpus is global and
   * must be reinforceable). Another tenant's lesson raises `not_found` upstream
   * and surfaces here as the same refusal an unknown id does.
   *
   * The upstream errors are NOT swallowed. Unlike `listLessons`, which degrades
   * to an empty section so a settings page stays usable, a caller here asked to
   * RECORD something: an outage reported as success is a lost occurrence and a
   * corpus that quietly stops counting, which is the defect this whole change
   * exists to fix.
   */
  async reinforceLesson(
    projectId: string,
    ctx: AccessActorContext,
    input: { lessonId: string; occurrenceRef: string },
  ): Promise<ReinforcedLessonDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'lesson:reinforce');

    const raw = await reinforceLesson({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      lessonId: input.lessonId,
      occurrenceRef: input.occurrenceRef,
    });
    return {
      id: raw.id,
      title: raw.title,
      scope: raw.scope,
      lastOccurredAt: raw.lastOccurredAt,
      recurrenceCount: raw.recurrenceCount,
      counted: raw.counted,
    };
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
      if (err instanceof MotirAiJobNotFoundError || isSectionQuiet(err)) return null;
      throw err;
    }
  },

  /**
   * STOP APPLYING a lesson, or APPLY IT AGAIN — the write half (MOTIR-3345).
   *
   * ⚠️ GUARDED BY `lesson:manage`, NOT `lesson:view` — and this is the single
   * most likely defect on this card, because it is invisible to every test an
   * admin performs. An admin holds both keys, so a manual walk passes, the E2E
   * passes, and the distinction only fails for a role nobody has created yet:
   * a member given read access could switch off what the planner tells the
   * whole project. The two keys were separated one card earlier (MOTIR-3336)
   * precisely to make that role expressible, and checking the view key here
   * would quietly undo it at the first call site.
   *
   * ⚠️ THE ORDER IS THE GUARD, exactly as on the reads: `assertPermission` runs
   * BEFORE the upstream call, so a caller without the key causes no request at
   * all. Asserted as the stub's CALL COUNT rather than as a status code,
   * because a route that called upstream and then refused would pass a status
   * assertion.
   *
   * ⚠️ AND THIS ONE DOES NOT DEGRADE. The reads go quiet on a motir-ai outage
   * because a settings page with three working groups on it must not 500 over
   * an unrelated service. A WRITE is the opposite case: swallowing the failure
   * would tell the user their lesson was retired when nothing happened, and the
   * row would flip back on the next read. Every error propagates, and the route
   * turns it into something the surface can say.
   */
  async setLessonApplied(
    projectId: string,
    ctx: AccessActorContext,
    lessonId: string,
    applied: boolean,
  ): Promise<ProjectLessonDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'lesson:manage');
    const write = applied ? applyLesson : retireLesson;
    const raw = await write({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      lessonId,
      // The acting user, threaded through so motir-ai can record WHO decided.
      actorId: ctx.userId,
    });
    // The same defensive narrowing the reads apply, for the same reason and in
    // the same direction — except a global row arriving HERE would mean the
    // upstream had performed a write it is supposed to refuse, so it is a throw
    // rather than a filter: there is no partial answer to give.
    if (!isTenantRow(raw)) {
      throw new MotirAiUnavailableError('lesson write answered with a non-tenant row');
    }
    return toLessonDTO(raw);
  },
};
