import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { EmptyState } from '@/components/ui/EmptyState';
import { CodeAccessSettings } from './_components/CodeAccessSettings';

// TEAM CODE ACCESS — project settings (Story MOTIR-1775 · MOTIR-1945), the room
// `design/repository-set/team-access.mock.html` draws at the placement
// MOTIR-1943 Q4 decided: a SIBLING pane in the Access group, beside Members &
// access rather than a section appended to it (design §15.3).
//
// Server component: it reads the whole matrix once (MOTIR-1910's `listTeamAccess`
// crosses every candidate member with every repository of the set, so the surface
// renders without an N+1), the repository SET (for the strip and the
// mid-establish banner, which the matrix does not carry), the actor's own GitHub
// identity, and their edit capability — then hands typed data to the client
// island that owns the interaction.
//
// BROWSE-gated by the area layout; the WRITE is re-gated in
// `projectRepoAccessService.grantTeamAccess` (edit — handing out push access to
// the project's code must never be reachable by merely being able to SEE it), so
// `canEdit` here only governs which affordances render. A non-admin sees the same
// data, plus the one action that is theirs alone: connecting their own GitHub.

/** The shipped 7.10 connect pane — grant 1 (identity) is all this surface needs;
 *  no repository permission is asked for, because none is needed to be invited to
 *  a repository. Redrawn nowhere (design §15.14). */
const GITHUB_SETTINGS_PATH = '/settings/workspace/github';

export default async function ProjectCodeAccessPage() {
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

  const actorCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [access, repos, identity, caps] = await Promise.all([
    projectRepoAccessService.listTeamAccess(ctx.projectId, actorCtx),
    projectRepoSetService.listByProject(ctx.projectId, actorCtx),
    githubIdentityService.getIdentityForUser(ctx.userId),
    projectAccessService.getSettingsCapabilities(ctx.projectId, actorCtx),
  ]);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('codeAccess.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t.rich('codeAccess.subtitle', {
            projectName: ctx.project.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <CodeAccessSettings
        projectKey={ctx.project.identifier}
        projectName={ctx.project.name}
        initialAccess={access}
        initialRepos={repos}
        currentUserId={ctx.userId}
        canEdit={caps.canEdit}
        selfLogin={identity?.githubLogin ?? null}
        selfAvatarUrl={identity?.avatarUrl ?? null}
        connectHref={GITHUB_SETTINGS_PATH}
        plansHref="/plans"
        membersHref="/settings/project/members"
      />
    </div>
  );
}
