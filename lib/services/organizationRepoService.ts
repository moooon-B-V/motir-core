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
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { deriveCodeGraphIndexState } from '@/lib/codeGraph/indexState';
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
  ProjectRepoInvalidFieldError,
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

/** Translate the `(project_id, github_repo_id)` race into its typed error, so a
 *  raw P2002 never escapes (the concurrency-to-typed-error rule). */
function translateLinkViolation(
  err: unknown,
  fallback: { name: string; githubRepoId: string; projectId: string },
): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = err.meta?.['target'];
    const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    if (fields.some((f) => f.includes('github_repo_id'))) {
      throw new RealizedRepoAlreadyClaimedError(fallback.githubRepoId);
    }
    throw new ProjectRepoNameTakenError(fallback.name, fallback.projectId);
  }
  throw err;
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
    const { repos, linksByRepo, projectIds } = await withWorkspaceContext(
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
        return { repos: found, linksByRepo: byRepo, projectIds: [...ids] };
      },
    );
    if (repos.length === 0) return [];

    // The PROJECT rows are read under the system arm `project_workspace_or_system_read`
    // already carries — the ids are resolved above and this only turns them into
    // names, which the access filter below then narrows. No new arm is owed, and
    // no arm is widened: this is the same read `codeGraphOffboardingService`
    // performs on the same table for the same reason.
    const projectsById = await withSystemContext(async (tx) => {
      const projects = await projectRepository.findManyByIds(projectIds, tx);
      return new Map(projects.map((p) => [p.id, p]));
    });

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
    for (const [workspaceId, projects] of byWorkspace) {
      const allowed = await projectAccessService.filterBrowsable(projects, {
        userId: ctx.userId,
        workspaceId,
      });
      for (const p of allowed) browsable.add(p.id);
    }

    return repos.map((repo) => ({
      githubRepoId: repo.id,
      repoRef: `${repo.owner}/${repo.name}`,
      projects: (linksByRepo.get(repo.id) ?? [])
        .filter((id) => browsable.has(id))
        .map((id) => projectsById.get(id))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map(toUsingProjectDto),
    }));
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

    return usage.flatMap((row) => {
      const repo = byId.get(row.githubRepoId);
      if (!repo) return [];
      const indexState: OrgRepoIndexStateDto = deriveCodeGraphIndexState({
        hasSucceededIndex: indexedRefs.has(row.repoRef),
        defaultBranchHeadSha: repo.defaultBranchHeadSha,
        indexedHeadSha: repo.indexedHeadSha,
        hasRunningIndex: repo.indexingRunId !== null && runningRunIds.has(repo.indexingRunId),
      });
      return [{ repo: toOrgRepoOptionDto(repo), projects: row.projects, indexState }];
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
      return orgRepos.filter((repo) => !taken.has(repo.id)).map(toOrgRepoOptionDto);
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
    return inProjectOrg(projectId, ctx, 'edit', async (tx, organizationId) => {
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
    });
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

    return inProjectOrg(projectId, ctx, 'edit', async (tx, organizationId) => {
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
    });
  },
};
