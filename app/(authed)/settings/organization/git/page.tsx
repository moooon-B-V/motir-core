import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { organizationsService } from '@/lib/services/organizationsService';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { isOrgAdminForWorkspace } from '@/lib/services/organizationAccessService';
import { githubInstallationManageUrl } from '@/lib/github/appLinks';
import { CODE_GRAPH_RETENTION_WINDOW_DAYS } from '@/lib/codeGraph/offboarding';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { EmptyState } from '@/components/ui/EmptyState';
import { GitConnectBanner } from '@/components/settings/GitConnectBanner';
import { GitSettingsShell } from '../../workspace/_components/GitSettingsShell';
import { GrantRow } from '../../workspace/_components/gitSettingsPrimitives';
import { BadgeCheck, FolderGit2, Lock } from 'lucide-react';
import { GitlabConnection } from './_components/GitlabConnection';
import { OrgGitClient } from './_components/OrgGitClient';
import { ConnectGithubButton, GithubConnectRoom } from './_components/GithubConnectRoom';
import type { LinkedGithubAccount } from './_components/githubAccounts';

// SETTINGS → ORGANISATION → GIT (Story MOTIR-4669 · MOTIR-4680), built to
// `design/github/github.mock.html` Panel 6 and reached by the `Git` row
// MOTIR-4673 designed and this commit adds to the registry.
//
// It is the WORKSPACE page moved a tier, plus one substantive addition — the
// organisation's whole repository INVENTORY with `Used by N projects`. The shared
// chrome (`GitSettingsShell` + its provider `Segmented`) is COMPOSED, not
// re-specified.
//
// ⚠️ ONE ROUTE, PROVIDER AS A SEARCH PARAM — not two sibling routes. The
// inventory spans BOTH providers (a repository belongs to the organisation, not
// to a host), so the Segmented switches the CONNECTION card above it rather than
// the page. Two routes would also have needed two registry entries for a row the
// design draws once, and the totality test pairs entries with routes 1:1.
//
// ⚠️ READING IS ORG MEMBERSHIP; WRITING IS ORG ADMIN. `organization-tier.md` §6
// forbids a relocation that narrows an audience, and the surface this moved from
// (`/settings/workspace/github`) checks a session and a workspace context and NO
// role at all. So a plain member sees the inventory and no destructive control —
// absent, not disabled — with a sentence saying who can.
//
// ⚠️ THE PAGE-STATE CONTRACT is split in `OrgGitClient`'s own comment: the header
// and the connection card are server-rendered (so `router.refresh()` reaches
// them) and the inventory is a client island seeded via `useState` (so it
// provably is not). A disconnect does both.

interface OrgGitPageProps {
  searchParams: Promise<{
    provider?: string;
    github?: string;
    gitlab?: string;
    /** Named by the install round trip alongside `?github=select_repos`. */
    installation_id?: string;
  }>;
}

export default async function OrganizationGitPage({ searchParams }: OrgGitPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('github');
  const sp = await searchParams;
  const provider = sp.provider === 'gitlab' ? 'gitlab' : 'github';

  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return (
      <GitSettingsShell provider={provider} hrefs={PROVIDER_HREFS}>
        <EmptyState title={t('noWorkspace.title')} description={t('noWorkspace.description')} />
      </GitSettingsShell>
    );
  }

  // ⚠️ THE SHELL AND THE PICKER PAINT FIRST (MOTIR-3448's arrival contract). The
  // four reads below are the page's weight — an org-spanning inventory, its usage
  // fan-in and the index ledger — and none of them is needed to draw the title or
  // the provider Segmented. So the header is above the boundary and everything
  // that depends on the reads is below it, behind the SHARED frame.
  //
  // ⚠️ AND NO `loading.tsx` MAY BE ADDED (CLAUDE.md). A route-level boundary in
  // this tree flushes the response head, and `settings/organization/billing`
  // `notFound()`s on a self-host build — the 404 that `billing-selfhost.spec.ts`
  // asserts would become a 200. An in-page `<Suspense>` placed after the gate
  // streams without touching the status, which is why it is the instrument here.
  // ⚠️ THE READ GATE MOVED WITH THE RAIL ROW (MOTIR-6312 · the Git-row flag in
  // `design/org-admin/design-notes.md` § *Workspaces are created and removed at
  // the org tier*). The org repository inventory is Owner/Admin reading under the
  // role model, so a plain org member opening this URL directly meets panel 5d's
  // forbidden state — never the inventory under a row that hides it. What a
  // Member keeps is Settings › Project › Repositories (MOTIR-4674).
  if (!(await isOrgAdminForWorkspace(ctx.userId, ctx.workspaceId))) {
    const [tOrg, organization] = await Promise.all([
      getTranslations('orgAdmin'),
      organizationsService.resolveWorkspaceOrganization(ctx.userId, ctx.workspaceId),
    ]);
    return (
      <GitSettingsShell provider={provider} hrefs={PROVIDER_HREFS}>
        <EmptyState
          icon={<Lock className="h-12 w-12" aria-hidden />}
          title={tOrg('states.forbiddenTitle')}
          description={tOrg('states.forbiddenDescription', { org: organization?.name ?? '' })}
        />
      </GitSettingsShell>
    );
  }

  return (
    <GitSettingsShell
      provider={provider}
      hrefs={PROVIDER_HREFS}
      subtitle={t('organization.subtitleGeneric')}
    >
      {/* ABOVE the boundary: the banner is about the round trip the reader just
          took, needs none of the reads, and a confirmation that waits for a
          database arrives after the reader has started wondering. */}
      <GitConnectBanner status={sp.github} gitlabStatus={sp.gitlab} />
      <Suspense fallback={<SettingsPaneFrame />}>
        <OrgGitBody
          userId={ctx.userId}
          workspaceId={ctx.workspaceId}
          provider={provider}
          selectReposInstallationId={
            sp.github === 'select_repos' && sp.installation_id ? sp.installation_id : null
          }
        />
      </Suspense>
    </GitSettingsShell>
  );
}

/** Everything that depends on the page's four reads. */
async function OrgGitBody({
  userId,
  workspaceId,
  provider,
  selectReposInstallationId,
}: {
  userId: string;
  workspaceId: string;
  provider: 'github' | 'gitlab';
  selectReposInstallationId: string | null;
}) {
  const ctx = { userId, workspaceId };

  // ⚠️ `allSettledOrThrow`, never a bare `Promise.all` (MOTIR-3066): each arm
  // opens its own transaction, and `Promise.all` abandons the others' connections
  // on the first rejection rather than letting them settle.
  //
  // ⚠️ THE NAME AND THE INVENTORY RESOLVE FROM THE SAME WORKSPACE (MOTIR-4801).
  // The heading once came from the ACTOR-scoped resolve with no preference —
  // the caller's FIRST org membership — while `listInventory` below resolved the
  // organisation from `ctx.workspaceId`. For a member of two organisations the
  // two halves of this page could therefore disagree: a heading naming one
  // tenant over rows belonging to another, each with a `Disconnect` button.
  // Both arms now read `ctx.workspaceId`, so the page has ONE subject.
  //
  // ⚠️ AND THE CONNECTION READS THE ORGANISATION, NOT THE WORKSPACE (MOTIR-4836).
  // It went through the WORKSPACE-tier lookup
  // (`githubInstallationRepository.findByWorkspaceId`, whose service wrapper is
  // honestly named for it) — a `workspace_id` comparison, on an ORGANISATION
  // surface. So from a SIBLING workspace of the installing one this card found
  // nothing and offered `Connect GitHub` for an account that is already
  // installed, while the inventory directly below it listed that same
  // organisation's seven repositories. One page, one request, two tiers. The
  // trigger is an organisation with a second workspace, which is why it survived
  // until one existed.
  const [organization, canDisconnect, installations, rows] = await allSettledOrThrow([
    organizationsService.resolveWorkspaceOrganization(ctx.userId, ctx.workspaceId),
    isOrgAdminForWorkspace(ctx.userId, ctx.workspaceId),
    githubInstallationService.listOrganizationInstallations({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    organizationRepoService.listInventory(ctx),
  ]);
  const organizationName = organization?.name ?? '';

  // ⚠️ THE GITLAB ARM IS A DIFFERENT CONNECTION, NOT A DIFFERENT SKIN. One OAuth
  // authorization conveys identity and project access, and selection happens in
  // app — so the provider Segmented swaps the whole card, and only the inventory
  // below is shared. Rendering GitHub's card under `?provider=gitlab` is what
  // shipped first, and it left a workspace with no way to connect GitLab at all.
  if (provider === 'gitlab') {
    return (
      <>
        <GitlabConnection
          userId={ctx.userId}
          workspaceId={ctx.workspaceId}
          canManage={canDisconnect}
          organizationName={organizationName}
        />
        <OrgGitClient
          key={inventoryKey(rows)}
          initialRows={rows}
          organizationName={organizationName}
          canDisconnect={canDisconnect}
          manageOnGithubHrefs={{}}
          retentionDays={CODE_GRAPH_RETENTION_WINDOW_DAYS}
        />
      </>
    );
  }

  // ⚠️ THE CARD RENDERS THE SET, IT DOES NOT PICK FROM IT (MOTIR-4836), and
  // since MOTIR-8223 it says so in its own shape: `GitHub accounts`, one row per
  // account linked to THIS organisation, each with its own actions
  // (`design/github/github--multi-org-account.mock.html` Panels A6a/A6b).
  // `installations.map(` below is the whole of the choice — none is made.
  //
  // ⚠️ THE MANAGE LINK IS PER ACCOUNT NOW, NOT PAGE-WIDE. It was supplied only
  // when `installations.length === 1`, because one link could name only one
  // installation; with two accounts linked the inventory's `Continue on GitHub`
  // had nowhere to go. Each account row and each of that account's repository
  // rows now carry the account's OWN installation settings (design § 31.7).
  const accounts: LinkedGithubAccount[] = installations
    .map((installation) => ({
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repoCount: installation.repos.length,
      manageUrl: githubInstallationManageUrl(installation),
    }))
    .sort((a, b) => a.accountLogin.localeCompare(b.accountLogin));
  const manageOnGithubHrefs: Record<string, string> = {};
  for (const installation of installations) {
    const href = githubInstallationManageUrl(installation);
    for (const repo of installation.repos) manageOnGithubHrefs[repo.id] = href;
  }

  return (
    <>
      <GithubConnectRoom
        organizationId={organization?.id ?? ''}
        organizationName={organizationName}
        accounts={accounts}
        selectReposInstallationId={selectReposInstallationId}
      >
        <GithubConnectPanel organizationName={organizationName} />
      </GithubConnectRoom>

      <OrgGitClient
        key={inventoryKey(rows)}
        initialRows={rows}
        organizationName={organizationName}
        canDisconnect={canDisconnect}
        manageOnGithubHrefs={manageOnGithubHrefs}
        retentionDays={CODE_GRAPH_RETENTION_WINDOW_DAYS}
      />
    </>
  );
}

/**
 * The inventory island seeds `useState` once, so a link or a disconnect made in
 * the connection card above it would never reach it through `router.refresh()`.
 * Keying it by the repository set it was seeded with remounts it exactly when
 * that set changes — and leaves it alone (its optimistic removal included) when
 * a refresh changes nothing it shows.
 */
function inventoryKey(rows: { repo: { id: string } }[]): string {
  return rows
    .map((row) => row.repo.id)
    .sort()
    .join(',');
}

/**
 * THE ORGANISATION'S GITHUB GRANT, when it has none yet.
 *
 * ⚠️ THIS DOOR WAS MISSING, and `tests/e2e/github.spec.ts` is what said so. The
 * tier move deleted `/settings/workspace/github`, whose not-connected panel was
 * the only place the Motir App could be installed from; this page shipped with a
 * sentence saying the organisation was not connected and no way to connect it.
 * A settings page that names a state it cannot leave is worse than no page.
 *
 * ⚠️ THE TWO STEPS ARE AT TWO TIERS NOW, and saying so is the whole content of
 * this card. Step 1 is the MEMBER's own identity and lives at Settings → Account
 * → Git accounts (MOTIR-4682) — nobody can connect it on somebody else's behalf,
 * so this page links to it rather than offering it. Step 2 is the
 * ORGANISATION's grant, which is the App installation, and that is the primary
 * action here. The old workspace page put both on one screen because it did not
 * distinguish the tiers; that conflation is the thing this story removed.
 */
async function GithubConnectPanel({ organizationName }: { organizationName: string }) {
  const t = await getTranslations('github');
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('connect.title')}</h2>
        <p className="font-sans text-sm text-(--el-text-muted)">
          {t('organization.notConnected', { org: organizationName })}
        </p>
      </div>

      <GrantRow
        icon={<BadgeCheck aria-hidden />}
        eyebrow={t('connect.step1.eyebrow')}
        title={t('connect.step1.title')}
        body={t('connect.step1.body')}
        extra={
          <a
            href="/settings/account/git"
            className="inline-flex w-fit items-center gap-1.5 font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {t('organization.identityAtAccount')}
          </a>
        }
      />
      <div role="separator" className="border-t border-(--el-border-soft)" />
      <GrantRow
        icon={<FolderGit2 aria-hidden />}
        eyebrow={t('connect.step2.eyebrow')}
        title={t('connect.step2.title')}
        body={t('connect.step2.body')}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('connect.orgFoot')}</p>
        {/* ⚠️ A BUTTON THAT OPENS THE PICKER, not a link to GitHub (MOTIR-8223,
            design § 31.4). An account the App is already installed on is listed
            there and linked without leaving Motir; installing on a new account
            is the picker's last row. */}
        <ConnectGithubButton />
      </div>
    </div>
  );
}

/**
 * The provider Segmented stays on THIS route and changes a search param.
 *
 * ⚠️ A RECORD, NOT A FUNCTION. `ProviderSwitch` is a client component and this
 * page is a Server Component; React refuses a function across that boundary
 * (*"Functions cannot be passed directly to Client Components"*), and the first
 * cut of this page passed one and threw at RENDER time — caught by the
 * acceptance walk, not by the type checker.
 */
const PROVIDER_HREFS = {
  github: '/settings/organization/git',
  gitlab: '/settings/organization/git?provider=gitlab',
} as const;
