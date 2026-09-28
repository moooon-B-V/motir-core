'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { DispatchRunCostDto, DispatchRunMachineTimeDto } from '@/lib/dto/dispatchRuns';
import { machineTimeParts } from '@/lib/runs/hostedRun';

// THE COST of a HOSTED run (Story MOTIR-683 · MOTIR-691; `design/runs/design-notes.md`
// § The COST block) — three figures, three units, never summed.
//
//   · TOKENS — what the model-call credits were priced from; shown, never summed in.
//   · CREDITS — the ONE amount, and the total: model calls + machine time, split
//     underneath. Whole numbers, as the server answers them (never recomputed here).
//   · MACHINE TIME — a duration, from the fleet meter by run (MOTIR-6448).
//
// ⚠️ NEVER `$`. The meter's cost figure is Motir's own fleet cost, not a price;
// the machine-time route does not even carry it. What the run CHARGED is credits.
//
// ⚠️ THE MACHINE CHARGE LANDS ONCE, when the container settles (MOTIR-6514), so
// while the run is live the split says the machine time is charged at the end
// rather than printing a zero that reads as "free".
//
// A LOCAL run renders none of this and makes no cost read — it never touches the
// gateway. The caller mounts this only for a hosted run.

export function HostedRunCost({
  runId,
  live,
  cost,
  variant,
  refreshKey,
}: {
  runId: string;
  live: boolean;
  /** The run's cost from its detail read; `null` = motir-ai could not be asked;
   *  `undefined` = not read yet. */
  cost: DispatchRunCostDto | null | undefined;
  variant: 'block' | 'strip';
  /** Bumped by the caller when the run moved — re-reads the machine time. */
  refreshKey: number;
}) {
  const t = useTranslations('runs.hosted.cost');
  const [machine, setMachine] = useState<DispatchRunMachineTimeDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/dispatch-runs/${encodeURIComponent(runId)}/machine-time`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as DispatchRunMachineTimeDto;
        if (!cancelled) setMachine(body);
      } catch {
        // The duration stays as last read; the credits are the charge of record.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, refreshKey]);

  const duration =
    machine === null
      ? '—'
      : machineTimeParts(machine.billableSeconds)
          .map((p) => t(`unit.${p.unit}`, { n: p.n }))
          .join(' ');

  // The split names the machine charge once it EXISTS: the run ended and either it
  // was charged, or every container settled (a run that never booted is charged 0).
  const machineCharged = !live && !!cost && (cost.machineCredits > 0 || machine?.settled === true);

  const head =
    variant === 'block' ? (
      <div className="flex items-center gap-2">
        <h3 className="font-sans text-sm font-semibold text-(--el-text)">{t('head')}</h3>
        {live ? (
          <>
            <span
              className="size-2 shrink-0 rounded-full bg-(--el-status-in-progress)"
              aria-hidden="true"
            />
            <span className="font-sans text-xs text-(--el-text-secondary)">{t('liveHint')}</span>
          </>
        ) : null}
      </div>
    ) : (
      <span className="flex items-center gap-2 text-xs font-semibold text-(--el-text)">
        {live ? t('stripLive') : t('head')}
        {live ? (
          <span className="font-normal text-(--el-text-secondary)">{t('stripUpdating')}</span>
        ) : null}
      </span>
    );

  return (
    <section
      aria-label={t('head')}
      data-testid="hosted-run-cost"
      className={
        variant === 'block'
          ? 'flex flex-col gap-2'
          : 'flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2'
      }
    >
      {head}
      {cost === null ? (
        <p
          className="font-sans text-xs text-(--el-text-secondary)"
          data-testid="hosted-cost-unavailable"
        >
          {t('unavailable')}
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Figure label={t('tokens')} testId="hosted-cost-tokens">
            <span className="text-(--el-text)">
              {cost
                ? t('tokensValue', { input: cost.inputTokens, output: cost.outputTokens })
                : '—'}
            </span>
            {cost ? (
              <span className="text-xs text-(--el-text-secondary)">
                {t('cache', { read: cost.cacheReadTokens, write: cost.cacheWriteTokens })}
              </span>
            ) : null}
          </Figure>
          <Figure label={t('credits')} testId="hosted-cost-credits">
            <span className="text-(--el-text)">
              {cost ? t('creditsValue', { count: cost.totalCredits }) : '—'}
            </span>
            {cost ? (
              <span className="text-xs text-(--el-text-secondary)">
                {machineCharged
                  ? t('split', { model: cost.credits, machine: cost.machineCredits })
                  : t('splitPending', { model: cost.credits })}
              </span>
            ) : null}
          </Figure>
          <Figure label={t('machine')} testId="hosted-cost-machine">
            <span className="text-(--el-text)">{duration}</span>
            <span className="text-xs text-(--el-text-secondary)">{t('machineCharged')}</span>
          </Figure>
        </dl>
      )}
    </section>
  );
}

function Figure({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm"
      data-testid={testId}
    >
      <dt className="text-xs text-(--el-text-secondary)">{label}</dt>
      <dd className="flex flex-col gap-0.5">{children}</dd>
    </div>
  );
}
