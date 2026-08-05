import {
  isImmediate,
  offboardDueAt,
  OFFBOARD_ALL_REPOS,
  type CodeGraphOffboardReason,
  type OffboardScope,
} from '@/lib/codeGraph/offboarding';
import { codeGraphOffboardingRepository } from '@/lib/repositories/codeGraphOffboardingRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE OFFBOARDING QUEUE'S BUSINESS LAYER (MOTIR-2166 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5).
//
// §14 commits the product to a stated retention window for a derived code graph.
// A window is DEFERRED work, so something has to survive the trigger long enough
// to do it — this service writes that something, and cancels it when the user
// undoes the trigger.
//
// **It enqueues and cancels. It does not SWEEP and it does not call motir-ai** —
// that is MOTIR-2168. A queue with no consumer is inert and safe, which is the
// intended merge order.
//
// ── Two contracts every caller depends on ────────────────────────────────────
//
// **1. POST-COMMIT AND QUIET.** Every trigger is a user action that has already
// succeeded — a disconnect, an archive, a workspace delete. Enqueueing is a side
// effect of that success, so it runs OUTSIDE the transaction and may never
// propagate an error into it (`notes.html` #39 — a post-commit side effect that
// throws turns a committed mutation into a 500; CLAUDE.md's side-effects-outside-tx
// rule). `enqueueQuietly` / `cancelQuietly` are the entry points the triggers use,
// and they swallow. §14.5 accepts the consequence explicitly: "some enqueues will
// be lost. That is what the reconciliation backstop (MOTIR-2169) is for."
//
// **2. SYSTEM CONTEXT.** The queue's RLS policy is `app.system_admin` and nothing
// else. That is not incidental: a `workspace_id` policy would make the row
// invisible the moment a workspace-delete removed the workspace — the one case
// the row exists for — and would let a tenant DELETE their own pending removal.
// So every write here opens its own `withSystemContext` transaction rather than
// joining the caller's workspace-scoped one, which it could not write through
// anyway.
//
// ── The one ordering trap, stated so it is not rediscovered ──────────────────
//
// **A workspace-delete arm must ENUMERATE its projects before the cascade removes
// them.** The other three triggers leave the project rows standing, so the scope
// is still readable afterwards; `deleteWorkspace` takes the projects with it. A
// caller that reads the project list after the delete has nothing to enumerate and
// the graphs become permanently unreachable orphans — the exact end state Decision
// 10 exists to prevent, produced by the code meant to prevent it. This service
// cannot enforce that from here (it only sees the scopes it is handed), so
// `workspacesService.deleteWorkspace` reads the projects FIRST and hands them in.

/** What one enqueue covers, before the per-repo fan-out. */
export interface EnqueueInput {
  coreWorkspaceId: string;
  /** The projects whose graphs are being offboarded. */
  coreProjectIds: string[];
  /**
   * The repos to remove per project — `owner/name` each. Omit for the WHOLE
   * project (archive / workspace delete), which enqueues one `OFFBOARD_ALL_REPOS`
   * row per project and which motir-ai serves by omitting `repoRef`.
   */
  repoRefs?: string[];
  reason: CodeGraphOffboardReason;
  /** Injectable clock, so a test can pin `dueAt` exactly rather than assert a window. */
  now?: Date;
}

export const codeGraphOffboardingService = {
  /**
   * Enqueue a pending removal for every (project × repo) the input names,
   * with the `dueAt` §14.3 fixes for that trigger.
   *
   * THROWS on failure — this is the form the sweep's own tests and any future
   * synchronous caller need. Triggers use {@link enqueueQuietly}.
   */
  async enqueue(input: EnqueueInput): Promise<number> {
    const scopes = expand(input);
    if (scopes.length === 0) return 0;

    const dueAt = offboardDueAt(input.reason, input.now ?? new Date());
    return withSystemContext(async (tx) => {
      for (const scope of scopes) {
        await codeGraphOffboardingRepository.upsert({ ...scope, dueAt, reason: input.reason }, tx);
      }
      return scopes.length;
    });
  },

  /**
   * {@link enqueue}, but it can never fail its caller.
   *
   * This is the form all four triggers use. The user's disconnect / archive /
   * delete has ALREADY COMMITTED by the time this runs; failing that request
   * because a queue write did not land would report a false failure for an action
   * the database kept (`notes.html` #39). The row being lost is a real cost, and
   * §14.5 names its mitigation — the reconciliation backstop — rather than paying
   * for it with a broken mutation.
   */
  async enqueueQuietly(input: EnqueueInput): Promise<number> {
    try {
      return await codeGraphOffboardingService.enqueue(input);
    } catch (err) {
      console.error('[code-graph-offboarding] enqueue failed', {
        coreWorkspaceId: input.coreWorkspaceId,
        coreProjectIds: input.coreProjectIds,
        repoRefs: input.repoRefs,
        reason: input.reason,
        error: err,
      });
      return 0;
    }
  },

  /**
   * Cancel the pending removals a re-onboard reverses (§14.3).
   *
   * This is what makes the window a GRACE PERIOD rather than a delay. Without it a
   * user who disconnects a repo by mistake and reconnects an hour later still loses
   * their index 30 days later, for no reason anyone could explain — and re-indexing
   * is a metered container per (repo × project), so they would be billed for their
   * own misclick.
   *
   * Cancels only the scopes named. A repo re-connected inside an ARCHIVED
   * project's window does not clear the project-wide row: re-connecting a repo is
   * not un-archiving the project.
   */
  async cancel(input: {
    coreWorkspaceId: string;
    coreProjectIds: string[];
    repoRefs?: string[];
  }): Promise<number> {
    const scopes = expand(input);
    if (scopes.length === 0) return 0;

    return withSystemContext(async (tx) => {
      let cancelled = 0;
      for (const scope of scopes) {
        cancelled += await codeGraphOffboardingRepository.deleteByScope(scope, tx);
      }
      return cancelled;
    });
  },

  /** {@link cancel}, quiet — the form the connect / index paths use, for the §39 reason above. */
  async cancelQuietly(input: {
    coreWorkspaceId: string;
    coreProjectIds: string[];
    repoRefs?: string[];
  }): Promise<number> {
    try {
      return await codeGraphOffboardingService.cancel(input);
    } catch (err) {
      console.error('[code-graph-offboarding] cancel failed', {
        coreWorkspaceId: input.coreWorkspaceId,
        coreProjectIds: input.coreProjectIds,
        repoRefs: input.repoRefs,
        error: err,
      });
      return 0;
    }
  },

  /**
   * The REPO-scoped triggers' entry point: enqueue `repoRefs` across every project
   * of the workspace, resolving the project set itself.
   *
   * ⚠️ **The fan-out over projects is not a convenience.** motir-ai keys a graph by
   * `(coreWorkspaceId, coreProjectId, repoRef)` and dispatches one index container
   * per (repo × project), so ONE disconnected repo leaves one graph PER PROJECT of
   * the workspace behind. A queue row naming only the workspace would name nothing
   * motir-ai can resolve, and the repo's graphs would survive the disconnect that
   * was supposed to remove them.
   *
   * Quiet end to end — including the project read, which sits OUTSIDE
   * {@link enqueueQuietly}'s own guard and would otherwise be an unprotected throw
   * on a path whose user action has already committed (`notes.html` #39).
   */
  async enqueueForRepos(
    coreWorkspaceId: string,
    repoRefs: string[],
    reason: CodeGraphOffboardReason,
  ): Promise<number> {
    if (repoRefs.length === 0) return 0;
    try {
      const coreProjectIds = await withSystemContext((tx) =>
        projectRepository.findAllIdsByWorkspace(coreWorkspaceId, tx),
      );
      if (coreProjectIds.length === 0) return 0;
      return await codeGraphOffboardingService.enqueueQuietly({
        coreWorkspaceId,
        coreProjectIds,
        repoRefs,
        reason,
      });
    } catch (err) {
      console.error('[code-graph-offboarding] repo enqueue failed', {
        coreWorkspaceId,
        repoRefs,
        reason,
        error: err,
      });
      return 0;
    }
  },

  /**
   * The RE-ONBOARD entry point: call off any pending removal for `repoRefs`
   * across the workspace's projects.
   *
   * This is what makes the window a GRACE PERIOD rather than a delay (§14.3).
   * Quiet end to end, for the same reason as {@link enqueueForRepos}.
   */
  async cancelForRepos(coreWorkspaceId: string, repoRefs: string[]): Promise<number> {
    if (repoRefs.length === 0) return 0;
    try {
      const coreProjectIds = await withSystemContext((tx) =>
        projectRepository.findAllIdsByWorkspace(coreWorkspaceId, tx),
      );
      if (coreProjectIds.length === 0) return 0;
      return await codeGraphOffboardingService.cancelQuietly({
        coreWorkspaceId,
        coreProjectIds,
        repoRefs,
      });
    } catch (err) {
      console.error('[code-graph-offboarding] repo cancel failed', {
        coreWorkspaceId,
        repoRefs,
        error: err,
      });
      return 0;
    }
  },

  /** Every pending row for a project — read-only, for the sweep's tests and ops. */
  async listPending(coreWorkspaceId: string, coreProjectId: string) {
    return withSystemContext((tx) =>
      codeGraphOffboardingRepository.findByProject(coreWorkspaceId, coreProjectId, tx),
    );
  },
};

/**
 * (projects × repos) → the scope rows, with the project-wide sentinel when no
 * repo is named.
 *
 * Deduped, because the callers legitimately produce repeats: a connection
 * disconnect enumerates every repo on the connection, and two connections in one
 * workspace can carry the same `owner/name`. The upsert would converge anyway;
 * deduping keeps the returned count honest about how many removals are pending.
 */
function expand(input: {
  coreWorkspaceId: string;
  coreProjectIds: string[];
  repoRefs?: string[];
}): OffboardScope[] {
  const refs = input.repoRefs === undefined ? [OFFBOARD_ALL_REPOS] : [...new Set(input.repoRefs)];
  const projects = [...new Set(input.coreProjectIds)];
  const scopes: OffboardScope[] = [];
  for (const coreProjectId of projects) {
    for (const repoRef of refs) {
      scopes.push({ coreWorkspaceId: input.coreWorkspaceId, coreProjectId, repoRef });
    }
  }
  return scopes;
}

export { isImmediate, OFFBOARD_ALL_REPOS };
