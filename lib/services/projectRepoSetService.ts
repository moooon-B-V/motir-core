import { Prisma, type ProjectRepoRole, type ProjectRepoState } from '@prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { keyForAppend } from '@/lib/workItems/positioning';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoPinService } from '@/lib/services/projectRepoPinService';
import {
  toProjectRepoDto,
  toProjectRepoSetDto,
  type ProjectRepoWithRealized,
} from '@/lib/mappers/projectRepoMappers';
import type {
  AddProjectRepoInput,
  PatchProjectRepoInput,
  ProjectRepoDto,
  ProjectRepoProposalSignalDto,
  ProjectRepoSetDto,
  SetProjectRepoOwnershipInput,
} from '@/lib/dto/projectRepos';
import {
  toProjectRepoNames,
  toProjectRepoPinNames,
  type ProjectRepoName,
} from '@/lib/projectRepos/names';
import { allowedTransitions, canTransition } from '@/lib/projectRepos/transitions';
import {
  PROJECT_REPO_PROPOSAL_SIGNALS,
  defaultSeedSourceForRole,
  isProjectRepoProposalSignal,
} from '@/lib/projectRepos/vocabulary';
import {
  ProjectRepoInvalidFieldError,
  ProjectRepoNameTakenError,
  ProjectRepoNotFoundError,
  ProjectRepoStateTransitionError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';

// The project's REPOSITORY SET — reads and writes (Story MOTIR-1775 · MOTIR-1780),
// specified by `docs/decisions/project-repository-set.md`.
//
// SCOPE, deliberately narrow. This service owns the SET as data: propose rows,
// edit them, order them, move each through the ADR §4.1 establish machine, record
// which `GithubRepo` realizes each, and answer "which repo names may an item in
// this project be pinned to?". It does NOT:
//
//   * create anything on GitHub — that is the creation primitive (MOTIR-1781),
//     which calls `markCreating` → `attachRealizedRepo` / `markFailed` around its
//     own network work. Repo creation is a side effect OUTSIDE any transaction
//     (ADR §4.2 + the side-effects-outside-tx rule), which is exactly why the
//     state machine is exposed as separate short transactions rather than one
//     method that would have to hold a row locked across a GitHub round-trip;
//   * DERIVE the set's contents from a plan (which roles, which names) — that is
//     MOTIR-1881, which writes `proposed` rows THROUGH `addRow`;
//   * render anything — that is MOTIR-1782;
//   * re-point `resolveCodeContext` / `codeGraphIndexService` from workspace scope
//     to project scope. This card makes the association EXIST; adopting it is
//     MOTIR-1754's behaviour change. See the comments at both sites.
//
// TRANSACTIONS + RLS: every path opens `withWorkspaceContext`, which is what binds
// the `app.workspace_id` GUC the `project_repository` policy reads (and, for the
// joined realized repo, the `github_repo` policy). One service method = one
// transaction, and every validation read that GATES a write happens inside that
// same transaction (`db.$transaction` is what `withWorkspaceContext` opens), so a
// concurrent editor cannot slip between the guard and the write.
//
// ACCESS: reads are browse-gated, writes edit-gated, both through
// `projectAccessService` — the project's own access policy, no second rule here.

/** GitHub's own repo-name charset + length limit — the SHAPE a name must have to
 *  be creatable at all. Whether it is AVAILABLE is a host mechanic the creation
 *  primitive learns (MOTIR-1781; MOTIR-1777 (d) settles how), never asserted here. */
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const REPO_NAME_MAX = 100;
const LABEL_MAX = 80;
const SEED_SOURCE_MAX = 200;
const FAILURE_REASON_MAX = 2000;
const TARGET_ACCOUNT_MAX = 100;

/**
 * The states in which a row's PLAN fields (role / name / seed source) may still be
 * edited: `proposed` (nothing created yet — Principle #3, the plan is editable
 * before coding starts) and `failed` (ADR §1.5 pre-fills a de-collided name for
 * the user to accept or change, which is only possible if a failed row is
 * editable).
 *
 * NOT editable while `creating` (a creation is in flight under that exact name) and
 * not once SETTLED (`created` / `connected` — the repository exists, so renaming
 * the row would make the record disagree with reality; `skipped` — the row is
 * settled, and re-planning it is a remove-and-re-add). The free-form `label` is
 * editable in EVERY state: it is a human annotation that drives nothing.
 */
const PLAN_EDITABLE_STATES: readonly ProjectRepoState[] = ['proposed', 'failed'];

/** Trim + shape-validate an intended repo name. */
function validateName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new ProjectRepoInvalidFieldError('name', 'it must not be blank.');
  }
  if (name.length > REPO_NAME_MAX) {
    throw new ProjectRepoInvalidFieldError(
      'name',
      `it must be at most ${REPO_NAME_MAX} characters.`,
    );
  }
  if (!REPO_NAME_PATTERN.test(name)) {
    throw new ProjectRepoInvalidFieldError(
      'name',
      'it may contain only letters, digits, and the characters . _ -',
    );
  }
  if (name === '.' || name === '..') {
    throw new ProjectRepoInvalidFieldError('name', 'it must not be a path segment (. or ..).');
  }
  return name;
}

/** Trim a free-form label; a blank one normalizes to null (an explicit clear), so
 *  a caller never has to distinguish `''` from `null`. */
function validateLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const label = raw.trim();
  if (label.length === 0) return null;
  if (label.length > LABEL_MAX) {
    throw new ProjectRepoInvalidFieldError('label', `it must be at most ${LABEL_MAX} characters.`);
  }
  return label;
}

/** Trim + bound a seed source. An opaque string by design (ADR §2) — this
 *  validates SHAPE only, so MOTIR-709's registry keys need no change here. */
function validateSeedSource(raw: string): string {
  const seedSource = raw.trim();
  if (seedSource.length === 0) {
    throw new ProjectRepoInvalidFieldError('seedSource', 'it must not be blank.');
  }
  if (seedSource.length > SEED_SOURCE_MAX) {
    throw new ProjectRepoInvalidFieldError(
      'seedSource',
      `it must be at most ${SEED_SOURCE_MAX} characters.`,
    );
  }
  return seedSource;
}

/**
 * Validate a caller-supplied derivation signal (MOTIR-1892) against ADR §0.1's
 * ladder. An ABSENT signal is legal and means null — that is every hand-added
 * row, which has no Motir inference to record. A PRESENT one must name a rung the
 * ADR fixes: the column is what the establish step maps to copy, so a value it
 * cannot map is a bug to reject at the write, not one to discover at render.
 */
function validateProposalSignal(raw: unknown): ProjectRepoProposalSignalDto | null {
  if (raw === undefined || raw === null) return null;
  if (!isProjectRepoProposalSignal(raw)) {
    throw new ProjectRepoInvalidFieldError(
      'proposalSignal',
      `it must be one of ${PROJECT_REPO_PROPOSAL_SIGNALS.join(', ')}.`,
    );
  }
  return raw;
}

/**
 * Access-gate the project, then run `fn` inside ONE workspace-scoped transaction.
 *
 * The gate is the ONLY resolution needed: `projectAccessService` resolves the
 * project ITSELF and throws `ProjectNotFoundError` (→ 404) both when the id does
 * not exist AND when it belongs to another workspace — so the two are literally
 * indistinguishable to a caller (the no-existence-leak posture, asserted in the
 * service test). Deliberately NOT `projectsService.assertProjectInWorkspace`,
 * whose `ProjectWorkspaceMismatchError` would confirm a cross-tenant id is real.
 * A member who may browse but not edit is then rejected as `'edit'` (→ 403).
 */
async function inProject<T>(
  projectId: string,
  ctx: ServiceContext,
  mode: 'browse' | 'edit',
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (mode === 'edit') {
    await projectAccessService.assertCanEdit(projectId, ctx);
  } else {
    await projectAccessService.assertCanBrowse(projectId, ctx);
  }
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId }, fn);
}

/**
 * Resolve a set ROW to its project, edit-gate it, then run `fn` in ONE
 * workspace-scoped transaction which LOCKS the row and re-reads it. The lock +
 * re-read is the lost-update guard every state transition needs (the legality of a
 * hop is derived from the current state, so the state must not move between the
 * read and the write) and is also what makes a concurrent transition's loser
 * observe the already-moved state and fail with the typed illegal-transition
 * error rather than clobbering it.
 */
async function inLockedRow<T>(
  rowId: string,
  ctx: ServiceContext,
  fn: (row: ProjectRepoWithRealized, tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const existing = await projectRepoRepository.findById(rowId, ctx.workspaceId);
  if (!existing) throw new ProjectRepoNotFoundError(rowId);
  await projectAccessService.assertCanEdit(existing.projectId, ctx);
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: existing.projectId },
    async (tx) => {
      const locked = await projectRepoRepository.lockById(rowId, tx);
      if (!locked) throw new ProjectRepoNotFoundError(rowId);
      const fresh = await projectRepoRepository.findById(rowId, ctx.workspaceId, tx);
      if (!fresh) throw new ProjectRepoNotFoundError(rowId);
      return fn(fresh, tx);
    },
  );
}

/** Translate the two unique-index races into their typed domain errors, so a raw
 *  P2002 never escapes the service (the concurrency-to-typed-error rule). */
function translateUniqueViolation(
  err: unknown,
  fallback: { projectId: string; name?: string; githubRepoId?: string },
): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = err.meta?.['target'];
    const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    if (fields.some((f) => f.includes('github_repo_id')) && fallback.githubRepoId) {
      throw new RealizedRepoAlreadyClaimedError(fallback.githubRepoId);
    }
    if (fallback.name !== undefined) {
      throw new ProjectRepoNameTakenError(fallback.name, fallback.projectId);
    }
  }
  throw err;
}

export const projectRepoSetService = {
  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * A project's whole repository set — the ordered rows (primary first) PLUS the
   * SET-level ownership decision, in one read. The rows come back with their
   * realized repos joined in a single query.
   *
   * An empty `rows` list is the honest answer for a project that has not run the
   * establish step (every project that predates this table). It is NOT an error:
   * ADR consequence — `resolveDispatchTargetRepo`'s single-connected-repo fallback
   * is what answers for a project with no set.
   */
  async getSet(projectId: string, ctx: ServiceContext): Promise<ProjectRepoSetDto> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      const project = await projectRepository.findById(projectId, tx);
      // The access gate already proved it exists and is browsable; a null here
      // would mean it was deleted mid-transaction, so fall back to "no decision
      // recorded" rather than throwing on a read.
      return toProjectRepoSetDto(projectId, rows, {
        repoSetOwnership: project?.repoSetOwnership ?? null,
        repoSetTargetAccount: project?.repoSetTargetAccount ?? null,
      });
    });
  },

  /** Just the rows of a project's set, in order. `getSet` when the caller also
   *  needs the ownership decision. */
  async listByProject(projectId: string, ctx: ServiceContext): Promise<ProjectRepoDto[]> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      return rows.map(toProjectRepoDto);
    });
  },

  /**
   * The rows carrying a given ROLE, in set order — a LIST, because a role may
   * repeat (ADR §1.2). A caller resolving an item's repo pin by role must treat
   * `length !== 1` as unresolvable (§5.3: no match → null; more than one → null,
   * never an arbitrary pick).
   */
  async getByProjectAndRole(
    projectId: string,
    role: ProjectRepoRole,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto[]> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.findByProjectAndRole(
        projectId,
        role,
        ctx.workspaceId,
        tx,
      );
      return rows.map(toProjectRepoDto);
    });
  },

  /**
   * The repo NAMES an item in this project may be pinned to — the project-scoped
   * counterpart of `listConnectedRepoNames`, in the SAME normalized form, so a pin
   * validated against the project's set and one validated against the workspace's
   * connected set agree on spelling.
   *
   * ESTABLISHED rows only, realized-repo casing, de-duplicated — see
   * `lib/projectRepos/names.ts` for why each of those is load-bearing. The result
   * extends `ConnectedRepoName`, so it feeds `resolveDispatchTargetRepo` unchanged;
   * MOTIR-1783 / MOTIR-1784 / MOTIR-1884 consume this rather than re-implementing
   * the lookup.
   */
  async resolveProjectRepoNames(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<ProjectRepoName[]> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      return toProjectRepoNames(rows);
    });
  },

  /**
   * BOTH repo-name domains a `targetRepo` is resolved against (MOTIR-1783), plus
   * whether this project has a set at all — from ONE read of the set.
   *
   * Three answers rather than three calls, because the scope ladder in
   * `lib/workItems/dispatchRepo.ts` needs all three at once and they must describe
   * the SAME snapshot of the set: `hasSet` decides whether the project's set
   * answers at all or the workspace-connected compatibility path does, and mixing
   * that decision with a domain read from a later snapshot is how a project that
   * gained its first row mid-request would validate a pin against the workspace
   * and then dispatch against the project.
   *
   * `hasSet` is "the project has ROWS", not "the project has established rows": a
   * set whose repositories are all still proposed HAS been planned, and answering
   * it with the workspace's single connected repo would hand back a repository the
   * project deliberately did not choose.
   */
  async getRepoNameDomains(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<{ hasSet: boolean; dispatchable: ProjectRepoName[]; pinnable: ProjectRepoName[] }> {
    return inProject(projectId, ctx, 'browse', async (tx) => {
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      return {
        hasSet: rows.length > 0,
        dispatchable: toProjectRepoNames(rows),
        pinnable: toProjectRepoPinNames(rows),
      };
    });
  },

  // ── Editing the set (before it is executed) ───────────────────────────────

  /**
   * APPEND a `proposed` row to the project's set. Nothing is created on the host —
   * a row starts as a proposal, and the user's confirmation at the establish step
   * is what moves it (ADR §0.2).
   *
   * `seedSource` defaults from the role via ADR §2's table, so a caller that knows
   * only "this is the api repo" cannot accidentally seed it from the web starter.
   *
   * The name-collision guard runs INSIDE the transaction and is
   * case-insensitive — git-host repo names are, so `acme-web` and `Acme-Web` are
   * one repository, while the DB's `(project_id, name)` unique index only catches
   * the exact duplicate. That index is still the arbiter of a lost race, and its
   * P2002 is translated to the same typed error.
   *
   * `proposalSignal` records WHY Motir proposed the row (ADR §0.1) and is
   * supplied only by the derivation (MOTIR-1881 through MOTIR-1892). A caller
   * that omits it — every hand-added row — persists NULL, which is what makes the
   * column distinguish "Motir inferred this" from "the user asked for this"
   * rather than attributing an inference to nobody.
   */
  async addRow(
    projectId: string,
    input: AddProjectRepoInput,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    const name = validateName(input.name);
    const label = validateLabel(input.label);
    const seedSource = validateSeedSource(
      input.seedSource ?? defaultSeedSourceForRole(input.role as ProjectRepoRole),
    );
    const proposalSignal = validateProposalSignal(input.proposalSignal);

    const row = await inProject(projectId, ctx, 'edit', async (tx) => {
      const clash = await projectRepoRepository.findByProjectAndNameInsensitive(
        projectId,
        name,
        ctx.workspaceId,
        tx,
      );
      if (clash) throw new ProjectRepoNameTakenError(name, projectId);
      const last = await projectRepoRepository.findLastPosition(projectId, ctx.workspaceId, tx);
      try {
        return await projectRepoRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId,
            role: input.role as ProjectRepoRole,
            label,
            name,
            seedSource,
            proposalSignal,
            state: 'proposed',
            position: keyForAppend(last),
          },
          tx,
        );
      } catch (err) {
        translateUniqueViolation(err, { projectId, name });
      }
    });
    // A freshly-created row is `proposed`, so it is unrealized by construction.
    return toProjectRepoDto({ ...row, githubRepo: null });
  },

  /**
   * PARTIALLY edit a row — the establish step lets the user rename a row, change
   * its role, or switch what it seeds from before anything is created.
   *
   * `role` / `name` / `seedSource` are editable only while the row's plan is still
   * open ({@link PLAN_EDITABLE_STATES}): a `creating` row has a creation in flight
   * under that exact name, and a settled row's repository already exists, so
   * editing either would make the record disagree with reality. `label` is
   * editable in every state — it is a human annotation that drives nothing.
   *
   * Changing the `role` deliberately does NOT re-derive `seedSource`: an edited
   * value is a decision, and silently rewriting it would be the freeze-a-guess
   * defect `docs/decisions/target-repo-attribution.md` §3 warns about. A caller
   * that wants the new role's default passes `seedSource` explicitly.
   */
  async patchRow(
    rowId: string,
    input: PatchProjectRepoInput,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    const wantsPlanEdit =
      input.role !== undefined || input.name !== undefined || input.seedSource !== undefined;
    const name = input.name !== undefined ? validateName(input.name) : undefined;
    const seedSource =
      input.seedSource !== undefined ? validateSeedSource(input.seedSource) : undefined;
    // `label` is only in the patch when the key is PRESENT; `label: null` clears it.
    const label = 'label' in input ? validateLabel(input.label) : undefined;

    return inLockedRow(rowId, ctx, async (row, tx) => {
      if (wantsPlanEdit && !PLAN_EDITABLE_STATES.includes(row.state)) {
        throw new ProjectRepoInvalidFieldError(
          'state',
          `a ${row.state} row's role / name / seed source can no longer be edited (only ${PLAN_EDITABLE_STATES.join(' or ')} rows can); its label still can.`,
        );
      }
      if (name !== undefined) {
        const clash = await projectRepoRepository.findByProjectAndNameInsensitive(
          row.projectId,
          name,
          ctx.workspaceId,
          tx,
          rowId,
        );
        if (clash) throw new ProjectRepoNameTakenError(name, row.projectId);
      }
      try {
        const updated = await projectRepoRepository.update(
          rowId,
          {
            ...(input.role !== undefined ? { role: input.role as ProjectRepoRole } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(label !== undefined ? { label } : {}),
            ...(seedSource !== undefined ? { seedSource } : {}),
          },
          tx,
        );
        return toProjectRepoDto({ ...updated, githubRepo: row.githubRepo });
      } catch (err) {
        translateUniqueViolation(err, { projectId: row.projectId, name: name ?? row.name });
      }
    });
  },

  /**
   * REMOVE a row from the set — how a user drops a repository they do not want,
   * and (per the transitions module) how a settled row is re-planned.
   *
   * Removing a row NEVER touches the repository itself: a created repo is a real
   * artifact in the user's own account, and deleting it to tidy a record would be
   * strictly worse than reporting the truth (ADR §4.2). Removing an established
   * row therefore un-claims its `GithubRepo`, which stays connected to the
   * workspace and can be attached to another row later. Idempotent: removing an
   * already-gone row is a no-op, not a 404, so a double-submit is harmless.
   */
  async removeRow(rowId: string, ctx: ServiceContext): Promise<void> {
    const existing = await projectRepoRepository.findById(rowId, ctx.workspaceId);
    if (!existing) return;
    await projectAccessService.assertCanEdit(existing.projectId, ctx);
    await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: existing.projectId },
      (tx) => projectRepoRepository.deleteById(rowId, tx),
    );
  },

  /**
   * Record WHO owns the set and WHICH account it lands in (ADR §3.2 / §3.4) — one
   * choice for the whole SET, stored on the project, never per row. §3.5 is what
   * makes that the right shape: a set is never half in the user's account and half
   * in Motir's, so a row that cannot be created in the chosen target fails as a row
   * rather than silently retargeting.
   */
  async setOwnership(
    projectId: string,
    input: SetProjectRepoOwnershipInput,
    ctx: ServiceContext,
  ): Promise<ProjectRepoSetDto> {
    const targetAccount = input.targetAccount.trim();
    if (targetAccount.length === 0) {
      throw new ProjectRepoInvalidFieldError('targetAccount', 'it must not be blank.');
    }
    if (targetAccount.length > TARGET_ACCOUNT_MAX) {
      throw new ProjectRepoInvalidFieldError(
        'targetAccount',
        `it must be at most ${TARGET_ACCOUNT_MAX} characters.`,
      );
    }
    return inProject(projectId, ctx, 'edit', async (tx) => {
      await projectRepository.setRepoSetOwnership(
        projectId,
        { ownership: input.ownership, targetAccount },
        tx,
      );
      const rows = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
      return toProjectRepoSetDto(projectId, rows, {
        repoSetOwnership: input.ownership,
        repoSetTargetAccount: targetAccount,
      });
    });
  },

  // ── The establish machine (ADR §4.1) ─────────────────────────────────────
  //
  // Exposed as SEPARATE short transactions rather than one "create the repo"
  // method, because repo creation is a network side effect that must happen
  // OUTSIDE any transaction: the creation primitive (MOTIR-1781) calls
  // `markCreating`, does its GitHub work with no row locked, then calls
  // `attachRealizedRepo` or `markFailed`. Every hop is legality-checked against
  // `lib/projectRepos/transitions.ts` under the row lock.

  /**
   * Move a row to `state`, if that hop is legal from where it currently sits.
   * Rejects with {@link ProjectRepoStateTransitionError} otherwise — naming the
   * legal targets so a caller self-corrects, the same self-correcting shape
   * `transition_status` uses for a work item.
   *
   * `failureReason` is REQUIRED for a hop to `failed` (a failed row that cannot say
   * why is exactly the "partial establishment inferred rather than recorded" the
   * table exists to prevent) and is CLEARED on every other hop, so a retried row
   * does not carry the stale reason for a failure it recovered from.
   */
  async transitionRow(
    rowId: string,
    state: ProjectRepoState,
    ctx: ServiceContext,
    options: { failureReason?: string } = {},
  ): Promise<ProjectRepoDto> {
    let failureReason: string | null = null;
    if (state === 'failed') {
      const reason = (options.failureReason ?? '').trim();
      if (reason.length === 0) {
        throw new ProjectRepoInvalidFieldError(
          'failureReason',
          'a row moving to failed must record why.',
        );
      }
      failureReason = reason.slice(0, FAILURE_REASON_MAX);
    }

    return inLockedRow(rowId, ctx, async (row, tx) => {
      if (!canTransition(row.state, state)) {
        throw new ProjectRepoStateTransitionError(
          rowId,
          row.state,
          state,
          allowedTransitions(row.state),
        );
      }
      const updated = await projectRepoRepository.update(rowId, { state, failureReason }, tx);
      return toProjectRepoDto({ ...updated, githubRepo: row.githubRepo });
    });
  },

  /** `proposed | failed → creating` — the creation primitive claims the row before
   *  it touches GitHub, so a concurrent run observes `creating` and backs off. */
  markCreating(rowId: string, ctx: ServiceContext): Promise<ProjectRepoDto> {
    return this.transitionRow(rowId, 'creating', ctx);
  },

  /** `creating → failed`, recording WHY (ADR §4.1) — resumable, not terminal: the
   *  row can then be retried, connected to an existing repo, or skipped. */
  markFailed(rowId: string, reason: string, ctx: ServiceContext): Promise<ProjectRepoDto> {
    return this.transitionRow(rowId, 'failed', ctx, { failureReason: reason });
  },

  /** `proposed | failed → skipped` — deliberately without a repository, which is
   *  NOT an error (ADR §4.3): approval may complete with a row unresolved, leaving
   *  the project explicitly code-less for that role. */
  skipRow(rowId: string, ctx: ServiceContext): Promise<ProjectRepoDto> {
    return this.transitionRow(rowId, 'skipped', ctx);
  },

  /**
   * REALIZE a row: attach the `GithubRepo` mirror row that now backs it, and settle
   * its state in the SAME locked transaction — this is the seam that makes one
   * table serve as both the plan and the record, so the two can never disagree.
   *
   * The target state is DERIVED from where the row sits, because ADR §4.1 leaves no
   * ambiguity: a row Motir was creating becomes `created`; a `proposed` or `failed`
   * row being pointed at a repository that already exists becomes `connected`
   * (which is also how a monorepo collapses the set to one row). A settled row has
   * no legal hop, so re-attaching to one is the typed illegal-transition error, not
   * a silent overwrite of which repo a project's code lives in.
   *
   * Called by the creation primitive (MOTIR-1781) AFTER its GitHub work completes —
   * never with a transaction held open across that round-trip.
   *
   * POST-COMMIT, this fires the role → repo-name RESOLUTION (MOTIR-1913): a row
   * reaching an established state is exactly the moment items pinned to its role
   * can finally be told which repository they ship in. It is wired HERE rather than
   * in each caller because this method is the ONE seam every establish path goes
   * through — the creation primitive's `created` hop and the establish UI's
   * connect-existing `connected` hop alike — so neither has to remember it and
   * neither can drift. Best-effort by design: the repository EXISTS and the row IS
   * established by the time this runs, and failing the attach over a derived pin
   * would report a settled row as failed. The pass is idempotent, so the next
   * establish (or an explicit re-run) completes what a dropped one missed.
   */
  async attachRealizedRepo(
    rowId: string,
    githubRepoId: string,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    const attached = await this.attachRealizedRepoRow(rowId, githubRepoId, ctx);
    try {
      // A SEPARATE transaction, deliberately: the pass locks the project's WHOLE
      // set, and taking that lock while `inLockedRow` still held one row of it
      // would let two concurrent attaches on different rows acquire the set in
      // different orders — a deadlock. Sequencing them is what keeps one lock
      // order (set, then work items) for every writer.
      await projectRepoPinService.resolvePins(attached.projectId, ctx);
    } catch (err) {
      console.error(
        `[projectRepoSetService] could not resolve repo pins for project ${attached.projectId} ` +
          `after establishing row ${rowId}:`,
        err,
      );
    }
    return attached;
  },

  /** {@link attachRealizedRepo} WITHOUT the post-commit pin resolution — the row
   *  write on its own, in its one locked transaction. Split out so the resolution
   *  reads a COMMITTED set rather than joining the lock that produced it. */
  async attachRealizedRepoRow(
    rowId: string,
    githubRepoId: string,
    ctx: ServiceContext,
  ): Promise<ProjectRepoDto> {
    return inLockedRow(rowId, ctx, async (row, tx) => {
      const target: ProjectRepoState = row.state === 'creating' ? 'created' : 'connected';
      if (!canTransition(row.state, target)) {
        throw new ProjectRepoStateTransitionError(
          rowId,
          row.state,
          target,
          allowedTransitions(row.state),
        );
      }
      // The pre-check turns the common same-tenant case into a clean 409; the
      // `github_repo_id` unique index is the real, tenant-blind guarantee and its
      // P2002 is translated below.
      const claimant = await projectRepoRepository.findByGithubRepoId(githubRepoId, tx);
      if (claimant && claimant.id !== rowId) {
        throw new RealizedRepoAlreadyClaimedError(githubRepoId);
      }
      try {
        const updated = await projectRepoRepository.update(
          rowId,
          { githubRepoId, state: target, failureReason: null },
          tx,
        );
        const realized = await projectRepoRepository.findById(rowId, ctx.workspaceId, tx);
        return toProjectRepoDto(realized ?? { ...updated, githubRepo: null });
      } catch (err) {
        translateUniqueViolation(err, { projectId: row.projectId, githubRepoId });
      }
    });
  },
};
