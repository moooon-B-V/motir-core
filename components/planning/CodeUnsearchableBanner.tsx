'use client';

import Link from 'next/link';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Pause } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { CodeUnsearchableRepoDto } from '@/lib/dto/planChange';

// THE "CODE CAN'T BE SEARCHED" BANNER (Story MOTIR-9165 · MOTIR-9170; design
// `plan-change-run-live--code-unsearchable.mock.html`, notes § The planning rail when the
// code cannot be searched). A planning phase that cannot search a TARGET repository's code
// stops instead of guessing; this is how the rail says which repository, why, where to go
// to fix it, and how to carry on.
//
// Information register, never the failure treatment: `--el-warning-*`, no `--el-danger-*`.
// The state is always worded for the reader — never the wire value.

const NS = 'planningWorkspace.codeUnsearchable';

export interface CodeUnsearchableBannerProps {
  repos: readonly CodeUnsearchableRepoDto[];
  /** `walk` — stopped mid-run (a resume control); `conversation` — stopped before any job
   *  opened (the person's next message is the retry, so no resume control). */
  where: 'walk' | 'conversation';
  /** Present only while a run is paused on this stop. */
  onResume?: (() => void) | undefined;
  resuming?: boolean;
  /** The pause the person last resumed was re-checked and one of its repositories is still
   *  blocked: the repository and the state it now shows, for the status line. */
  stillBlocked?: CodeUnsearchableRepoDto | null;
}

export function CodeUnsearchableBanner({
  repos,
  where,
  onResume,
  resuming = false,
  stillBlocked = null,
}: CodeUnsearchableBannerProps) {
  const t = useTranslations(NS);
  const tNav = useTranslations('shell');
  const titleId = useId();
  const rows = [...repos].sort((a, b) => a.repoRef.localeCompare(b.repoRef));
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-testid="code-unsearchable-banner"
      data-where={where}
      className="flex flex-col gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-warning-surface) p-(--spacing-card-padding-12) text-(--el-warning-text)"
    >
      <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
        <Pause className="size-3.5 shrink-0" aria-hidden="true" />
        {t('title')}
      </h3>
      <p className="text-[13px]">{t(where === 'walk' ? 'introWalk' : 'introConversation')}</p>
      <ul
        aria-label={t('listLabel')}
        className="flex flex-col gap-1.5"
        data-testid="code-unsearchable-repos"
      >
        {rows.map((r) => (
          <li
            key={r.repoRef}
            data-testid="code-unsearchable-row"
            data-repo={r.repoRef}
            data-state={r.state}
            className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-control-y)"
          >
            <span className="font-mono text-[13px] break-all text-(--el-text-strong)">
              {r.repoRef}
            </span>
            <span className="justify-self-end rounded-(--radius-badge) bg-(--el-tint-peach) px-(--spacing-chip-x) py-(--spacing-chip-y) text-right text-xs font-semibold text-(--el-text-strong)">
              {t(`states.${r.state}.chip`)}
            </span>
            <span className="col-span-2 text-xs text-(--el-text-secondary)">
              {t(`states.${r.state}.line`)}
            </span>
          </li>
        ))}
      </ul>
      {stillBlocked ? (
        <p
          role="status"
          data-testid="code-unsearchable-checked"
          className="border-t border-(--el-border) pt-2 text-[13px]"
        >
          {t('stillBlocked', {
            repo: stillBlocked.repoRef,
            state: t(`states.${stillBlocked.state}.chip`),
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onResume ? (
          <Button
            variant="primary"
            size="sm"
            disabled={resuming}
            onClick={onResume}
            data-testid="code-unsearchable-resume"
          >
            {t('resume')}
          </Button>
        ) : null}
        <Link
          href="/code"
          data-testid="code-unsearchable-codebase"
          className="inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) border border-(--el-button-border) bg-(--el-card) px-(--spacing-control-x) text-[13px] font-semibold text-(--el-link) hover:text-(--el-link-pressed) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring-color)"
        >
          {tNav('commandPalette.goToCode')}
        </Link>
      </div>
    </section>
  );
}
