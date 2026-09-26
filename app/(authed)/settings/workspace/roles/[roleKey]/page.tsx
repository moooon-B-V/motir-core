import { notFound } from 'next/navigation';
import { RoleDetail } from '../_components/RoleDetail';
import { loadRolesPage } from '../_load';

// One workspace role's detail (MOTIR-6466; design panel 2): its keys by domain,
// the Rooms row, and — for a Manager, on a custom role — Edit and Delete.

export default async function WorkspaceRoleDetailPage({
  params,
}: {
  params: Promise<{ roleKey: string }>;
}) {
  const { roleKey } = await params;
  const { workspace, catalog, canManage } = await loadRolesPage();
  const role = catalog.roles.find((candidate) => candidate.key === roleKey);
  if (!role) notFound();

  return (
    <div className="mx-auto max-w-[48rem]">
      <RoleDetail
        role={role}
        catalog={catalog}
        workspaceName={workspace.name}
        canManage={canManage}
        workspaceId={workspace.id}
      />
    </div>
  );
}
