import { notFound } from 'next/navigation';
import { RoleEditor } from '../../_components/RoleEditor';
import { loadRolesPage } from '../../_load';

// Edit a workspace custom role (MOTIR-6466; design panel 2g). Manager-only: a
// non-Manager, an unknown key and a built-in all find no editor here (the API
// refuses independently).

export default async function EditWorkspaceRolePage({
  params,
}: {
  params: Promise<{ roleKey: string }>;
}) {
  const { roleKey } = await params;
  const { workspace, catalog, canManage } = await loadRolesPage();
  const role = catalog.roles.find((candidate) => candidate.key === roleKey);
  if (!canManage || !role || role.builtIn || role.name === null) notFound();

  return (
    <div className="mx-auto max-w-[48rem]">
      <RoleEditor
        workspaceId={workspace.id}
        domains={catalog.domains}
        catalog={catalog}
        role={{ id: role.key, name: role.name, permissions: role.permissions }}
      />
    </div>
  );
}
