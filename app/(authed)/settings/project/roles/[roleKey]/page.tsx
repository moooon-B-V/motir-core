import { permanentRedirect } from 'next/navigation';
import { workspaceRolePath } from '../_redirect';

// RETIRED (MOTIR-6466): a role's detail lives on the workspace now.
export default async function ProjectRoleDetailRedirect({
  params,
}: {
  params: Promise<{ roleKey: string }>;
}): Promise<never> {
  const { roleKey } = await params;
  permanentRedirect(workspaceRolePath(roleKey));
}
