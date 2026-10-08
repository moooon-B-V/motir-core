'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import {
  usePlanProgressReading,
  type PlanProgressClockReading,
} from '@/lib/hooks/usePlanProgressReading';
import {
  PLAN_STEP_PHRASE_MESSAGE_KEY,
  type PlanProgressSnapshot,
  type PlanProgressStep,
} from '@/lib/plans/planProgress';
import { WORKBENCH_PATH } from '@/lib/workbench/tab';

// THE PROGRESS LINE of a plan being written (Story MOTIR-7820 · Subtask
// MOTIR-7829; design `design/ai-planning/design-notes.md` Part XXV §25.1–25.5,
// §25.10–25.14, mock `plan-review--live-progress.mock.html` sheets 1–3).
//
// ONE component in two densities, so the plan surface and the Workbench ›
// Planning row cannot say different things:
//   · `pane`    — the pane header's [marker] [progress button + details popover]
//                 [pointer to Workbench › Planning] (§25.2);
//   · `compact` — one plain row, the thing a Workbench row composes (§25.5).
//
// ⚠️ IT DECIDES NOTHING. The state, the live steps, each step's phrase, the
// counts and the stall are the derivation's (`lib/plans/planProgress.ts`), read
// through the one clock (`usePlanProgressReading`). This file owns the WORDS,
// the FORMATS and the layout — never a comparison against the threshold, never
// a filter over the steps, never a phrase chosen from `kind`.
//
// ⚠️ WHAT IS LIVE (§25.14). The MARKER is the only live region: `role="status"`,
// and its text is the STATE WORD alone (Starting… · Being written · Stalled ·
// Reconnecting), so a screen reader hears a state change once and never a tick,
// a count or a step moving between items. The progress button is NOT live — six
// parallel sessions would otherwise announce every few seconds — and the compact
// form is plain text.
//
// Motion: none (C7). The line's text is swapped in place.

export type PlanProgressDensity = 'pane' | 'compact';

/** Workbench › Planning — the tab's own key is MOTIR-7831's; the URL form is
 *  `lib/workbench/tab.ts`'s one-canonical-URL rule (`?tab=<slug>`). */
export const PLAN_PROGRESS_POINTER_HREF = `${WORKBENCH_PATH}?tab=planning`;

export interface PlanProgressLineProps {
  progress: PlanProgressSnapshot | null;
  /** The poll's `failing` — the dropped-read row (§25.10). */
  failing?: boolean;
  density: PlanProgressDensity;
}

/** The line, with its own clock. A host that also needs the live steps (the
 *  canvas cues) reads the hook once and renders {@link PlanProgressLineView}. */
export function PlanProgressLine({ progress, failing = false, density }: PlanProgressLineProps) {
  const reading = usePlanProgressReading(progress, { failing });
  return <PlanProgressLineView reading={reading} failing={failing} density={density} />;
}

type Translate = ReturnType<typeof useTranslations>;

const MINUTE_MS = 60_000;

/** A duration in the design's elapsed format (§25.4): `<1 min` · `{m} min` ·
 *  `{h} h {m} min`. Also the `{duration}` of every other key. */
export function formatPlanDuration(ms: number, t: Translate): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (totalMinutes < 1) return t('progress.elapsedUnderMinute');
  if (totalMinutes < 60) return t('progress.elapsedMinutes', { minutes: totalMinutes });
  return t('progress.elapsedHours', {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  });
}

/** Last activity (§25.4): `just now` under 10 s, then 10-second steps, then the
 *  elapsed formatter. Measured from the server-corrected `sinceActivityMs`, so
 *  it and the stalled verdict read the same clock. */
function formatLastActivity(sinceMs: number, t: Translate): string {
  if (sinceMs < 10_000) return t('progress.lastActivityJustNow');
  if (sinceMs < MINUTE_MS) {
    return t('progress.lastActivitySeconds', { seconds: Math.floor(sinceMs / 10_000) * 10 });
  }
  return t('progress.lastActivityAgo', { duration: formatPlanDuration(sinceMs, t) });
}

/** The step's words — keyed by the derivation's phrase, never by `kind`. */
function stepWords(step: PlanProgressStep, tRoot: Translate): string {
  const key = PLAN_STEP_PHRASE_MESSAGE_KEY[step.phrase];
  return step.targetTitle !== null ? tRoot(key, { title: step.targetTitle }) : tRoot(key);
}

type MarkerState = 'starting' | 'writing' | 'stalled' | 'reconnecting';

function markerOf(reading: PlanProgressClockReading, failing: boolean): MarkerState {
  if (failing) return 'reconnecting';
  if (reading.state === 'stalled') return 'stalled';
  if (reading.state === 'starting') return 'starting';
  return 'writing';
}

const MARKER_WORD: Record<MarkerState, string> = {
  starting: 'liveStarting',
  writing: 'liveWriting',
  stalled: 'liveStalled',
  reconnecting: 'liveReconnecting',
};

function MarkerDot({ marker }: { marker: MarkerState }) {
  const warn = marker === 'stalled' || marker === 'reconnecting';
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-(--radius-badge) ${
        warn ? 'bg-(--el-warning)' : 'bg-(--el-status-in-progress)'
      }`}
    />
  );
}

/** One `· value` segment. `drop` hides it (separator and value together) below
 *  the header's width — §25.2's drop order, on the container, not the viewport. */
function Segment({ children, drop }: { children: ReactNode; drop?: string }) {
  return (
    <>
      <span aria-hidden="true" className={`shrink-0 ${drop ?? ''}`}>
        ·
      </span>
      <span className={`shrink-0 tabular-nums ${drop ?? ''}`}>{children}</span>
    </>
  );
}

// §25.2's drop order: last activity first (< 720 px), then elapsed and the
// pointer (< 560 px). Counts never drop.
const DROP_LAST_ACTIVITY = '@max-[45rem]:hidden';
const DROP_ELAPSED = '@max-[35rem]:hidden';

export function PlanProgressLineView({
  reading,
  failing = false,
  density,
}: {
  reading: PlanProgressClockReading | null;
  failing?: boolean;
  density: PlanProgressDensity;
}) {
  const t = useTranslations('planReview');
  const tRoot = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  if (!reading) return null;

  // Clock times in the reader's locale AND timezone (§25.4's popover row). The
  // app's global default is UTC (`i18n/request.ts`), so the browser's zone is
  // passed explicitly — safe from a hydration mismatch because the popover's
  // content renders only after a press, on the client.
  const time = (iso: string) =>
    format.dateTime(new Date(iso), {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

  const marker = markerOf(reading, failing);
  const stalled = reading.state === 'stalled';
  const first = reading.liveSteps[0] ?? null;
  const more = reading.liveSteps.length - 1;
  const firstWords = first ? stepWords(first, tRoot) : null;

  const steps =
    first && firstWords !== null ? (
      <>
        <span
          data-testid="plan-progress-steps"
          title={firstWords}
          className={`min-w-[7rem] truncate font-medium text-(--el-text) ${
            density === 'compact' ? 'max-w-[28ch]' : ''
          }`}
        >
          {firstWords}
        </span>
        {more > 0 ? (
          <span className="shrink-0">{t('progress.moreSteps', { count: more })}</span>
        ) : null}
      </>
    ) : null;

  const counts =
    reading.proposed > 0
      ? t('progress.authored', { authored: reading.authored, proposed: reading.proposed })
      : null;
  const elapsed = formatPlanDuration(reading.elapsedMs, t);
  const activity = stalled
    ? t('progress.stalledFor', { duration: formatPlanDuration(reading.sinceActivityMs, t) })
    : formatLastActivity(reading.sinceActivityMs, t);

  // The line's tail — `step words · +N more` leads; with no step, the first
  // segment carries no separator.
  const tail = (leadingSeparator: boolean) => {
    const parts: { key: string; node: ReactNode; drop?: string }[] = [];
    if (counts) parts.push({ key: 'counts', node: counts });
    parts.push({ key: 'elapsed', node: elapsed, drop: DROP_ELAPSED });
    parts.push({ key: 'activity', node: activity, drop: DROP_LAST_ACTIVITY });
    return parts.map((p, i) =>
      i === 0 && !leadingSeparator ? (
        <span key={p.key} className={`shrink-0 tabular-nums ${p.drop ?? ''}`}>
          {p.node}
        </span>
      ) : (
        <Segment key={p.key} drop={p.drop}>
          {p.node}
        </Segment>
      ),
    );
  };

  if (density === 'compact') {
    return (
      <div
        data-testid="plan-progress-compact"
        data-state={marker}
        className="flex min-w-0 items-center gap-1.5 text-xs text-(--el-text-secondary)"
      >
        <MarkerDot marker={marker} />
        {steps ?? (
          <span className="shrink-0 font-medium text-(--el-text)">{t(MARKER_WORD[marker])}</span>
        )}
        {tail(true)}
      </div>
    );
  }

  return (
    <>
      {/* THE MARKER (§25.1, §25.14) — the shipped live marker, its WORD now the
          state. The ONLY live region in the line. */}
      <span
        data-testid="plan-live-state"
        data-state={marker}
        role="status"
        aria-live="polite"
        className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-(--el-text-secondary)"
      >
        <MarkerDot marker={marker} />
        {t(MARKER_WORD[marker])}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-testid="plan-progress"
            className={`ml-2 inline-flex h-(--height-control) max-w-[44rem] min-w-0 items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-xs text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${
              open ? 'bg-(--el-surface-soft)' : ''
            }`}
          >
            {steps}
            {tail(steps !== null)}
            {open ? (
              <ChevronUp aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
            )}
          </button>
        </Popover.Trigger>
        <Popover.Content
          align="end"
          width="24rem"
          aria-label={t('progress.detailsAria')}
          data-testid="plan-progress-details"
        >
          <div className="flex flex-col gap-3 p-(--spacing-card-padding)">
            <span className="text-[10.5px] font-bold tracking-[0.05em] text-(--el-text-secondary) uppercase">
              {t('progress.detailsNow')}
            </span>
            {reading.liveSteps.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {reading.liveSteps.map((step) => (
                  <li key={step.sessionKey} className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-(--el-text)">
                      {stepWords(step, tRoot)}
                    </span>
                    <span className="text-xs text-(--el-text-secondary) tabular-nums">
                      {t('progress.detailsStarted', {
                        time: time(step.startedAt),
                        duration: formatPlanDuration(
                          reading.serverNowMs - Date.parse(step.startedAt),
                          t,
                        ),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-(--el-text-secondary)">{t('progress.detailsNoSteps')}</p>
            )}
            <div className="flex flex-col gap-0.5 border-t border-(--el-border-soft) pt-3 text-xs text-(--el-text-secondary) tabular-nums">
              {counts ? <span className="font-medium text-(--el-text)">{counts}</span> : null}
              <span>
                {t('progress.detailsStarted', {
                  time: time(new Date(reading.serverNowMs - reading.elapsedMs).toISOString()),
                  duration: elapsed,
                })}
              </span>
              <span>
                {t('progress.detailsLastActivity', { time: time(reading.lastActivityAt) })}
              </span>
            </div>
            {stalled ? (
              <p className="text-xs text-(--el-text)">
                {t('progress.detailsStalled', {
                  duration: formatPlanDuration(reading.sinceActivityMs, t),
                })}
              </p>
            ) : null}
            <p className="text-xs text-(--el-text-secondary)">
              {t('progress.pointerSentence')}{' '}
              <Link
                href={PLAN_PROGRESS_POINTER_HREF}
                className="font-medium text-(--el-link) hover:underline"
              >
                {t('progress.pointer')}
              </Link>
            </p>
          </div>
        </Popover.Content>
      </Popover>
      {/* THE POINTER (§25.2) — pane only; moves into the popover below 560 px. */}
      <Link
        href={PLAN_PROGRESS_POINTER_HREF}
        data-testid="plan-progress-pointer"
        aria-label={t('progress.pointerSentence')}
        className={`ml-2 inline-flex shrink-0 items-center gap-1 rounded-(--radius-control) px-(--spacing-control-x) text-xs font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${DROP_ELAPSED}`}
      >
        {t('progress.pointer')}
        <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
      </Link>
    </>
  );
}
