'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { List, Workflow } from 'lucide-react';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import { Segmented } from '@/components/ui/Segmented';
import type { PlanViewDto } from '@/lib/planning/planView';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// The plan page's List | Canvas pane, as ONE component two hosts mount
// (Subtask MOTIR-6185 · Story MOTIR-6155).
//
// ── What this is, and what it deliberately is NOT ───────────────────────────
// This is a LIFT, not a rewrite. The pane header, the `Segmented` switch, the
// `min-h-0 flex-1` body box and both bodies moved here verbatim from
// `PlanDetail`, which is the only thing that rendered them. Nothing a plan-page
// user can see or do changes, which is why that page's suites pass unmodified —
// they are the regression net for this move.
//
// It exists because the planning SURFACE is about to show the same thing
// (MOTIR-6186). Two copies of "the list, the canvas and the switch between them"
// is two places that can disagree about what a plan contains, and the surface
// must not grow a second list, a second review canvas or a second edge
// computation: `PlanReviewCanvas` keeps its one edge engine, `mergePlanLevel`.
//
// ── It is PRESENTATIONAL and fully CONTROLLED ───────────────────────────────
// It owns no fetching, no URL and no view state. The HOST decides which view is
// showing and what a press means, and the two hosts want different answers:
// the plan page keeps the view in the URL (MOTIR-3239 / MOTIR-3434), and the
// surface keeps it local because an overlay must not write into the address bar
// of the page underneath it (`design/ai-planning/design-notes.md` Part XXI,
// decision 3). A component that owned the URL could not serve the overlay at
// all — which is the whole reason the view is a prop rather than state here.
//
// ── The `band` slot ─────────────────────────────────────────────────────────
// The one structural addition, and it is not a new element: the plan page's
// establish band sits BETWEEN the header and the body, so the lift needs
// somewhere to put it. Part VIII §2 is what decides that position — the header
// governs the BODY, and the band is not part of the body — so the slot is that
// decision expressed as a prop rather than re-argued in each host.

export interface PlanProposalViewsProps {
  /** The proposals to draw — the review's own item set. */
  items: PlanReviewItemDto[];
  /**
   * The plan's decision, drawn on every node and row the plan contributes
   * (MOTIR-3161). Three-valued: `accepted` / `declined` / null. Read from the
   * host's own decided state, never inferred from a status — a declined plan's
   * review keeps its pre-decision status (MOTIR-3162).
   */
  outcome: PlanItemOutcome | null;
  projectKey: string;
  /** Bumped by the host when the committed tree changes, so the canvas refetches. */
  version: number;
  /** The canvas's accessible name. */
  ariaLabel: string;
  /** Which body shows. CONTROLLED — this component never changes it itself. */
  view: PlanViewDto;
  onViewChange: (next: PlanViewDto) => void;
  /** Rendered between the header and the body (the plan page's establish band). */
  band?: ReactNode;
}

export function PlanProposalViews({
  items,
  outcome,
  projectKey,
  version,
  ariaLabel,
  view,
  onViewChange,
  band,
}: PlanProposalViewsProps) {
  const t = useTranslations('planReview');

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="plan-proposal-views">
      {/* The PANE HEADER (Part VIII §2). The plan page's canvas pane had none —
          `PlanningWorkspace`'s `canvas` slot is filled edge to edge — so one was
          decided there rather than found. It sits at the TOP of the pane, ABOVE
          the band, because the bar governs the BODY and the band is not part of
          the body: Part VI decided the step STACKS above the canvas, and a
          switcher under the band would make the band read as chrome belonging to
          one of the two views.
          (Part VIII reserved this bar's right end for Part IX's Show-changes
          control; Part IX RELEASED it and put that control in the canvas's own
          cluster, so the bar holds the switcher alone.) */}
      <div className="flex h-11 shrink-0 items-center border-b border-(--el-border) bg-(--el-surface) px-(--spacing-control-x)">
        <Segmented<PlanViewDto>
          label={t('viewSwitchAria')}
          value={view}
          onChange={onViewChange}
          options={[
            { value: 'list', label: t('viewList'), icon: <List className="size-3.5" /> },
            {
              value: 'canvas',
              label: t('viewCanvas'),
              icon: <Workflow className="size-3.5" />,
            },
          ]}
        />
      </div>
      {band}
      <div className="min-h-0 flex-1">
        {/* A SECOND BODY in the same pane, never a re-drawing of the first. The
            canvas answers where a proposal LANDS; the list answers what exactly
            is being approved, which is a question about a SET. */}
        {view === 'list' ? (
          <PlanProposalList items={items} outcome={outcome} />
        ) : (
          <PlanReviewCanvas
            items={items}
            projectKey={projectKey}
            version={version}
            outcome={outcome}
            ariaLabel={ariaLabel}
          />
        )}
      </div>
    </div>
  );
}
