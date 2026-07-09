'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils/cn';
import { Footer } from './ConnectStep';
import {
  runImport,
  ImportApiError,
  type ConnectionConfig,
  type ImportPlan,
  type Mapping,
  type RunProgress,
} from './importClient';

type RunPhase = 'running' | 'done' | 'error';
interface RunCounts {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}
const ZERO: RunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
const LOG_WINDOW = 40;

/**
 * The import RUN step — streams the NDJSON progress from the run route into a
 * live `aria-live` counts region (design Panel 4). `phase` starts as `running`
 * so the streaming effect never performs a synchronous `setState` in its body
 * (every update lands in a post-`await` stream callback — the set-state-in-effect
 * lint rule + deterministic-signal discipline). Terminal states: complete /
 * partial-failure / failed, each offering the right next action.
 */
export function RunStep({
  importId,
  connection,
  mapping,
  project,
  confirmCount,
}: {
  importId: string;
  connection: ConnectionConfig;
  mapping: Mapping;
  project: { id: string; name: string };
  confirmCount: number;
}) {
  const t = useTranslations('import');

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<RunPhase>('running');
  const [counts, setCounts] = useState<RunCounts>(ZERO);
  const [finalStatus, setFinalStatus] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [log, setLog] = useState<RunProgress[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;

    void runImport(
      importId,
      mapping,
      connection,
      (event) => {
        if (cancelled) return;
        if (event.type === 'summary') {
          setCounts(event.counts);
          setFinalStatus(event.status);
          setPhase('done');
        } else {
          setLog((prev) => [...prev, event].slice(-LOG_WINDOW));
          setCounts((prev) => tally(prev, event.plan, Boolean(event.error)));
        }
      },
      controller.signal,
    ).catch((err) => {
      if (cancelled || controller.signal.aborted) return;
      setErrorCode(err instanceof ImportApiError ? err.code : 'UNKNOWN');
      setPhase('error');
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Re-runs on `attempt` bump (retry); the import id/mapping/connection are
    // fixed for the life of this step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const total = confirmCount;
  const done = counts.created + counts.updated;
  // Full navigation (not next/Link) so the destination re-reads server-side and
  // never serves a stale Router-Cache payload after the import write (notes #134).
  const issuesHref = '/backlog';

  function retry() {
    setPhase('running');
    setCounts(ZERO);
    setFinalStatus(null);
    setErrorCode(null);
    setLog([]);
    setAttempt((a) => a + 1);
  }

  // Counts region — always present, aria-live so the advancing totals are heard.
  const countsRegion = (
    <p role="status" aria-live="polite" className="text-sm text-(--el-text)">
      {t('run.counts', { created: counts.created, updated: counts.updated, failed: counts.failed })}
    </p>
  );

  if (phase === 'running') {
    return (
      <section className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-4 rounded-(--radius-card) border border-(--el-border) p-8 text-center">
          <Spinner size="lg" />
          <p className="text-base font-medium text-(--el-text-strong)">
            {t('run.importing', { ref: project.name })}
          </p>
          <p className="text-sm text-(--el-text-muted) tabular-nums">
            {t('run.progress', { done, total: total || done })}
          </p>
          <ProgressBar value={done} total={total || Math.max(done, 1)} />
          {countsRegion}
          <p className="text-xs text-(--el-text-tertiary)">{t('run.runningNote')}</p>
        </div>
        <LiveLog log={log} label={t('run.logLabel')} />
        <Footer>
          <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
            {t('run.stop')}
          </Button>
          <span />
        </Footer>
      </section>
    );
  }

  if (phase === 'error') {
    return (
      <TerminalState
        icon={<XCircle className="size-6 text-(--el-danger)" />}
        tint="bg-(--el-tint-rose)"
        title={t('run.failedTitle')}
        body={
          errorCode === 'IMPORT_SOURCE_NOT_CONNECTED'
            ? t('errors.notConnected')
            : t('errors.generic')
        }
        action={<Button onClick={retry}>{t('run.retry')}</Button>}
      />
    );
  }

  // phase === 'done'
  const partial = finalStatus === 'partially_failed' || counts.failed > 0;
  if (partial) {
    return (
      <TerminalState
        icon={<CheckCircle2 className="size-6 text-(--el-warning)" />}
        tint="bg-(--el-tint-peach)"
        title={t('run.partialTitle', { done, total: total || done, failed: counts.failed })}
        body={t('run.partialBody')}
        action={
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={retry}>
              {t('run.retry')}
            </Button>
            <a href={issuesHref}>
              <Button>{t('run.viewBacklog')}</Button>
            </a>
          </div>
        }
      >
        {countsRegion}
      </TerminalState>
    );
  }

  return (
    <TerminalState
      icon={<CheckCircle2 className="size-6 text-(--el-success)" />}
      tint="bg-(--el-tint-mint)"
      title={t('run.completeTitle', {
        count: counts.created + counts.updated,
        project: project.name,
      })}
      body={t('run.completeBody', {
        created: counts.created,
        updated: counts.updated,
        skipped: counts.skipped,
      })}
      action={
        <a href={issuesHref}>
          <Button>{t('run.viewBacklog')}</Button>
        </a>
      }
    >
      {countsRegion}
    </TerminalState>
  );
}

function tally(prev: RunCounts, plan: ImportPlan, failed: boolean): RunCounts {
  if (failed) return { ...prev, failed: prev.failed + 1 };
  if (plan === 'create') return { ...prev, created: prev.created + 1 };
  if (plan === 'update') return { ...prev, updated: prev.updated + 1 };
  return { ...prev, skipped: prev.skipped + 1 };
}

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = Math.min(100, Math.round((value / Math.max(total, 1)) * 100));
  return (
    <div
      className="h-2 w-full max-w-[24rem] overflow-hidden rounded-full bg-(--el-muted)"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full bg-(--el-accent) transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The streaming per-issue echo — decorative (`aria-hidden`), since the counts
 *  region already announces the same totals to a screen reader. */
function LiveLog({ log, label }: { log: RunProgress[]; label: string }) {
  if (log.length === 0) return null;
  return (
    <div
      aria-hidden
      className="max-h-40 overflow-y-auto rounded-(--radius-card) border border-(--el-border) p-3"
    >
      <span className="sr-only">{label}</span>
      <ul className="flex flex-col gap-0.5 font-mono text-xs">
        {log.map((event, i) =>
          event.type === 'item' ? (
            <li key={`${event.externalId}-${i}`} className="flex items-center gap-2">
              <span
                className={cn(
                  event.error
                    ? 'text-(--el-danger)'
                    : event.plan === 'create'
                      ? 'text-(--el-success)'
                      : event.plan === 'update'
                        ? 'text-(--el-info)'
                        : 'text-(--el-text-muted)',
                )}
              >
                {event.error ? 'Failed' : event.plan}
              </span>
              <span className="text-(--el-text-muted)">{event.externalId}</span>
            </li>
          ) : null,
        )}
      </ul>
    </div>
  );
}

function TerminalState({
  icon,
  tint,
  title,
  body,
  action,
  children,
}: {
  icon: React.ReactNode;
  tint: string;
  title: string;
  body: string;
  action: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col items-center gap-4 py-8 text-center">
      <span className={cn('flex size-14 items-center justify-center rounded-full', tint)}>
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-(--el-text-strong)">{title}</h2>
        <p className="max-w-[36rem] text-sm text-(--el-text-muted)">{body}</p>
      </div>
      {children}
      <div className="pt-2">{action}</div>
    </section>
  );
}
