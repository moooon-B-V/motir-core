import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { CodeAccessSettings } from './_components/CodeAccessSettings';
import { guardSettingsPage } from '../_guard';

// TEAM CODE ACCESS — one matrix over this project's explicit repository links.
// The project_repository association is both the membership and isolation
// boundary (MOTIR-4955); organisation connectivity alone contributes no row.
// Reads are browse-gated, while grant/revoke writes are re-gated in the service.

/**
 * Where a member goes to connect their OWN git account — grant 1 (identity) is
 * all this surface needs; no repository permission is asked for, because none is
 * needed to be invited to a repository. Redrawn nowhere (design §15.14).
 *
 * ⚠️ RE-POINTED BY MOTIR-4682, and it is load-bearing rather than tidying. This
 * was `/settings/workspace/github` — a page that hosted the member's personal
 * identity beside the workspace's installation, and that MOTIR-4680 redirects
 * away once the connection moves to the organisation. Left alone, **the one
 * action nobody can take on a member's behalf** would have lost its door: this
 * link is the only route to it from the room where a member discovers they need
 * it.
 *
 * The destination is the ACCOUNT tier because that is where the credential
 * lives — `GithubIdentity` is `userId @unique` and has never belonged to a
 * workspace. `tests/settings/accountGitAccounts.test.tsx` asserts this constant
 * names a route that is not redirected away, so the door cannot go stale again
 * behind a rename.
 */
const GIT_ACCOUNT_PATH = '/settings/account/git';

/**
 * The Repositories room — the surface that answers "WHICH repositories does this
 * project work on", over the whole effective domain rather than the set
 * (MOTIR-3126 · MOTIR-4669). It is where a reader who finds THIS pane empty
 * should go, and until MOTIR-4803 nothing on this pane said so.
 */
const REPOSITORIES_PATH = '/settings/project/repositories';

export default async function ProjectCodeAccessPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at
  // the WORKSPACE tier). The guard stays because the type does — the only null
  // left is a session-less request — and it redirects rather than rendering.
  if (!ctx) redirect('/sign-in');

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `code-access`, never re-declared here.
  const refused = await guardSettingsPage('code-access', ctx);
  if (refused) return refused;

  // Every repository-bearing read below is project_repository-scoped. An empty
  // set is therefore a real project empty state, not a prompt to inspect the
  // workspace installation (MOTIR-4955).
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
        connectHref={GIT_ACCOUNT_PATH}
        plansHref="/plans"
        membersHref="/settings/project/members"
        repositoriesHref={REPOSITORIES_PATH}
        connectedRepoCount={0}
      />
    </div>
  );
}
