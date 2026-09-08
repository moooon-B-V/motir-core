import { Prisma, type Project, type ProjectRepoRole } from '@/generated/prisma/client';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { bindOrganizationContext } from '@/lib/organizations/context';
import { resolveOrganizationId } from '@/lib/github/resolveOrganizationId';
import { keyForAppend } from '@/lib/workItems/positioning';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assertOrgAdmin, assertOrgMember } from '@/lib/services/organizationAccessService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { migrateOnboardingRepository } from '@/lib/repositories/migrateOnboardingRepository';
import { projectsLayeringConnectedRepos } from '@/lib/projectRepos/effectiveDomain';
import { repoNameKey } from '@/lib/workItems/repoName';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { deriveCodeGraphIndexState } from '@/lib/codeGraph/indexState';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { toProjectRepoDto } from '@/lib/mappers/projectRepoMappers';
import { toOrgRepoOptionDto, toUsingProjectDto } from '@/lib/mappers/organizationRepoMappers';
import type {
  OrgRepoIndexStateDto,
  OrgRepoInventoryRowDto,
  OrgRepoOptionDto,
  OrgRepoUsageDto,
} from '@/lib/dto/organizationRepos';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import {
  GithubRemovalHappensOnGithubError,
  MotirHostedRepoIsTakenOverError,
  ProjectRepoInvalidFieldError,
  ProjectRepoLinkConflictError,
  ProjectRepoNameTakenError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';

// ADD AND LINK — the ONE action this story is about (Story MOTIR-4669 ·
// MOTIR-4678). No UI here; that is MOTIR-4680 and MOTIR-4681.
//
// `Add repository` is one act with TWO inputs, and this service is what makes
// that true rather than the UI pretending it:
//
//   PICK    an organisation-connected repository → create the `ProjectRepo` link.
//           NOTHING ELSE HAPPENS. No installation call, no index enqueue, no
//           graph work. The row is usable immediately and reads
//           `already indexed · shared`.
//   CONNECT a new one → perform the organisation connection AND the project link.
//           The ONLY path that costs an index.
//
// ⚠️ THE ABSENCE ON THE PICK PATH IS THE FEATURE. "Nothing re-indexes" is not
// visible on a screen — it is the non-occurrence of a job — so it is asserted
// where the enqueue would have been, on a double's call count being zero. A
// reasonable implementer WILL be tempted to enqueue "for safety" here; that
// would silently reintroduce the per-project index cost this whole story exists
// to remove.
//
// 4-layer per CLAUDE.md: this service owns the transactions and the gates; every
// row read/write goes through a repository; the routes are transport.

/** What the caller supplies to link a repository the organisation already has. */
export interface LinkExistingRepoInput {
  /** The internal `GithubRepo.id`, as `listAvailableForProject` returned it. */
  githubRepoId: string;
  role: ProjectRepoRole;
  /** The row's name inside the project. Defaults to the repository's own name. */
  name?: string;
  label?: string;
}

/** What the caller supplies to connect a NEW repository and link it in one act. */
export interface ConnectAndLinkInput {
  /** The PROVIDER's installation id, from the App's post-install redirect. */
  installationId: string;
  /** The provider's repo id (`GithubRepo.repoId`) selected during that install. */
  providerRepoId: string;
  role: ProjectRepoRole;
  name?: string;
  label?: string;
}

/**
 * ⚠️ THE ORG GUC IS BOUND INSIDE THE PROJECT'S OWN TRANSACTION, and both halves
 * are load-bearing.
 *
 * The project gate (`repository:manage` / browse) is what proves the actor may
 * touch THIS project, and it is workspace-scoped. The organisation read is what
 * makes the picker span the org's OTHER workspaces, and `github_repo`'s shipped
 * `FOR ALL` policy is workspace-keyed — so without `bindOrganizationContext` the
 * inventory read returns a SUBSET and looks like a short list rather than a bug.
 * MOTIR-4677's `github_repo_org_read` (`FOR SELECT`) is what admits the rest, and
 * this is the call that turns it on.
 *
 * The organisation id comes from the WORKSPACE ROW's own `organizationId` — a
 * trusted resolution, never request input, which is the constraint
 * `bindOrganizationContext` documents for itself.
 */
async function inProjectOrg<T>(
  projectId: string,
  ctx: ServiceContext,
  mode: 'browse' | 'edit',
  fn: (tx: Prisma.TransactionClient, organizationId: string) => Promise<T>,
): Promise<T> {
  if (mode === 'edit') {
    await projectAccessService.assertPermission(projectId, ctx, 'repository:manage');
  } else {
    await projectAccessService.assertCanBrowse(projectId, ctx);
  }
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
    async (tx) => {
      const organizationId = await resolveOrganizationId(ctx.workspaceId, tx);
      await bindOrganizationContext(tx, organizationId);
      return fn(tx, organizationId);
    },
  );
}

/**
 * The two shapes Prisma can put in a `P2002`'s `meta.target`: the COLUMN LIST
 * (`["project_id", "github_repo_id"]`) or the INDEX NAME
 * (`project_repository_project_id_github_repo_id_key`). Both are matched, and
 * both are matched POSITIVELY — see `translateLinkViolation`.
 */
function targetFields(err: Prisma.PrismaClientKnownRequestError): string[] | null {
  const target = err.meta?.['target'];
  if (Array.isArray(target)) {
    const fields = target.map(String).filter((f) => f.length > 0);
    return fields.length > 0 ? fields : null;
  }
  if (typeof target === 'string' && target.length > 0) return [target];
  return null;
}

/**
 * The constraint name out of the DRIVER's own error, when `meta.target` has none.
 *
 * ⚠️ THIS IS WHERE THE ANSWER ACTUALLY IS UNDER RLS, and it was worth finding:
 * Prisma drops the constraint name on its way to `meta.target` (the adapter builds
 * that from `DETAIL` alone), but it PRESERVES the driver's original error beneath
 * `meta.driverAdapterError`. Measured on a real lost race under the `motir_app`
 * role:
 *
 *   meta = { modelName: 'ProjectRepo', driverAdapterError: { cause: {
 *     originalCode: '23505',
 *     originalMessage: 'duplicate key value violates unique constraint
 *                       "project_repository_project_id_github_repo_id_key"' } } }
 *
 * So the index name survives, quoted, in a message PostgreSQL sends whether or not
 * it is willing to describe the conflicting VALUES — which is exactly the
 * distinction RLS draws. Reading it turns the ordinary case back into a local,
 * positive classification with no second query.
 *
 * It is read DEFENSIVELY and is never the only path: the message is
 * server-localized, so a `lc_messages` other than English changes the prose around
 * the name. Only the QUOTED identifier is taken, and a miss falls through to the
 * set re-read rather than guessing.
 */
function driverConstraintName(err: Prisma.PrismaClientKnownRequestError): string | null {
  const adapterError = err.meta?.['driverAdapterError'];
  if (typeof adapterError !== 'object' || adapterError === null) return null;
  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return null;
  const message = (cause as { originalMessage?: unknown }).originalMessage;
  if (typeof message !== 'string') return null;
  return message.match(/"([^"]+)"/)?.[1] ?? null;
}

/** `@@unique([projectId, githubRepoId])`, in either shape. */
function namesClaimConstraint(fields: string[]): boolean {
  // One test covers both shapes: the column is `github_repo_id`, and the index
  // name `project_repository_project_id_github_repo_id_key` contains it.
  return fields.some((f) => f.includes('github_repo_id'));
}

/** `@@unique([projectId, name])`, in either shape. */
function namesNameConstraint(fields: string[]): boolean {
  // Two tests, because the index name does NOT contain the bare column: it is
  // `project_repository_project_id_name_key`. Checked AFTER the claim constraint,
  // so the ordering never has to arbitrate between them.
  return fields.some((f) => f === 'name' || f.endsWith('_name_key'));
}

/**
 * Translate a unique-constraint violation on the set INSERT into its typed error,
 * so a raw P2002 never escapes (the concurrency-to-typed-error rule).
 *
 * ⚠️ BOTH ARMS ARE POSITIVE, AND THE REMAINDER HAS ITS OWN NAME (Bug MOTIR-4833).
 * This function used to test for `github_repo_id` and let an `else` throw
 * `ProjectRepoNameTakenError` — so a violation it could not classify was ASSERTED
 * to be a name collision. That is not a vaguer answer than the truth, it is a
 * different and actionable one: it tells a person to rename something, when the
 * real condition was that another project's write claimed the repository first
 * and renaming cannot help.
 *
 * ⚠️ AND `meta.target` IS ABSENT FOR EVERY LOST RACE ON THIS PATH — which is why
 * there are three classification layers rather than one. MEASURED, not deduced:
 *
 *   1. `project_repository` is `FORCE ROW LEVEL SECURITY`, and the app connects as
 *      a NON-SUPERUSER role, so PostgreSQL's `BuildIndexValueDescription` declines
 *      to describe the conflicting key and the `23505` arrives with **no `DETAIL`
 *      line at all** (verified against this schema's own dev database: as the
 *      owner `DETAIL` is present, as `motir_app` it is `undefined`, while
 *      `constraint` — the index name — is present in BOTH).
 *   2. `@prisma/adapter-pg` derives `meta.target` from `error.detail` ALONE
 *      (`error.detail?.match(/Key \(([^)]+)\)/)`, `node_modules/@prisma/adapter-pg`),
 *      and never from `error.constraint`. No `DETAIL` ⇒ no `target`.
 *
 * So the index name the database DID report never reaches `meta.target`, the
 * `github_repo_id` arm was unreachable under RLS, and every lost race — of either
 * constraint — produced the name error. It stayed invisible because the pre-checks
 * usually win the race, and because when the NAME race lost the fallback happened
 * to be the right answer; only the CLAIM race could ever go red.
 *
 * ⚠️ THE NAME IS NOT LOST, THOUGH — IT IS ONE LEVEL DOWN. Prisma preserves the
 * driver's original error under `meta.driverAdapterError`, whose `originalMessage`
 * quotes the constraint (`driverConstraintName`). So the ordinary case classifies
 * locally after all, and `resolveUnclassifiedLinkConflict` is the backstop for the
 * case where neither layer names a constraint rather than the common path.
 *
 * ⚠️ EXPORTED FOR ITS OWN UNIT TEST, and that is the point rather than a
 * concession. The only thing that has ever executed these branches is a
 * `Promise.allSettled` race whose loser reaches the INSERT — so which arm gets
 * exercised is decided by a scheduler, and the branch that carried the defect was
 * covered by luck for as long as it existed. Driving the function directly with
 * each `meta.target` shape is what turns that into a test.
 */
export function translateLinkViolation(
  err: unknown,
  fallback: { name: string; githubRepoId: string; projectId: string },
): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    // Most reliable first: the STRUCTURED target, when Prisma has one. Then the
    // constraint name out of the driver's own error, which survives RLS. Then, and
    // only then, the remainder — resolved against the set by the caller.
    const fields = targetFields(err) ?? [driverConstraintName(err)].filter((f) => f !== null);
    if (fields.length > 0 && namesClaimConstraint(fields)) {
      throw new RealizedRepoAlreadyClaimedError(fallback.githubRepoId);
    }
    if (fields.length > 0 && namesNameConstraint(fields)) {
      throw new ProjectRepoNameTakenError(fallback.name, fallback.projectId);
    }
    // The instrument this defect cost an elimination argument to reach. One line
    // here settles the next occurrence by reading it instead of deducing it.
    console.warn('[organizationRepoService] unclassified P2002 on the repository-set insert', {
      code: err.code,
      meta: err.meta,
      projectId: fallback.projectId,
      githubRepoId: fallback.githubRepoId,
    });
    throw new ProjectRepoLinkConflictError(
      fallback.projectId,
      fallback.name,
      fallback.githubRepoId,
    );
  }
  throw err;
}

/**
 * Resolve an unclassifiable link conflict by ASKING THE SET, once the failed
 * transaction has unwound.
 *
 * ⚠️ IT HAS TO RUN OUT HERE, AND THAT IS THE WHOLE REASON THIS WRAPPER EXISTS.
 * The obvious place to disambiguate is the `catch` beside the INSERT, where both
 * the intent and a `tx` are in hand — and it cannot work there: PostgreSQL aborts
 * the transaction block on the `23505`, so every further statement on that `tx`
 * fails with `25P02` until it rolls back. By the time control reaches here the
 * transaction is gone, the WINNER's row is committed, and one read answers the
 * question the error could not.
 *
 * It opens no new authorization surface: the org-admin gate and the project
 * `repository:manage` gate both passed inside the transaction that just failed,
 * and this reads the same project's own set under the same workspace context.
 */
async function resolveUnclassifiedLinkConflict<T>(
  projectId: string,
  ctx: ServiceContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof ProjectRepoLinkConflictError)) throw err;
    await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        // The CLAIM is asked first because it is the one a rename cannot fix.
        const claimed = await projectRepoRepository.findByProjectAndGithubRepoId(
          projectId,
          err.githubRepoId,
          tx,
        );
        if (claimed) throw new RealizedRepoAlreadyClaimedError(err.githubRepoId);
        const named = await projectRepoRepository.findByProjectAndNameInsensitive(
          projectId,
          err.repoName,
          ctx.workspaceId,
          tx,
        );
        if (named) throw new ProjectRepoNameTakenError(err.repoName, projectId);
      },
    );
    // Neither uniqueness explains it. That is a real answer and it keeps its own
    // name — a 409 the caller can retry, never a name collision it cannot fix.
    throw err;
  }
}

export const organizationRepoService = {
  /**
   * `Used by N projects` — WHO holds each of the organisation's repositories.
   *
   * ONE read, TWO consumers: the count drawn on every inventory row AT REST
   * (`design/github` panel 6) and the names the org-level disconnect dialog
   * enumerates. That is deliberate — the whole disclosure argument is that the
   * number was on screen before the decision, so a dialog computing its own list
   * could disagree with the row a person had been looking at all week.
   *
   * ⚠️ ACCESS-FILTERED, PER WORKSPACE, AND THE COUNT IS THE LIST'S LENGTH. The
   * row is org-membership-gated (`organization-tier.md` §6), and an organisation
   * contains projects a given member may not browse. The filter runs once per
   * workspace because that is where the actor's role lives — a workspace they are
   * not in returns nothing, by `filterBrowsable`'s null-role rail. A separate
   * count would announce the existence of a project the viewer cannot name.
   *
   * ⚠️ "USES" IS WHAT A PROJECT HAS **CHOSEN** — CORRECTED 2026-09-07 (MOTIR-4821);
   * the struck text stood here and shipped a FALSE claim on a destructive
   * disclosure.
   *
   * ~~"USES" IS THE SCOPE LADDER, NOT `project_repository` (MOTIR-4802). The answer
   * is composed of two halves: EXPLICIT links, plus every project of the
   * repository's OWN workspace whose domain layers the connected registry.~~
   *
   * The FIRST half was right and is unchanged. The SECOND was a permissive
   * default read backwards. `lib/projectRepos/effectiveDomain.ts` answers *if this
   * project dispatches work, which repositories MAY it reach?*, and it hands a
   * project with no set at all the workspace's whole connected registry precisely
   * BECAUSE that project has never chosen. Inverting it produces *which projects
   * USE this repository*, which no permissive default can support: a scratch
   * project created and left empty was named against all seven of the
   * organisation's repositories, in the column the DISCONNECT dialogue leans on,
   * so a person deciding whether disconnecting will hurt anybody was shown
   * projects that had never touched it (MOTIR-4821). Reusing the module that owns
   * a question is right; assuming the relation is SYMMETRIC because one direction
   * is authoritative is not.
   *
   * MOTIR-4802's report is answered by the same correction rather than reverted.
   * It was filed because Motir's own project — six connected repositories, an
   * empty set — read `Used by no project yet` on repositories it demonstrably
   * works in. What makes that project different from the scratch one is not its
   * domain (identical) but its WORK: it names those repositories on its work
   * items, and the scratch project names nothing. So:
   *
   *   EXPLICIT  a `project_repository` link, whichever workspace it comes from —
   *             the org tier's whole point is that a project may link a
   *             repository connected from a sibling workspace.
   *   NAMED     a project of the repository's OWN workspace whose domain layers
   *             the connected registry AND which names this repository on a work
   *             item (`work_item.targetRepos` — the only way a set-less project
   *             can express the choice at all). `listConnectedRepoNames` is
   *             workspace-scoped, so the layering half stays scoped the same way.
   *
   * The ladder is still not re-derived here — `projectsLayeringConnectedRepos`
   * owns the rung, and it now gates the evidence rather than standing in for it.
   *
   * ⚠️ THE PERMISSIVE DEFAULT IS STILL REAL AND IS STILL DISCLOSED — as a
   * property of the ORGANISATION, said once in the inventory card's foot and in
   * the disconnect dialogue, never by naming N projects that never chose
   * anything.
   *
   * Two BULK reads gather the ladder's inputs for the whole organisation, rather
   * than N project-scoped `resolveEffectiveRepoDomain` calls per render. Each
   * runs under the ONE context that can see all of its rows, and neither may be
   * moved: `project_repository` answers only under the ORG binding (no system
   * arm) and `migrate_onboarding` only under SYSTEM context (no org arm). Either
   * read taken under the wrong one returns a subset that the ladder converts into
   * a WRONG verdict rather than a short list — the failure this whole card is.
   */
  async listRepositoryUsage(ctx: ServiceContext): Promise<OrgRepoUsageDto[]> {
    // The organisation is resolved from the actor's WORKSPACE row — trusted, not
    // request input — and membership is what admits the read at all.
    // ONE org-bound transaction for BOTH org-spanning reads. `github_repo` and
    // `project_repository` each carry a `*_org_read` FOR SELECT arm (MOTIR-4677
    // and this card's own migration); neither answers from a bare workspace
    // context, and both would return a SUBSET rather than raise — the MOTIR-2956
    // failure shape, which is why they are bound together rather than one at a
    // time.
    const { repos, linksByRepo, linkedProjectIds, workspaceIds, setProjectIds } =
      await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        async (tx) => {
          const orgId = await resolveOrganizationId(ctx.workspaceId, tx);
          await assertOrgMember(ctx.userId, orgId, tx);
          await bindOrganizationContext(tx, orgId);
          const found = await githubRepoRepository.listByOrganization(orgId, tx);
          const byRepo = new Map<string, string[]>();
          const ids = new Set<string>();
          for (const repo of found) {
            const links = await projectRepoRepository.listByGithubRepoId(repo.id, tx);
            byRepo.set(
              repo.id,
              links.map((l) => l.projectId),
            );
            for (const l of links) ids.add(l.projectId);
          }
          // The ladder's FIRST input, in one read for the whole organisation. It
          // is gathered HERE and not below because `project_repository` has no
          // system arm — see the method's own warning.
          const wsIds = [...new Set(found.map((r) => r.workspaceId))];
          const withRows = await projectRepoRepository.listProjectIdsWithRows(wsIds, tx);
          return {
            repos: found,
            linksByRepo: byRepo,
            linkedProjectIds: [...ids],
            workspaceIds: wsIds,
            setProjectIds: new Set(withRows),
          };
        },
      );
    if (repos.length === 0) return [];

    // The PROJECT rows are read under the system arm `project_workspace_or_system_read`
    // already carries — the ids are resolved above and this only turns them into
    // names, which the access filter below then narrows. No new arm is owed, and
    // no arm is widened: this is the same read `codeGraphOffboardingService`
    // performs on the same table for the same reason.
    const { projectsById, projectIdsByWorkspace, layering } = await withSystemContext(
      async (tx) => {
        // The LAYERING candidates: every non-archived project of a workspace that
        // has a repository connected. Archived is excluded deliberately — an
        // archived project is not somebody a disconnect dialogue should warn
        // about, and `findByWorkspace` is the read that already draws that line.
        const byWorkspace = new Map<string, string[]>();
        const found = new Map<string, Project>();
        for (const workspaceId of workspaceIds) {
          const projects = await projectRepository.findByWorkspace(workspaceId, tx);
          byWorkspace.set(
            workspaceId,
            projects.map((p) => p.id),
          );
          for (const project of projects) found.set(project.id, project);
        }
        const candidateIds = [...found.keys()];
        const ownCode = new Set(
          await migrateOnboardingRepository.listProjectIdsWithConnectedRepo(candidateIds, tx),
        );
        const layers = projectsLayeringConnectedRepos(
          candidateIds.map((projectId) => ({
            projectId,
            hasSet: setProjectIds.has(projectId),
            hasOwnCode: ownCode.has(projectId),
          })),
        );
        // A LINKED project need not be a candidate: the org tier's whole claim is
        // that a project may link a repository connected from a sibling
        // workspace, and that project's own workspace may have none of its own.
        const outside = linkedProjectIds.filter((id) => !found.has(id));
        for (const project of await projectRepository.findManyByIds(outside, tx)) {
          found.set(project.id, project);
        }
        return { projectsById: found, projectIdsByWorkspace: byWorkspace, layering: layers };
      },
    );

    // One filter pass per WORKSPACE — the actor's role is workspace-scoped, so a
    // single call with one ctx would judge every project by their role in one
    // workspace and admit projects in workspaces they have never joined.
    const byWorkspace = new Map<string, Project[]>();
    for (const project of projectsById.values()) {
      const list = byWorkspace.get(project.workspaceId) ?? [];
      list.push(project);
      byWorkspace.set(project.workspaceId, list);
    }
    const browsable = new Set<string>();
    // WHICH REPOSITORY NAMES EACH LAYERING PROJECT HAS ACTUALLY NAMED ON ITS WORK
    // — the evidence half of the NAMED rung (MOTIR-4821), keyed by
    // `repoNameKey` so `owner/name` and a differently-cased `name` compare as the
    // one checkout identity `mergeDomainsByName` already treats them as.
    //
    // ⚠️ IT IS GATHERED INSIDE THE ACCESS LOOP, AND THAT PLACEMENT IS THE RAIL.
    // `filterBrowsable` runs per workspace because the actor's role is
    // workspace-scoped, so a workspace the actor is not in returns nothing — and
    // reading work items only for the projects it just ADMITTED is what keeps this
    // read inside the actor's own membership without a new RLS arm. Reading the
    // whole organisation's work first and filtering afterwards would bind a
    // workspace context the actor may have no membership in; `work_item`'s
    // policy compares the workspace and nothing else, so it would answer.
    const namedByProject = new Map<string, Set<string>>();
    for (const [workspaceId, projects] of byWorkspace) {
      const allowed = await projectAccessService.filterBrowsable(projects, {
        userId: ctx.userId,
        workspaceId,
      });
      for (const p of allowed) browsable.add(p.id);
      // Only the LAYERING ones: a project that reaches this list through an
      // explicit link is already answered, and asking for its work would be a
      // read whose result nothing consults.
      const layeringHere = allowed
        .filter((p) => p.workspaceId === workspaceId && layering.has(p.id))
        .map((p) => p.id);
      if (layeringHere.length === 0) continue;
      const names = await withWorkspaceContext({ userId: ctx.userId, workspaceId }, (tx) =>
        workItemRepository.listRepoNamesByProject(workspaceId, layeringHere, tx),
      );
      for (const [projectId, list] of names) {
        const keys = new Set<string>();
        for (const name of list) {
          const key = repoNameKey(name);
          if (key) keys.add(key);
        }
        namedByProject.set(projectId, keys);
      }
    }

    return repos.map((repo) => {
      // EXPLICIT first, then NAMED — a stable order, and the one a reader
      // expects: the projects that LINKED this repository, then the ones that
      // named it on their work.
      const explicit = linksByRepo.get(repo.id) ?? [];
      // NAMED, not merely LAYERED: the project's domain must reach the repository
      // AND its work must name it. Dropping the second conjunct is exactly the
      // MOTIR-4821 regression — every set-less project against every repository.
      const repoKey = repoNameKey(repo.name);
      const named = (projectIdsByWorkspace.get(repo.workspaceId) ?? []).filter(
        (id) => layering.has(id) && repoKey !== null && namedByProject.get(id)?.has(repoKey),
      );
      return {
        githubRepoId: repo.id,
        repoRef: `${repo.owner}/${repo.name}`,
        projects: [...new Set([...explicit, ...named])]
          .filter((id) => browsable.has(id))
          .map((id) => projectsById.get(id))
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map(toUsingProjectDto),
      };
    });
  },

  /**
   * THE ORGANISATION'S REPOSITORY INVENTORY — one row per connected repository,
   * with who uses it and what Motir knows about its index (MOTIR-4680).
   *
   * Composes {@link listRepositoryUsage} rather than re-deriving it, so the count
   * the inventory row draws and the names the disconnect dialog enumerates are
   * literally the same list. ONE read, both consumers, which is the whole
   * disclosure argument: a dialog computing its own could disagree with the row a
   * person had been looking at all week.
   *
   * ⚠️ THE INDEX STATE IS ALL FOUR NOW (MOTIR-4724), and it is DERIVED IN ONE
   * PLACE — `deriveCodeGraphIndexState`. This service assembles the facts and
   * reads none of them itself: a second comparison written here would be a second
   * definition of "stale", and the whole point of that module is that the
   * organisation inventory and the `Code` page cannot disagree about the word.
   *
   * Two of the three facts are columns on the repo row. The third — is a
   * `running` index run still running — is resolved against the LEDGER rather
   * than off the column, because `indexing_run_id` is a pointer and a crashed run
   * would otherwise leave a row reading `Indexing…` for ever.
   *
   * The ledger is workspace-keyed and this is an organisation, so the refs are
   * gathered per workspace under system context — the same read
   * `codeGraphOffboardingService` performs on the same table for the same reason.
   */
  async listInventory(ctx: ServiceContext): Promise<OrgRepoInventoryRowDto[]> {
    const usage = await organizationRepoService.listRepositoryUsage(ctx);
    if (usage.length === 0) return [];

    const organizationId = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => resolveOrganizationId(ctx.workspaceId, tx),
    );

    const { indexedRefs, runningRunIds } = await withSystemContext(async (tx) => {
      const workspaces = await workspaceRepository.listByOrganization(organizationId, tx);
      const refs = new Set<string>();
      for (const workspace of workspaces) {
        for (const ref of await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(
          workspace.id,
          tx,
        )) {
          refs.add(ref);
        }
      }
      // WHICH claimed runs are actually still running. One read for the whole
      // inventory rather than one per row, and it is what makes a crashed run
      // self-healing: an `abandoned` row is simply not in this set.
      const running = await tx.jobRun.findMany({
        where: { functionId: 'system.code-graph-index', status: 'running' },
        select: { id: true },
      });
      return { indexedRefs: refs, runningRunIds: new Set(running.map((r) => r.id)) };
    });

    const repos = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        await bindOrganizationContext(tx, organizationId);
        return githubRepoRepository.listByOrganization(organizationId, tx);
      },
    );
    const byId = new Map(repos.map((r) => [r.id, r]));

    // ⚠️ WHOSE EACH ROW IS — resolved ONCE for the list, and the answer the ROOM
    // already gives (bug MOTIR-4892). `listByOrganization` filters on
    // `github_repo.organization_id` and nothing else, which answers "can this
    // organisation's projects dispatch into it?" — deliberately, since
    // `persistProvisionedRepo` stamps the creating project's organisation onto a
    // repository MOTIR provisions. So a repository Motir hosts is in this list and
    // must stay in it; what was missing is the row being able to SAY so.
    // The classification is `isMotirHostedOwner`, the same predicate
    // `lib/projectRepos/roomSections.ts` classifies the project room's sections
    // with, so the two surfaces cannot answer "whose is it?" differently again.
    const hostOwner = provisioningOrgLogin();

    return usage.flatMap((row) => {
      const repo = byId.get(row.githubRepoId);
      if (!repo) return [];
      const indexState: OrgRepoIndexStateDto = deriveCodeGraphIndexState({
        hasSucceededIndex: indexedRefs.has(row.repoRef),
        defaultBranchHeadSha: repo.defaultBranchHeadSha,
        indexedHeadSha: repo.indexedHeadSha,
        hasRunningIndex: repo.indexingRunId !== null && runningRunIds.has(repo.indexingRunId),
      });
      return [{ repo: toOrgRepoOptionDto(repo, hostOwner), projects: row.projects, indexState }];
    });
  },

  /**
   * DISCONNECT FROM THE ORGANISATION — the destructive one, and the one that
   * shares a word with the harmless row action.
   *
   * It clears the repository's link on EVERY project of the organisation — across
   * workspaces, which is what makes it the org-level act — and enqueues the
   * windowed offboarding (`repo_disconnected`), one enqueue per affected
   * workspace because the queue is workspace-scoped.
   *
   * ⚠️ THE LINKS ARE CLEARED, THE ROWS ARE NOT DELETED, and this is the SCHEMA's
   * decision rather than this card's: `ProjectRepo.githubRepo` is `onDelete:
   * SetNull` and says why on itself — *"disconnecting this repo leaves each row
   * standing"*, because a project's PLAN for a repository outlives the connection
   * to one. This card's description says "removes every `ProjectRepo` row"; its
   * acceptance criterion says "removes every LINK", and the link is what a
   * disconnect removes. Deleting the rows would delete the projects' plans as a
   * side effect of an integration change.
   *
   * ⚠️ GITHUB IS REFUSED HERE, ON PURPOSE. See
   * {@link GithubRemovalHappensOnGithubError} — the disclosure plus the link-out
   * is the GitHub arm, and the removal arrives through the webhook.
   */
  async disconnectFromOrganisation(
    githubRepoId: string,
    ctx: ServiceContext,
  ): Promise<{ clearedLinks: number; enqueued: number }> {
    const { repo, organizationId } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const orgId = await resolveOrganizationId(ctx.workspaceId, tx);
        await assertOrgAdmin(ctx.userId, orgId, tx);
        await bindOrganizationContext(tx, orgId);
        const found = await githubRepoRepository.findById(githubRepoId, tx);
        return { repo: found, organizationId: orgId };
      },
    );
    if (!repo || repo.organizationId !== organizationId) {
      throw new ProjectRepoInvalidFieldError(
        'githubRepoId',
        'it does not name a repository connected to this organisation.',
      );
    }
    const repoRef = `${repo.owner}/${repo.name}`;
    // ⚠️ OWNERSHIP IS TESTED BEFORE THE PROVIDER, and the order is the fix (bug
    // MOTIR-4892). `GithubRemovalHappensOnGithubError` is thrown for EVERY
    // `github` row, so until this line ran first it answered a repository MOTIR
    // hosts with *"change the Motir App's repository access on GitHub"* — an
    // instruction pointing at the ORGANISATION's installation, which a repository
    // under the shared provisioning installation is not in. The act that applies
    // to it is the TAKEOVER (MOTIR-711), and the refusal names it.
    if (isMotirHostedOwner(repo.owner, provisioningOrgLogin())) {
      throw new MotirHostedRepoIsTakenOverError(repoRef);
    }
    if (repo.provider === 'github') throw new GithubRemovalHappensOnGithubError(repoRef);

    // ENUMERATE BEFORE THE CASCADE — the ordering trap MOTIR-2166 names. The
    // `project_repository` rows are what say which projects had this repository;
    // once the mirror row is gone and the links are null, nothing is left to
    // enumerate and the graphs become unreachable orphans.
    // The LINKS under the org arm this card adds; the PROJECTS under the system
    // arm `project` already carries. Two contexts, because the two tables answer
    // to different policies and neither answers to both — reading the projects
    // inside the org-bound transaction returns only the caller's own workspace,
    // which is how this first ran and why `clearedLinks` came back 1 instead of 2.
    const projectIds = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        await bindOrganizationContext(tx, organizationId);
        const links = await projectRepoRepository.listByGithubRepoId(repo.id, tx);
        return links.map((l) => l.projectId);
      },
    );
    const affected = await withSystemContext(async (tx) => {
      const projects = await projectRepository.findManyByIds(projectIds, tx);
      const byWorkspace = new Map<string, string[]>();
      for (const project of projects) {
        const list = byWorkspace.get(project.workspaceId) ?? [];
        list.push(project.id);
        byWorkspace.set(project.workspaceId, list);
      }
      return { byWorkspace };
    });

    // ⚠️ THE CLEAR IS ONE BOUND WRITE PER AFFECTED WORKSPACE, not one sweeping
    // statement, and that is the RLS talking rather than a style choice. The org
    // arms this card and MOTIR-4677 add are `FOR SELECT` only — permissive
    // policies OR-combine, so widening the write arm would have handed a sibling
    // workspace a DELETE it never had. `project_repository`'s sole write policy is
    // `workspace_id = app.workspace_id` with no system arm, so the only context
    // that can clear a link is that link's own workspace. The authorisation
    // happened once, at the org-admin gate above; this is the execution, walked.
    let cleared = 0;
    for (const workspaceId of affected.byWorkspace.keys()) {
      cleared += await withWorkspaceContext({ userId: ctx.userId, workspaceId }, (tx) =>
        projectRepoRepository.clearGithubRepoLinks(repo.id, workspaceId, tx),
      );
    }
    // The MIRROR row is the organisation's, and it is deleted from the workspace
    // that connected it — `github_repo`'s write policy is workspace-keyed too.
    await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: repo.workspaceId ?? ctx.workspaceId },
      (tx) =>
        githubRepoRepository.deleteByInstallationAndRepoId(repo.installationId, repo.repoId, tx),
    );

    // POST-COMMIT, BEST-EFFORT, per the four triggers' own convention: the user's
    // disconnect has already committed, so a failed queue write must not report a
    // false failure for an action the database kept. Windowed —
    // `repo_disconnected` is not immediate, and re-adding inside the window
    // cancels it, which is what makes the retention promise a grace period.
    let enqueued = 0;
    for (const [workspaceId, projectIds] of affected.byWorkspace) {
      enqueued += await codeGraphOffboardingService.enqueueQuietly({
        coreWorkspaceId: workspaceId,
        coreProjectIds: projectIds,
        repoRefs: [repoRef],
        reason: 'repo_disconnected',
      });
    }
    return { clearedLinks: cleared, enqueued };
  },

  /**
   * THE PICKER'S FIRST SEGMENT — the organisation's connected repositories,
   * MINUS the ones this project already holds.
   *
   * Gated on project BROWSE and org membership rather than org admin, and that is
   * deliberate: §6 of `docs/decisions/organization-tier.md` forbids a relocation
   * that narrows an audience, and the surface this inventory relocates from
   * (`/settings/workspace/github`) reads with no role check at all. The ADD is
   * org-admin; SEEING what the organisation has is not.
   *
   * The subtraction is done here rather than in SQL because both sides are small
   * and the join would have to cross an RLS boundary the two reads already cross
   * correctly on their own.
   */
  async listAvailableForProject(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<OrgRepoOptionDto[]> {
    return inProjectOrg(projectId, ctx, 'browse', async (tx, organizationId) => {
      const [orgRepos, held] = await Promise.all([
        githubRepoRepository.listByOrganization(organizationId, tx),
        projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx),
      ]);
      const taken = new Set(held.map((row) => row.githubRepoId).filter((id): id is string => !!id));
      const hostOwner = provisioningOrgLogin();
      return orgRepos
        .filter((repo) => !taken.has(repo.id))
        .map((repo) => toOrgRepoOptionDto(repo, hostOwner));
    });
  },

  /**
   * PICK — link a repository the organisation already has into this project.
   *
   * ⚠️ NOTHING IS ENQUEUED. Not conditionally, not "if the graph looks stale".
   * The repository is connected and indexed at the organisation; a second project
   * using it is one row.
   *
   * The row is created `connected` with its `githubRepoId` set in ONE write
   * rather than created `proposed` and then attached, because there is no
   * intermediate state to observe: the repository exists before the row does.
   */
  async linkExistingRepo(
    projectId: string,
    input: LinkExistingRepoInput,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    return resolveUnclassifiedLinkConflict(projectId, ctx, () =>
      inProjectOrg(projectId, ctx, 'edit', async (tx, organizationId) => {
        // The org-admin gate, in the SERVICE and inside the transaction. The room's
        // own `repository:manage` is a PROJECT permission — without this a project
        // admin who is not an org admin could attach the organisation's
        // repositories through it. A gate on the button is a gate one caller away
        // from being missing.
        await assertOrgAdmin(ctx.userId, organizationId, tx);

        const repo = await githubRepoRepository.findById(input.githubRepoId, tx);
        // Not-found and belongs-to-another-org are ONE answer on purpose: a probe
        // must not be able to tell a real id in a foreign org from a fictional one.
        if (!repo || repo.organizationId !== organizationId) {
          throw new ProjectRepoInvalidFieldError(
            'githubRepoId',
            'it does not name a repository connected to this organisation.',
          );
        }

        const name = (input.name ?? repo.name).trim();
        const clash = await projectRepoRepository.findByProjectAndNameInsensitive(
          projectId,
          name,
          ctx.workspaceId,
          tx,
        );
        if (clash) throw new ProjectRepoNameTakenError(name, projectId);

        const existing = await projectRepoRepository.findByProjectAndGithubRepoId(
          projectId,
          repo.id,
          tx,
        );
        // The double-add raises the SAME typed error and the same 409 MOTIR-4648
        // preserved through `@@unique([projectId, githubRepoId])` — the guarantee
        // that survived dropping the global unique index.
        if (existing) throw new RealizedRepoAlreadyClaimedError(repo.id);

        const last = await projectRepoRepository.findLastPosition(projectId, ctx.workspaceId, tx);
        let row;
        try {
          row = await projectRepoRepository.create(
            {
              workspaceId: ctx.workspaceId,
              projectId,
              role: input.role,
              name,
              ...(input.label !== undefined ? { label: input.label } : {}),
              // ⚠️ NOT `defaultSeedSourceForRole` — see SEED_SOURCE_ORGANIZATION. This row
              // seeds from nothing: the repository is the organisation's and has its own
              // history. The Repositories room splits its two sections on exactly this
              // question, so a default here would render the row under "Motir hosts…"
              // offering Take it over for a repository the organisation already owns.
              seedSource: SEED_SOURCE_ORGANIZATION,
              state: 'connected',
              githubRepoId: repo.id,
              position: keyForAppend(last),
            },
            tx,
          );
        } catch (err) {
          translateLinkViolation(err, { name, githubRepoId: repo.id, projectId });
        }
        return toProjectRepoDto({ ...row, githubRepo: repo, collaborators: [] });
      }),
    );
  },

  /**
   * CONNECT — bind the installation to the ORGANISATION and link one of its
   * repositories to this project, in one act.
   *
   * This is the only path that costs an index, and it does not enqueue one
   * itself: `bindInstallationForWorkspace` already enqueues the first index for
   * every repo the install newly selected (MOTIR-1500, re-gated by MOTIR-1961).
   * Adding a second enqueue here would double-count the one thing this story
   * measures, so the composition is deliberate and the test asserts EXACTLY one.
   */
  async connectAndLink(
    projectId: string,
    input: ConnectAndLinkInput,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    // The gate runs BEFORE the installation bind, in its own transaction: the
    // bind talks to the provider and writes rows, and a refusal must happen while
    // there is still nothing to undo.
    await inProjectOrg(projectId, ctx, 'edit', async (tx, organizationId) => {
      await assertOrgAdmin(ctx.userId, organizationId, tx);
    });

    await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: ctx.workspaceId,
      installationId: input.installationId,
    });

    return resolveUnclassifiedLinkConflict(projectId, ctx, () =>
      inProjectOrg(projectId, ctx, 'edit', async (tx, organizationId) => {
        const repo = await githubRepoRepository.findByRepoIdAndProvider(
          input.providerRepoId,
          'github',
          tx,
        );
        if (!repo || repo.organizationId !== organizationId) {
          throw new ProjectRepoInvalidFieldError(
            'providerRepoId',
            'the install did not select that repository for this organisation.',
          );
        }
        const name = (input.name ?? repo.name).trim();
        const last = await projectRepoRepository.findLastPosition(projectId, ctx.workspaceId, tx);
        let row;
        try {
          row = await projectRepoRepository.create(
            {
              workspaceId: ctx.workspaceId,
              projectId,
              role: input.role,
              name,
              ...(input.label !== undefined ? { label: input.label } : {}),
              // ⚠️ NOT `defaultSeedSourceForRole` — see SEED_SOURCE_ORGANIZATION. This row
              // seeds from nothing: the repository is the organisation's and has its own
              // history. The Repositories room splits its two sections on exactly this
              // question, so a default here would render the row under "Motir hosts…"
              // offering Take it over for a repository the organisation already owns.
              seedSource: SEED_SOURCE_ORGANIZATION,
              state: 'connected',
              githubRepoId: repo.id,
              position: keyForAppend(last),
            },
            tx,
          );
        } catch (err) {
          translateLinkViolation(err, { name, githubRepoId: repo.id, projectId });
        }
        return toProjectRepoDto({ ...row, githubRepo: repo, collaborators: [] });
      }),
    );
  },
};
