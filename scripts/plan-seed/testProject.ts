import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';

// The AI-generation TEST BED project (Subtask 7.4.10 · MOTIR-1426). A SECOND
// project under the existing `moooon` workspace whose tree is NOT seeded and whose
// first plan is never approved, so `Project.onboardingRanAt` stays NULL and
// `/onboarding` LOADS for it (the onboarding-ran gate redirects to `/roadmap` only
// AFTER a plan is approved — `plansService.approvePlan`). AI access is INHERITED
// from the `moooon` org's `isMeta` flag (the credit gate is waived), so nothing
// here touches billing.
//
// ⚠️ THE NULL MARKER HERE IS DELIBERATE, AND IS NOT AN INCONSISTENCY WITH THE
// SIBLING PROJECT (MOTIR-1799). As of MOTIR-1799 the seed STAMPS
// `onboardingRanAt` on the `motir` dogfood project (see `./dogfoodProject.ts`):
// the meta project is ESTABLISHED and reaches that state by stamping the marker,
// not by walking a wizard. This test bed is the deliberate counterpart — the one
// project that still lands in `/onboarding`, so the flow remains exercisable. The
// difference between the two is load-bearing: do NOT "fix" this project to match
// `motir`, and do not revert `motir`'s stamp to match this one.
//
// It is the test bed for the generation ENTRY (MOTIR-1396) — kept DISTINCT from
// the real `motir` plan project. Reaching the "Generate plan" entry then needs a
// `tiers_complete` pre-plan baseline, seeded separately in `motir-ai` (MOTIR-1430)
// — or produced by running discovery. This module is split out (mirroring the
// other plan-seed helpers — `mapItem` / `motirOverview` / `preserveStatus`) so it
// is unit-testable without running the whole self-invoking `seed.ts` script.

export const SEED_TEST_PROJECT_NAME = 'Generation test';
export const SEED_TEST_PROJECT_IDENTIFIER = 'GEN';

export interface SeedGenerationTestProjectInput {
  /** The `moooon` workspace the test project is created under. */
  workspaceId: string;
  /** The owner (project `admin`) — must be a member of the workspace. */
  ownerUserId: string;
  /** Everyone to enrol so the whole team can switch to it (the owner may be
   *  included or not — they are always enrolled as `admin`, the rest `member`). */
  memberUserIds: string[];
}

/**
 * Create the onboarding-ready generation test-bed project under the `moooon`
 * workspace and enrol the team. Leaves `onboardingRanAt` NULL **on purpose** (no
 * plan is approved) so this stays the project that lands in `/onboarding` — the
 * deliberate counterpart to the `motir` dogfood project, which the seed stamps as
 * established (MOTIR-1799, `./dogfoodProject.ts`). Does NOT change any
 * active-project pin — `motir` stays the default landing project; testers switch
 * to this one via the project switcher.
 * Returns the created project DTO (carries `id`, `identifier`, `onboardingRanAt`).
 */
export async function seedGenerationTestProject(
  input: SeedGenerationTestProjectInput,
): Promise<Awaited<ReturnType<typeof projectsService.createProject>>> {
  const project = await projectsService.createProject({
    name: SEED_TEST_PROJECT_NAME,
    identifier: SEED_TEST_PROJECT_IDENTIFIER,
    workspaceId: input.workspaceId,
    actorUserId: input.ownerUserId,
  });

  // Enrol the team (mirrors the `motir` project enrolment). `createProject` does
  // NOT create a ProjectMembership, so a plain create per user is correct and —
  // because the clear pass deletes the workspace (cascading its projects +
  // memberships) — idempotent across reseeds. Owner → `admin`, the rest → `member`.
  const memberIds = Array.from(new Set([input.ownerUserId, ...input.memberUserIds]));
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const userId of memberIds) {
      await projectMembershipRepository.create(
        {
          workspaceId: input.workspaceId,
          projectId: project.id,
          userId,
          role: userId === input.ownerUserId ? 'admin' : 'member',
        },
        tx,
      );
    }
  });

  return project;
}
