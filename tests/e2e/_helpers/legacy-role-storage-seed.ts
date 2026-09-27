import { adminDb } from './db-reset';
import { organizationsService } from '@/lib/services/organizationsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';

// The fixture of the legacy-role-storage E2E (Story MOTIR-6469 · MOTIR-6564).
//
// ONE organization, Northwind Co, owned by Olga, with Maya as an org ADMIN — the
// person the walk drives. Maya creates the walk's workspace (Harbor) through the
// product's own "New workspace" control, so the org then holds two workspaces
// and `/settings/workspace` is revealed (`organization-tier.md` §6d).
//
// Three more people, each with a workspace of their own (what signing up gives
// a real person, and what lets them sign in to a settled workbench):
//   * Iris — invited from the Members page; accepts the token THIS build mints.
//   * Pip  — holds a token in the PRE-RELEASE shape (legacy `role` only); the
//            spec seeds it, because nothing in this build can mint one.
//   * Oscar — never joins Harbor: the outsider for the no-access state.

export const LRS_PASSWORD = 'legacy-role-storage-e2e-pass-123';
export const HARBOR = 'Harbor';

export interface LegacyRoleStorageSeed {
  organizationId: string;
  maya: { id: string; email: string; name: string };
  iris: { id: string; email: string; name: string };
  pip: { id: string; email: string; name: string };
  oscar: { id: string; email: string; name: string };
}

export async function seedLegacyRoleStorage(slug: string): Promise<LegacyRoleStorageSeed> {
  const email = (label: string) => `lrs-${label}-${slug}@example.com`;
  const person = async (label: string, name: string) => {
    const u = await usersService.createUser({ email: email(label), password: LRS_PASSWORD, name });
    return { id: u.id, email: u.email, name };
  };

  const olga = await person('owner', 'Olga Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Northwind',
    ownerUserId: olga.id,
  });
  const organizationId = workspace.organizationId!;
  // ⚠️ THE FREE PLAN CAPS AN ORGANIZATION AT ONE WORKSPACE; a paid AI plan bundles
  // a seat, which lifts the cap — the same one-field remedy
  // `workspace-roles-seed.ts` uses — so Maya's "New workspace" can succeed.
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { aiIncludedSeat: true },
  });

  // Maya is an org Admin; the org's sole workspace takes her in as a Member.
  const maya = await person('admin', 'Maya Admin');
  await organizationsService.addMember({
    organizationId,
    userId: maya.id,
    role: 'admin',
    actorUserId: olga.id,
  });

  const iris = await person('iris', 'Iris Invitee');
  const pip = await person('pip', 'Pip Prerelease');
  const oscar = await person('oscar', 'Oscar Outsider');
  for (const u of [iris, pip, oscar]) {
    await workspacesService.createWorkspace({ name: `${u.name}'s Workspace`, ownerUserId: u.id });
  }

  return { organizationId, maya, iris, pip, oscar };
}
