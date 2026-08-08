import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { RoleList } from './_components/RoleList';

// Project settings → Access → Roles & permissions, screen 1 (Story MOTIR-2282 ·
// Subtask MOTIR-2263). A server component: it reads the active project's role
// catalog through `projectAccessService.getRoleCatalog` and renders it. There is
// no client state on this screen at all — it is a description of the model, and
// the only interaction is a link into a role.
//
// The area LAYOUT already owns the two guards every settings page shares — no
// active project, and no browse access (the shipped `NoAccessState`) — so this
// page does not re-derive them; the `getActiveProject` check below is the
// type-narrowing tail of the same thing.
//
// ⚠️ READ-ONLY, AND NOT BECAUSE THE ACTOR IS A MEMBER. The three built-in roles
// are immutable for everyone including a project admin: they exist to reproduce
// the shipped behaviour exactly. `Create role` and the editor arrive with custom
// roles (MOTIR-2257), which is why there is no capability check here to render.

export default async function ProjectRolesPage() {
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

  const catalog = await projectAccessService.getRoleCatalog(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-(--el-text) font-serif text-3xl font-semibold">
          {t('rolesPage.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t.rich('rolesPage.subtitle', {
            projectName: ctx.project.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <RoleList catalog={catalog} />
    </div>
  );
}
