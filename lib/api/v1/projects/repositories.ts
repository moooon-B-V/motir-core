import { z } from 'zod/v4';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import { repoCloneUrl } from '@/lib/repos/cloneUrl';
import { PROJECT_REPO_ROLES, PROJECT_REPO_STATES } from '@/lib/projectRepos/vocabulary';

// The v1 PROJECT REPOSITORY resource (Story MOTIR-3584 · Subtask MOTIR-3586) —
// one row of a project's repository set, as a PAT-authenticated client sees it.
//
// ── What question this resource answers ─────────────────────────────────────
// "Which repositories does this project have, at which clone URL, on which
// default branch?" — asked BEFORE a work item has been picked, which is the
// only shape of the question `/api/v1` could not answer. The data all exists:
// the set is stored (`project_repository`), `ProjectRepoDto.realizedRepo`
// carries the coordinates, and `lib/repos/cloneUrl.ts` derives the URL. It was
// simply published per-ITEM on the dispatch prompt and nowhere per-PROJECT.
//
// TWO consumers, deliberately — `docs/decisions/link-materializes-the-checkouts.md`
// §7: `motir link`, which clones into a person's linked folder, and the hosted
// provisioner Epic 9 builds, which materializes a container-per-run. That is why
// this resource publishes COORDINATES rather than a CLI-shaped instruction: two
// independent derivations of a clone URL is how a local checkout and a hosted
// container end up disagreeing about which host a repository lives on.
//
// ── A v1 response is a SCHEMA's output, never a service DTO ──────────────────
// `ProjectRepoDto` is the establish step's internal shape and has grown a field
// per surface — `proposalSignal`, `takeover`, `access` all arrived that way.
// §8's additive-only promise cannot ride something nobody promised to keep
// still, so `presentProjectRepository` shapes FIELD BY FIELD and never spreads.
//
// ── What is deliberately NOT here, and why ──────────────────────────────────
// The bar is "a client can FIND and CLONE a repository with this", not "the DTO
// happens to carry it". Each omission is ADDITIVE to reverse under §8;
// withdrawing a field that turned out to be internal is not.
//
//   • `seedSource` — which starter a repository was created FROM. An establish-
//     step input, settled before the row was established, and nothing a client
//     cloning code can act on.
//   • `proposalSignal` — WHY Motir proposed the row. Its own DTO comment calls it
//     a record for the establish-step UI to render on a later page load; it says
//     nothing about where the code is.
//   • `takeover` / `access` — the handoff saga and the collaborator invitation.
//     Both are surfaces a PERSON walks in Motir, both are `null`/`not_invited`
//     for the overwhelming majority of rows, and neither is reachable from a
//     token. A client that cannot clone a private repository learns that from
//     git, and the remedy is the invitation surface, not a field here (the ADR's
//     §3 refusal message names it in words).
//   • `failureReason` — the establish attempt's own error text, written for the
//     person watching the step. `state: "failed"` is what a materializing client
//     branches on; the sentence behind it is Motir's UI to render.
//   • The AUTHORED `name` — the intended repository name, editable until the row
//     is established. It is NOT a checkout key: `name` below is the REALIZED
//     repository's own casing, which `lib/dto/projectRepos.ts` records as
//     "AUTHORITATIVE for a checkout … what `work_item.targetRepo` stores and the
//     CLI keys `<root>/<name>` on". Publishing the authored one under the same
//     word would hand a client a directory name nothing resolves to.

/** `true` only when `Union` is fully covered by `Covered`; otherwise `never`. */
type AssertTotal<Union, Covered> = [Exclude<Union, Covered>] extends [never] ? true : never;

/**
 * The row's establish state — the closed vocabulary the shipped
 * `PROJECT_REPO_STATES` runtime list already owns, re-declared here as a Zod
 * enum rather than re-typed, so a state added to the Prisma enum reaches this
 * document without a second edit.
 */
const stateSchema = z.enum(PROJECT_REPO_STATES);
const _statesTotal: AssertTotal<ProjectRepoDto['state'], (typeof PROJECT_REPO_STATES)[number]> =
  true;
void _statesTotal;

/** The row's architectural role. Same construction, same reason. */
const roleSchema = z.enum(PROJECT_REPO_ROLES);
const _rolesTotal: AssertTotal<ProjectRepoDto['role'], (typeof PROJECT_REPO_ROLES)[number]> = true;
void _rolesTotal;

/** One repository of a project's set. */
export const projectRepositorySchema = z.object({
  /**
   * The `project_repository` row's id — the SAME value a work item's
   * `targetRepositories` names (contract `1.11.0`).
   *
   * ⚠️ An internal id on a v1 resource is the exception ADR §7 allows for a
   * thing with no key of its own, and this is that case twice over: a set row
   * has no key, and v1 already PUBLISHES these ids on the work-item resource
   * with nothing on the wire to resolve them against. Omitting it here would
   * leave that reference permanently un-followable.
   */
  id: z.string(),
  role: roleSchema,
  /** What distinguishes two rows of a repeated role (`api` + "billing"), or null. */
  label: z.string().nullable(),
  /**
   * The CHECKOUT key — the realized repository's own casing on the host, which
   * is what a checkout directory is named and what `targetRepo` pins store.
   *
   * `null` on a row with no realized repository, which is the honest answer: a
   * `proposed` row names no checkout because none exists yet.
   */
  name: z.string().nullable(),
  /** `owner/name` on the host, or null on a row with no realized repository. */
  repoRef: z.string().nullable(),
  /**
   * The HTTPS clone URL, derived through `repoCloneUrl`, or `null`.
   *
   * TWO different reasons for `null`, and a client cannot tell them apart from
   * this field alone — which is why `state` and `established` ride beside it:
   * the row has no realized repository at all, or it has one whose PROVIDER this
   * build cannot address. `repoCloneUrl`'s own header records why the second is
   * an answer rather than a gap — "Guessing a host would hand an agent a URL
   * that fails at `git clone`". The endpoint never invents one.
   */
  cloneUrl: z.string().nullable(),
  /** The branch a fresh clone lands on, or null with no realized repository. */
  defaultBranch: z.string().nullable(),
  /**
   * Whether the repository is ARCHIVED on the host — read-only, so nothing can
   * be pushed to it. `false` when there is no realized repository to ask about.
   *
   * A materializing client CLONES an archived repository and says so: it is
   * readable, and refusing to BRANCH on one belongs to dispatch, which refuses
   * by name (`lib/projectRepos/names.ts`). ADR
   * `link-materializes-the-checkouts.md` §2 pins that split.
   */
  archived: z.boolean(),
  /** What HAPPENED to this row in the establish step. */
  state: stateSchema,
  /**
   * Whether this row names a repository that EXISTS RIGHT NOW — `state` is
   * `created` or `connected` AND the realized repository is still present.
   *
   * ⚠️ THE DISCRIMINATOR A MATERIALIZING CLIENT BRANCHES ON, published rather
   * than left to be re-derived from `state` + a null check. `ProjectRepoDto`'s
   * own comment gives the reason — "Derived here so no consumer re-implements
   * the two-part rule and none of them can drift from `resolveProjectRepoNames`,
   * which filters on exactly this" — and a client outside this repository is
   * exactly the consumer most able to drift.
   */
  established: z.boolean(),
});
export type V1ProjectRepository = z.infer<typeof projectRepositorySchema>;

/**
 * Map a `ProjectRepoDto` to the wire resource — field by field, never a spread.
 *
 * Every nullable field above is `null` for the SAME structural reason: there is
 * no `realizedRepo`. They are carried separately rather than as one nested
 * object so a client reads a flat row, and so an added coordinate is an added
 * field (§8-additive) rather than a reshape of a nested one.
 */
export function presentProjectRepository(row: ProjectRepoDto): V1ProjectRepository {
  const realized = row.realizedRepo;
  return {
    id: row.id,
    role: row.role,
    label: row.label,
    name: realized?.name ?? null,
    repoRef: realized?.repoRef ?? null,
    // Derived at read time, never stored — `lib/repos/cloneUrl.ts` records why:
    // the instance base is deployment config that can change under a row that
    // outlives it, so a stored column would freeze whatever it was at connect.
    cloneUrl: realized ? repoCloneUrl(realized) : null,
    defaultBranch: realized?.defaultBranch ?? null,
    archived: realized?.archived ?? false,
    state: row.state,
    established: row.established,
  };
}
