import { permanentRedirect } from 'next/navigation';
import { WORKSPACE_ROLES_HOME } from './_redirect';

// RETIRED (MOTIR-6466): the Roles room moved to workspace settings.
export default function ProjectRolesRedirect(): never {
  permanentRedirect(`${WORKSPACE_ROLES_HOME}?from=project`);
}
