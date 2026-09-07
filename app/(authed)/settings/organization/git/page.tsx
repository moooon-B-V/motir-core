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
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { GithubMark } from '@/components/icons/GithubMark';
import { GitConnectBanner } from '@/components/settings/GitConnectBanner';
import { GitSettingsShell } from '../../workspace/_components/GitSettingsShell';
import { GrantRow } from '../../workspace/_components/gitSettingsPrimitives';
import { githubAppInstallUrl } from '@/lib/github/appLinks';
import { encodeInstallState } from '@/lib/github/installState';
import { buttonVariants } from '@/components/ui/Button';
import { BadgeCheck, ExternalLink, FolderGit2 } from 'lucide-react';
import { GitlabConnection } from './_components/GitlabConnection';
import { OrgGitClient } from './_components/OrgGitClient';

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
  searchParams: Promise<{ provider?: string; github?: string; gitlab?: string }>;
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
          github={sp.github}
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
}: {
  userId: string;
  workspaceId: string;
  provider: 'github' | 'gitlab';
  github?: string | undefined;
}) {
  const t = await getTranslations('github');
  const ctx = { userId, workspaceId };

  // ⚠️ `allSettledOrThrow`, never a bare `Promise.all` (MOTIR-3066): each arm
  // opens its own transaction, and `Promise.all` abandons the others' connections
  // on the first rejection rather than letting them settle.
  const [organization, canDisconnect, installation, rows] = await allSettledOrThrow([
    organizationsService.resolveActiveOrganization(ctx.userId, null),
    isOrgAdminForWorkspace(ctx.userId, ctx.workspaceId),
    githubInstallationService.getWorkspaceInstallation({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    organizationRepoService.listInventory(ctx),
  ]);
  const organizationName = organization?.organization.name ?? '';

  // ⚠️ THE GITLAB ARM IS A DIFFERENT CONNECTION, NOT A DIFFERENT SKIN. One OAuth
  // authorization conveys identity and project access, and selection happens in
  // app — so the provider Segmented swaps the whole card, and only the inventory
  // below is shared. Rendering GitHub's card under `?provider=gitlab` is what
  // shipped first, and it left a workspace with no way to connect GitLab at all.
  if (provider === 'gitlab') {
    return (
      <>
        <GitlabConnection userId={ctx.userId} workspaceId={ctx.workspaceId} />
        <OrgGitClient
          initialRows={rows}
          organizationName={organizationName}
          canDisconnect={canDisconnect}
          manageOnGithubHref={null}
          retentionDays={CODE_GRAPH_RETENTION_WINDOW_DAYS}
        />
      </>
    );
  }

  return (
    <>
      <Card>
        {installation ? (
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-(--el-muted) text-(--el-text-secondary)"
            >
              <GithubMark className="h-5 w-5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-sans text-sm font-semibold text-(--el-text)">
                  {t('organization.connectionTitle')}
                </span>
                <Pill severity="success">
                  {t('installation.installedOn', {
                    account: installation.accountLogin,
                    type: installation.accountType.toLowerCase(),
                  })}
                </Pill>
              </div>
              {/* ⚠️ NOT an identity card. The member's own `GithubIdentity` moved
                  to Settings → Account → Git accounts (MOTIR-4682); drawing a
                  personal credential on the ORGANISATION's page is this story's
                  own tier confusion pointed the other way. */}
              <span className="font-sans text-xs text-(--el-text-secondary)">
                {canDisconnect ? null : t('organization.adminOnly', { org: organizationName })}
              </span>
            </div>
          </div>
        ) : (
          <GithubConnectPanel
            organizationName={organizationName}
            installUrl={githubAppInstallUrl(
              encodeInstallState({ workspaceId: ctx.workspaceId, userId: ctx.userId }),
            )}
          />
        )}
      </Card>

      <OrgGitClient
        initialRows={rows}
        organizationName={organizationName}
        canDisconnect={canDisconnect}
        manageOnGithubHref={
          installation
            ? githubInstallationManageUrl({
                accountLogin: installation.accountLogin,
                accountType: installation.accountType,
                installationId: installation.installationId,
              })
            : null
        }
        retentionDays={CODE_GRAPH_RETENTION_WINDOW_DAYS}
      />
    </>
  );
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
async function GithubConnectPanel({
  organizationName,
  installUrl,
}: {
  organizationName: string;
  installUrl: string | null;
}) {
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
        <p className="font-sans text-sm text-(--el-text-muted)">{t('connect.orgFoot')}</p>
        {installUrl ? (
          <a
            href={installUrl}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonVariants({ variant: 'primary' })}
          >
            <GithubMark className="h-4 w-4" aria-hidden />
            {t('connect.installLink')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : (
          /* No App slug configured — a self-hosted deployment that registered
             none. The button would link nowhere, so it is absent and the reason
             is stated. */
          <p className="font-sans text-sm text-(--el-text-muted)">{t('connect.noInstallHref')}</p>
        )}
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
