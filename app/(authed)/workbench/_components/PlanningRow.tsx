'use client';

import { Children, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Pill } from '@/components/ui/Pill';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { planRowDestination } from '@/lib/planning/planDestination';
import { planSentenceOf } from '@/lib/planning/planSentence';
import { PlanProgressLine } from '@/components/planning/PlanProgressLine';
import { usePeekRowClick } from '@/app/(authed)/items/_components/IssueQuickView';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { workbenchTabHref } from '@/lib/workbench/tab';
import type { WorkbenchPlanningRowDto } from '@/lib/dto/home';
import type { PlanningRowOutcome } from './planningOutcome';

// ONE PLAN BEING WRITTEN, as a row (Story MOTIR-7820 · Subtask MOTIR-7831; design
// `design/workbench/design-notes.md` § 36.4 / § 36.6 / § 36.8, mock
// `workbench--planning.mock.html` Panels 3–6).
//
// ⚠️ IT IS NOT A WORK-ITEM ROW. `WorkbenchList`'s row (kind glyph, key, Your role,
// Assignee, Status) describes a work item and a plan has none of those, so this is
// its own two-line anatomy over two columns — Plan · Planner — with § 29's plan
// leading line on line 1 and Part XXV's compact progress line on line 2.
//
// ⚠️ IT DECIDES THREE THINGS AND COMPOSES THE REST. What it decides: the
// PLANNER's words, the two-line layout, and the held row's outcome sentence. What
// it composes, deliberately rather than restates:
//   · the plan's NAME — `planSentenceOf` (`lib/planning/planSentence.ts`), the one
//     rule the To-approve plan row reads, so the two lists that show plans cannot
//     name one plan two ways (§ 36.4);
//   · where the row GOES — `planRowDestination` with `planStatus: 'generating'`
//     (§ 36.6), which already answers *the planning surface when the plan has a
//     session, else `/plans/<id>`*;
//   · its PROGRESS — `<PlanProgressLine density="compact" />`, whose words,
//     durations, stalled form and ARIA are all Part XXV's (MOTIR-7829).

/** The two tracks (§ 36.4) — Plan flexes, Planner is a fixed 220px. */
export const PLANNING_GRID_TEMPLATE = 'minmax(10rem, 1fr) 220px';

export function PlanningRow({
  row,
  arrived,
  outcome,
  failing,
}: {
  row: WorkbenchPlanningRowDto;
  /** Arrived while the reader was looking — the shipped neutral `New` pill (§ 26). */
  arrived: boolean;
  /**
   * Set once the plan has LEFT the read (§ 36.8): the row is HELD in place and
   * line 2 becomes its outcome. `null` is the ordinary case — still being written.
   */
  outcome: PlanningRowOutcome | null;
  /** The poll is dropping reads (§ 36.7 / Part XXV §25.10) — the line keeps its
   *  last snapshot and wears the warning dot. */
  failing: boolean;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('workbench');
  const tPlanning = useTranslations('workbench.planning');
  const tPlan = useTranslations('approvalGate.planApproval.row');
  const peekRowClick = usePeekRowClick();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const held = outcome !== null;
  const sentence = planSentenceOf(row);
  const sentenceText = tPlan.markup(sentence.form, {
    name: sentence.name,
    project: sentence.name,
    title: (chunks: string) => chunks,
  });
  const qs = searchParams.toString();
  const destination = planRowDestination({
    // A HELD row's plan is no longer `generating`, and its outcome says which arm
    // it took: a written plan is reviewed on its planning surface (§ 29), and a
    // plan that ended is a record on its own page. `planRowDestination` is still
    // the one rule — this passes it the status the row now knows.
    planStatus: outcome?.planStatus ?? 'generating',
    planId: row.planId,
    sessionId: row.sessionId,
    host: `${pathname}${qs ? `?${qs}` : ''}`,
    anchorKey: row.targets[0]?.key ?? null,
    // `planVia=planning` (§ 36.6): the surface's reopened line names THIS entrance.
    via: 'planning',
    routes,
  });
  const opensSurface = destination.kind === 'planning-surface';

  function onRowClick(e: MouseEvent<HTMLAnchorElement>) {
    // A modified or non-primary click keeps the real `href` — the plan page, in a
    // new tab. With no conversation to return to, the real navigation goes ahead.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (!opensSurface) return;
    e.preventDefault();
    // `shallowPush`, so Close lands back on exactly this tab (§ 36.6; CLAUDE.md
    // § *URL state the CLIENT reads*). The overlay's body is fetched by the
    // overlay itself, so nothing here needs the server to answer.
    shallowPush(destination.href);
  }

  const titleInk = held ? 'text-(--el-text-secondary)' : 'text-(--el-text)';
  const parts: ReactNode = tPlan.rich(sentence.form, {
    name: sentence.name,
    project: sentence.name,
    title: (chunks) =>
      sentence.form === 'targeted' ? (
        // THE TITLE IS THE TARGET'S QUICK-VIEW DOOR — § 28 DECISION 3's contract,
        // above the stretched row door on `z-10`, exactly as § 29's row composes it.
        <Link
          key="title"
          href={routes.item(sentence.key)}
          onClick={(e) => peekRowClick(e, sentence.key)}
          className={cn(
            'relative z-10 min-w-0 truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none',
            titleInk,
          )}
        >
          {chunks}
        </Link>
      ) : (
        // A plan has no quick view: its own title is plain text under the row door.
        <span key="title" className={cn('min-w-0 truncate font-medium', titleInk)}>
          {chunks}
        </span>
      ),
  });

  const keys = row.targets.map((target) => target.key);
  const planner = plannerCopy(row.author);

  return (
    <div
      role="row"
      data-testid={`planning-row-${row.planId}`}
      data-held={held ? 'true' : undefined}
      className={cn(
        'relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0',
        'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
        'md:pt-0 md:pr-7 md:pb-2.5 md:pl-4',
      )}
    >
      <div
        role="presentation"
        className="flex flex-col gap-1 md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0"
        style={{ gridTemplateColumns: PLANNING_GRID_TEMPLATE }}
      >
        <div role="cell" className="flex min-w-0 items-center gap-2">
          {/* THE DOOR (§ 36.6): `/plans/<id>` is the real href — a new tab opens the
              plan page — and a plain primary click opens the planning surface over
              this tab. The planning overlay is a dialog, hence `aria-haspopup`. */}
          <Link
            href={routes.plan(row.planId)}
            aria-haspopup="dialog"
            aria-label={tPlanning('rowAria', { sentence: sentenceText })}
            onClick={onRowClick}
            className="absolute inset-0 z-0 focus:outline-none"
          />
          {/* The Motir-AI mark § 29 put on the ROW. A HELD row drops it and keeps a
              same-size spacer, so nothing shifts under the reader (§ 36.8). */}
          {held ? (
            <span aria-hidden className="h-4 w-4 shrink-0" />
          ) : (
            <Sparkles className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
          )}
          <span className="flex min-w-0 items-center gap-1 text-sm">
            {Children.toArray(parts).map((part, index) =>
              typeof part === 'string' ? (
                part.trim() === '' ? null : (
                  <span key={`frame-${index}`} className="shrink-0 text-(--el-text-secondary)">
                    {part}
                  </span>
                )
              ) : (
                part
              ),
            )}
          </span>
          {/* The KEY cell names the targets: the first, `+{n}` for the rest, every
              key in its `title` (§ 36.4). It is PLAIN TEXT, never a second door —
              the title beside it already opens that work item. */}
          {keys.length > 0 ? (
            <span
              className="shrink-0 font-mono text-xs text-(--el-text-secondary)"
              title={keys.length > 1 ? keys.join(', ') : undefined}
            >
              {keys.length > 1
                ? `${keys[0]} ${tPlan('moreTargets', { count: keys.length - 1 })}`
                : keys[0]}
            </span>
          ) : null}
          {arrived ? <Pill tone="neutral">{t('live.new')}</Pill> : null}
        </div>

        <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
          <div role="cell" className="flex min-w-0 items-center">
            {/* WHO IS WRITING IT. A long value truncates at the cell's END, so a long
                model id loses its tail first and the harness stays readable; the full
                string is in `title`, and nothing is shortened in data (§ 36.4). */}
            <span
              className="truncate text-xs text-(--el-text-secondary)"
              title={
                planner.kind === 'verbatim'
                  ? planner.text
                  : tPlanning.markup(planner.key, {
                      ...planner.values,
                      mono: (chunks: string) => chunks,
                    })
              }
            >
              {planner.kind === 'verbatim'
                ? planner.text
                : tPlanning.rich(planner.key, {
                    ...planner.values,
                    mono: (chunks) => <span className="font-mono">{chunks}</span>,
                  })}
            </span>
          </div>
        </div>
      </div>

      {/* LINE 2 — HOW FAR IT HAS GOT, or (held) WHAT IT LEFT AS. Indented to the
          title's left edge, spanning both columns. */}
      <div role="cell" className="flex min-w-0 flex-wrap items-center gap-2 pl-6">
        {outcome === null ? (
          <PlanProgressLine density="compact" progress={row.progress} failing={failing} />
        ) : (
          <>
            {outcome.chipKey === null ? null : (
              <Pill tone="neutral">{tPlanning(`left.${outcome.chipKey}`)}</Pill>
            )}
            <span className="text-xs text-(--el-text-secondary)">
              {tPlanning(`left.${outcome.lineKey}`)}
            </span>
            {outcome.chipKey === 'planned' ? (
              /* A proposed plan's review is found on the FIRST tab (§ 29), so the
                 held row points at it — above the row door, like the title. */
              <Link
                href={workbenchTabHref('approvals')}
                className="relative z-10 text-xs font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                {tPlanning('left.plannedLink')}
              </Link>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * THE PLANNER'S WORDS (§ 36.4) — which `workbench.planning.planner.*` message this
 * row's `author` takes, and its values.
 *
 * Five cases, written as explicit branches rather than a table: the hosted planner
 * is *Motir AI*; an MCP agent is named by whatever it told us — its harness and its
 * model, its model alone (*MCP agent · {model}*), or neither (*MCP agent*). A model
 * id renders `font-mono` through the message's `<mono>` tag.
 *
 * ⚠️ HARNESS-ONLY IS NOT A MESSAGE, and that is the one place this file departs
 * from § 36.13's table, which lists the form (*{harness}*) and no key for it. The
 * form is the harness string and nothing else — no frame, no separator, no
 * translated word — so a message would be `{harness}` in both catalogues, i.e. two
 * strings that cannot ever differ from the value they carry. It renders verbatim,
 * which is also what the design says of a harness: *free text, nothing shortened in
 * data*.
 */
type PlannerCopy =
  | { kind: 'verbatim'; text: string }
  | {
      kind: 'message';
      key: 'planner.motir' | 'planner.harnessModel' | 'planner.agent' | 'planner.agentModel';
      values: Record<string, string>;
    };

function plannerCopy(author: WorkbenchPlanningRowDto['author']): PlannerCopy {
  if (author.source !== 'mcp') return { kind: 'message', key: 'planner.motir', values: {} };
  const { harness, model } = author;
  if (harness && model) {
    return { kind: 'message', key: 'planner.harnessModel', values: { harness, model } };
  }
  if (harness) return { kind: 'verbatim', text: harness };
  if (model) return { kind: 'message', key: 'planner.agentModel', values: { model } };
  return { kind: 'message', key: 'planner.agent', values: {} };
}
