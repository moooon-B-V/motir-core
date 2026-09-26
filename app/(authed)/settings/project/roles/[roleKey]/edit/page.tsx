import { permanentRedirect } from 'next/navigation';
import { workspaceRolePath } from '../../_redirect';

// RETIRED (MOTIR-6466): a role is edited on the workspace now.
export default async function EditProjectRoleRedirect({
  params,
}: {
  params: Promise<{ roleKey: string }>;
}): Promise<never> {
  const { roleKey } = await params;
  permanentRedirect(workspaceRolePath(roleKey, '/edit'));
}
