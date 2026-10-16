'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertCircle, Check, CheckCircle2, FileCode2, RotateCcw, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { BAR_SECONDARY_HOVER } from '@/components/onboarding/layout';
import { GithubMark } from '@/components/icons/GithubMark';
import { cn } from '@/lib/utils/cn';
import type {
  MigrateIndexRepoDto,
  MigrateIndexRepoStatusDto,
  MigrateIndexStatusDto,
  MigrateLatestImportDto,
} from '@/lib/dto/migrateOnboarding';
import { repoName, summariseIndex, type IndexSummary } from './indexSummary';

// The onboarding bar's indexing indicator (Story MOTIR-8246 · MOTIR-8771) —
// `design/onboarding-migrate/index-nonblocking--delta.mock.html` panels A–E, J,
// K as amended by `index-nonblocking--enter-motir.mock.html` panel C. A chip
// that names the repository and one state, opening a detail with one row per
// repository, a retry for a failed one, and the running work-items import.
// Opening or closing it never touches the run's step.
//
// It reads the status the wizard already polls (one read for the whole page)
// and owns only the retry and its own open / done-fade state.

/** How long the chip says "done" before it leaves the bar. */
export const INDEX_DONE_LINGER_MS = 4000;

const IMPORT_SOURCE_NAME: Record<MigrateLatestImportDto['source'], string> = {
  jira: 'Jira',
  linear: 'Linear',
  github: 'GitHub',
  plane: 'Plane',
  csv: 'CSV',
};

type RetryRefusal = 'notConnected' | 'tooLarge' | 'generic';

interface RowRetry {
  busy: boolean;
  refusal: RetryRefusal | null;
}

export interface IndexIndicatorProps {
  runId: string;
  status: MigrateIndexStatusDto | null;
  latestImport: MigrateLatestImportDto | null;
  /** Re-read the status at once (after a retry was accepted). */
  onRetried: () => void;
}

export function IndexIndicator({ runId, status, latestImport, onRetried }: IndexIndicatorProps) {
  const t = useTranslations('onboardingMigrate');
  const tw = useTranslations('planningWorkspace.indexing');
  const [open, setOpen] = useState(false);
  // A retry the server accepted reads `queued` at once — until the next read,
  // which is the read the retry is recorded against.
  const [requeued, setRequeued] = useState<Record<string, MigrateIndexStatusDto | null>>({});
  const [retry, setRetry] = useState<Record<string, RowRetry>>({});

  const isRequeued = (repoRef: string) => repoRef in requeued && requeued[repoRef] === status;
  const view: MigrateIndexStatusDto | null = status
    ? {
        ...status,
        repos: status.repos.map((r) =>
          r.status === 'failed' && isRequeued(r.repoRef) ? { ...r, status: 'queued' } : r,
        ),
        failedCount: status.repos.filter((r) => r.status === 'failed' && !isRequeued(r.repoRef))
          .length,
      }
    : null;

  const summary = summariseIndex(view);
  const importRunning = latestImport?.status === 'running';

  // DONE, THEN GONE: shown on the first read that says so, only when this
  // indicator saw the index unfinished; never drawn on a run that mounts on an
  // already-indexed project. (State adjusted during render, React's pattern
  // for state derived from a changing input.)
  const allDone = summary?.state === 'done';
  const [sawUnfinished, setSawUnfinished] = useState(false);
  const [doneExpired, setDoneExpired] = useState(false);
  if (summary && !allDone && !sawUnfinished) setSawUnfinished(true);
  if (!allDone && doneExpired) setDoneExpired(false);
  useEffect(() => {
    if (!allDone) return;
    const timer = window.setTimeout(() => setDoneExpired(true), INDEX_DONE_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [allDone]);

  const retryRepo = async (repoRef: string) => {
    if (retry[repoRef]?.busy) return;
    setRetry((r) => ({ ...r, [repoRef]: { busy: true, refusal: null } }));
    let refusal: RetryRefusal | null = null;
    try {
      const res = await fetch(`/api/onboarding/migrate/${runId}/index-retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoRef }),
      });
      if (res.ok) {
        const body = (await res.json()) as { status: MigrateIndexRepoStatusDto };
        if (body.status === 'queued') setRequeued((q) => ({ ...q, [repoRef]: status }));
        onRetried();
      } else if (res.status === 409) refusal = 'notConnected';
      else if (res.status === 422) refusal = 'tooLarge';
      else refusal = 'generic';
    } catch {
      refusal = 'generic';
    }
    setRetry((r) => ({ ...r, [repoRef]: { busy: false, refusal } }));
  };

  if (!summary) return null;
  if (allDone && !importRunning && (!sawUnfinished || doneExpired)) return null;

  const label = chipLabel(summary, t, tw);
  const failed = summary.state === 'failed';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="migrate-index-indicator"
          data-state-summary={summary.state}
          aria-controls="migrate-index-detail"
          className={cn(
            buttonVariants({ variant: 'secondary', size: 'sm' }),
            'max-w-[22rem] gap-1.5',
            BAR_SECONDARY_HOVER,
            open && 'bg-(--el-surface)',
            failed && 'border-(--el-danger-on-surface)',
          )}
        >
          <span className="relative inline-flex sm:hidden" aria-hidden>
            <FileCode2 className="size-4 text-(--el-text)" />
            <span
              className={cn(
                'absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-(--el-page-bg)',
                STATE_DOT[summary.state],
              )}
            />
          </span>
          <span className="hidden flex-none sm:inline-flex" aria-hidden>
            <StateGlyph state={summary.state} />
          </span>
          <span aria-live="polite" className="sr-only min-w-0 truncate sm:not-sr-only">
            <span className="text-(--el-text)">{label.title}</span>
            {label.tail ? (
              <span
                className={failed ? 'text-(--el-danger-on-surface)' : 'text-(--el-text-secondary)'}
              >
                {' · '}
                {label.tail}
              </span>
            ) : null}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Content
        id="migrate-index-detail"
        align="end"
        width="min(24rem, calc(100vw - 2rem))"
        collisionPadding={16}
        aria-label={t('index.heading')}
        data-testid="migrate-index-detail"
        className="p-(--spacing-card-padding)"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="m-0 text-sm font-semibold text-(--el-text)">{t('index.heading')}</p>
          <Popover.Close asChild>
            <Button variant="ghost" size="sm" aria-label={t('indexing.close')}>
              <X className="size-4" aria-hidden />
            </Button>
          </Popover.Close>
        </div>
        <p className="m-0 mt-1 text-xs text-(--el-text-secondary)">{t('indexing.detailBody')}</p>
        {summary.total > 1 ? (
          <p className="m-0 mt-2 text-xs text-(--el-text-secondary)">
            {t('index.aggregate', { done: summary.indexedCount, total: summary.total })}
          </p>
        ) : null}

        <p className="mt-4 mb-2 text-[0.7rem] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
          {t('index.perRepo')}
        </p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {view!.repos.map((repo) => (
            <RepoRow
              key={repo.repoRef}
              repo={repo}
              retry={retry[repo.repoRef]}
              onRetry={() => void retryRepo(repo.repoRef)}
            />
          ))}
        </ul>

        {importRunning && latestImport ? (
          <>
            <p className="mt-4 mb-2 text-[0.7rem] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
              {t('indexing.importHeading')}
            </p>
            <div
              data-testid="migrate-index-detail-import"
              className="flex items-center gap-3 rounded-(--radius-control) border border-(--el-border-soft) px-(--spacing-control-x) py-2.5"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-(--el-text)">
                {IMPORT_SOURCE_NAME[latestImport.source] ?? latestImport.source}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
                <Dots pulsing />
                {t('indexing.importProgress', { done: latestImport.processedCount })}
              </span>
            </div>
          </>
        ) : null}
      </Popover.Content>
    </Popover>
  );
}

type T = ReturnType<typeof useTranslations<'onboardingMigrate'>>;
type TW = ReturnType<typeof useTranslations<'planningWorkspace.indexing'>>;

function chipLabel(s: IndexSummary, t: T, tw: TW): { title: string; tail: string | null } {
  if (s.total <= 1) {
    const repos = repoName(s.repoRef);
    switch (s.state) {
      case 'failed':
        return { title: tw('failedTitle', { repos }), tail: null };
      case 'done':
        return { title: t('indexing.doneTitle', { repos }), tail: null };
      case 'indexing':
        return { title: tw('title', { repos }), tail: tw('chipRunning') };
      case 'queued':
        return { title: tw('title', { repos }), tail: tw('chipQueued') };
    }
  }
  const repos = t('indexing.repoCount', { count: s.total });
  if (s.state === 'done') return { title: t('indexing.doneTitle', { repos }), tail: null };
  if (s.state === 'failed') {
    return {
      title: tw('title', { repos }),
      tail: t('indexing.failedTail', { count: s.failedCount }),
    };
  }
  return {
    title: tw('title', { repos }),
    tail: t('indexing.aggregateTail', { done: s.indexedCount, total: s.total }),
  };
}

const STATE_DOT: Record<IndexSummary['state'], string> = {
  queued: 'bg-(--el-text-secondary)',
  indexing: 'bg-(--el-accent-on-surface)',
  done: 'bg-(--el-success)',
  failed: 'bg-(--el-danger-on-surface)',
};

function StateGlyph({ state }: { state: IndexSummary['state'] }) {
  switch (state) {
    case 'failed':
      return <AlertCircle className="size-3.5 text-(--el-danger-on-surface)" />;
    case 'done':
      return <CheckCircle2 className="size-3.5 text-(--el-success)" />;
    case 'indexing':
      return <Dots pulsing />;
    case 'queued':
      return <Dots />;
  }
}

/** The plan window's three-dot cue: pulsing while work runs, still when queued. */
function Dots({ pulsing = false }: { pulsing?: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            'size-[5px] rounded-full',
            pulsing
              ? 'animate-pulse bg-(--el-accent-on-surface) motion-reduce:animate-none'
              : 'bg-(--el-text-secondary)',
          )}
          style={pulsing ? { animationDelay: `${i * 150}ms` } : undefined}
        />
      ))}
    </span>
  );
}

/** The row chip's look, total over the four states. An unknown value renders raw. */
const ROW_STATE: Record<MigrateIndexRepoStatusDto, { key: string; className: string }> = {
  indexed: { key: 'indexed', className: 'bg-(--el-tint-mint) text-(--el-text-strong)' },
  indexing: { key: 'indexing', className: 'bg-(--el-tint-sky) text-(--el-text-strong)' },
  queued: { key: 'queued', className: 'bg-(--el-muted) text-(--el-text-secondary)' },
  failed: {
    key: 'failed',
    className: 'bg-(--el-danger-surface) text-(--el-danger-on-surface)',
  },
};

const REFUSAL_KEY: Record<RetryRefusal, string> = {
  notConnected: 'indexing.refusedNotConnected',
  tooLarge: 'indexing.refusedTooLarge',
  generic: 'indexing.retryError',
};

function RepoRow({
  repo,
  retry,
  onRetry,
}: {
  repo: MigrateIndexRepoDto;
  retry: RowRetry | undefined;
  onRetry: () => void;
}) {
  const t = useTranslations('onboardingMigrate');
  const tw = useTranslations('planningWorkspace.indexing');
  const look = ROW_STATE[repo.status];
  const [owner, ...rest] = repo.repoRef.split('/');
  const name = rest.join('/') || repo.repoRef;
  const failed = repo.status === 'failed';

  return (
    <li
      data-testid="migrate-index-detail-repo"
      data-repo-ref={repo.repoRef}
      data-status={repo.status}
      className={cn(
        'rounded-(--radius-control) border px-(--spacing-control-x) py-2.5',
        failed ? 'border-(--el-danger-on-surface)' : 'border-(--el-border-soft)',
      )}
    >
      <div className="flex items-center gap-3">
        <GithubMark className="size-4 flex-none text-(--el-text-secondary)" aria-hidden />
        <span className="sr-only">GitHub</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-text)">
          <span className="text-(--el-text-secondary)">{owner}/</span>
          {name}
        </span>
        <span
          className={cn(
            'inline-flex flex-none items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold',
            look?.className ?? 'bg-(--el-muted) text-(--el-text-secondary)',
          )}
        >
          {repo.status === 'indexed' ? (
            <Check className="size-3" strokeWidth={3} aria-hidden />
          ) : null}
          {repo.status === 'indexing' ? <Dots pulsing /> : null}
          {look ? t(`index.state.${look.key}` as 'index.state.indexed') : repo.status}
        </span>
      </div>
      {failed ? (
        <div className="mt-2">
          <p className="m-0 text-xs text-(--el-text-secondary)">{t('indexing.rowFailed')}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              loading={retry?.busy ?? false}
              leftIcon={<RotateCcw className="size-3.5" />}
            >
              {retry?.busy ? t('indexing.retrying') : tw('retry')}
            </Button>
            <Link
              href="/settings/organization/git"
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              {t('indexing.checkConnection')}
            </Link>
          </div>
          {retry?.refusal ? (
            <p
              role="alert"
              className="m-0 mt-2 flex items-start gap-1.5 text-xs text-(--el-danger-on-surface)"
            >
              <AlertCircle className="mt-px size-3.5 flex-none" aria-hidden />
              {t(REFUSAL_KEY[retry.refusal] as 'indexing.retryError')}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
