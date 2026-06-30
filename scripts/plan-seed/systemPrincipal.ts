import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { MOTIR_SYSTEM_USER_EMAIL, MOTIR_SYSTEM_USER_NAME } from '@/lib/ai/systemPrincipal';

// Provision the Motir SYSTEM PRINCIPAL (MOTIR-1451) — the service identity the
// AI self-learning loop writes AS when it files a `kind: bug` into the meta
// project (resolved at request time by `lib/ai/serviceAuth.ts`). A SECOND seed
// helper alongside `seedGenerationTestProject` (mirroring its shape), split out
// so it is unit-testable without running the whole self-invoking `seed.ts`.
//
// The principal must satisfy `workItemsService.createWorkItem`'s gates when it
// reports into the meta project, so it is enrolled at BOTH tiers:
//   * a WORKSPACE membership — so `assertReporterMember` passes (it checks the
//     workspace_membership row); and
//   * a PROJECT membership on the meta project — so the 6.4 `assertCanEdit`
//     gate passes regardless of the project's accessLevel.
// It is created with a workspace membership directly (NOT `workspacesService.
// addMember`) so it does NOT auto-join the ORG roster — the system principal is
// infrastructure, not a team member, and must stay out of member-management UIs
// and seat counts.
//
// Idempotent across reseeds: the user is a global row reused by email upsert;
// the memberships hang off the `moooon` workspace the clear pass deletes
// (cascading them), so a plain create re-provisions cleanly each run.

export interface SeedSystemPrincipalInput {
  /** The meta workspace (`moooon`) the principal becomes a member of. */
  workspaceId: string;
  /** The meta project (`motir`) the principal becomes a project member of. */
  projectId: string;
}

/**
 * Upsert the reserved, non-loginnable system `User` (no credential `Account`)
 * and enrol it in the meta workspace + project. Returns its user id.
 */
export async function seedSystemPrincipal(
  input: SeedSystemPrincipalInput,
): Promise<{ userId: string }> {
  const user = await db.user.upsert({
    where: { email: MOTIR_SYSTEM_USER_EMAIL },
    update: { name: MOTIR_SYSTEM_USER_NAME },
    create: { email: MOTIR_SYSTEM_USER_EMAIL, name: MOTIR_SYSTEM_USER_NAME, emailVerified: true },
  });

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await workspaceMembershipRepository.create(
      { userId: user.id, workspaceId: input.workspaceId, role: 'member' },
      tx,
    );
    await projectMembershipRepository.create(
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        userId: user.id,
        role: 'member',
      },
      tx,
    );
  });

  return { userId: user.id };
}
