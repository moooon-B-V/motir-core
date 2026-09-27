import { adminDb } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// The tenant Story MOTIR-6169's browser walk runs against (Subtask MOTIR-6553):
// a workspace "Northwind" with three projects Open to the workspace — Atlas,
// Borealis, Cobalt — each with one work item, and the people the recipe needs:
//
//   Maya Manager    the workspace Manager, who invites and switches modes;
//   Fran Full       a Full member never added to Cobalt — who loses it;
//   Kai Kept        a Full member the Manager adds to Cobalt after the switch;
//   Nia Nobody      a Limited member added to nothing — the no-project shell;
//   Cy Contractor   an account that is NOT a member yet: the invite's target.
//
// A second workspace, "Sales", reveals the workspace tier so Workspace settings
// is its own page. Everything is written through the shipped services.

export const PA_PASSWORD = 'project-access-e2e-pass-123';

export interface ProjectAccessSeed {
  workspaceId: string;
  manager: { name: string; email: string };
  fran: { name: string; email: string };
  kai: { name: string; email: string };
  nia: { name: string; email: string };
  contractor: { id: string; name: string; email: string };
  atlas: { id: string; key: string; name: string; itemKey: string; itemTitle: string };
  borealis: { id: string; key: string; name: string; itemKey: string; itemTitle: string };
  cobalt: { id: string; key: string; name: string; itemKey: string; itemTitle: string };
}

export async function seedProjectAccess(slug: string): Promise<ProjectAccessSeed> {
  const email = (label: string) => `pa-${label}-${slug}@example.com`;
  const person = (label: string, name: string) =>
    usersService.createUser({ email: email(label), password: PA_PASSWORD, name });

  const maya = await person('manager', 'Maya Manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Northwind',
    ownerUserId: maya.id,
  });
  // A paid seat, so the cloud lane's plan admits the second workspace (as the
  // workspace-roles seed does).
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { aiIncludedSeat: true },
  });
  await workspacesService.createWorkspace({
    name: 'Sales',
    ownerUserId: maya.id,
    organizationId: workspace.organizationId,
  });
  const ctx = { userId: maya.id, workspaceId: workspace.id };

  const project = async (name: string, identifier: string, itemTitle: string) => {
    const p = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: maya.id,
      name,
      identifier,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: p.id, kind: 'task', title: itemTitle },
      ctx,
    );
    return { id: p.id, key: p.identifier, name, itemKey: item.identifier, itemTitle };
  };
  const atlas = await project('Atlas', 'ATL', 'Draft the atlas intro');
  const borealis = await project('Borealis', 'BOR', 'Borealis launch checklist');
  const cobalt = await project('Cobalt', 'COB', 'Cobalt pricing notes');

  const fran = await person('fran', 'Fran Full');
  const kai = await person('kai', 'Kai Kept');
  const nia = await person('nia', 'Nia Nobody');
  for (const u of [fran, kai, nia]) {
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
  }
  await workspacesService.setMemberAccessScope({
    actorUserId: maya.id,
    workspaceId: workspace.id,
    targetUserId: nia.id,
    scope: 'limited',
  });
  const contractor = await person('contractor', 'Cy Contractor');

  // Maya lands on Atlas; the walk switches her to Cobalt through the switcher.
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: maya.id, workspaceId: workspace.id } },
    data: { activeProjectId: atlas.id },
  });

  return {
    workspaceId: workspace.id,
    manager: { name: 'Maya Manager', email: email('manager') },
    fran: { name: 'Fran Full', email: email('fran') },
    kai: { name: 'Kai Kept', email: email('kai') },
    nia: { name: 'Nia Nobody', email: email('nia') },
    contractor: { id: contractor.id, name: 'Cy Contractor', email: email('contractor') },
    atlas,
    borealis,
    cobalt,
  };
}
