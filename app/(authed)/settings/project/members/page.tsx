import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject, type ProjectContext } from '@/lib/projects';
import { isCloud } from '@/lib/billing/availability';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { teamAccessSummary } from '@/lib/projectRepos/teamAccessView';
import { publicProjectUrl } from '@/lib/publicProjects/urls';
import { ProjectMembersSettings } from './_components/ProjectMembersSettings';
import { CodeAccessDoorCard } from './_components/CodeAccessDoorCard';
import { guardSettingsPage } from '../_guard';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// Project Access & members — server component (Subtask 6.4.5; the three access
// MODES since Story MOTIR-6169 · MOTIR-6550). Reads the active project, its
// members and access mode (through `projectMembersService`), the workspace
// members with their role and scope (the add picker and each row's chips), and
// the actor's permission set, then hands typed data to the client editor. Every
// WRITE is re-gated in the service; the two booleans derived here only decide
// which of the page's two cards render their controls (design A6 / A7).

export default async function ProjectMembersPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `members`, never re-declared here.
  const refused = await guardSettingsPage('members', ctx);
  if (refused) return refused;

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('access.title')}</h1>
        <p className="text-(--el-text-secondary) font-sans text-sm">
          {t('access.subtitle', { projectName: ctx.project.name })}
        </p>
      </header>

      {/* The page's reads stream behind an in-page boundary placed AFTER the
          guard above (design A9 — never a `loading.tsx`, which would fix the
          status at 200 before the guard ran; CLAUDE.md § loading boundaries). */}
      <Suspense fallback={<AccessMembersSkeleton />}>
        <AccessMembersSection ctx={ctx} />
      </Suspense>
    </div>
  );
}

async function AccessMembersSection({ ctx }: { ctx: ProjectContext }) {
  const actor = { key: ctx.project.identifier, actorUserId: ctx.userId, ctx };

  // No role catalog: a project membership carries no role since roles moved to
  // the workspace (Story MOTIR-6168 · MOTIR-6464). The actor's permission set
  // splits the page's two cards (design A6 / A7): `project:manage_access` owns
  // the mode control, `member:manage` the people controls — the guard above
  // already required the second, so it is read here only to be explicit.
  const [members, access, workspaceMembers, workspace, permissions, codeAccess, repos] =
    await Promise.all([
      projectMembersService.listMembers(actor),
      projectMembersService.getAccess(actor),
      workspacesService.listMembers(ctx.workspaceId, ctx.userId),
      workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId),
      projectAccessService.getPermissions(ctx.projectId, ctx),
      // Door 2's count (MOTIR-1945) — read here rather than inside the card so
      // the card stays a pure presentational leaf and the reads still go out in
      // one parallel batch.
      projectRepoAccessService.listTeamAccess(ctx.projectId, ctx),
      projectRepoSetService.listByProject(ctx.projectId, ctx),
    ]);
  const codeAccessCounts = teamAccessSummary(codeAccess, repos);

  return (
    <>
      <ProjectMembersSettings
        projectKey={ctx.project.identifier}
        projectName={ctx.project.name}
        workspaceName={workspace?.name ?? ''}
        accessMode={access.accessMode}
        members={members}
        workspaceMembers={workspaceMembers}
        currentUserId={ctx.userId}
        canManageAccess={permissions.has('project:manage_access')}
        canManageMembers={permissions.has('member:manage')}
        // Whether this BUILD publishes at all (MOTIR-4035). Read on the server,
        // where `MOTIR_CLOUD` lives, and threaded to the client island.
        publicAccessAvailable={isCloud()}
        // The project's address ON THE PUBLIC SITE (MOTIR-4242), resolved by the
        // one module that owns that question (`publicSiteOrigin()` →
        // `MOTIR_PUBLIC_SITE_URL`, MOTIR-3881). Threaded because that variable
        // is a server variable and the editor is a client island.
        publicPageUrl={publicProjectUrl(ctx.project.identifier)}
      />

      <CodeAccessDoorCard
        granted={codeAccessCounts.granted}
        eligible={codeAccessCounts.eligible}
        hasCode={repos.some((repo) => repo.established)}
      />
    </>
  );
}

// The page's loading frame (design A9): the two cards' outlines, in the page's
// own layout, so nothing shifts when the reads land.
function AccessMembersSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="border-(--el-border) flex flex-col gap-3 rounded-(--radius-card) border p-(--spacing-card-padding)"
        >
          <div className="bg-(--el-muted) h-4 w-1/3 animate-pulse rounded-(--radius-control)" />
          {[0, 1, 2].map((j) => (
            <div key={j} className="bg-(--el-muted) h-12 animate-pulse rounded-(--radius-card)" />
          ))}
        </div>
      ))}
    </div>
  );
}
