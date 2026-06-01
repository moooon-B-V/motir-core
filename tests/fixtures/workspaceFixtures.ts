import type { User, Workspace } from '@prisma/client';
import { workspacesService } from '@/lib/services/workspacesService';
import { userRepository } from '@/lib/repositories/userRepository';
import { createTestUser } from './userFixtures';

// Shared test fixtures — workspace rows (Subtask 1.4.7).
//
// Extracted from the inlined `makeFixture` helpers. `createTestWorkspace`
// builds a real workspace via the service (so the owner's membership row is
// created exactly as production wires it). `workspacesService.createWorkspace`
// slugifies the name and retries with a random suffix on a slug collision, so
// re-using the default name 'Acme' across tests is safe — each call mints a
// unique slug. When no owner is supplied a fresh one is minted, so a caller
// that only needs "a workspace" gets the user for free.
//
// (Tests/fixtures may import repositories directly — CLAUDE.md's one
// sanctioned cross-layer reach — which is why `userRepository.findById` is
// used here to resolve a supplied owner back into a User row.)

export interface CreateTestWorkspaceOptions {
  /** Use this existing user as the owner; otherwise a fresh one is minted. */
  ownerUserId?: string;
  /** Override the workspace name (default 'Acme'). */
  name?: string;
}

export interface CreateTestWorkspaceResult {
  workspace: Workspace;
  owner: User;
}

/**
 * Create a real workspace owned by `ownerUserId` (or by a freshly-minted
 * user when none is given). Returns BOTH the workspace and its owner so the
 * caller can thread the owner id into downstream fixtures (projects, work
 * items) without a second lookup.
 */
export async function createTestWorkspace(
  opts: CreateTestWorkspaceOptions = {},
): Promise<CreateTestWorkspaceResult> {
  const owner = opts.ownerUserId
    ? ((await userRepository.findById(opts.ownerUserId)) as User)
    : await createTestUser();

  const { workspace } = await workspacesService.createWorkspace({
    name: opts.name ?? 'Acme',
    ownerUserId: owner.id,
  });

  return { workspace, owner };
}
