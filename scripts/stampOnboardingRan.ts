import type { Project } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import {
  withWorkspaceContext,
  withWorkspaceServiceContext,
  withBootstrapSlugContext,
} from '@/lib/workspaces/context';

// The core of `pnpm db:stamp:onboarding` (MOTIR-1799), split out from the CLI
// entry (`./stamp-onboarding-ran.ts`) so it is testable against a real Postgres
// without spawning a process — the same split `plan-seed/testProject.ts` uses.
//
// See the CLI entry's header for WHAT this is for and the two consequences its
// use accepts knowingly.

export interface StampOnboardingRanOptions {
  /** The project's workspace-unique key, e.g. `MOTIR`. Required — the whole
   *  point of this script is that it touches exactly ONE named project. */
  projectKey: string;
  /** Disambiguates when the key exists in more than one workspace. Optional:
   *  with a single match the script does not need it. */
  workspaceSlug?: string;
  /** Resolve and report, write NOTHING. */
  dryRun: boolean;
  /** The stamp instant (injectable so tests can assert the exact value). */
  now?: Date;
}

export type StampOnboardingRanOutcome =
  /** No project anywhere carries this key. */
  | { kind: 'project_not_found'; projectKey: string }
  /** `--workspace` named a workspace that does not exist. */
  | { kind: 'workspace_not_found'; workspaceSlug: string }
  /** The key exists in several workspaces and no `--workspace` picked one. */
  | {
      kind: 'ambiguous';
      projectKey: string;
      candidates: Array<{ projectId: string; workspaceId: string; workspaceSlug: string }>;
    }
  /** The workspace has no owner to bind a context as (an invariant violation). */
  | { kind: 'no_actor'; projectId: string; workspaceId: string }
  /** Already established — the null-guarded write is a no-op. The idempotent path. */
  | { kind: 'already_stamped'; project: Project; onboardingRanAt: Date }
  /** `--dry-run`: this is what a real run WOULD stamp. */
  | { kind: 'would_stamp'; project: Project }
  /** Written. */
  | { kind: 'stamped'; project: Project; at: Date };

/**
 * Refuse to run the CROSS-TENANT project-key search on a non-bypass connection.
 *
 * MOTIR-2813. `findAllByIdentifier` searches every workspace for a key, and no
 * policy arm exists for that (nor should one — a cross-tenant search is operator
 * behaviour by definition). Under `motir_app` it silently returns nothing, which
 * used to surface as `project_not_found` for a project that plainly exists and
 * sent the operator looking for the wrong thing.
 *
 * `rolbypassrls` is the exact attribute that decides it: `FORCE ROW LEVEL
 * SECURITY` makes even a table's owner obey policies, and the BYPASSRLS role
 * attribute overrides even that — so the ROLE is what to ask about, not the
 * table. One catalog read, no dependency on which role name a deployment uses.
 */
async function assertOperatorConnection(): Promise<void> {
  const [row] = await db.$queryRaw<Array<{ bypasses: boolean; role: string }>>`
    SELECT rolbypassrls AS "bypasses", rolname AS "role"
      FROM pg_roles WHERE rolname = current_user`;
  if (row?.bypasses) return;
  throw new Error(
    `stampOnboardingRan: the project-key search spans every workspace, which needs an ` +
      `OPERATOR connection. This one is "${row?.role ?? '(unknown)'}", which does not ` +
      `bypass row-level security, so the search would find nothing and report the project ` +
      `missing. Re-run with the owner DATABASE_URL, or pass --workspace <slug> (that arm binds ` +
      `app.bootstrap_slug and works under either role).`,
  );
}

/**
 * Stamp ONE project's `onboardingRanAt` marker, resolved by key.
 *
 * ⚠️ THE CONNECTION ROLE THIS SCRIPT REQUIRES — read before running it in
 * production (MOTIR-2813).
 *
 * The WRITE is safe under either role: `projectRepository.markOnboardingRan` runs
 * inside `withWorkspaceContext`, so the workspace GUC is bound and it passes under
 * the non-bypass `motir_app` role exactly as under the dev/CI BYPASSRLS one. This
 * header used to stop there, and that was a documentation defect on a script that
 * writes to production: it is NOT true of the RESOLVES above the write.
 *
 *   * `--workspace <slug>` IS safe under `motir_app`. The slug resolve binds
 *     `app.bootstrap_slug` (`withBootstrapSlugContext`), and
 *     `workspace_visible_bootstrap` admits exactly the one row carrying it —
 *     the same mechanism `workspacesService.createWorkspace` uses to read back a
 *     tenant root before any `app.workspace_id` exists. The PROJECT read that
 *     follows is a SECOND, separately bound transaction under
 *     `app.workspace_id`: the bootstrap GUC admits the workspace row and nothing
 *     below it, so folding the project read into that transaction would return
 *     null under `motir_app`.
 *
 *   * WITHOUT `--workspace`, the script REQUIRES AN OPERATOR (owner-role)
 *     CONNECTION, and it now says so out loud rather than failing confusingly.
 *     `projectRepository.findAllByIdentifier` searches for a project key ACROSS
 *     every workspace — that is the point, since the script refuses an ambiguous
 *     match rather than guessing — and there is no policy arm for a cross-tenant
 *     search, nor should there be. Under `motir_app` that read returns nothing,
 *     which used to surface as `project_not_found` for a project that plainly
 *     exists. `assertOperatorConnection` below now turns that into a LOUD,
 *     accurate error instead, because a silent wrong answer on a production-writing
 *     script is the whole defect this note exists to close.
 *
 * IDEMPOTENT: `markOnboardingRan` is a null-guarded `updateMany`, so it is
 * set-once. A second consecutive run reports `already_stamped` and writes
 * nothing — it never overwrites an existing timestamp.
 *
 * SCOPED: it resolves exactly one project and writes to that row's id. Any other
 * project — including a sibling in the same workspace — is untouched, and an
 * ambiguous key is REFUSED rather than guessed at.
 */
export async function stampOnboardingRan(
  options: StampOnboardingRanOptions,
): Promise<StampOnboardingRanOutcome> {
  const { projectKey, workspaceSlug, dryRun } = options;

  let project: Project | null | undefined;
  if (workspaceSlug) {
    // Bound (MOTIR-2813), in TWO steps, because the two reads are admitted by
    // two different GUCs. First the tenant root: `workspace_visible_bootstrap`
    // admits exactly the row whose slug is bound by `app.bootstrap_slug`.
    const workspace = await withBootstrapSlugContext(workspaceSlug, (tx) =>
      workspaceRepository.findBySlug(workspaceSlug, tx),
    );
    if (!workspace) return { kind: 'workspace_not_found', workspaceSlug };
    // ...then the project, under `app.workspace_id`. The bootstrap binding does
    // NOT carry it, and `project_workspace_member` keys on it — so reading the
    // project inside the bootstrap transaction returns nothing under `motir_app`
    // and reports `project_not_found` for a project that exists. Userless, so
    // the service (workspace-only) context, not the user one.
    project = await withWorkspaceServiceContext(workspace.id, (tx) =>
      projectRepository.findByIdentifier(workspace.id, projectKey, tx),
    );
  } else {
    // The cross-tenant search. There is no honest binding for it, so refuse the
    // wrong ROLE loudly instead of reporting the wrong ANSWER quietly.
    await assertOperatorConnection();
    // No workspace given: the key must resolve to exactly one project. Refusing
    // an ambiguous match is deliberate — this script writes to production, and
    // silently picking "the first one" is how the wrong tenant gets stamped.
    const matches = await projectRepository.findAllByIdentifier(projectKey);
    if (matches.length > 1) {
      const candidates = [];
      for (const match of matches) {
        const workspace = await workspaceRepository.findById(match.workspaceId);
        candidates.push({
          projectId: match.id,
          workspaceId: match.workspaceId,
          workspaceSlug: workspace?.slug ?? '(unknown)',
        });
      }
      return { kind: 'ambiguous', projectKey, candidates };
    }
    project = matches[0] ?? null;
  }

  if (!project) return { kind: 'project_not_found', projectKey };
  if (project.onboardingRanAt) {
    return { kind: 'already_stamped', project, onboardingRanAt: project.onboardingRanAt };
  }
  if (dryRun) return { kind: 'would_stamp', project };

  // Bind the context as the workspace OWNER (the creator tier — `roles.ts`),
  // mirroring `backfill-default-boards.ts`: `withWorkspaceContext` sets that
  // user's GUC so the write satisfies the project table's RLS policy under the
  // production non-bypass role.
  const owner = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
    workspaceMembershipRepository.findOwnerByWorkspace(project.workspaceId, tx),
  );
  if (!owner) {
    return { kind: 'no_actor', projectId: project.id, workspaceId: project.workspaceId };
  }

  const at = options.now ?? new Date();
  const written = await withWorkspaceContext(
    { userId: owner.userId, workspaceId: project.workspaceId, projectId: project.id },
    async (tx) => projectRepository.markOnboardingRan(project.id, at, tx),
  );

  // A concurrent stamp between the read above and this write loses the
  // null-guard race and returns 0 — report it as the no-op it is, not as a
  // write that happened.
  if (written === 0) {
    const fresh = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      projectRepository.findById(project.id, tx),
    );
    return {
      kind: 'already_stamped',
      project: fresh ?? project,
      onboardingRanAt: fresh?.onboardingRanAt ?? at,
    };
  }
  return { kind: 'stamped', project, at };
}
