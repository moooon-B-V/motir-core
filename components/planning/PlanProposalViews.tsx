'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Info, List, Workflow } from 'lucide-react';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import { Segmented } from '@/components/ui/Segmented';
import type { PlanViewDto } from '@/lib/planning/planView';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { addedProposalIds, newlyAddedCount } from '@/lib/planning/livePane';

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
  /**
   * Keep `PlanReviewCanvas` MOUNTED while List shows, hidden and `inert`, so the
   * level a reader drilled to survives Canvas → List → Canvas (Subtask
   * MOTIR-6186; `design-notes.md` Part XXI 21.7).
   *
   * ⚠️ OFF BY DEFAULT, and the default is the point. The plan page's own suite
   * asserts `plan-review-canvas` is ABSENT under List
   * (`tests/components/plan-detail-view-switch.test.tsx`), so a default-on
   * version would change that page — which the lift exists not to do. The
   * planning surface opts in; the plan page does not.
   *
   * `inert` is what makes the hidden copy safe rather than merely invisible: it
   * takes the subtree out of the tab order and out of the accessibility tree, so
   * a keyboard user on List cannot land inside a canvas they cannot see.
   */
  preserveCanvasLevel?: boolean;
  /**
   * THE ARRIVAL HAND-OFF, when a HOST swapped this component in underneath a
   * reader (MOTIR-6155). Forwarded verbatim to `PlanReviewCanvas`; the plan page
   * passes none of it and is unchanged by its existence.
   *
   * Together they are MOTIR-6161's rule surviving a change of pane: the canvas
   * opens on `canvasHeldTrail` rather than the plan's level, starts already
   * `readerHasNavigated`, and so DECLINES `followTo` into the bar's offer instead
   * of moving somebody who chose where to stand.
   */
  canvasHeldTrail?: readonly CanvasCrumb[] | null;
  followTo?: { key: string; trail: readonly CanvasCrumb[] } | null;
  onFollowDeclined?: (key: string) => void;
  readerHasNavigated?: boolean;
  onCanvasLevelChange?: (trail: readonly CanvasCrumb[]) => void;
  /**
   * The plan is being WRITTEN, and this pane is drawing it as it is (MOTIR-6300;
   * design Part XXIII §23.1). The pane is the same one a proposed plan gets — that
   * is the whole design, so the hand-over into the proposed plan swaps nothing —
   * and `live` adds only what a plan being written owes:
   *   · the LIVE MARKER at the header's right end (*Being written*), a polite
   *     status, so a reader looking for Approve is told why it is not there;
   *   · MOTION on the canvas, a changeKey per proposal, and the arrivals count;
   *   · the present-tense empty List, and the rows' entrance;
   *   · ONE announcement per batch of added cards (§23.15).
   * OFF by default. The plan page never passes it, and is unchanged by it.
   */
  live?: boolean;
  /** Three reads in a row have failed (§23.10): the marker says so. The last
   *  snapshot stays drawn — nothing else changes. Read only while `live`. */
  liveFailing?: boolean;
  /**
   * The plan was DISCARDED before it finished (§23.12): the plan page's own
   * sentence (`planReview.discardedOutcome`) in the band slot, and the List's
   * empty statement without its *"Declining ends it"* body. `band`, if given,
   * wins the slot.
   */
  discarded?: boolean;
  /** Forwarded verbatim to `PlanReviewCanvas` (bug MOTIR-6223): the planning
   *  surface opts in to the *"Plan is in … · Go there"* offer when the plan sits
   *  beside the reader's level. The plan page passes nothing and is unchanged. */
  offerPlanElsewhere?: boolean;
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
  preserveCanvasLevel = false,
  canvasHeldTrail = null,
  followTo = null,
  onFollowDeclined,
  readerHasNavigated = false,
  onCanvasLevelChange,
  live = false,
  liveFailing = false,
  discarded = false,
  offerPlanElsewhere = false,
}: PlanProposalViewsProps) {
  const t = useTranslations('planReview');
  const showingList = view === 'list';
  const announcement = useBatchAnnouncement(items, live);
  const canvas = (
    <PlanReviewCanvas
      items={items}
      projectKey={projectKey}
      version={version}
      outcome={outcome}
      ariaLabel={ariaLabel}
      heldTrail={canvasHeldTrail}
      followTo={followTo}
      onFollowDeclined={onFollowDeclined}
      readerHasNavigated={readerHasNavigated}
      onLevelChange={onCanvasLevelChange}
      live={live}
      offerPlanElsewhere={offerPlanElsewhere}
    />
  );
  // THE DISCARDED BAND (§23.12) — the band idiom (`--el-surface-soft` +
  // `--el-border` + `--el-text-strong`), in the plan page's own words.
  const discardedBand = discarded ? (
    <p
      data-testid="plan-live-discarded"
      className="flex shrink-0 items-start gap-2 border-b border-(--el-border) bg-(--el-surface-soft) px-4 py-2.5 text-xs leading-relaxed text-(--el-text-strong)"
    >
      <Info className="mt-px size-3.5 flex-none text-(--el-text-secondary)" aria-hidden="true" />
      <span>{t('discardedOutcome')}</span>
    </p>
  ) : null;

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
        {/* THE LIVE MARKER (§23.1) — the slot Part IX released. A 6px dot and a
            word, STATIC (a permanent loop here is the attention sink the running
            edge warns about). `role="status"`, so *Being written → Reconnecting*
            is heard once. It leaves at the hand-over. */}
        {live ? (
          <span
            data-testid="plan-live-state"
            role="status"
            aria-live="polite"
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-(--el-text-secondary)"
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-(--radius-badge) ${
                liveFailing ? 'bg-(--el-warning)' : 'bg-(--el-status-in-progress)'
              }`}
            />
            {t(liveFailing ? 'liveReconnecting' : 'liveWriting')}
          </span>
        ) : null}
        {/* ONE announcement per batch of added cards (§23.15) — never per card,
            never for a read that added nothing, never for an exit or a deepen. */}
        {live ? (
          <span
            className="sr-only"
            role="status"
            aria-live="polite"
            data-testid="plan-live-announce"
          >
            {announcement ? (
              <span key={announcement.seq}>{t('liveAnnounce', { count: announcement.count })}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      {band ?? discardedBand}
      <div className="relative min-h-0 flex-1">
        {/* A SECOND BODY in the same pane, never a re-drawing of the first. The
            canvas answers where a proposal LANDS; the list answers what exactly
            is being approved, which is a question about a SET. */}
        {showingList ? (
          <PlanProposalList items={items} outcome={outcome} live={live} discarded={discarded} />
        ) : null}
        {preserveCanvasLevel ? (
          // KEPT MOUNTED under List (21.7). The drilled level lives in the
          // canvas's own state, so the only way it can survive a round trip is
          // for the canvas never to unmount. `hidden` would not do: the engine
          // measures its box, and a `display: none` subtree measures zero — so it
          // is taken out of FLOW with `invisible` + `pointer-events-none` while
          // keeping its size, and out of the tab and accessibility trees with
          // `inert`.
          <div
            className={showingList ? 'pointer-events-none invisible absolute inset-0' : 'h-full'}
            // React 19 renders `inert` as a real boolean attribute from a boolean
            // prop; `false` removes it. It is what takes the hidden copy out of the
            // tab order and the accessibility tree, so `aria-hidden` is not doing
            // that job alone.
            inert={showingList}
            aria-hidden={showingList || undefined}
            data-testid="plan-review-canvas-keepalive"
          >
            {canvas}
          </div>
        ) : (
          !showingList && canvas
        )}
      </div>
    </div>
  );
}

/**
 * The announcement of a BATCH (§23.15): how many `add`s the last snapshot brought,
 * with a sequence number so two batches of the same size are both heard. The
 * first snapshot the pane draws is the baseline and announces nothing — nothing
 * ARRIVED while the reader was here. Inert unless `live`.
 */
function useBatchAnnouncement(
  items: readonly PlanReviewItemDto[],
  live: boolean,
): { count: number; seq: number } | null {
  const [state, setState] = useState<{
    items: readonly PlanReviewItemDto[];
    ids: ReadonlySet<string>;
    said: { count: number; seq: number } | null;
  }>(() => ({ items, ids: addedProposalIds(items), said: null }));
  if (items !== state.items) {
    const ids = addedProposalIds(items);
    const count = live ? newlyAddedCount(state.ids, ids) : 0;
    setState({
      items,
      ids,
      said: count > 0 ? { count, seq: (state.said?.seq ?? 0) + 1 } : state.said,
    });
  }
  return live ? state.said : null;
}
