import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
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

  // Bound (MOTIR-2868) on the workspace the principal is being enrolled INTO.
  // This is a seed helper, but it is not a bootstrap: the meta workspace and
  // project already exist and their ids are the function's own inputs, so the
  // tenant is known and the narrow context is available. Both writes are gated
  // on it — `membership_insert_active_or_bootstrap`'s first arm (`"workspaceId"
  // = app.workspace_id`) and `project_membership_active_workspace` — and the
  // RETURNING each `create` performs re-reads through the matching SELECT arm.
  //
  // ⚠️ NOT `withSystemContext`. Neither tenant-root membership policy has a
  // `system_admin` arm at all, so it would not even work here (see
  // `tests/github/githubWebhookService.test.ts`, which tried exactly that and
  // was refused); and where it does work it hands a seed script a tenant-blind
  // connection, which is the exemption this whole effort is closing. A seed
  // script that runs BEFORE any tenant exists is the legitimate system-context
  // case; this one runs after.
  await withWorkspaceServiceContext(input.workspaceId, async (tx: Prisma.TransactionClient) => {
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
