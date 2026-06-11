import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { componentsService } from '@/lib/services/componentsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { EmptyState } from '@/components/ui/EmptyState';
import { ComponentsSettingsEditor } from './_components/ComponentsSettingsEditor';

// Project Components settings — server component (Subtask 5.4.10). Reads the
// active project and its component taxonomy (through the 5.4.3 service: name
// order, resolved default assignees, in-use counts — the bounded admin read),
// plus the project's ASSIGNABLE member set (the 6.4.6 scoping) for the
// default-assignee picker, then hands typed data to the client editor. The
// 6.4 members page / 5.3.6 fields page are the structural template: every
// WRITE is re-gated in the service (the project-admin check in
// componentsService); `canManage` here only governs whether the mutation
// affordances render — a non-admin who reaches the page sees it read-only
// (the 5.4.7 degradation) and still can't mutate.
//
// `canManage` = a workspace owner/admin (the always-pass tier) OR a project
// admin — the 6.4 two-tier check. Reads stay open to members/viewers (the
// browse gate inside listComponents); the issue-view rail picker needs the
// component list.

export default async function ProjectComponentsPage() {
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

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const actor = { key: ctx.project.identifier, actorUserId: ctx.userId, ctx };

  const [components, members, assignableMembers, wsRole] = await Promise.all([
    componentsService.listComponents(ctx.project.identifier, wsCtx),
    projectMembersService.listMembers(actor),
    assignableMembersService.list({
      projectId: ctx.projectId,
      accessLevel: ctx.project.accessLevel,
      ctx: wsCtx,
    }),
    workspacesService.getMemberRole(ctx.userId, ctx.workspaceId),
  ]);

  const myMembership = members.find((m) => m.userId === ctx.userId);
  const canManage = isWorkspaceManager(wsRole) || myMembership?.role === 'admin';

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('components.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t.rich('components.subtitle', {
            projectName: ctx.project.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <ComponentsSettingsEditor
        projectKey={ctx.project.identifier}
        components={components}
        assignableMembers={assignableMembers}
        canManage={canManage}
      />
    </div>
  );
}
