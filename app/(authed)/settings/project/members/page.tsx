import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { EmptyState } from '@/components/ui/EmptyState';
import { ProjectMembersSettings } from './_components/ProjectMembersSettings';

// Project Members + Access settings — server component (Subtask 6.4.5). Reads
// the active project, the project's members + access level (through the 6.4.4
// service), and the workspace member list (for the add-member picker), then
// hands typed data to the client editor. Every WRITE is re-gated in the service
// (the project-admin check in projectMembersService); `canManage` here only
// governs whether the edit affordances render — a non-admin who reaches the
// page still sees it read-only and still can't mutate.
//
// `canManage` = a workspace owner/admin (the always-pass tier) OR a project
// admin. The per-access-level BROWSE gate (who can even open this) is Subtask
// 6.4.3 / 6.4.6 — not yet landed, so today any workspace member can view.

export default async function ProjectMembersPage() {
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

  const actor = { key: ctx.project.identifier, actorUserId: ctx.userId, ctx };

  const [members, access, workspaceMembers, workspace, wsRole] = await Promise.all([
    projectMembersService.listMembers(actor),
    projectMembersService.getAccess(actor),
    workspacesService.listMembers(ctx.workspaceId, ctx.userId),
    workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId),
    workspacesService.getMemberRole(ctx.userId, ctx.workspaceId),
  ]);

  const myMembership = members.find((m) => m.userId === ctx.userId);
  const canManage = isWorkspaceManager(wsRole) || myMembership?.role === 'admin';

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('access.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t.rich('access.subtitle', {
            projectName: ctx.project.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <ProjectMembersSettings
        projectKey={ctx.project.identifier}
        projectName={ctx.project.name}
        workspaceName={workspace?.name ?? ''}
        accessLevel={access.accessLevel}
        members={members}
        workspaceMembers={workspaceMembers}
        currentUserId={ctx.userId}
        canManage={canManage}
      />
    </div>
  );
}
