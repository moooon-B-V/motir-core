import { ExternalLink, FolderGit2, KeyRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { GitlabMark } from '@/components/icons/GitlabMark';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { gitlabBaseUrl } from '@/lib/gitlab/gitlabOAuth';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import type { GithubInstallationDTO } from '@/lib/dto/github';
import { GrantRow, IdentityHeader } from '../../../workspace/_components/gitSettingsPrimitives';
import { GitlabDisconnectButton } from './GitlabDisconnectButton';
import { GitlabProjectSyncSwitch } from './GitlabProjectSyncSwitch';
import { GitlabProjectPicker } from './GitlabProjectPicker';

// THE GITLAB CONNECTION, AT THE TIER THAT OWNS IT (Story 7.23 · MOTIR-1478,
// moved by MOTIR-4669 · MOTIR-4680) — `design/gitlab/gitlab.mock.html` Panels
// 1 / 2 / 2b, which draw this surface inside the ORGANISATION settings rail.
//
// ⚠️ THIS IS THE HALF THE TIER MOVE DROPPED, and CI is what said so. MOTIR-4680
// deleted `/settings/workspace/gitlab` and pointed its permanent redirect at
// `/settings/organization/git`, whose body rendered the GitHub arm only. The
// provider Segmented still offered a `gitlab` tab, so the surface LOOKED present
// and answered every GitLab question with GitHub's card: a workspace that had not
// connected GitLab had no way left to do it, in a product that advertises the
// provider on its pricing page. `tests/e2e/gitlab.spec.ts` failed on the missing
// heading, which is exactly the job of a walk that starts at a URL.
//
// GitLab's connect model genuinely differs from GitHub's and the panels keep that
// difference rather than flattening it: ONE OAuth authorization conveys identity
// AND project access (there is no App to install), and project selection is
// IN-APP — the `api` scope lets Motir enumerate and connect projects here (Panel
// 2b) rather than on a screen of GitLab's. The connection is WORKSPACE-scoped and
// reuses `GithubInstallation` under `provider: 'gitlab'` (MOTIR-1474).

const OAUTH_START_PATH = '/api/gitlab/oauth/start';

/** The connection read, and the panel it chooses between. */
export async function GitlabConnection({
  userId,
  workspaceId,
}: {
  userId: string;
  workspaceId: string;
}) {
  const connection = await gitlabConnectionService.getConnectionForWorkspace({
    userId,
    workspaceId,
  });
  return !connection ? (
    <NotConnectedPanel connectHref={OAUTH_START_PATH} />
  ) : (
    <ConnectedPanel connection={connection} />
  );
}

/** Panel 1 — the single-OAuth connect card. Two steps (Authorize + Projects), but
 *  ONE grant: GitLab's `api` scope conveys identity AND project access + webhook
 *  rights in the same authorization, so step 2 is the in-app SELECTION that grant
 *  enables, not a second grant (the design's honest connect model). */
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
