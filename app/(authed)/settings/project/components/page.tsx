import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { componentsService } from '@/lib/services/componentsService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { ComponentsSettingsEditor } from './_components/ComponentsSettingsEditor';
import { guardSettingsPage } from '../_guard';

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

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `components`, never re-declared here.
  const refused = await guardSettingsPage('components', ctx);
  if (refused) return refused;

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  // MOTIR-3558 — the gate is DONE at this line. Everything above decides who may
  // see this page and whether it exists; nothing below can change the status, so
  // the boundary is safe here and would not have been one line earlier.
  // `app/(authed)/settings/project/components/loading.tsx` used to draw this wait
  // from a route file; it is deleted, because a route-level fallback plus an
  // in-page one shows the same pending state twice for one navigation.
  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      {/* REAL, and painted from the gate — see the sibling Fields page's note.
          This is why `SettingsPaneFrame` draws no header. */}
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

      <Suspense fallback={<SettingsPaneFrame />}>
        <ComponentsPaneBody
          projectKey={ctx.project.identifier}
          projectId={ctx.projectId}
          accessLevel={ctx.project.accessLevel}
          wsCtx={wsCtx}
        />
      </Suspense>
    </div>
  );
}

/**
 * The pane's two reads, moved below the boundary so the header flushes first.
 * They stay ONE wave — they were already concurrent and this card changes no
 * read, only where the wait is drawn.
 *
 * The membership + workspace-role reads that used to ride this batch existed
 * ONLY to compute the private admin check MOTIR-2469 retired — two fewer round
 * trips on every load of this page.
 */
async function ComponentsPaneBody({
  projectKey,
  projectId,
  accessLevel,
  wsCtx,
}: {
  projectKey: string;
  projectId: string;
  accessLevel: Parameters<typeof assignableMembersService.list>[0]['accessLevel'];
  wsCtx: { userId: string; workspaceId: string };
}) {
  const [components, assignableMembers] = await Promise.all([
    componentsService.listComponents(projectKey, wsCtx),
    assignableMembersService.list({ projectId, accessLevel, ctx: wsCtx }),
  ]);

  // MOTIR-2469 retired the private admin check that used to sit here — a role
  // comparison against the workspace and project membership rows, written before
  // there was a permission model to ask, and a SECOND policy answering a question
  // the catalog already answers. The page is reached only by an actor who holds
  // its registry key (the guard above), so the manage affordances are simply on.
  const canManage = true;

  return (
    <ComponentsSettingsEditor
      projectKey={projectKey}
      components={components}
      assignableMembers={assignableMembers}
      canManage={canManage}
    />
  );
}
