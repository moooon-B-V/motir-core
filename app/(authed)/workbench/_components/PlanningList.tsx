'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { fetchPlanReview } from '@/lib/planning/planReviewClient';
import type { WorkbenchPlanningPageDto, WorkbenchPlanningRowDto } from '@/lib/dto/home';
import { PlanningRow, PLANNING_GRID_TEMPLATE } from './PlanningRow';
import {
  mergePlanningRows,
  planningOutcomeOf,
  UNKNOWN_OUTCOME,
  type PlanningRowOutcome,
} from './planningOutcome';

// THE PLANNING TAB'S LIVE LIST (Story MOTIR-7820 · Subtask MOTIR-7831; design
// `design/workbench/design-notes.md` § 36.5 / § 36.7 / § 36.8 / § 36.10, mock
// Panels 3–8).
//
// ⚠️ IT POLLS, AND THAT IS NOT A SHORTCUT PAST THE LIVE STREAM. The Workbench's
// nudge (`useWorkbenchLive`) fires on a WATERMARK move — a work item changing — and
// no watermark moves when a planner takes a step or authors a proposal, so there is
// no signal to listen to. And a `router.refresh()` could not reach these rows
// anyway: this is a client island seeded from server props through `useState`, the
// third surface kind of CLAUDE.md § *Page state after a mutation*, whose
// initializer runs once. So the island re-reads for itself.
//
// ⚠️ TEN SECONDS, WHILE THE DOCUMENT IS VISIBLE (§ 36.7). Ten is the compact
// line's finest VISIBLE step — *last activity* moves in 10s steps (Part XXV §25.4)
// — so a faster poll would buy nothing a reader can see; and the times tick once a
// second off each snapshot's own `serverNow` inside the line, so the row keeps
// moving between reads. A hidden tab polls not at all and reads once the moment it
// comes back, because a plan's progress while nobody was looking is one read, not
// the dozens an interval would have made.
//
// ⚠️ A LATE RESPONSE NEVER WINS. Each read carries a monotonic `seq` and an
// `AbortController`; a response older than the newest applied one is dropped, and
// a failed or aborted read leaves the last rows exactly where they were (§ 36.7,
// Panel 7). After three consecutive failures the rows wear Part XXV's warning dot
// and keep their words — nothing is greyed, and no row leaves on a failed read.
//
// ⚠️ THE COUNT IS A SERVER SURFACE, so a changed `total` asks for ONE
// `router.refresh()` (§ 36.7; the page-state contract's case 2 beside this
// island's case 3). The refresh re-reads the strip's chip; it does not and cannot
// re-seed these rows.

/** The poll's cadence (§ 36.7). */
export const PLANNING_POLL_MS = 10_000;

/** Consecutive failed reads after which the rows report the dropped read. */
export const PLANNING_FAILING_AFTER = 3;

interface Tracked {
  rows: WorkbenchPlanningRowDto[];
  heldIds: ReadonlySet<string>;
  arrivedIds: ReadonlySet<string>;
  total: number;
}

export function PlanningList({
  seed,
  projectName,
  label,
  empty,
}: {
  /** The server's first page — page 1 at the tab's ceiling (§ 36.10). */
  seed: WorkbenchPlanningPageDto;
  /** The active project, for the scope line (§ 36.5). */
  projectName: string;
  /** The list's accessible name — the tab's own label. */
  label: string;
  /**
   * What an empty tab shows, rendered HERE rather than instead of this component
   * (the MOTIR-5245 finding the Approvals list carries): the component that knows
   * what ARRIVED has to exist before the first row lands, or the one arrival a
   * reader is most certainly watching — into an empty tab — is the one that can
   * never be marked `New`.
   */
  empty: ReactNode;
}) {
  const t = useTranslations('workbench');
  const tPlanning = useTranslations('workbench.planning');
  const router = useRouter();

  const [tracked, setTracked] = useState<Tracked>(() => ({
    rows: seed.items,
    heldIds: new Set(),
    // The FIRST reading marks nothing: a reader who has just landed has had
    // nothing arrive under them.
    arrivedIds: new Set(),
    total: seed.total,
  }));
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, PlanningRowOutcome>>(new Map());
  const [failing, setFailing] = useState(false);

  /**
   * Read the outcome of a plan that has just left — once per row, ever (§ 36.8).
   *
   * One shared `AbortController` for the lifetime of the island, so a read in
   * flight is dropped on unmount and NOT when a sibling row's outcome lands.
   */
  const readOutcome = useCallback(async (planId: string, signal?: AbortSignal) => {
    try {
      const review = await fetchPlanReview(planId, signal);
      const outcome = planningOutcomeOf(review);
      // Still `generating`: it was absent from one window, not finished. Nothing
      // is recorded, so the next read can hold it again.
      if (!outcome) return;
      setOutcomes((current) => new Map(current).set(planId, outcome));
    } catch {
      // The read failed, so the row says the one thing the poll proved: it is no
      // longer being written (§ 36.8's fourth form).
      setOutcomes((current) =>
        current.has(planId) ? current : new Map(current).set(planId, UNKNOWN_OUTCOME),
      );
    }
  }, []);

  const outcomeAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    outcomeAbortRef.current = ctrl;
    return () => ctrl.abort();
  }, []);

  // ⚠️ THE OUTCOME READS ARE AN EFFECT OF WHAT IS HELD, not a side effect inside
  // the poll's own `.then`. The poll applies its page through a functional state
  // update — which is what keeps it independent of the rows it is replacing, so
  // the interval is never restarted by its own result — and this effect reacts to
  // the held set that update produced. `requested` is what makes it ONCE per row:
  // a row that has been asked about is never asked again, however many polls hold
  // it, and a failed read's own fallback outcome is already recorded.
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const planId of tracked.heldIds) {
      if (requestedRef.current.has(planId)) continue;
      requestedRef.current.add(planId);
      void readOutcome(planId, outcomeAbortRef.current?.signal);
    }
  }, [tracked.heldIds, readOutcome]);

  // ⚠️ ONE `router.refresh()` WHEN THE SET'S SIZE MOVED (§ 36.7). The strip's
  // count is a SERVER surface — the page-state contract's case 2 — and this island
  // is case 3, so the two are updated by two mechanisms and neither reaches the
  // other. The previous total lives in a ref written inside this effect, so a
  // re-render with the same total asks for nothing.
  const refreshedForTotal = useRef(seed.total);
  useEffect(() => {
    if (tracked.total === refreshedForTotal.current) return;
    refreshedForTotal.current = tracked.total;
    router.refresh();
  }, [tracked.total, router]);

  useEffect(() => {
    let stopped = false;
    let issued = 0;
    let applied = 0;
    let failures = 0;
    const inFlight = new Set<AbortController>();

    const read = () => {
      if (stopped) return;
      const seq = ++issued;
      const ctrl = new AbortController();
      inFlight.add(ctrl);
      void fetch('/api/workbench/planning', {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`planning read failed (${res.status})`);
          return (await res.json()) as WorkbenchPlanningPageDto;
        })
        .then((page) => {
          // Dropped: the poll stopped, or a LATER read has already been applied.
          if (stopped || seq <= applied) return;
          applied = seq;
          failures = 0;
          setFailing(false);
          setTracked((current) => {
            const merged = mergePlanningRows(current.rows, page.items, (row) => row.planId);
            return {
              rows: merged.rows,
              heldIds: merged.heldIds,
              // `New` stays on an arrival until the next LOAD, so the marks union
              // rather than being replaced by the newest read's.
              arrivedIds: new Set([...current.arrivedIds, ...merged.arrivedIds]),
              total: page.total,
            };
          });
        })
        .catch(() => {
          // Best-effort: the rows stand and the next read retries. A failure older
          // than an applied success says nothing about now.
          if (stopped || seq <= applied) return;
          failures += 1;
          if (failures >= PLANNING_FAILING_AFTER) setFailing(true);
        })
        .finally(() => {
          inFlight.delete(ctrl);
        });
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      // Back on screen: read AT ONCE rather than waiting out an interval the
      // reader cannot see (§ 36.7).
      read();
    };

    const handle = setInterval(() => {
      if (document.visibilityState === 'visible') read();
    }, PLANNING_POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const ctrl of inFlight) ctrl.abort();
      inFlight.clear();
    };
  }, []);

  // ⚠️ A HELD ROW KEEPS THE LIST NON-EMPTY — a tab whose last plan has just been
  // written must not flip to *No plans being written* underneath the receipt that
  // says it was.
  if (tracked.rows.length === 0) return <>{empty}</>;

  const shown = tracked.rows.length;
  // The ceiling bit when the set is larger than the page the server could return
  // (§ 36.10). It is measured against the SERVER's page, not against the rows on
  // screen, so a held row does not make the note appear or disappear.
  const rest = tracked.total - seed.items.length;
  const atCeiling = rest > 0;

  return (
    <>
      {/* THE SCOPE LINE (§ 36.5) — the tab is narrower than its name suggests, and
          the reader cannot see what is excluded. Above the rows only: the empty
          state carries the same scope in its own body. */}
      <p data-testid="planning-scope" className="mb-2 text-xs text-(--el-text-secondary)">
        {tPlanning.rich('scope', {
          // ⚠️ The project's NAME is `{name}` and the emphasis TAG is `<project>`,
          // two different identifiers, because next-intl resolves tags and values
          // out of one object — `approvalGate.planApproval.row.targeted` spells its
          // pair `<title>{name}</title>` for the same reason.
          name: projectName,
          project: (chunks) => (
            <strong key="project" className="font-medium text-(--el-text)">
              {chunks}
            </strong>
          ),
          link: (chunks) => (
            <Link
              key="link"
              href="/plans"
              className="font-medium text-(--el-link) hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {chunks}
            </Link>
          ),
        })}
      </p>
      <div
        data-surface="card"
        className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
      >
        <div role="table" aria-label={label} className="w-full text-sm">
          {/* Hidden below `md`: it labels a grid that does not exist at that width,
              and every Workbench row stacks there (§ 36.11). */}
          <div role="rowgroup" className="hidden md:block">
            <div
              role="row"
              className="sticky top-0 z-20 grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-7 pl-4"
              style={{ gridTemplateColumns: PLANNING_GRID_TEMPLATE, height: 40 }}
            >
              {[t('columns.plan'), t('columns.planner')].map((column) => (
                <div key={column} role="columnheader" className="flex min-w-0 items-center">
                  <span className="truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
                    {column}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div role="rowgroup">
            {tracked.rows.map((row) => (
              <PlanningRow
                key={row.planId}
                row={row}
                arrived={tracked.arrivedIds.has(row.planId)}
                outcome={
                  tracked.heldIds.has(row.planId)
                    ? (outcomes.get(row.planId) ?? UNKNOWN_OUTCOME)
                    : null
                }
                failing={failing}
              />
            ))}
          </div>
        </div>
        {atCeiling ? (
          /* THE CEILING NOTE (§ 36.10) — a note, never an alert: nothing is wrong,
             the reader simply has more plans being written than one screen holds.
             There is NO pager; the strip's count stays the true total, which is why
             this line has to say how many are shown. */
          <div
            role="note"
            data-testid="planning-ceiling"
            className="flex flex-wrap items-center gap-x-1 border-t border-(--el-border) bg-(--el-surface-soft) px-4 py-2.5 text-xs text-(--el-text-secondary)"
          >
            {tPlanning.rich('ceiling', {
              shown,
              rest,
              link: (chunks) => (
                <Link
                  key="link"
                  href="/plans?status=generating"
                  className="font-medium text-(--el-link) hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {chunks}
                </Link>
              ),
            })}
          </div>
        ) : null}
      </div>
    </>
  );
}
