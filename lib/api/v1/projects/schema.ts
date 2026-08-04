import { z } from 'zod';
import type { ProjectDTO } from '@/lib/dto/projects';

// The v1 PROJECT resource, declared once (Story 11.3 · Subtask 11.3.3 —
// MOTIR-2060). Both `GET /api/v1/projects` and `GET /api/v1/projects/{projectKey}`
// return a shape defined HERE, on the pattern `lib/api/v1/workItems/schema.ts`
// set and the ADR's Amendment 2 pins: 11.3 owns its resource schemas, 11.4
// assembles them.
//
// ── A v1 response is a SCHEMA's output, never a service DTO ──────────────────
// `ProjectDTO` is the web app's internal shape and grows a field whenever a page
// needs one — `aiGenerateExplanations` and `onboardingRanAt` both arrived that
// way. §8's additive-only promise cannot ride something nobody promised to keep
// still, so the mapper below shapes FIELD BY FIELD and never spreads.
//
// ── Identifiers on the wire ─────────────────────────────────────────────────
// ADR §7: a project is named by its `MOTIR`-style identifier, never by its
// internal cuid. There is no exception on this resource — unlike the work-item
// resource, which carries `assigneeId` / `sprintId` because those name things
// that have no key of their own, a project has nothing to point at.
//
// ── What is deliberately NOT here, and why ──────────────────────────────────
// Each omission is ADDITIVE to reverse under §8 (a new field on a response
// object is explicitly allowed), whereas withdrawing a field that turned out to
// be internal is not. So the bar is "a client can act on this", not "the DTO
// happens to carry it":
//
//   • `id` — the internal cuid. §7.
//   • `slug` — a create-time artifact NO url consumes; `projectsService.updateDetails`
//     records that a rename deliberately does not regenerate it, precisely because
//     nothing addresses a project by slug. Publishing it would freeze a vestigial
//     field as contract.
//   • `avatarIcon` / `avatarColor` — keys into Motir's own preset registry
//     (`lib/projects/avatar.ts`). They are meaningless to a client that is not
//     rendering Motir's UI, and publishing them would make that registry's key
//     space public API.
//   • `onboardingRanAt` / `aiGenerateExplanations` — internal product
//     configuration (which planning flow the project entered, whether the AI
//     planner drafts explanations), not project identity. Exposing configuration
//     invites clients to branch on it, and the AI toggle sits behind the
//     open-core boundary this story does not reach across.
//   • `createdAt` / `previousKeys` — NOT AVAILABLE on the read these endpoints
//     use, and that is a deliberate trade recorded at the detail route: they load
//     only on `projectsService.getDetails`, which resolves LIVE keys only, while
//     `getByKey` is alias-aware. Serving a retired project key consistently with
//     every other project-scoped v1 path was worth more than two descriptive
//     fields. Adding them later means an alias-aware details read — a card in the
//     owning epic, not something v1 invents at the edge (§9's corollary).

/** `true` only when `Union` is fully covered by `Covered`; otherwise `never`. */
type AssertTotal<Union, Covered> = [Exclude<Union, Covered>] extends [never] ? true : never;

/**
 * The project's browse-access level.
 *
 * A closed vocabulary, guarded the way the work-item vocabularies are — two
 * COMPILE errors rather than a runtime surprise: `satisfies` rejects a member
 * that is not a real DTO value, and `AssertTotal` rejects a DTO value missing
 * from the tuple. A level added to `ProjectDTO['accessLevel']` therefore breaks
 * the build HERE, at the seam that decides what the public API says.
 */
const ACCESS_LEVELS = [
  'open',
  'limited',
  'private',
  'public',
] as const satisfies readonly ProjectDTO['accessLevel'][];
const _accessLevelsTotal: AssertTotal<ProjectDTO['accessLevel'], (typeof ACCESS_LEVELS)[number]> =
  true;
// Type-level; referenced so `noUnusedLocals` stays happy and a reader can see it
// is load-bearing rather than a leftover.
void _accessLevelsTotal;

const accessLevelSchema = z.enum(ACCESS_LEVELS);

/** A project key: the canonical upper-case identifier, e.g. `MOTIR`. */
export const projectKeySchema = z.string().regex(/^[A-Z][A-Z0-9]*$/);

/** The v1 project resource — one shape, returned by the list and the read alike. */
export const projectSchema = z.object({
  key: projectKeySchema,
  name: z.string(),
  accessLevel: accessLevelSchema,
  /**
   * `true` when the project is soft-deleted. The LIST never returns one
   * (`listProjects` filters archived rows out), but a by-key read can surface
   * one, and a client that cannot tell would treat a dead project as live.
   */
  archived: z.boolean(),
});
export type V1Project = z.infer<typeof projectSchema>;

/**
 * Map a `ProjectDTO` to the wire resource — field by field, never a spread.
 *
 * Takes only the fields BOTH read paths populate, so a response is never
 * `null`-shaped merely because the caller happened to use the hot read. That is
 * the exact hazard `ProjectDTO`'s optional `createdAt` / `previousKeys` create
 * and the reason they are not on this resource.
 */
export function presentProject(project: ProjectDTO): V1Project {
  return {
    key: project.identifier,
    name: project.name,
    accessLevel: project.accessLevel,
    archived: project.archivedAt !== null,
  };
}
