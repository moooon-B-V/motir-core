import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { RoleEditor } from '../_components/RoleEditor';

// Project settings → Access → Roles & permissions → CREATE (Story MOTIR-2257 ·
// Subtask MOTIR-2483), `design/projects/roles-permissions.mock.html` panel 3.
//
// ⚠️ The STATIC `new` segment resolves ahead of the sibling dynamic `[roleKey]`,
// so `/roles/new` reaches this page and never the detail screen — Next's own
// precedence, relied on rather than worked around with a reserved-word check.
//
// ⚠️ THE PAGE'S GATE IS PRESENTATION, NEVER PROTECTION. An actor without
// `project:manage_access` gets the no-access state here, and the API refuses the
// write independently (MOTIR-2474) — so removing this check would cost a nice
// error, not a security boundary.

export default async function NewProjectRolePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('project.empty.title')} description={t('project.empty.description')} />
      </div>
    );
  }

  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const held = await projectAccessService.getPermissions(ctx.projectId, actor);
  // A 404 rather than a 403: a settings surface an actor cannot use should look
  // missing, the same no-existence-leak posture the API takes.
  if (!held.has('project:manage_access')) notFound();

  const catalog = await projectAccessService.getRoleCatalog(ctx.projectId, actor);

  return (
    <RoleEditor projectKey={ctx.project.identifier} domains={catalog.domains} catalog={catalog} />
  );
}
