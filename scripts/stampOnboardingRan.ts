import type { Project } from '@/lib/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

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
 * Stamp ONE project's `onboardingRanAt` marker, resolved by key.
 *
 * Every write goes through `projectRepository.markOnboardingRan` inside
 * `withWorkspaceContext` — no raw Prisma write, no raw SQL, and the workspace
 * GUC is bound so the write passes under the non-bypass `prodect_app` role in
 * production exactly as it does under the dev/CI BYPASSRLS role.
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

  let project: Project | null;
  if (workspaceSlug) {
    const workspace = await workspaceRepository.findBySlug(workspaceSlug);
    if (!workspace) return { kind: 'workspace_not_found', workspaceSlug };
    project = await projectRepository.findByIdentifier(workspace.id, projectKey);
  } else {
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
  const owner = await workspaceMembershipRepository.findOwnerByWorkspace(project.workspaceId);
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
    const fresh = await projectRepository.findById(project.id);
    return {
      kind: 'already_stamped',
      project: fresh ?? project,
      onboardingRanAt: fresh?.onboardingRanAt ?? at,
    };
  }
  return { kind: 'stamped', project, at };
}
