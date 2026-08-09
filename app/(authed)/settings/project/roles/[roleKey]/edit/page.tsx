import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { RoleEditor } from '../../_components/RoleEditor';

// Project settings → Access → Roles & permissions → EDIT (Story MOTIR-2257 ·
// Subtask MOTIR-2483). *"Editing a custom role is this same page with the values
// filled in"* — one authoring surface, built once.
//
// ⚠️ A BUILT-IN 404s HERE. `admin` / `member` / `viewer` are code, not rows, and
// editing one is not a thing that exists — so the editor is not offered for them
// at all, rather than offered and refused. The service refuses it independently
// (`BuiltInRoleImmutableError`), so this is the nice half of the same answer.
//
// ⚠️ NO `Start from` ON THIS ROUTE. Nothing records which built-in seeded a role
// (Yue, 2026-08-09), so there is no base to show and nothing that could be
// changed — the editor omits the field rather than showing a disabled one, which
// would imply a value exists.

export default async function EditProjectRolePage({
  params,
}: {
  params: Promise<{ roleKey: string }>;
}) {
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
  if (!held.has('project:manage_access')) notFound();

  const { roleKey } = await params;
  const catalog = await projectAccessService.getRoleCatalog(ctx.projectId, actor);
  const role = catalog.roles.find((candidate) => candidate.key === roleKey);
  // Unknown segment, or a BUILT-IN: neither has an editor.
  if (!role || role.builtIn || role.name === null) notFound();

  return (
    <RoleEditor
      projectKey={ctx.project.identifier}
      domains={catalog.domains}
      catalog={catalog}
      role={{ id: role.key, name: role.name, permissions: role.permissions }}
    />
  );
}
