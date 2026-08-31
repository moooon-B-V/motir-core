'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { DispatchRunEventDto } from '@/lib/dto/dispatchRuns';

// WHAT THE RUN PRODUCED beyond code (MOTIR-3983 ·
// `design/runs/design-notes.md` § What the run PRODUCED).
//
// ⚠️ NO REGION AT ALL WHEN THERE IS NOTHING, and that is the first requirement
// rather than a nicety. Most runs file no bug and submit no plan, so a strip
// that is present and empty on every ordinary run teaches a reader to skip
// exactly the place the rare, important thing appears. This component returns
// `null` — no heading, no rule, no "no findings" box — and the log simply starts
// at the top.
//
// ⚠️ IT SHOWS ONLY WHAT THE RECORD CARRIES. `run-findings-protocol.md` Q5 put a
// POINTER and one label in each event's `data`; a title the record does not hold
// cannot be invented here, because displaying one would be shipping a privacy
// change through a component. Every field below is read off the event.

/** `bug_filed.data` — the pointer plus the one label a not-yet-loaded row needs. */
interface BugFiled {
  key?: unknown;
  workItemId?: unknown;
  title?: unknown;
}
/** `plan_submitted.data` / `plan_approved`'s `ApprovalRecord`. */
interface PlanData {
  planId?: unknown;
  proposalCount?: unknown;
  key?: unknown;
}

type Finding =
  | { kind: 'bug'; seq: number; itemKey: string | null; title: string | null }
  | { kind: 'submitted'; seq: number; planId: string | null; proposals: number | null }
  | {
      kind: 'approved';
      seq: number;
      planId: string | null;
      proposals: number | null;
      forKey: string | null;
    };

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export interface RunFindingsProps {
  events: DispatchRunEventDto[];
}

export function RunFindings({ events }: RunFindingsProps) {
  const t = useTranslations('runs');

  const findings = useMemo<Finding[]>(() => {
    const out: Finding[] = [];
    for (const ev of events) {
      const d = (ev.data ?? {}) as BugFiled & PlanData;
      if (ev.kind === 'bug_filed') {
        out.push({ kind: 'bug', seq: ev.seq, itemKey: str(d.key), title: str(d.title) });
      } else if (ev.kind === 'plan_submitted') {
        out.push({
          kind: 'submitted',
          seq: ev.seq,
          planId: str(d.planId),
          proposals: num(d.proposalCount),
        });
      } else if (ev.kind === 'plan_approved') {
        out.push({
          kind: 'approved',
          seq: ev.seq,
          planId: str(d.planId),
          proposals: num(d.proposalCount),
          forKey: str(d.key),
        });
      }
    }
    // The RUN's order, never arrival order.
    return out.sort((a, b) => a.seq - b.seq);
  }, [events]);

  if (findings.length === 0) return null;

  const asks = findings.filter((f) => f.kind === 'submitted');
  const approved = findings.filter((f) => f.kind === 'approved');
  const bugs = findings.filter((f) => f.kind === 'bug');

  return (
    <section
      className="flex shrink-0 flex-col border-b border-(--el-border-soft) bg-(--el-surface-soft)"
      aria-label={t('findings.label')}
      data-testid="run-findings"
    >
      {/* THE ASK. Nothing moves until a person decides, so it carries the accent
          rule and says it is waiting for them. ⚠️ A re-plan is a CORRECT
          OUTCOME, not a failure — `renderReplanSubmitted` says so in its own
          first line — and the accent is `--el-status-planning`, the same hue the
          `replanned` tone uses, so this defines no second vocabulary. */}
      {asks.map((f) => (
        <div
          key={f.seq}
          data-testid="finding-plan-submitted"
          className="flex items-baseline gap-2 px-(--spacing-card-padding) py-1.5 text-xs shadow-[inset_3px_0_0_var(--el-status-planning)]"
        >
          <span
            className="size-2 flex-none translate-y-px rounded-(--radius-badge) bg-(--el-status-planning)"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 text-(--el-text)">
            <strong className="font-medium">{t('findings.planSubmitted')}</strong>{' '}
            {f.proposals !== null ? t('findings.proposals', { count: f.proposals }) : null}{' '}
            <span className="text-(--el-text-secondary)">{t('findings.waitingForYou')}</span>
          </span>
          {f.planId !== null ? (
            <Link
              href={`/plans/${encodeURIComponent(f.planId)}`}
              className="flex-none font-medium text-(--el-accent-on-surface) underline-offset-2 hover:underline"
            >
              {t('findings.review')}
            </Link>
          ) : null}
        </div>
      ))}

      {/* THE NEWS. It already happened, to the reader's own tree — no rule, no
          waiting language. ⚠️ NAMED PLAN BY PLAN, never a count: `autoLoop.ts`
          settled that ("A count would tell an operator that their tree moved
          without telling them where"), so the surface prints the terminal's own
          shape. */}
      {approved.length > 0 ? (
        <div
          data-testid="finding-plan-approved"
          className="px-(--spacing-card-padding) py-1.5 text-xs"
        >
          <div className="flex items-baseline gap-2">
            <span
              className="size-2 flex-none translate-y-px rounded-(--radius-badge) bg-(--el-status-planning)"
              aria-hidden="true"
            />
            <span className="text-(--el-text)">
              <strong className="font-medium">{t('findings.plansApproved')}</strong>{' '}
              <span className="text-(--el-text-secondary)">{t('findings.treeChanged')}</span>
            </span>
          </div>
          <ul className="mt-0.5 ml-4 space-y-0.5 text-[0.6875rem] text-(--el-text-secondary)">
            {approved.map((f) => (
              <li key={f.seq}>
                {f.planId !== null ? (
                  <Link
                    href={`/plans/${encodeURIComponent(f.planId)}`}
                    className="text-(--el-accent-on-surface) underline-offset-2 hover:underline"
                  >
                    {f.planId}
                  </Link>
                ) : null}
                {f.forKey !== null ? ` ${t('findings.approvedFor', { key: f.forKey })}` : null}
                {f.proposals !== null
                  ? ` · ${t('findings.materialized', { count: f.proposals })}`
                  : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* THE BUGS — separate rows always. "3 bugs" loses the only thing a reader
          wants, which three. ⚠️ ADDITIVE IS NOT UNREACHABLE: each row OPENS,
          because a bug the run found and a reader cannot get to is a
          notification rather than a finding. The one that does not open is the
          one whose target the record cannot name. */}
      {bugs.map((f) => (
        <div
          key={f.seq}
          data-testid="finding-bug"
          className="flex items-baseline gap-2 border-t border-(--el-border-soft) px-(--spacing-card-padding) py-1.5 text-xs first:border-t-0"
        >
          <span
            className="size-2 flex-none translate-y-px rounded-(--radius-badge) bg-(--el-type-bug)"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 text-(--el-text)">
            <strong className="font-medium">{t('findings.bugFiled')}</strong>
            {f.itemKey !== null ? <span className="font-mono"> · {f.itemKey}</span> : null}
            {f.title !== null ? ` — ${f.title}` : null}
          </span>
          {f.itemKey !== null ? (
            <Link
              href={`/items/${encodeURIComponent(f.itemKey)}`}
              className="flex-none font-medium text-(--el-accent-on-surface) underline-offset-2 hover:underline"
            >
              {t('findings.open')}
            </Link>
          ) : null}
        </div>
      ))}
    </section>
  );
}
