'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type {
  DispatchRunDetailDto,
  DispatchRunEventDto,
  DispatchRunStatus,
} from '@/lib/dto/dispatchRuns';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import {
  HOSTED_PHASES,
  hostedEndKind,
  readHostedPhases,
  stoppedInPhase,
  type HostedPhase,
  type HostedPhaseRead,
} from '@/lib/runs/hostedRun';

// THE HOSTED RUN'S PARTS the run section and the run modal both draw (Story
// MOTIR-683 · MOTIR-691; `design/runs/design-notes.md` § The hosted PHASES,
// § The END states) — one definition, so the two surfaces cannot disagree about
// how far a run got or why it ended.

/**
 * The run's DETAIL — its cost, its end and what each leg shipped — read for a
 * HOSTED run only. A local run never reaches this: it is billed nowhere Motir can
 * read, and its surfaces are unchanged.
 */
export function useHostedRunDetail(
  runId: string | null,
  refreshKey: number,
): DispatchRunDetailDto | null {
  const [detail, setDetail] = useState<{ id: string; dto: DispatchRunDetailDto } | null>(null);
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/dispatch-runs/${encodeURIComponent(runId)}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok || cancelled) return;
        const dto = (await res.json()) as DispatchRunDetailDto;
        if (!cancelled) setDetail({ id: runId, dto });
      } catch {
        // The last read stands; the timeline still follows the stream.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, refreshKey]);
  return detail && detail.id === runId ? detail.dto : null;
}

/** Every pull request the run's legs delivered — one per repository it changed. */
export function hostedPullRequests(detail: DispatchRunDetailDto | null): LinkedPullRequestDto[] {
  if (!detail) return [];
  const seen = new Map<string, LinkedPullRequestDto>();
  for (const card of detail.cards) {
    for (const d of card.deliveries) seen.set(d.pullRequest.url, d.pullRequest);
  }
  return [...seen.values()];
}

/** The repositories the run checked out, from its `checkout_ready` events. */
function checkedOut(events: readonly DispatchRunEventDto[]): string[] {
  const repos = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== 'checkout_ready' || !ev.data || typeof ev.data !== 'object') continue;
    const data = ev.data as { repositories?: unknown; branches?: unknown };
    if (Array.isArray(data.repositories)) {
      for (const r of data.repositories) if (typeof r === 'string') repos.add(r);
    }
    if (Array.isArray(data.branches)) {
      for (const b of data.branches) {
        const repo = (b as { repository?: unknown }).repository;
        if (typeof repo === 'string') repos.add(repo);
      }
    }
  }
  return [...repos];
}

export function hostedPhaseRead(
  events: readonly DispatchRunEventDto[],
  status: DispatchRunStatus,
  detail: DispatchRunDetailDto | null,
): HostedPhaseRead {
  return readHostedPhases({
    events,
    status,
    hasPullRequest: hostedPullRequests(detail).length > 0,
  });
}

/**
 * THE PHASE LIST — the decision's six, in the shipped timeline's row grammar: a
 * filled dot for done, the sky ring for now, an empty ring for pending, so the
 * list never resizes. A run that did not succeed marks the phase it stopped in —
 * danger for a failure, WARNING for one that ran out of time (unknown is not
 * failed, the tone table's rule).
 */
export function HostedPhaseList({
  events,
  status,
  detail,
  model,
}: {
  events: readonly DispatchRunEventDto[];
  status: DispatchRunStatus;
  detail: DispatchRunDetailDto | null;
  model: string | null;
}) {
  const t = useTranslations('runs.hosted');
  const read = hostedPhaseRead(events, status, detail);
  const stoppedAt = status !== 'running' && status !== 'succeeded' ? stoppedInPhase(read) : null;
  const repos = checkedOut(events);
  const prs = hostedPullRequests(detail);
  const exitCode = detail?.hostedEnd?.exitCode ?? null;

  const detailFor = (phase: HostedPhase): ReactNode => {
    if (phase === 'cloned' && repos.length > 0) return repos.join(' · ');
    if (phase === 'running' && model) return t('phaseDetail.running', { model });
    if (phase === 'finished' && exitCode !== null) return t('phaseDetail.exit', { code: exitCode });
    if (phase === 'pullRequest' && prs.length > 0) {
      return prs.map((pr, i) => (
        <span key={pr.url}>
          {i > 0 ? ' · ' : ''}
          <a className="text-(--el-link) underline" href={pr.url} target="_blank" rel="noreferrer">
            {`${pr.repo} #${pr.number}`}
          </a>
        </span>
      ));
    }
    return null;
  };

  return (
    <ol className="flex flex-col gap-1.5" aria-live="polite" data-testid="hosted-phases">
      {HOSTED_PHASES.map((phase) => {
        const done = read.reached.has(phase);
        const now = read.current === phase;
        const stopped = stoppedAt === phase;
        const dot = stopped
          ? status === 'timed_out'
            ? 'bg-(--el-warning)'
            : 'bg-(--el-danger)'
          : now
            ? 'border-2 border-(--el-status-in-progress) bg-(--el-tint-sky)'
            : done
              ? 'bg-(--el-status-done)'
              : 'border border-(--el-border-strong)';
        const extra = done || now ? detailFor(phase) : null;
        return (
          <li
            key={phase}
            className="flex items-center gap-2 font-sans text-sm"
            data-phase={phase}
            data-state={stopped ? 'stopped' : now ? 'now' : done ? 'done' : 'pending'}
          >
            <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
            <span className={done || now ? 'text-(--el-text)' : 'text-(--el-text-secondary)'}>
              {t(`phase.${phase}`)}
            </span>
            {extra ? (
              <span className="min-w-0 truncate font-mono text-xs text-(--el-text-secondary)">
                {extra}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The reason line a hosted run's end recorded — quoted, never reconstructed. */
export function hostedReasonLine(
  detail: DispatchRunDetailDto | null,
  t: ReturnType<typeof useTranslations>,
): string | null {
  const end = detail?.hostedEnd;
  if (!end) return null;
  if (end.detail) return end.detail;
  if (detail?.status === 'failed' && end.exitCode !== null && end.exitCode !== 0) {
    return t('exitReason', { code: end.exitCode });
  }
  return null;
}

/**
 * THE END — what the run did, under the pill. A success leads with every pull
 * request it opened; every other end says what happened, quotes the recorded
 * reason, and says the work item STAYS where it was (the run-dies decision: no
 * end but success moves a card).
 */
export function HostedEndBlock({ detail }: { detail: DispatchRunDetailDto }) {
  const t = useTranslations('runs.hosted');
  const kind = hostedEndKind(detail.status, detail.hostedEnd);
  if (!kind) return null;
  const prs = hostedPullRequests(detail);
  const reason = hostedReasonLine(detail, t);
  return (
    <div className="flex flex-col gap-1.5" data-testid="hosted-end" data-end={kind}>
      {prs.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {prs.map((pr) => (
            <li
              key={pr.url}
              className="rounded-(--radius-control) bg-(--el-tint-mint) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong)"
            >
              {t('prHeadline')}{' '}
              <a
                className="font-mono font-semibold text-(--el-link) underline"
                href={pr.url}
                target="_blank"
                rel="noreferrer"
              >
                {`${pr.repo} #${pr.number}`}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="font-sans text-sm text-(--el-text)">{t(`end.${kind}`)}</p>
      {reason ? (
        <p className="font-mono text-xs text-(--el-text-secondary)" data-testid="hosted-reason">
          {reason}
        </p>
      ) : null}
      {kind !== 'succeeded' ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('end.stays')}</p>
      ) : null}
    </div>
  );
}
