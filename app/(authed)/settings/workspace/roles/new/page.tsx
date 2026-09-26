import { notFound } from 'next/navigation';
import { RoleEditor } from '../_components/RoleEditor';
import { loadRolesPage } from '../_load';

// Create a workspace role (MOTIR-6466; design panel 2f): Start from Manager ·
// Member · Viewer seeds the grid. Manager-only; the API refuses independently.

export default async function NewWorkspaceRolePage() {
  const { workspace, catalog, canManage } = await loadRolesPage();
  if (!canManage) notFound();

  return (
    <div className="mx-auto max-w-[48rem]">
      <RoleEditor workspaceId={workspace.id} domains={catalog.domains} catalog={catalog} />
    </div>
  );
}
