'use client';

import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { GithubMark } from '@/components/icons/GithubMark';
import {
  accountInitial,
  accountTypeKey,
  type GithubAccountRef,
  type LinkedGithubAccount,
} from './githubAccounts';

// THE ORGANISATION'S GITHUB ACCOUNTS (Story MOTIR-8216 · MOTIR-8223), built to
// `design/github/github--multi-org-account.mock.html` Panels A6a and A6b.
//
// ⚠️ SINGULAR → PLURAL, AND N = 1 IS NOT A SPECIAL CASE. The card was one row
// for THE installation, with one `Manage on GitHub` that could only be drawn
// when there was exactly one (`soleInstallation`). It is now one row per
// linked account, drawn identically for one and for two, and each row carries
// its OWN three actions — the manage link is that row's installation, so it is
// drawable for every N.
//
// ⚠️ IT IS PROPS ALL THE WAY DOWN. The page reads the accounts on the server and
// this list holds no copy of them, so the `router.refresh()` after a link or a
// disconnect is what redraws it — the page-state contract's server case.

export interface GitAccountListProps {
  accounts: LinkedGithubAccount[];
  organizationName: string;
  onConnect: () => void;
  onAddOrRemove: (account: GithubAccountRef) => void;
  onDisconnect: (account: GithubAccountRef) => void;
}

export function GitAccountList({
  accounts,
  organizationName,
  onConnect,
  onAddOrRemove,
  onDisconnect,
}: GitAccountListProps) {
  const t = useTranslations('github.accounts');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('title')}</h2>
          <p className="font-sans text-sm text-(--el-text-secondary)">
            {t('subtitle', { org: organizationName })}
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onConnect}>
          <GithubMark className="h-3.5 w-3.5" aria-hidden />
          {t('connect')}
        </Button>
      </div>
      <ul aria-label={t('title')} className="flex flex-col">
        {accounts.map((account) => (
          <li
            key={account.installationId}
            className="flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) py-3"
          >
            <span
              aria-hidden
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-avatar-fallback) font-sans text-sm font-semibold text-(--el-text-inverted)"
            >
              {accountInitial(account.accountLogin)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate font-sans text-sm font-semibold text-(--el-text)">
                  {account.accountLogin}
                </span>
                <Pill severity="success">{t('linked')}</Pill>
              </span>
              <span className="font-sans text-xs text-(--el-text-secondary)">
                {t('meta', {
                  type: t(`type.${accountTypeKey(account.accountType)}`),
                  count: account.repoCount,
                })}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onAddOrRemove(account)}
              >
                {t('addOrRemove')}
              </Button>
              <a
                href={account.manageUrl}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                {t('manageOnGithub')}
              </a>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDisconnect(account)}
                className="border border-(--el-border) text-(--el-danger-on-surface) hover:bg-(--el-danger-surface)"
              >
                {t('disconnect')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
