import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { GitBranch, Info } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { GithubMark } from '@/components/icons/GithubMark';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { GithubIdentityDTO } from '@/lib/dto/github';
import { DisconnectAccountButton } from './_components/DisconnectAccountButton';

// SETTINGS → ACCOUNT → GIT ACCOUNTS (Story MOTIR-4669 · MOTIR-4682), built to
// `design/settings/account-settings.mock.html` Panels 9–10.
//
// Every other card in this story moves something UP a tier — the repository and
// its connection go from the workspace to the ORGANISATION. This one moves
// something DOWN, and it is the piece most likely to be lost in the shuffle,
// because it is small and because it currently lives on the same page as the
// thing being moved up.
//
// `GithubIdentity` is `userId @unique`. It has never belonged to a workspace, and
// `projectSettingsNav.ts` already calls connecting it "the one action nobody can
// take on [a member's] behalf." It belongs beside tokens and passkeys.
//
// ⚠️ WHAT THIS PANE IS NOT: no repository list, no installation lifecycle. Those
// are the ORGANISATION's (MOTIR-4680). A pane here showing "repositories you can
// see" would re-introduce the exact tier confusion this story removes — and
// `tests/settings/accountGitAccounts.test.tsx` asserts their ABSENCE, so a later
// addition goes red rather than passing quietly.
//
// ⚠️ NO ADMIN GATE, AND THAT IS THE POINT OF IT. Every authenticated user reaches
// this pane, because the credential it manages is theirs. The registry entry
// carries no permission for the same reason (`accountSettingsNav.ts` records why
// that registry has no access axis at all).

const OAUTH_START_PATH = '/api/github/oauth/start?from=accountGit';

export default async function AccountGitAccountsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.gitAccounts');

  // TWO INDEPENDENT READS, and the independence is the page's subject. The
  // identity is the USER's (`withUserContext`, RLS-narrowed to their own row);
  // the installation is the ORGANISATION's, read only to answer state C below.
  // A workspace context is not required to render this pane — an account is
  // configured with no workspace selected — so the second read is skipped rather
  // than made a precondition.
  const ctx = await getWorkspaceContext();
  const [identity, installation] = await Promise.all([
    githubIdentityService.getIdentityForUser(session.user.id),
    ctx
      ? githubInstallationService.getWorkspaceInstallation({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      {identity ? (
        <ConnectedAccount
          identity={identity}
          hasInstallation={Boolean(installation)}
          copy={{
            host: t('host.github'),
            connected: t('state.connected'),
            connectedOn: t('connectedOn', {
              date: new Date(identity.createdAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              }),
            }),
            noInstallationTitle: t('noInstallation.title'),
            noInstallationBody: t('noInstallation.body'),
          }}
        />
      ) : (
        <Card>
          <EmptyState
            icon={<GitBranch aria-hidden />}
            title={t('empty.title')}
            description={t('empty.description')}
            action={
              <a href={OAUTH_START_PATH} className={buttonVariants({ variant: 'primary' })}>
                <GithubMark className="h-4 w-4" aria-hidden />
                {t('connect')}
              </a>
            }
          />
        </Card>
      )}
    </div>
  );
}

/** The connected row, plus state C's quiet note when it applies. */
function ConnectedAccount({
  identity,
  hasInstallation,
  copy,
}: {
  identity: GithubIdentityDTO;
  hasInstallation: boolean;
  copy: {
    host: string;
    connected: string;
    connectedOn: string;
    noInstallationTitle: string;
    noInstallationBody: string;
  };
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
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
                @{identity.githubLogin}
              </span>
              <Pill severity="success">{copy.connected}</Pill>
            </div>
            <span className="font-sans text-xs text-(--el-text-secondary)">
              {copy.host} · {copy.connectedOn}
            </span>
          </div>
          <DisconnectAccountButton />
        </div>
      </Card>

      {/* ⚠️ STATE C — connected, and the organisation has no installation. It is a
          COMPLETE, WORKING STATE, not an error and not a pending one: the two
          grants are INDEPENDENT, which the shipped connect page says in as many
          words. So it is drawn as a quiet fact on a neutral surface —
          - NOT a warning: nothing is wrong.
          - NOT a call to action: connecting the organisation is an ORG-ADMIN act,
            and a member sent to do it is sent to a door that will not open for
            them, which is worse than saying nothing.
          This is the arm an implementer would otherwise improvise as an error,
          which is why the design drew it and why the test asserts it BY NAME. */}
      {hasInstallation ? null : (
        <div className="flex gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding)">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-sans text-sm font-medium text-(--el-text)">
              {copy.noInstallationTitle}
            </p>
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {copy.noInstallationBody}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
