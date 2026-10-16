'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Building2,
  Check,
  ChevronRight,
  CloudOff,
  ExternalLink,
  Info,
  Plus,
  UserRound,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { GithubMark } from '@/components/icons/GithubMark';
import { WARM_CTA, WarmButton as Button } from '@/components/onboarding/layout';
import { cn } from '@/lib/utils/cn';
import type { MigrateConnectExistingAccountDto } from '@/lib/dto/migrateOnboarding';
import type { InstalledAccountsState } from './useInstalledAccounts';

// THE CONNECT STEP'S ALREADY-INSTALLED ACCOUNTS (Story MOTIR-8245 · MOTIR-8762),
// built on `design/onboarding-migrate/` Revision 8 and its delta mock
// `onboarding-migrate--installed-accounts.mock.html`, panels 2l–2o, 2s.vii, 2t.
//
// PRESENTATIONAL. The accounts read is `useInstalledAccounts`; this file renders
// its answer and calls back. It owns the step's INSTALL CONTROL whenever it
// renders at all — the dashed _Install on another account_ row replaces the
// pre-flight's lone Connect GitHub (behaviour 2) — so the panel drops its own.
//
// NOTHING NEW ON AN EMPTY LIST. An `ok` answer with no account, and an identity
// prompt the person skipped, render nothing: the step is the shipped pre-flight
// (2n, and behaviour 3), which `existingAccountsShown` says to the panel.

/** The sign-in that returns to THIS step (`GITHUB_RETURN_SURFACES`). */
export const IDENTITY_START_HREF = '/api/github/oauth/start?from=onboardingMigrateConnect';

/** Whether the block renders at all — and so whether it owns the install control. */
export function existingAccountsShown(
  state: InstalledAccountsState,
  identitySkipped: boolean,
): boolean {
  if (state.kind === 'ok') return state.accounts.length > 0;
  if (state.kind === 'identity_required') return !identitySkipped;
  return true;
}

export interface ExistingAccountsProps {
  state: InstalledAccountsState;
  identitySkipped: boolean;
  /** The sign-in came back refused or unfinished (`?github=denied|state_error|error`). */
  identityDeclined: boolean;
  onSkipIdentity: () => void;
  onRetry: () => void;
  /** A row's pick — the repository picker is behind this seam (MOTIR-8763). */
  onPickAccount: (installationRef: string) => void;
  /** The step's own install press (`send`). */
  onInstall: () => void;
}

export function ExistingAccounts({
  state,
  identitySkipped,
  identityDeclined,
  onSkipIdentity,
  onRetry,
  onPickAccount,
  onInstall,
}: ExistingAccountsProps) {
  const t = useTranslations('onboardingMigrate.connect');
  const tPicker = useTranslations('github.picker');
  if (!existingAccountsShown(state, identitySkipped)) return null;

  const installRow = <InstallRow onInstall={onInstall} />;

  switch (state.kind) {
    case 'loading':
      return (
        <div data-testid="existing-accounts-loading" className="grid gap-3" aria-busy="true">
          <p
            role="status"
            className="m-0 flex items-center gap-2.5 text-sm text-(--el-text-secondary)"
          >
            <span aria-hidden className="flex-none text-(--el-highlight)">
              <Spinner size="sm" />
            </span>
            {t('existing.loading')}
          </p>
          <div aria-hidden className="grid gap-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="flex min-h-(--height-control) items-center gap-3 px-(--spacing-control-x)"
              >
                <span className="size-8 flex-none rounded-full bg-(--el-muted)" />
                <span className="h-3 w-40 rounded-(--radius-control) bg-(--el-muted)" />
              </div>
            ))}
          </div>
          {installRow}
        </div>
      );

    case 'failed':
      return (
        <div data-testid="existing-accounts-failed" className="grid gap-3">
          <Head
            glyph={<CloudOff className="size-4" />}
            title={t('existing.loadErrorTitle')}
            hint={t('existing.loadErrorHint')}
            status
          />
          <span>
            <Button
              variant="secondary"
              size="md"
              onClick={onRetry}
              data-testid="existing-accounts-retry"
            >
              {t('existing.retryCta')}
            </Button>
          </span>
          {installRow}
        </div>
      );

    case 'not_admin':
      return (
        <div data-testid="existing-accounts-not-admin" className="grid gap-3">
          <Notice
            title={t('existing.outcome.notAdminTitle')}
            hint={t('existing.outcome.notAdminHint')}
          />
          {installRow}
        </div>
      );

    case 'identity_required':
      return (
        <div data-testid="existing-accounts-identity" className="grid gap-3">
          <IdentityPrompt declined={identityDeclined} onSkip={onSkipIdentity} />
          {installRow}
        </div>
      );

    case 'ok':
      return (
        <div data-testid="existing-accounts" className="grid gap-3">
          <Head
            glyph={<Building2 className="size-4" />}
            title={t('existing.title')}
            hint={t('existing.hint')}
          />
          <ul aria-label={tPicker('accountsLabel')} className="m-0 grid list-none gap-1 p-0">
            {state.accounts.map((account) => (
              <li key={account.installationId}>
                <AccountRow
                  account={account}
                  onPick={() => onPickAccount(account.installationId)}
                />
              </li>
            ))}
            <li>{installRow}</li>
          </ul>
        </div>
      );
  }
}

function Head({
  glyph,
  title,
  hint,
  status,
}: {
  glyph: ReactNode;
  title: string;
  hint: string;
  status?: boolean;
}) {
  return (
    <div role={status ? 'status' : undefined} className="grid gap-1">
      <p className="m-0 flex items-center gap-2.5 text-sm font-semibold text-(--el-text)">
        <span aria-hidden className="flex flex-none text-(--el-text-secondary)">
          {glyph}
        </span>
        {title}
      </p>
      <p className="m-0 max-w-[60ch] text-sm leading-normal text-(--el-text-secondary)">{hint}</p>
    </div>
  );
}

/** A benign outcome: `Info` + a title and a hint on the sky tint (never danger). */
function Notice({ title, hint }: { title: string; hint?: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-(--radius-control) bg-(--el-tint-sky) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
    >
      <Info className="mt-0.5 size-4 flex-none" aria-hidden />
      <span className="grid gap-0.5">
        <span className={hint ? 'font-semibold' : undefined}>{title}</span>
        {hint ? <span className="leading-normal">{hint}</span> : null}
      </span>
    </div>
  );
}

function IdentityPrompt({ declined, onSkip }: { declined: boolean; onSkip: () => void }) {
  const t = useTranslations('onboardingMigrate.connect');
  // The sign-in leaves this tab; until it does, the primary says so (2o.ii).
  const [leaving, setLeaving] = useState(false);
  return (
    <div
      data-testid="existing-accounts-identity-prompt"
      className="grid gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding)"
    >
      <div className="grid gap-1">
        <p className="m-0 flex items-center gap-2.5 text-sm font-semibold text-(--el-text)">
          <UserRound className="size-4 flex-none text-(--el-text-secondary)" aria-hidden />
          {t('existing.identity.title')}
        </p>
        <p className="m-0 max-w-[60ch] text-sm leading-normal text-(--el-text-secondary)">
          {t('existing.identity.hint')}
        </p>
      </div>
      {declined ? <Notice title={t('existing.identity.declinedHint')} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={IDENTITY_START_HREF}
          onClick={() => setLeaving(true)}
          aria-busy={leaving || undefined}
          data-testid="existing-accounts-sign-in"
          className={cn(
            buttonVariants({ variant: 'primary', size: 'md' }),
            'w-fit gap-2',
            WARM_CTA,
          )}
        >
          {leaving ? (
            <span aria-hidden className="flex">
              <Spinner size="sm" />
            </span>
          ) : (
            <GithubMark className="size-4" aria-hidden />
          )}
          <span>{leaving ? t('starting') : t('existing.identity.cta')}</span>
        </a>
        <button
          type="button"
          onClick={onSkip}
          data-testid="existing-accounts-skip"
          className="rounded-(--radius-control) text-sm text-(--el-text-secondary) underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent-on-surface)"
        >
          {t('existing.identity.skipCta')}
        </button>
      </div>
    </div>
  );
}

function AccountRow({
  account,
  onPick,
}: {
  account: MigrateConnectExistingAccountDto;
  onPick: () => void;
}) {
  const t = useTranslations('onboardingMigrate.connect');
  const tPicker = useTranslations('github.picker');
  const organization = account.accountType.toLowerCase() === 'organization';
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={t('existing.pickAria', { login: account.accountLogin })}
      data-testid="existing-account-row"
      data-installation-id={account.installationId}
      className="flex min-h-(--height-control) w-full flex-wrap items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left hover:bg-(--el-option-active-bg) focus-visible:bg-(--el-option-active-bg) focus-visible:outline-none"
    >
      {account.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a GitHub avatar URL, not a static asset
        <img src={account.avatarUrl} alt="" className="size-8 flex-none rounded-full" />
      ) : (
        <span
          aria-hidden
          className="inline-flex size-8 flex-none items-center justify-center rounded-full bg-(--el-avatar-fallback) text-sm font-semibold text-(--el-text-inverted)"
        >
          {(account.accountLogin.trim()[0] ?? '?').toUpperCase()}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-(--el-text)">
          {account.accountLogin}
        </span>
        <Pill tone="neutral">
          {organization ? (
            <Building2 className="size-3.5 flex-none" aria-hidden />
          ) : (
            <UserRound className="size-3.5 flex-none" aria-hidden />
          )}
          {organization ? t('existing.typeOrg') : t('existing.typeUser')}
        </Pill>
        {account.linkState === 'linked_here' ? (
          <Pill severity="success" data-testid="existing-account-linked">
            <Check className="size-3.5 flex-none" aria-hidden />
            {t('existing.linkedHere')}
          </Pill>
        ) : (
          <Pill tone="neutral">{tPicker('notLinked')}</Pill>
        )}
      </span>
      <span className="inline-flex items-center gap-1 text-sm font-medium text-(--el-link)">
        {t('existing.pickCta')}
        <ChevronRight className="size-4 flex-none" aria-hidden />
      </span>
    </button>
  );
}

/** Settings' dashed install row (MOTIR-8223), pressing the step's own install. */
export function InstallRow({ onInstall }: { onInstall: () => void }) {
  const t = useTranslations('onboardingMigrate.connect');
  return (
    <button
      type="button"
      onClick={onInstall}
      data-testid="connect-start"
      className="flex min-h-(--height-control) w-full items-center gap-3 rounded-(--radius-control) border border-dashed border-(--el-button-border) px-(--spacing-control-x) py-(--spacing-control-y) text-left hover:bg-(--el-option-active-bg)"
    >
      <span
        aria-hidden
        className="inline-flex size-8 flex-none items-center justify-center rounded-full bg-(--el-card-icon-bg) text-(--el-card-icon-fg)"
      >
        <Plus className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-(--el-text)">
          {t('existing.installAnotherCta')}
        </span>
        <span className="text-xs text-(--el-text-secondary)">
          {t('existing.installAnotherHint')}
        </span>
      </span>
      <ExternalLink className="size-4 flex-none text-(--el-icon-muted)" aria-hidden />
      <span className="sr-only"> {t('newTab')}</span>
    </button>
  );
}
