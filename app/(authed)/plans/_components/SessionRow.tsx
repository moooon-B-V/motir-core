'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Bot,
  History,
  ListTree,
  MessagesSquare,
  RotateCw,
  Sparkles,
} from 'lucide-react';

import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';
import { useOpenPlanningWorkspace } from '@/lib/hooks/useOpenPlanningWorkspace';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';
import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import type { PlanSessionStateDto } from '@/lib/dto/planSessions';

import type { SessionRowView } from './types';

// One Plans-list row — ONE PLANNING CONVERSATION (MOTIR-6025), built to
// `design/ai-planning/design-notes.md` Part XIX §19.2 and
// `plans-sessions--list.mock.html`. It is the retired `PlanRow` with the four
// changes §19.2 names, and nothing else:
//
//   1. The square carries the session's ORIGIN; the plan's state has its own
//      chip on the right, so a status tint in the square would say it twice.
//   2. The row is NOT one `<Link>`. It has two destinations — the conversation
//      and the plan — and a link inside a link is invalid. The TITLE is the
//      row's link, stretched over the row by `after:absolute after:inset-0`;
//      the chip is a second link lifted above it with `relative z-10`.
//   3. The title's `href` is the OVERLAY address — this page's own URL plus
//      `planSession=<id>` — from the shipped `useOpenPlanningWorkspace`, so the
//      conversation opens over `/plans` and Close returns to the same filtered,
//      scrolled list.
//   4. Below `sm` the row wraps and the chip takes its own line.
//
// ⚠️ A `No plan yet` row is a conversation, never an invitation to start one
// (§19.3a): it opens exactly like every other row, and carries no chip link and
// no *Plan with AI* control.

const ORIGIN_ICON: Record<PlanSessionOriginDto, typeof MessagesSquare> = {
  conversation: MessagesSquare,
  mcp: Bot,
  generation: Sparkles,
  expand: ListTree,
  cadence: RotateCw,
  legacy: History,
};

/** The chip, one `Pill` tone per plan state — the tones the Plans page has always
 *  given these statuses (§19.3). TOTAL over the vocabulary, `none` included. */
function StateChip({ state, label }: { state: PlanSessionStateDto; label: React.ReactNode }) {
  switch (state) {
    case 'none':
      return <Pill tone="neutral">{label}</Pill>;
    case 'generating':
      return <Pill severity="info">{label}</Pill>;
    case 'planned':
      return <Pill status="planned">{label}</Pill>;
    case 'stale':
      return <Pill severity="danger">{label}</Pill>;
    case 'approved':
      return <Pill severity="success">{label}</Pill>;
    case 'declined':
      return <Pill tone="archived">{label}</Pill>;
  }
}

/** Where the conversation opens: anchored at its first key, or project-wide. */
function launchContextFor(view: SessionRowView): PlanningLaunchContext {
  const [first] = view.targetKeys;
  return first
    ? { kind: 'work-item', itemKey: first, sessionId: view.id }
    : { kind: 'project', sessionId: view.id };
}

/** Meta 1 — the ANCHOR: the first key, `+N` for the rest, the full set in `title`. */
function Anchor({ keys }: { keys: string[] }) {
  const t = useTranslations('aiPlanning.sessions');
  const [first] = keys;
  if (!first) return <span>{t('anchorProject')}</span>;
  return (
    <span className="font-mono" title={keys.join(', ')}>
      {keys.length > 1 ? t('anchorMore', { first, count: keys.length - 1 }) : first}
    </span>
  );
}

/** Meta 3 — WHO started it, and for every origin but a conversation, which door
 *  opened it. A cadence session has no starter and reads its label alone. */
function Starter({ view }: { view: SessionRowView }) {
  const t = useTranslations('aiPlanning.sessions');
  const originLabel = view.origin === 'conversation' ? null : t(`origin.${view.origin}`);
  if (!view.startedByName && !originLabel) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {view.startedByName ? (
        <>
          <span
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[9px] font-semibold text-(--el-text-inverted)"
            aria-hidden
          >
            {view.startedByName.charAt(0).toUpperCase()}
          </span>
          <b className="max-w-[10rem] truncate font-semibold" title={view.startedByName}>
            {view.startedByName}
          </b>
        </>
      ) : null}
      {view.startedByName && originLabel ? (
        <span className="text-(--el-text-faint)" aria-hidden>
          ·
        </span>
      ) : null}
      {originLabel ? <span className="min-w-0">{originLabel}</span> : null}
    </span>
  );
}

export function SessionRow({
  view,
  highlighted = false,
}: {
  view: SessionRowView;
  /** The `?session=<id>` landing — the shipped selected-row treatment (§19.5 panel 3). */
  highlighted?: boolean;
}) {
  const t = useTranslations('aiPlanning.sessions');
  const { href, open } = useOpenPlanningWorkspace(launchContextFor(view));
  const Icon = ORIGIN_ICON[view.origin];
  const state: PlanSessionStateDto = view.latestPlan?.status ?? 'none';
  const stateLabel = t(`planState.${state}`);
  // `Waiting for approval` keeps the accent border — the retired row's
  // `awaitingReview` rule, same meaning: this one needs a decision.
  const awaitingReview = state === 'planned';

  return (
    <div
      className={cn(
        'relative flex flex-wrap items-center gap-3 rounded-(--radius-card) sm:flex-nowrap',
        'border px-(--spacing-control-x) py-(--spacing-control-y) shadow-(--shadow-subtle)',
        'transition-colors hover:border-(--el-border-strong)',
        awaitingReview || highlighted ? 'border-(--el-accent)' : 'border-(--el-border)',
        highlighted ? 'bg-(--el-selection-bg)' : 'bg-(--el-surface)',
      )}
    >
      <span
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-muted)"
        aria-hidden
      >
        <Icon className="h-4 w-4 text-(--el-text-strong)" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <Link
          href={href}
          onClick={open}
          className="block truncate text-sm font-semibold text-(--el-text) after:absolute after:inset-0 after:rounded-(--radius-card) focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-(--focus-ring-color)"
        >
          {view.title || t('untitled')}
        </Link>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--el-text-secondary)">
          <Anchor keys={view.targetKeys} />
          <span>{t('lastActive', { when: view.activeLabel })}</span>
          <Starter view={view} />
        </div>
      </div>

      <div className="flex w-full shrink-0 items-center gap-2 pl-11 sm:w-auto sm:pl-0">
        {view.planCount > 1 ? (
          <span className="text-xs text-(--el-text-secondary)">
            {t('earlierPlans', { count: view.planCount - 1 })}
          </span>
        ) : null}
        {view.latestPlan ? (
          <Link
            href={`/plans/${view.latestPlan.id}`}
            aria-label={t('openPlanAria', { state: stateLabel })}
            className="relative z-10 rounded-(--radius-badge) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <StateChip
              state={state}
              label={
                <>
                  {stateLabel}
                  <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
                </>
              }
            />
          </Link>
        ) : (
          <StateChip state={state} label={stateLabel} />
        )}
      </div>
    </div>
  );
}
