import { permanentRedirect } from 'next/navigation';
import { WORKSPACE_ROLES_HOME } from '../_redirect';

// RETIRED (MOTIR-6466): roles are authored on the workspace now.
export default function NewProjectRoleRedirect(): never {
  permanentRedirect(`${WORKSPACE_ROLES_HOME}/new?from=project`);
}
