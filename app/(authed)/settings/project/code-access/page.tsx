import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoAccessService } from '@/lib/services/projectRepoAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveEffectiveRepoDomain } from '@/lib/projectRepos/effectiveDomain';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { EmptyState } from '@/components/ui/EmptyState';
import { CodeAccessSettings } from './_components/CodeAccessSettings';
import { guardSettingsPage } from '../_guard';

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
// ⚠️ THIS SURFACE IS DELIBERATELY NARROWER THAN THE REPOSITORIES ROOM, and the
// narrowness is the answer to MOTIR-3126, not an oversight it missed.
//
// That card widened `/settings/project/repositories` to render BOTH registries —
// the `project_repository` set and the workspace-CONNECTED repositories the
// effective-domain ladder layers under it — because the room's question is "which
// repositories does this project have?", and answering it from one table told
// Motir's own project it had none. This pane asks a DIFFERENT question: "who else
// on the team can clone the code Motir is holding?" — and its answer is a
// per-`(repository × member)` COLLABORATOR INVITATION that Motir sends through the
// GitHub App (`projectRepoAccessService.listTeamAccess` → `isInvitable`, which is
// true only of a `created` row with a live realized repository).
//
// A workspace-connected repository has no such record and can have none: it is the
// user's own repository on their own account, its collaborators are granted on
// GitHub by its owner, and Motir has no invitation there to report, grant or
// revoke. Listing one here would render a row of members whose access state is
// unknowable and whose only action Motir cannot perform — strictly worse than its
// absence. So `projectRepoSetService.listByProject` stays the right read for this
// pane: there is genuinely nothing for Motir to grant.
//
// ⚠️ AMENDED BY MOTIR-4803, and only in its LAST CLAUSE — the read is unchanged
// and the reasoning above is why. ~~the empty state ("nothing to grant until a
// plan is approved") stays true for a project whose repositories are all its
// own~~ **The LIST was right and the SENTENCE was not.** The pane rendered
// `{projectName} has no code yet`, which quantifies over the PROJECT's code
// while this room is scoped to the repositories Motir MADE — false of Motir's
// own project, which holds six repositories and no set at all, and the reporter
// who met it could not tell a scoped page from a broken one. The narrowness of
// the read was never the defect; a sentence wider than the read was. So the
// empty state now has two arms and the ladder is consulted to pick between them
// (below) — nothing is added to the matrix.
//
// If a revoke/read-back path for connected repositories ever lands, this is the
// comment to come back to — the boundary is the INVITATION, not the registry.
//
// BROWSE-gated by the area layout; the WRITE is re-gated in
// `projectRepoAccessService.grantTeamAccess` (edit — handing out push access to
// the project's code must never be reachable by merely being able to SEE it), so
// `canEdit` here only governs which affordances render. A non-admin sees the same
// data, plus the one action that is theirs alone: connecting their own GitHub.

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
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('project.empty.title')} description={t('project.empty.description')} />
      </div>
    );
  }

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `code-access`, never re-declared here.
  const refused = await guardSettingsPage('code-access', ctx);
  if (refused) return refused;

  // ⚠️ THE LADDER JOINS THE WAVE — IT IS CONSULTED FOR THE EMPTY STATE, AND FOR
  // NOTHING ELSE (MOTIR-4803). The matrix and strip reads stay the SET; the
  // paragraph at the top of this file is unchanged and is still the reason. What
  // was wrong was the SENTENCE the pane renders when that set is empty:
  // "{project} has no code yet" quantifies over the project's code, and Motir's
  // own project has six repositories while holding no set at all. So the pane
  // needs to know whether the absence is total or merely its own, and
  // `resolveEffectiveRepoDomain` is the one place that question is answered
  // (MOTIR-3086 · MOTIR-3126).
  //
  // ⚠️ IN the `Promise.all`, not after it. It was sequenced after the batch
  // first, to skip the read on a project whose set makes the answer irrelevant —
  // and that traded a query for a ROUND TRIP, which is the wrong direction and
  // is what `tests/navigation/loading-boundary-guard.test.ts`'s serial-read
  // ratchet (MOTIR-3449) exists to catch. It caught it: five serial reads
  // against a ceiling of four. A parallel read costs no latency, and the module
  // sequences its OWN two reads so a project answered by its set alone still
  // does the minimum — so the saving was never this page's to make.
  const actorCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [access, repos, identity, caps, domain] = await Promise.all([
    projectRepoAccessService.listTeamAccess(ctx.projectId, actorCtx),
    projectRepoSetService.listByProject(ctx.projectId, actorCtx),
    githubIdentityService.getIdentityForUser(ctx.userId),
    projectAccessService.getSettingsCapabilities(ctx.projectId, actorCtx),
    resolveEffectiveRepoDomain(ctx.projectId, actorCtx),
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
        connectedRepoCount={domain.connected.length}
      />
    </div>
  );
}
