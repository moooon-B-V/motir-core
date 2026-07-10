import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ExternalLink, FolderGit2, KeyRound } from 'lucide-react';
import { GitlabMark } from '@/components/icons/GitlabMark';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { gitlabBaseUrl } from '@/lib/gitlab/gitlabOAuth';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { EmptyState } from '@/components/ui/EmptyState';
import type { GithubInstallationDTO } from '@/lib/dto/github';
import { GitSettingsShell } from '../_components/GitSettingsShell';
import { SettingsBanner, GrantRow, IdentityHeader } from '../_components/gitSettingsPrimitives';
import { GitlabDisconnectButton } from './_components/GitlabDisconnectButton';
import { GitlabProjectSyncSwitch } from './_components/GitlabProjectSyncSwitch';
import { GitlabProjectPicker } from './_components/GitlabProjectPicker';

// Settings → Workspace → Git, GitLab variant (Story 7.23 · MOTIR-1478) — Server
// Component. The GitLab half of the SHARED connect-settings surface, per the
// MOTIR-1472 design (design/gitlab Panels 1/2/2b). Renders under the same
// `GitSettingsShell` as the GitHub variant (the provider `Segmented` swaps between
// them) — the card's "shared connect-settings component, not a separate page."
//
// GitLab's connect model genuinely differs from GitHub's (the design's honest
// differences): ONE OAuth authorization covers identity + project access (no
// separate App install), and project selection is IN-APP (the OAuth `api` scope
// lets Motir enumerate + connect the user's projects HERE — Panel 2b — rather than
// on a separate GitLab screen). The connection is WORKSPACE-scoped (unlike GitHub's
// user identity); it reuses the shared `GithubInstallation` entity under
// `provider: 'gitlab'` (MOTIR-1474).
//
// 4-layer (CLAUDE.md): this page reads ONLY through `gitlabConnectionService`; the
// mutations (Disconnect, connect/disconnect project) go through Server Actions →
// service. The projects list is a server surface, so the actions `revalidatePath`
// (the page-state contract's server-surface case).

const OAUTH_START_PATH = '/api/gitlab/oauth/start';

// The OAuth start/callback (MOTIR-1474) redirect back with ?gitlab=<status>. Map
// each terminal outcome to a banner tone + a `gitlab.banner.*` message key.
const BANNER_TONE: Record<string, 'success' | 'danger' | 'info'> = {
  connected: 'success',
  denied: 'danger',
  state_error: 'danger',
  error: 'danger',
  not_configured: 'info',
  no_workspace: 'info',
};

interface GitlabSettingsPageProps {
  searchParams: Promise<{ gitlab?: string }>;
}

export default async function GitlabSettingsPage({ searchParams }: GitlabSettingsPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('gitlab');

  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return (
      <GitSettingsShell provider="gitlab">
        <EmptyState title={t('noWorkspace.title')} description={t('noWorkspace.description')} />
      </GitSettingsShell>
    );
  }

  const connection = await gitlabConnectionService.getConnectionForWorkspace({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  const sp = await searchParams;
  const bannerStatus = sp.gitlab;
  const bannerTone = bannerStatus ? BANNER_TONE[bannerStatus] : undefined;

  return (
    <GitSettingsShell provider="gitlab">
      {bannerTone ? (
        <SettingsBanner tone={bannerTone} message={t(`banner.${bannerStatus}`)} />
      ) : null}

      {!connection ? (
        <NotConnectedPanel connectHref={OAUTH_START_PATH} />
      ) : (
        <ConnectedPanel connection={connection} />
      )}
    </GitSettingsShell>
  );
}

/** Panel 1 — the single-OAuth connect card. Two steps (Authorize + Projects), but
 *  ONE grant: GitLab's `api` scope conveys identity AND project access + webhook
 *  rights in the same authorization, so step 2 is the in-app SELECTION the single
 *  grant enables, not a second grant (the design's honest connect model). */
async function NotConnectedPanel({ connectHref }: { connectHref: string }) {
  const t = await getTranslations('gitlab.connect');
  const scopes = ['read_user', 'read_api', 'api'];
  return (
    <Card
      header={
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h2>
          <p className="font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-sans text-sm text-(--el-text-muted)">{t('foot')}</p>
          <a href={connectHref} className={buttonVariants({ variant: 'primary' })}>
            <GitlabMark className="h-4 w-4" aria-hidden />
            {t('cta')}
          </a>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <GrantRow
          icon={<KeyRound aria-hidden />}
          eyebrow={t('step1.eyebrow')}
          title={t('step1.title')}
          body={t('step1.body')}
          extra={
            <div className="mt-1 flex flex-wrap gap-1.5">
              {scopes.map((scope) => (
                <span
                  key={scope}
                  className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs text-(--el-code-text)"
                >
                  {scope}
                </span>
              ))}
            </div>
          }
        />
        <div role="separator" className="border-t border-(--el-border-soft)" />
        <GrantRow
          icon={<FolderGit2 aria-hidden />}
          eyebrow={t('step2.eyebrow')}
          title={t('step2.title')}
          body={t('step2.body')}
        />
      </div>
    </Card>
  );
}

/** Panel 2 — connected: the identity card + the project-selection list. */
async function ConnectedPanel({ connection }: { connection: GithubInstallationDTO }) {
  const t = await getTranslations('gitlab');
  const base = gitlabBaseUrl();
  const host = new URL(base).host;
  const profileUrl = `${base}/${connection.accountLogin}`;
  return (
    <div className="flex flex-col gap-6">
      <Card
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {t('identity.connectedTo', { host })}
            </p>
            <a
              href={profileUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t('identity.openGitlab')}
            </a>
          </div>
        }
      >
        <IdentityHeader
          login={connection.accountLogin}
          verified={t('identity.verified')}
          caption={t('identity.connectedAs', { name: connection.accountLogin })}
          trailing={<GitlabDisconnectButton />}
        />
      </Card>

      <Card
        header={
          <div className="flex flex-col gap-1">
            <SectionLabel label={t('projects.title')} />
            <p className="font-sans text-sm text-(--el-text-muted)">{t('projects.caption')}</p>
          </div>
        }
        footer={<p className="font-sans text-sm text-(--el-text-muted)">{t('projects.foot')}</p>}
      >
        <div className="flex flex-col gap-3">
          {connection.repos.length === 0 ? (
            <p className="font-sans text-sm text-(--el-text-muted)">{t('projects.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {connection.repos.map((repo) => (
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
                  <Pill severity="success">{t('projects.synced')}</Pill>
                  <GitlabProjectSyncSwitch
                    repoId={repo.repoId}
                    label={`${repo.owner}/${repo.name}`}
                  />
                </li>
              ))}
            </ul>
          )}
          <GitlabProjectPicker />
        </div>
      </Card>
    </div>
  );
}
