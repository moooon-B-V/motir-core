'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleMinus,
  CircleX,
  LoaderCircle,
  Power,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { INSTANCE_BOOT_DEADLINE_MS } from '@/lib/agentInstances/config';
import type { AgentInstanceBootDto, AgentInstanceBootStepDto } from '@/lib/dto/agentInstances';

// THE BOOT READ-OUT (Story MOTIR-7393 · MOTIR-7400), built to the approved delta
// `design/my-agents/my-agents--boot.mock.html` (MOTIR-7395) and its section of
// `design/my-agents/design-notes.md`:
//
//   panels 2–3  the read-out while booting: one row per step, each state with its
//               own glyph and ink; the in-progress row tinted sky with a ticking
//               clock — the clock and the loader's rotation are what read as live,
//               never an animated colour
//   panels 4–6  failed: the hue in the row's border and glyph only, the reason in
//               words under the label, the rows after it waiting, the way out
//   panel 7     a wake: the clone rows skipped
//   panel 8     deleted mid-boot: the last word, drawn like a skipped row
//   panel 9     running: one summary line, with Show steps / Hide steps
//
// Inks: `--el-text-secondary` is the quiet ink on the card, `--el-text-strong` the
// ink on the sky tint, `--el-text` on a failed row. `--el-text-muted` and
// `--el-text-faint` are used nowhere (the delta's ink audit).

type Translate = ReturnType<typeof useTranslations<'myAgents.boot'>>;

/** `{s}s` under a minute, `{m}m {ss}s` from a minute on — a finished step's form. */
export function formatBootDuration(ms: number, t: Translate): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t('duration.seconds', { s: total });
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return t('duration.minutes', { m, s });
}

/** The ticking clock's `m:ss`. */
export function formatBootClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const STEP_KEY = {
  provision: 'provision',
  machine_start: 'machineStart',
  clone: 'clone',
  terminal_check: 'terminalCheck',
  ready: 'ready',
} as const;

const STATE_KEY = {
  waiting: 'waiting',
  in_progress: 'inProgress',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
} as const;

/** A step's label: `Cloning owner/name` on a clone row, the step's name otherwise. */
export function bootStepLabel(step: AgentInstanceBootStepDto, t: Translate): string {
  const key = STEP_KEY[step.step];
  return key === 'clone'
    ? t('step.clone', { repository: step.repository ?? '' })
    : t(`step.${key}`);
}

/** The row line of a booting agent in the list (panel 10): the step in its in-progress form. */
export function bootRowLine(
  step: { step: AgentInstanceBootStepDto['step']; repository: string | null },
  t: Translate,
): string {
  const key = STEP_KEY[step.step];
  return key === 'clone' ? t('row.clone', { repository: step.repository ?? '' }) : t(`row.${key}`);
}

/**
 * The reason under a failed row: Motir's own reasons in the reader's words, any
 * other detail (the provider's, a clone's) shown as sent.
 */
function failedDetail(step: AgentInstanceBootStepDto, t: Translate): string | null {
  const detail = step.detail;
  if (!detail) return null;
  const exit = /^exit code (\d+)$/.exec(detail);
  if (exit) return t('detail.exited', { code: exit[1]! });
  if (detail === 'the machine did not start in time')
    return t('detail.deadline', { minutes: INSTANCE_BOOT_DEADLINE_MS / 60_000 });
  if (
    step.step === 'clone' &&
    /not installed|no installation|has no access|not found/i.test(detail) &&
    step.repository
  )
    return t('detail.cloneNoAccess', { repository: step.repository });
  return detail;
}

/** The time column of a skipped row: why it was skipped, in words. */
function skippedWhy(step: AgentInstanceBootStepDto, t: Translate): string {
  if (step.detail === 'deleted') return t('detail.deleted');
  if (step.step === 'terminal_check') return t('skipped.terminal');
  if (step.step === 'clone' && !step.detail) return t('skipped.clone');
  return step.detail ?? t('state.skipped');
}

function since(iso: string | null, end: string | null, now: number): number {
  if (!iso) return 0;
  return (end ? Date.parse(end) : now) - Date.parse(iso);
}

/** A clock that ticks once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

const ROW =
  'grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-(--radius-control) border px-(--spacing-control-x) py-(--spacing-control-y) text-[0.8125rem]';
const GLYPH = 'mt-0.5 size-4';

function StepRow({ step, now, t }: { step: AgentInstanceBootStepDto; now: number; t: Translate }) {
  const label = bootStepLabel(step, t);
  const deleted = step.state === 'failed' && step.detail === 'deleted';
  const state = deleted ? 'skipped' : step.state;
  const words = <span className="sr-only">{` — ${t(`state.${STATE_KEY[step.state]}`)}`}</span>;
  // A clone row's repository is set in mono and wraps anywhere, never truncated (panel 11).
  const [before, after] =
    step.step === 'clone' ? t('step.clone', { repository: '\u0001' }).split('\u0001') : [label];
  const name =
    step.step === 'clone' ? (
      <>
        {before}
        <span className="font-mono text-xs [overflow-wrap:anywhere]">{step.repository}</span>
        {after}
      </>
    ) : (
      label
    );
  const mono = 'font-mono text-xs';

  switch (state) {
    case 'in_progress':
      return (
        <li
          data-state="in_progress"
          className={`${ROW} border-transparent bg-(--el-tint-sky) text-(--el-text-strong)`}
        >
          <LoaderCircle
            className={`${GLYPH} animate-spin motion-reduce:animate-none`}
            aria-hidden="true"
          />
          <span className="min-w-0 font-semibold">
            {name}
            {words}
          </span>
          <span aria-hidden="true" className={mono}>
            {formatBootClock(since(step.startedAt, null, now))}
          </span>
        </li>
      );
    case 'done':
      return (
        <li data-state="done" className={`${ROW} border-transparent text-(--el-text-secondary)`}>
          <CircleCheck className={`${GLYPH} text-(--el-success)`} aria-hidden="true" />
          <span className="min-w-0">
            {name}
            {words}
          </span>
          <span className={mono}>
            {formatBootDuration(since(step.startedAt, step.endedAt, now), t)}
          </span>
        </li>
      );
    case 'failed': {
      const why = failedDetail(step, t);
      return (
        <li data-state="failed" className={`${ROW} border-(--el-danger) text-(--el-text)`}>
          <CircleX className={`${GLYPH} text-(--el-danger)`} aria-hidden="true" />
          <span className="min-w-0">
            <span className="font-semibold">
              {name}
              {words}
            </span>
            {why ? <span className="mt-0.5 block text-xs">{why}</span> : null}
          </span>
          <span className={mono}>
            {formatBootDuration(since(step.startedAt, step.endedAt, now), t)}
          </span>
        </li>
      );
    }
    case 'skipped':
      return (
        <li
          data-state={deleted ? 'deleted' : 'skipped'}
          className={`${ROW} border-transparent text-(--el-text-secondary)`}
        >
          <CircleMinus className={GLYPH} aria-hidden="true" />
          <span className="min-w-0 line-through">
            {name}
            {words}
          </span>
          <span className={deleted ? mono : 'text-xs'}>
            {deleted
              ? formatBootDuration(since(step.startedAt, step.endedAt, now), t)
              : skippedWhy(step, t)}
          </span>
        </li>
      );
    case 'waiting':
      return (
        <li data-state="waiting" className={`${ROW} border-transparent text-(--el-text-secondary)`}>
          <Circle className={GLYPH} aria-hidden="true" />
          <span className="min-w-0">
            {name}
            {words}
          </span>
          <span />
        </li>
      );
  }
}

/** A polite announcement of each change of STATE, never of the clock (the notes' screen-reader rule). */
function useAnnouncement(boot: AgentInstanceBootDto, t: Translate): string {
  const seen = useRef<{ attempt: number; states: Map<number, string> } | null>(null);
  const [said, setSaid] = useState('');
  useEffect(() => {
    const prev = seen.current;
    const states = new Map(boot.steps.map((s) => [s.ordinal, s.state]));
    seen.current = { attempt: boot.attempt, states };
    if (!prev || prev.attempt !== boot.attempt) return;
    const changed = boot.steps.filter((s) => prev.states.get(s.ordinal) !== s.state);
    const last = changed.at(-1);
    if (!last) return;
    setSaid(
      t('announce', {
        step: bootStepLabel(last, t),
        state: t(`state.${STATE_KEY[last.state]}`),
      }),
    );
  }, [boot, t]);
  return said;
}

export function AgentBootReadout({
  boot,
  agentState,
  waking,
  onWake,
  onDelete,
}: {
  boot: AgentInstanceBootDto;
  /** The agent's own state: the summary shows only while it runs. */
  agentState: string;
  waking: boolean;
  onWake: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('myAgents.boot');
  const tm = useTranslations('myAgents');
  const booting = boot.outcome === null;
  const now = useNow(booting);
  const announcement = useAnnouncement(boot, t);
  const [open, setOpen] = useState(false);

  const rows = (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {boot.steps.map((step) => (
        <StepRow key={step.ordinal} step={step} now={now} t={t} />
      ))}
    </ol>
  );
  const live = (
    <span role="status" aria-live="polite" className="sr-only">
      {announcement}
    </span>
  );

  if (boot.outcome === 'running') {
    if (agentState !== 'running') return null;
    return (
      <section
        aria-label={t('label')}
        data-testid="agent-boot"
        data-outcome="running"
        className="border-b border-(--el-border-soft)"
      >
        <div className="flex items-center gap-2 px-(--spacing-card-padding) py-(--spacing-control-y) text-[0.8125rem] text-(--el-text-secondary)">
          <CircleCheck className="size-4 flex-none text-(--el-success)" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {t(boot.kind === 'wake' ? 'summary.wake' : 'summary.create', {
              time: formatBootDuration(since(boot.startedAt, boot.endedAt, now), t),
            })}
          </span>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {t(open ? 'hideSteps' : 'showSteps')}
            {open ? (
              <ChevronUp className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
        {open ? (
          <div className="px-(--spacing-card-padding) pb-(--spacing-control-y)">{rows}</div>
        ) : null}
      </section>
    );
  }

  const title =
    boot.outcome === 'failed'
      ? t('title.failed', {
          time: formatBootDuration(since(boot.startedAt, boot.endedAt, now), t),
        })
      : boot.outcome === 'deleted'
        ? t('title.deleted')
        : t(boot.kind === 'wake' ? 'title.wake' : 'title.create');

  return (
    <section
      aria-label={t('label')}
      data-testid="agent-boot"
      data-outcome={boot.outcome ?? 'booting'}
      className="flex flex-col gap-2 border-b border-(--el-border-soft) bg-(--el-card) p-(--spacing-card-padding)"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[0.8125rem] font-semibold text-(--el-text)">{title}</h3>
        {booting ? (
          <span aria-hidden="true" className="font-mono text-xs text-(--el-text-secondary)">
            {formatBootClock(since(boot.startedAt, null, now))}
          </span>
        ) : null}
      </div>
      {rows}
      {boot.outcome === 'failed' && agentState === 'failed' ? (
        <div className="flex flex-wrap items-center gap-2 pt-1 text-[0.8125rem] text-(--el-text)">
          <span className="min-w-0 flex-1 basis-56">{tm('failedWayOut')}</span>
          <Button
            size="sm"
            leftIcon={<Power aria-hidden="true" />}
            onClick={onWake}
            loading={waking}
          >
            {tm('panel.wake')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Trash2 aria-hidden="true" />}
            onClick={onDelete}
            className="text-(--el-danger-on-surface)"
          >
            {tm('panel.delete')}
          </Button>
        </div>
      ) : null}
      {live}
    </section>
  );
}
