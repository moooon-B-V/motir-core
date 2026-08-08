import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { RoleDetail } from '../_components/RoleDetail';

// Project settings → Access → Roles & permissions → one ROLE, screen 2 of the
// drill-down (Story MOTIR-2282 · Subtask MOTIR-2263).
//
// ⚠️ THE ROLE IS RESOLVED OUT OF THE CATALOG THE READ RETURNS, never narrowed
// against a constant. An unknown `roleKey` is a 404, and the day MOTIR-2257 adds
// a project's own custom roles this page resolves them with no change: the URL
// segment is looked up in `catalog.roles`, which is already project-scoped.
//
// This route deliberately has NO rail entry of its own — it is reached by
// activating a row on the list, and `lib/settings/projectSettingsNav.ts` declares
// it as the `roles` entry's `nestedRoutes`, which is what keeps the route↔registry
// totality guard meaningful rather than relaxed.

export default async function ProjectRoleDetailPage({
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

  const { roleKey } = await params;
  const catalog = await projectAccessService.getRoleCatalog(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const role = catalog.roles.find((candidate) => candidate.role === roleKey);
  if (!role) notFound();

  return <RoleDetail role={role} catalog={catalog} projectName={ctx.project.name} />;
}
