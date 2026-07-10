import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { BadgeCheck, ExternalLink, FolderGit2, TriangleAlert } from 'lucide-react';
import { GithubMark } from '@/components/icons/GithubMark';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubAppInstallUrl, githubInstallationManageUrl } from '@/lib/github/appLinks';
import { encodeInstallState } from '@/lib/github/installState';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { EmptyState } from '@/components/ui/EmptyState';
import type { GithubIdentityDTO, GithubInstallationDTO } from '@/lib/dto/github';
import { GitSettingsShell } from '../_components/GitSettingsShell';
import { SettingsBanner, GrantRow, IdentityHeader } from '../_components/gitSettingsPrimitives';
import { DisconnectButton } from './_components/DisconnectButton';

// Settings → Workspace → GitHub (Story 7.10 · MOTIR-895) — Server Component. The
// user-facing connect/settings + repo-selection surface for the GitHub-App
// integration, per the MOTIR-889 design (Panels 1/2/4b). Workspace-scoped: the
// installation is `GithubInstallation { workspaceId }` and repo selection is
// workspace-wide, while the connecting admin binds their own `GithubIdentity`
// (Grant 1) on this same page. The two grants are INDEPENDENT — an identity with
// no installation is a valid state (the needs-access / revoked panel).
//
// 4-layer (CLAUDE.md): this page reads ONLY through the services
// (`githubIdentityService` / `githubInstallationService`); the sole mutation
// (Disconnect) goes through a Server Action → service. Repo SELECTION is changed
// on GitHub's install screen — the UI mirrors that honestly with "Manage on
// GitHub" link-outs and never fakes in-app granting.

const OAUTH_START_PATH = '/api/github/oauth/start';

// The OAuth callback (MOTIR-1498) redirects back with ?github=<status>. Map each
// terminal outcome to a banner tone + a `github.banner.*` message key.
const BANNER_TONE: Record<string, 'success' | 'danger' | 'info'> = {
  connected: 'success',
  installed: 'success',
  denied: 'danger',
  state_error: 'danger',
  error: 'danger',
  install_error: 'danger',
  not_configured: 'info',
};

interface GithubSettingsPageProps {
  searchParams: Promise<{ github?: string }>;
}

export default async function GithubSettingsPage({ searchParams }: GithubSettingsPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('github');

  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return (
      <GitSettingsShell provider="github">
        <EmptyState title={t('noWorkspace.title')} description={t('noWorkspace.description')} />
      </GitSettingsShell>
    );
  }

  const [identity, installation] = await Promise.all([
    githubIdentityService.getIdentityForUser(ctx.userId),
    githubInstallationService.getWorkspaceInstallation({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
  ]);

  const sp = await searchParams;
  const bannerStatus = sp.github;
  const bannerTone = bannerStatus ? BANNER_TONE[bannerStatus] : undefined;
  // Carry a signed state through the install round-trip so GitHub echoes it back
  // to the setup handler (MOTIR-1588), which binds the installation to this
  // workspace. Encoded per-request from the acting user + workspace.
  const installUrl = githubAppInstallUrl(
    encodeInstallState({ workspaceId: ctx.workspaceId, userId: ctx.userId }),
  );

  return (
    <GitSettingsShell provider="github">
      {bannerTone ? (
        <SettingsBanner tone={bannerTone} message={t(`banner.${bannerStatus}`)} />
      ) : null}

      {!identity ? (
        <NotConnectedPanel
          connectHref={OAUTH_START_PATH}
          installUrl={installUrl}
          copy={{
            title: t('connect.title'),
            subtitle: t('connect.subtitle'),
            step1Eyebrow: t('connect.step1.eyebrow'),
            step1Title: t('connect.step1.title'),
            step1Body: t('connect.step1.body'),
            step2Eyebrow: t('connect.step2.eyebrow'),
            step2Title: t('connect.step2.title'),
            step2Body: t('connect.step2.body'),
            installLink: t('connect.installLink'),
            cta: t('connect.cta'),
            foot: t('connect.foot'),
          }}
        />
      ) : installation ? (
        <ConnectedPanel
          identity={identity}
          installation={installation}
          copy={{
            connectedName: t('identity.connectedAs', { name: identity.githubLogin }),
            verified: t('identity.verified'),
            installedOn: t('installation.installedOn', {
              account: installation.accountLogin,
              type: installation.accountType.toLowerCase(),
            }),
            manage: t('manageOnGitHub'),
            reposTitle: t('repos.title'),
            reposCaption: t('repos.caption'),
            reposEmpty: t('repos.empty'),
            reposFoot: t('repos.foot'),
          }}
        />
      ) : (
        <NeedsAccessPanel
          identity={identity}
          connectHref={OAUTH_START_PATH}
          installUrl={installUrl}
          copy={{
            pill: t('needsAccess.pill'),
            calloutTitle: t('needsAccess.calloutTitle'),
            calloutBody: t('needsAccess.calloutBody'),
            reconnect: t('needsAccess.reconnect'),
            install: t('needsAccess.install'),
            connectedName: t('identity.connectedAs', { name: identity.githubLogin }),
            verified: t('identity.verified'),
            stillConnected: t('needsAccess.stillConnected'),
          }}
        />
      )}
    </GitSettingsShell>
  );
}

function NotConnectedPanel({
  connectHref,
  installUrl,
  copy,
}: {
  connectHref: string;
  installUrl: string | null;
  copy: {
    title: string;
    subtitle: string;
    step1Eyebrow: string;
    step1Title: string;
    step1Body: string;
    step2Eyebrow: string;
    step2Title: string;
    step2Body: string;
    installLink: string;
    cta: string;
    foot: string;
  };
}) {
  return (
    <Card
      header={
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{copy.title}</h2>
          <p className="font-sans text-sm text-(--el-text-muted)">{copy.subtitle}</p>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-sans text-sm text-(--el-text-muted)">{copy.foot}</p>
          <a href={connectHref} className={buttonVariants({ variant: 'primary' })}>
            <GithubMark className="h-4 w-4" aria-hidden />
            {copy.cta}
          </a>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <GrantRow
          icon={<BadgeCheck aria-hidden />}
          eyebrow={copy.step1Eyebrow}
          title={copy.step1Title}
          body={copy.step1Body}
        />
        <div role="separator" className="border-t border-(--el-border-soft)" />
        <GrantRow
          icon={<FolderGit2 aria-hidden />}
          eyebrow={copy.step2Eyebrow}
          title={copy.step2Title}
          body={copy.step2Body}
          extra={
            installUrl ? (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex w-fit items-center gap-1.5 font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
              >
                {copy.installLink}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : null
          }
        />
      </div>
    </Card>
  );
}

function ConnectedPanel({
  identity,
  installation,
  copy,
}: {
  identity: GithubIdentityDTO;
  installation: GithubInstallationDTO;
  copy: {
    connectedName: string;
    verified: string;
    installedOn: string;
    manage: string;
    reposTitle: string;
    reposCaption: string;
    reposEmpty: string;
    reposFoot: string;
  };
}) {
  const manageUrl = githubInstallationManageUrl({
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    installationId: installation.installationId,
  });
  return (
    <div className="flex flex-col gap-6">
      <Card
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-sans text-sm text-(--el-text-secondary)">{copy.installedOn}</p>
            <ManageOnGithubLink href={manageUrl} label={copy.manage} />
          </div>
        }
      >
        <IdentityHeader
          login={identity.githubLogin}
          avatarUrl={identity.avatarUrl}
          caption={copy.connectedName}
          verified={copy.verified}
          trailing={<DisconnectButton />}
        />
      </Card>

      <Card
        header={
          <div className="flex flex-col gap-1">
            <SectionLabel label={copy.reposTitle} />
            <p className="font-sans text-sm text-(--el-text-muted)">{copy.reposCaption}</p>
          </div>
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-sans text-sm text-(--el-text-muted)">{copy.reposFoot}</p>
            <ManageOnGithubLink href={manageUrl} label={copy.manage} />
          </div>
        }
      >
        {installation.repos.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-muted)">{copy.reposEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {installation.repos.map((repo) => (
              <li
                key={repo.id}
                className="flex items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)"
              >
                <FolderGit2
                  className="h-[18px] w-[18px] shrink-0 text-(--el-icon-muted)"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate font-sans text-sm">
                  <span className="text-(--el-text-muted)">{repo.owner}/</span>
                  <span className="font-medium text-(--el-text)">{repo.name}</span>
                </span>
                <span className="shrink-0 rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs text-(--el-code-text)">
                  {repo.defaultBranch}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function NeedsAccessPanel({
  identity,
  connectHref,
  installUrl,
  copy,
}: {
  identity: GithubIdentityDTO;
  connectHref: string;
  installUrl: string | null;
  copy: {
    pill: string;
    calloutTitle: string;
    calloutBody: string;
    reconnect: string;
    install: string;
    connectedName: string;
    verified: string;
    stillConnected: string;
  };
}) {
  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-sans text-base font-semibold text-(--el-text)">GitHub</h2>
          <Pill severity="danger">{copy.pill}</Pill>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex gap-3 rounded-(--radius-card) border-l-2 border-(--el-danger) bg-(--el-danger-surface) p-(--spacing-card-padding)">
          <TriangleAlert className="h-5 w-5 shrink-0 text-(--el-danger)" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-sans text-sm font-semibold text-(--el-danger-surface-text)">
              {copy.calloutTitle}
            </p>
            <p className="font-sans text-sm text-(--el-danger-surface-text)">{copy.calloutBody}</p>
          </div>
        </div>

        <IdentityHeader
          login={identity.githubLogin}
          avatarUrl={identity.avatarUrl}
          caption={copy.stillConnected}
          verified={copy.verified}
        />

        <div className="flex flex-wrap gap-3">
          <a href={connectHref} className={buttonVariants({ variant: 'primary' })}>
            <GithubMark className="h-4 w-4" aria-hidden />
            {copy.reconnect}
          </a>
          {installUrl ? (
            <a
              href={installUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonVariants({ variant: 'secondary' })}
            >
              {copy.install}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function ManageOnGithubLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={buttonVariants({ variant: 'secondary', size: 'sm' })}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      {label}
    </a>
  );
}
