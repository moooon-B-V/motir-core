'use client';

import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CirclePlay,
  Flag,
  Folder,
  FolderOpen,
  FolderPen,
  Layers,
  MapPin,
} from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemTypeChip } from '@/components/issues/WorkItemTypeChip';
import { RunTonePill } from '@/components/runs/RunTonePill';
import type { RunTone } from '@/lib/runs/timeline';
import { isManualReadyItem } from '@/lib/dto/ready';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { IssueType } from '@/lib/issues/parentRules';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import { FolderPathLabel } from '@/components/planning/FolderPlacement';
import { canvasStatusLabel, canvasStatusMeta } from '@/lib/workflows/canvasStatusMeta';

// The CONTENT of a WORK-ITEM node on the project roadmap (Subtask 7.20.2 /
// MOTIR-1194) — the card the reusable `ProjectRoadmapCanvas` renders for an epic /
// story / subtask (the tier/design/plan stations render as `StationCard` instead).
// It owns the card's look in the shipped StationCard language: the kind-coloured
// tile (the kind's `--el-type-*` hue via `IssueTypeIcon`), the identifier + title,
// the status pill, and the drill affordance when the node has children. The canvas
// owns the box, position, drag, and the search-match ring. Tokens only.
//
// Subtask 7.20.6 / MOTIR-1013 adds two roadmap markers: a per-container PROGRESS
// meter (the subtree done/total bar on an epic/story) and the "YOU ARE HERE"
// current-position marker (the active node — its status pill is replaced by an
// accent map-pin pill, the card gets an accent border, and `aria-current="step"`).
//
// MOTIR-1379 (follow-up) adds the "NOT IN SPRINT" marker for the sprint-scoped
// roadmap: drilling into a committed root reveals its WHOLE subtree, so a
// drilled-in node the sprint did not commit to is shown with a DOTTED border + a
// receded `--el-muted` fill + a "not in sprint" tag and NO shadow (flat) — an
// informational signal, kept deliberately distinct from the red cross-blocked
// (broken-dependency) chrome. The shadow is dropped so a hard offset-shadow style
// (neo-brutalism) can't add a solid frame that reads as a second border.

/** A container's subtree done/total roll-up — the data behind the progress meter
 *  (Subtask 7.20.6 / MOTIR-1013). Mirrors `RoadmapProgress` in `roadmapClient`;
 *  kept local so the presentational node has no upward data dependency. */
export interface WorkItemProgress {
  done: number;
  total: number;
  /** The CI-verified subset of `total` (Subtask 7.10.6 / MOTIR-894) — the
   *  Story-level "N of M verified" count. Optional + `0` until CI feeds signals
   *  back; a positive value renders a small verified badge beside the meter. */
  verified?: number;
}

export interface WorkItemNodeData {
  id: string;
  identifier: string;
  title: string;
  kind: IssueType;
  /** The workflow status KEY, verbatim (bug MOTIR-3170). This used to be a CLOSED
   *  six-member union — `todo · in_progress · in_review · blocked · done ·
   *  cancelled` — which every producer had to satisfy, so each of them coerced
   *  anything else to `todo` and the canvas confidently drew a card whose pull
   *  request was open as **To Do**. Statuses are DATABASE-defined (a project
   *  configures its own workflow), so no union here can ever be total; the chip
   *  resolves a treatment at render time instead. */
  status: string;
  /** The status's own display LABEL, as the level read carried it from the
   *  project's workflow. Optional: a node built without it (onboarding / a plan
   *  preview) falls back to the translated catalog label for a default key. */
  statusLabel?: string | null;
  /** The status's lifecycle CATEGORY — the chip's fallback tone for a key the
   *  canvas has no per-key treatment for (see `statusLabel`). */
  statusCategory?: StatusCategoryDto | null;
  /** The work TYPE (Story 2.7) — drives the MANUAL / human chip (MOTIR-1642 /
   *  8.8.36), paired with `executor` via the shipped `isManualReadyItem`
   *  predicate. Optional: a node built without it (onboarding / plan preview)
   *  simply shows no chip. */
  type?: WorkItemTypeDto | null;
  /** WHO executes the work — `human` (or `type: 'manual'`) makes the node
   *  human-gated, so it carries the Manual chip. Optional (see `type`). */
  executor?: ExecutorDto | null;
  assigneeName?: string | null;
}

// The per-status treatment map that used to live here now lives in
// `lib/workflows/canvasStatusMeta.ts` (bug MOTIR-3170), for the reason the note
// on `WorkItemNodeData.status` gives: it was a `Record<ClosedUnion, …>`, which
// the compiler certifies as TOTAL against a union that is itself the
// hand-authored subset — so the one check that could have caught a missing
// status was structurally unable to. The resolver is shared with `PlanItemNode`
// so the canvas has ONE status vocabulary rather than three.

/**
 * The kind TILE's fill, by kind — declared ONCE, here (MOTIR-6296, absorbing bug
 * MOTIR-6196). `PlanItemNode` used to declare an identical copy, which is how a
 * proposal and a committed card became two drawings; both now draw their tile
 * through {@link WorkItemCardShell}, and `plan-item-node-shell.test.tsx` fails a
 * second declaration of this map anywhere under `components/`.
 */
export const KIND_TINT: Record<IssueType, string> = {
  epic: 'bg-(--el-tint-rose)',
  story: 'bg-(--el-tint-mint)',
  task: 'bg-(--el-tint-sky)',
  bug: 'bg-(--el-tint-peach)',
  subtask: 'bg-(--el-tint-lavender)',
};

/**
 * ONE workflow status as a canvas chip. The KEY is whatever the project's
 * workflow defines; `label` / `category` are the status's own identity as the
 * level read carried them (bug MOTIR-3170). A key with no per-key treatment
 * takes its category's tone, and one with neither takes the neutral chip — it
 * never impersonates To Do.
 */
export function WorkItemStatusPill({
  status,
  label = null,
  category = null,
}: {
  status: string;
  label?: string | null;
  category?: StatusCategoryDto | null;
}) {
  const meta = canvasStatusMeta(status, category);
  const Icon = meta.icon;
  const tStatus = useTranslations('labels.defaultStatus');
  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) px-1.5 py-0.5 text-[11px] font-medium ${meta.tint} ${meta.text}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {canvasStatusLabel(status, label, tStatus)}
    </span>
  );
}

/** One work item's disposition in a dispatch RUN, already resolved to a tone and
 *  a localized label by the consumer (MOTIR-3895). */
export interface RunLegBadge {
  tone: RunTone;
  label: string;
}

export function WorkItemNode({
  item,
  drillable = false,
  crossBlocked = false,
  crossBlockedSprint = false,
  notInSprint = false,
  progress = null,
  here = false,
  ready = false,
  runLeg = null,
}: {
  item: WorkItemNodeData;
  /** Has children — clicking DRILLS in; show the affordance. */
  drillable?: boolean;
  /** Blocked by an off-level dependency — flag it (MOTIR-1331). In project scope a
   *  bad-plan tangle; in sprint scope an out-of-sprint, not-done dependency. */
  crossBlocked?: boolean;
  /** Sprint scope (MOTIR-1379): the cross-blocked flag reads "blocker not in
   *  sprint" instead of the project-scope "blocked elsewhere" (MOTIR-1568). The
   *  copy names the out-of-sprint BLOCKER, not the card itself (which IS an
   *  in-sprint member) — distinct from the neutral `notInSprint` membership tag
   *  which reads "not in sprint" about the node (MOTIR-1582). The copy itself is
   *  resolved from the `roadmap.canvas.node` i18n catalog, not passed in. */
  crossBlockedSprint?: boolean;
  /** NOT a member of the active sprint (MOTIR-1379 follow-up) — sprint scope only.
   *  A drilled-in node under a committed root that the sprint did not itself
   *  commit to. An INFORMATIONAL, non-error signal (unlike `crossBlocked`, which is
   *  a real dependency problem): the card takes a DOTTED border + a receded
   *  `--el-muted` fill + a small "not in sprint" tag and NO shadow (flat), so the
   *  committed unit stays visually distinct from the rest of its subtree. Dropping
   *  the shadow keeps a hard offset-shadow style (neo-brutalism) from adding a solid
   *  frame that would double the dotted edge. The louder `crossBlocked` / `here`
   *  chromes win; the tag still shows alongside `here`. */
  notInSprint?: boolean;
  /** Subtree done/total roll-up → a thin progress meter on a container node
   *  (Subtask 7.20.6 / MOTIR-1013). `null` (a leaf) or a `0`-total → no meter. */
  progress?: WorkItemProgress | null;
  /** The current-position node ("you are here", the active epic at the road's
   *  start) — its status pill becomes an accent map-pin pill, the card gets an
   *  accent border, and it carries `aria-current="step"` (Subtask 7.20.6 /
   *  MOTIR-1013). */
  here?: boolean;
  /** READY to start (MOTIR-1417) — a startable, fully-unblocked node. Its status
   *  pill becomes the success "Ready" pill and the card gets a whole-card
   *  `--el-tint-mint` wash (MOTIR-1422). Suppressed on the "you are here" node (its
   *  accent treatment wins). */
  ready?: boolean;
  /**
   * THIS WORK ITEM'S DISPOSITION IN A RUN (MOTIR-3895) — the run modal's canvas
   * pane, and nothing else, supplies it.
   *
   * ⚠️ RESOLVED BY THE CONSUMER, not here, for the same reason `originCrumbLabel`
   * is: the tone comes from `lib/runs/timeline.ts`'s `DISPOSITION_TONE` (total
   * over the enum, so nothing invents one) and the label is localized copy, and
   * this node has neither map nor translator. Absent on every other surface, so
   * the roadmap and onboarding canvases render exactly as before.
   */
  runLeg?: RunLegBadge | null;
}) {
  const t = useTranslations('roadmap.canvas');
  // MANUAL / HUMAN work-type chip (MOTIR-1642 / 8.8.36): a human-gated node — the
  // SHIPPED `executor === 'human' || type === 'manual'` predicate the ready-list
  // *Show instruction* keys on (8.8.10) — carries a "Manual" chip so a person
  // scanning the roadmap spots what needs THEM. Reuses the shipped `WorkItemTypeChip`
  // (no new visual) on the BODY identifier line, so it never crowds the status row or
  // fights a state chrome (design/roadmap/node-worktype.*, MOTIR-1641). Nodes built
  // without type/executor (onboarding / plan preview) show no chip.
  const isManual = isManualReadyItem({ type: item.type ?? null, executor: item.executor ?? null });
  const showMeter = progress !== null && progress.total > 0;
  const pct = showMeter ? Math.round((progress.done / progress.total) * 100) : 0;
  // The ready treatment is suppressed on the "you are here" frontier (its accent
  // treatment is the louder, must-not-miss signal) — MOTIR-1417.
  const showReady = ready && !here;
  // DONE + READY card styles (MOTIR-1422) — both carried IN THE CARD body so they
  // survive zoom-out (the old 3px ready bar vanished) and read as opposites:
  // READY = a whole-card mint wash; DONE = a distinct `--el-tint-sky` card + struck title.
  // The accent "you are here" and the red cross-blocked flag are louder than both.
  const showDone = item.status === 'done' && !here && !crossBlocked;
  const showReadyWash = showReady && !crossBlocked;
  // NOT-IN-SPRINT chrome (MOTIR-1379 follow-up) — an informational, NON-error
  // signal, deliberately never the red cross-blocked chrome. The louder
  // `crossBlocked` (a real dependency problem) and `here` (the frontier) own the
  // fill, so the receded `--el-muted` fill applies only OUTSIDE them; the "not in
  // sprint" tag itself still shows alongside `here` (only the red cross-blocked
  // flag suppresses it, to avoid a double tag).
  const notInSprintChrome = notInSprint && !crossBlocked && !here;
  const showNotInSprintTag = notInSprint && !crossBlocked;
  const nodeState = crossBlocked
    ? 'cross-blocked'
    : here
      ? 'here'
      : showDone
        ? 'done'
        : showReadyWash
          ? 'ready'
          : notInSprintChrome
            ? 'not-in-sprint'
            : 'normal';
  return (
    <WorkItemCardShell
      // The current-position node carries `aria-current="step"` (the design's
      // "You are here" semantics — a step in the journey), so AT it reads as the
      // active waypoint, not just a visual ring.
      aria-current={here ? 'step' : undefined}
      // A stable state hook for the canvas + E2E (MOTIR-1422): cross-blocked / here /
      // done / ready / not-in-sprint / normal — the card's authoritative visual state.
      data-node-state={nodeState}
      // A raised `--el-surface` tile on the recessed `--el-canvas` board (the canvas
      // background, MOTIR-1362): the fill is clearly lighter than the board, and the
      // crisp border + `--shadow-card` lift defines the edge. The active "you are
      // here" node takes an accent border; a cross-story tangle wins the border (the
      // louder signal). MOTIR-1422 adds the card-level DONE (`--el-tint-sky`) + READY
      // (mint wash) fills — distinct palette tints, legible zoomed out, unlike the old
      // 3px ready edge.
      // NOT-IN-SPRINT (MOTIR-1379 follow-up): a DOTTED border (the "provisional, not
      // committed" edge) + a receded `--el-muted` fill + the "not in sprint" tag, and
      // crucially NO shadow. The shadow is dropped because the active `data-style`
      // owns elevation: under neo-brutalism `--shadow-*` is a HARD offset block that
      // reads as a solid frame — a dotted border ON TOP of that offset frame was the
      // "dotted + solid" double border. With no shadow the card is FLAT (reinforcing
      // "not committed") and the dotted edge is the only border, in every style. The
      // louder `crossBlocked` / `here` chromes still win (they keep their solid
      // borders + shadows).
      frameClassName={
        crossBlocked
          ? 'border-(--el-danger) bg-(--el-surface) shadow-[0_0_0_1px_var(--el-danger)_inset] shadow-(--shadow-card)'
          : here
            ? 'border-(--el-accent) bg-(--el-surface) shadow-(--shadow-card)'
            : showDone
              ? notInSprintChrome
                ? 'border-dotted border-(--el-border-strong) bg-(--el-tint-sky)'
                : 'border-(--el-border) bg-(--el-tint-sky) shadow-(--shadow-subtle)'
              : showReadyWash
                ? notInSprintChrome
                  ? 'border-dotted border-(--el-border-strong) bg-(--el-tint-mint)'
                  : 'border-(--el-border) bg-(--el-tint-mint) shadow-(--shadow-card)'
                : notInSprintChrome
                  ? 'border-dotted border-(--el-border-strong) bg-(--el-muted)'
                  : 'border-(--el-border) bg-(--el-surface) shadow-(--shadow-card)'
      }
      // TOP ROW — the compact STATUS chip (top-left) — REPLACED by the accent
      // "You are here" pill on the current-position node, the success "Ready" pill
      // on a ready-to-start node, or the neutral "Done" pill on a done node — and
      // the cross-link tag (or the has-children hint) pushed to the right. The
      // READY treatment is now the whole-card mint wash (MOTIR-1422), not a 3px bar.
      statusRow={
        <>
          {here ? (
            <HerePill />
          ) : showReady ? (
            <ReadyPill />
          ) : showDone ? (
            <DonePill />
          ) : (
            <WorkItemStatusPill
              status={item.status}
              label={item.statusLabel ?? null}
              category={item.statusCategory ?? null}
            />
          )}
          {/* The run DISPOSITION (MOTIR-3895), beside the work item's own status and
              never instead of it: they are different facts. The status is what the
              work item IS; the disposition is what THIS RUN did with it, and a run
              that skipped a work item has not changed its status at all. */}
          {runLeg ? (
            <RunTonePill tone={runLeg.tone} compact>
              {runLeg.label}
            </RunTonePill>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* The "not in sprint" tag (MOTIR-1379 follow-up) — a QUIET neutral chip,
                NOT the red cross-blocked flag: this node is simply outside the
                committed sprint, not a broken dependency. Suppressed when the card is
                cross-blocked (its own flag already reads "not in sprint" in sprint
                scope), so the card never carries two tags. */}
            {showNotInSprintTag ? (
              <span
                data-testid="not-in-sprint-tag"
                // A plain neutral chip (no border) — a bordered tag would read as an
                // extra border on the card, and a border style would fight the active
                // `data-style`. The card's muted fill + this tag carry the signal.
                className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-secondary)"
              >
                <CircleDashed className="size-3" aria-hidden="true" />
                {t('node.notInSprint')}
              </span>
            ) : null}
            {crossBlocked ? (
              <CrossBlockedFlag sprint={crossBlockedSprint} />
            ) : drillable ? (
              <ChevronRight
                className="size-4 shrink-0 text-(--el-text-muted)"
                aria-hidden="true"
                data-testid="drill-affordance"
              />
            ) : null}
          </div>
        </>
      }
      kind={item.kind}
      identifier={item.identifier}
      // The Manual chip rides the id line (right-aligned), NOT the crowded status
      // row — a hairline `--el-border` lifts it off every node fill. Composed from
      // the shipped WorkItemTypeChip; manual-only by design.
      identifierTrailing={
        isManual ? (
          <WorkItemTypeChip
            type="manual"
            className="ml-auto shrink-0 gap-1 border-(--el-border) px-1.5 py-0 text-[10.5px]"
          />
        ) : null
      }
      title={item.title}
      titleStruck={showDone}
      // PROGRESS METER (Subtask 7.20.6 / MOTIR-1013) — a thin done/total bar on a
      // container node: `--el-success` fill over the `--el-muted` track, with the
      // count beside it. Leaves (no `progress`) and `0`-total containers omit it.
      footer={
        showMeter ? (
          <div className="mt-2 flex shrink-0 items-center gap-2" data-testid="progress-meter">
            <div
              role="progressbar"
              aria-label={t('subtreeProgress')}
              aria-valuenow={progress.done}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-(--radius-badge) bg-(--el-muted)"
            >
              <div
                className="h-full rounded-(--radius-badge) bg-(--el-success)"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0 text-xs font-medium text-(--el-text-secondary) tabular-nums">
              {progress.done} / {progress.total}
            </span>
            {/* CI-verified count (Subtask 7.10.6 / MOTIR-894) — the "N of M verified"
                roll-up beside the done/total meter; shown only once CI has verified
                at least one descendant. */}
            {progress.verified && progress.verified > 0 ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-(--el-success) tabular-nums"
                title={t('verifiedCount', { count: progress.verified })}
              >
                <Check className="size-3" aria-hidden="true" />
                {progress.verified}
              </span>
            ) : null}
          </div>
        ) : item.assigneeName ? (
          <span className="shrink-0 truncate pt-1.5 text-right text-xs text-(--el-text-secondary)">
            {item.assigneeName}
          </span>
        ) : null
      }
    />
  );
}

/**
 * THE CARD SHELL (MOTIR-6296 · design Part XXIII §23.4) — the ONE drawing of a
 * canvas card, shared by a committed work item (`WorkItemNode`) and a proposal
 * (`PlanItemNode`). It owns everything the two must agree on: the fixed
 * `NODE_W × NODE_H` footprint (the deterministic layout spaces rows by NODE_H, so
 * a long title can never grow the card into the row below), the `--radius-card`
 * radius, the 1px border weight, the `p-3.5` padding, the status row, the kind
 * tile (through the one {@link KIND_TINT}), the identifier line and the title.
 *
 * A caller contributes only what its STATE means: `frameClassName` (border
 * style + colour, fill, shadow, any ring), the status row's contents, a footer
 * (the progress meter, the assignee, a proposal's bottom slot) and an `overlay`
 * — absolutely-positioned decoration drawn over the card (a proposal's outcome
 * spine, the `locked` hatch). That is the compose-don't-redraw seam
 * `PlanningTargetNode` already uses, one level down: a proposal is a LAYER over
 * this shell, never a second card.
 *
 * Everything else (`data-*`, `aria-*`) is spread onto the root, so each caller
 * keeps its own state hooks.
 */
export function WorkItemCardShell({
  frameClassName,
  statusRow,
  kind,
  identifier,
  identifierTrailing = null,
  title,
  titleStruck = false,
  titleSingleLine = false,
  footer = null,
  overlay = null,
  ...rootProps
}: {
  /** The state's border style + colour, fill, shadow (and any ring). The shell
   *  adds the shared `border` weight, radius and padding itself. */
  frameClassName: string;
  /** The top row's CONTENTS — the shell draws the row. */
  statusRow: ReactNode;
  kind: IssueType;
  identifier: ReactNode;
  /** Right of the identifier on its line (the Manual chip). */
  identifierTrailing?: ReactNode;
  title: string;
  /** The struck, secondary-ink title — a done card, a proposed removal. */
  titleStruck?: boolean;
  /** One clean ellipsis instead of the two-line clamp, for a card whose footer
   *  spends the bottom slot (Part XVII §17.2); the full title then rides `title`. */
  titleSingleLine?: boolean;
  footer?: ReactNode;
  /** Absolutely-positioned decoration over the card (spine, hatch). */
  overlay?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style' | 'title' | 'children'>) {
  return (
    <div
      {...rootProps}
      // Fixed height (= the layout's NODE_H) so a long, two-line title can never
      // grow the card into the row below it — the deterministic layout spaces rows
      // by NODE_H, so the card must honour it exactly. Compact: tight padding + a
      // small status chip, no wasted space (MOTIR-1194 review).
      style={{ width: NODE_W, height: NODE_H }}
      className={`relative flex flex-col overflow-hidden rounded-(--radius-card) border p-3.5 ${frameClassName}`}
    >
      <div className="flex shrink-0 items-center gap-2">{statusRow}</div>

      {/* BODY — the kind tile + identifier + title; the title gets the room. */}
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) ${KIND_TINT[kind]}`}
          aria-hidden="true"
        >
          <IssueTypeIcon type={kind} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-(--el-text-secondary)">{identifier}</span>
            {identifierTrailing}
          </div>
          <span
            // Tagged so a decorator that WRAPS this node (the plan-change diff
            // frame's `remove` state) can strike the title without redrawing the
            // card — the same struck-title language `titleStruck` uses below.
            data-node-title
            // MOTIR-5459 — `block` rides WITH `truncate`, never beside `line-clamp-2`:
            // `truncate` needs a block box for its ellipsis, while `.block` is emitted
            // after `.line-clamp-2` and would take `display` back from its
            // `-webkit-box`, leaving the two-line clamp inert.
            title={titleSingleLine ? title : undefined}
            className={`mt-0.5 ${titleSingleLine ? 'block truncate' : 'line-clamp-2'} text-sm leading-snug font-semibold ${
              // `--el-text-secondary`, never `--el-text-muted`, for the struck
              // title (MOTIR-4260): a proposed removal paints `bg-(--el-muted)`,
              // where the muted ink is 4.12:1 and secondary 6.18:1.
              titleStruck ? 'text-(--el-text-secondary) line-through' : 'text-(--el-text)'
            }`}
          >
            {title}
          </span>
        </div>
      </div>

      {footer}
      {overlay}
    </div>
  );
}

/** The "You are here" current-position pill (Subtask 7.20.6 / MOTIR-1013) — an
 *  accent map-pin chip in the StationCard's active-state language; it takes the
 *  status pill's slot on the active node. */
function HerePill() {
  const t = useTranslations('roadmap.canvas.node');
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-accent) px-1.5 py-0.5 text-[11px] font-medium text-(--el-accent-text)">
      <MapPin className="size-3" aria-hidden="true" />
      {t('here')}
    </span>
  );
}

/** The "Ready" pill (MOTIR-1417) — a success-toned chip in the status slot for a
 *  ready-to-start node (a to-do whose blockers are all done). Replaces the dim
 *  "To do" pill; the card also gets a `--el-success` left accent bar. */
function ReadyPill() {
  const t = useTranslations('roadmap.canvas.node');
  return (
    <span
      data-testid="ready-pill"
      // A white chip on the mint card wash (MOTIR-1422) — the success icon carries
      // the "go" hue; the chip surface lifts off the tint for contrast.
      className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-(--el-border) bg-(--el-page-bg) px-1.5 py-0.5 text-[11px] font-medium text-(--el-text-strong)"
    >
      <CirclePlay className="size-3 text-(--el-success)" aria-hidden="true" />
      {t('ready')}
    </span>
  );
}

/** The "Done" stamp (MOTIR-1422) — a SOLID DARK chip. Deliberately NOT
 *  success-green (so it can't be confused with the ready highlight) AND far heavier
 *  than the light "To do" chip (so done can't be confused with todo — the redo). The
 *  card itself takes a distinct `--el-tint-sky` fill + a struck title, so done
 *  reads as the opposite of ready's mint-forward wash. */
function DonePill() {
  const tStatus = useTranslations('labels.defaultStatus');
  return (
    <span
      data-testid="done-pill"
      className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-text-secondary) px-1.5 py-0.5 text-[11px] font-medium text-(--el-text-inverted)"
    >
      <CheckCircle2 className="size-3 text-(--el-text-inverted)" aria-hidden="true" />
      {tStatus('done')}
    </span>
  );
}

/**
 * The "blocked elsewhere" CHIP (MOTIR-1331) — the dependent's half of the
 * off-level treatment, beside the `cross` arrow and the ghost anchor. In sprint
 * scope it names the out-of-sprint BLOCKER instead (MOTIR-1568).
 *
 * EXPORTED (bug MOTIR-5387) because a PROPOSED card carries the same signal on
 * the plan-review canvas (`PlanItemNode`). The chip is a reserved canvas
 * language, and two copies of it would be two things a reader has to recognise
 * as one.
 */
export function CrossBlockedFlag({ sprint = false }: { sprint?: boolean }) {
  const t = useTranslations('roadmap.canvas.node');
  return (
    <span
      data-testid="cross-blocked-flag"
      className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-danger-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-danger-on-surface)"
    >
      <Flag className="size-3" aria-hidden="true" />
      {t(sprint ? 'blockerNotInSprint' : 'blockedElsewhere')}
    </span>
  );
}

/**
 * The GHOST ANCHOR for an off-level blocker (MOTIR-1331) — a dashed-red, hatched
 * chip that names the blocker the canvas can't show a node for ("PROD-42 ↗ in
 * Story X"), so the red cross-story edge has a target.
 */
export function GhostAnchor({
  identifier,
  title,
  parentTitle,
  folderPath = null,
  outOfSprint = false,
}: {
  identifier: string;
  /** The blocker's title; falls back to the localized default when absent. */
  title?: string | null;
  parentTitle?: string | null;
  /** The blocker's effective FOLDER path, root first (Bug MOTIR-5710 · MOTIR-5739,
   *  design sheet 7). When set it REPLACES the parent line: a filed blocker lives
   *  behind a folder door, and that door is what the reader has to find. */
  folderPath?: readonly string[] | null;
  /** Sprint scope (MOTIR-1379): the anchor reads "not in this sprint" — the
   *  blocker is an out-of-sprint, not-done dependency, not a cross-story tangle. */
  outOfSprint?: boolean;
}) {
  const t = useTranslations('roadmap.canvas.anchor');
  const tFolders = useTranslations('folders');
  return (
    <div
      // Fixed height (= the layout's NODE_H) + `overflow-hidden`, the SAME fixed-box
      // contract WorkItemNode honours: the deterministic layout spaces every row by
      // NODE_H, and the anchor is the only variable-height node — so a long parent
      // (a Motir story title of 80–120 chars) must not be able to grow the box past
      // its row and overlap the card beneath it in the same column (MOTIR-1581).
      style={{
        width: 200,
        height: NODE_H,
        backgroundImage:
          'repeating-linear-gradient(135deg, var(--el-surface), var(--el-surface) 7px, var(--el-danger-surface) 7px, var(--el-danger-surface) 9px)',
      }}
      className="overflow-hidden rounded-(--radius-card) border border-dashed border-(--el-danger) p-(--spacing-card-padding)"
    >
      <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-(--el-danger-on-surface)">
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
        {identifier}
      </span>
      <span className="mt-1 line-clamp-1 text-xs text-(--el-text-secondary)">
        {title ?? t('defaultTitle')}
      </span>
      {outOfSprint ? (
        <span className="mt-0.5 line-clamp-1 text-xs text-(--el-danger)">
          {t('notInThisSprint')}
        </span>
      ) : folderPath && folderPath.length > 0 ? (
        <span className="mt-0.5 flex min-w-0 text-xs" data-testid="anchor-folder">
          <FolderPathLabel
            path={folderPath}
            max={2}
            lastClassName=""
            srPrefix={tFolders('breadcrumbFolderLabel')}
          />
        </span>
      ) : parentTitle ? (
        <span className="mt-0.5 line-clamp-1 text-xs text-(--el-danger)">
          {t('inParent', { parent: parentTitle })}
        </span>
      ) : (
        <span className="mt-0.5 line-clamp-1 text-xs text-(--el-danger)">{t('elsewhere')}</span>
      )}
    </div>
  );
}

/**
 * The GROUPED node for a root level's NON-EPIC rows (MOTIR-3490; design
 * `design/roadmap/root-non-epic-rows.*`, decisions 2 and 3).
 *
 * The roadmap's root level has never had a notion of KIND — `findProjectTreeLevel`
 * selects on `parentId IS NULL` and nothing else — so a parentless bug, task or
 * story drew on the road beside the epics. This node is where they go instead: one
 * door, and the road stays the epics.
 *
 * It reuses {@link WorkItemNode}'s BOX exactly — same `NODE_W`/`NODE_H`, same
 * `--radius-card` / `--el-border` / `--el-surface` / `--shadow-card` — because it
 * sits on the same grid and must line up with its neighbours. Three slots differ,
 * and each difference is a decision rather than an omission:
 *
 *  - the KIND TILE is neutral `--el-muted` behind a `layers` glyph, NOT an
 *    `--el-type-*` hue: no kind backs this node, and borrowing one would say the
 *    group IS that kind;
 *  - the IDENTIFIER slot carries the COUNT, in the same mono type — it is what
 *    identifies the node, and there is no `MOTIR-<n>` to put there;
 *  - the STATUS PILL and the PROGRESS METER are ABSENT. Those are the two places
 *    a synthetic node is most tempted to say something ("Mixed", "7 open", a
 *    done/total bar) and each would be a claim about work this node does not own.
 *    The meter in particular means "this container's own work is N% done", and the
 *    group is a drawer, not a unit of work — its members are unrelated.
 *
 * Presentational: the consumer owns the partition and the drilled level.
 */
export function LevelGroupNode({ count }: { count: number }) {
  const t = useTranslations('roadmap.canvas.group');
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      data-node-state="group"
      data-testid="level-group-node"
      aria-label={t('aria', { count })}
      className="relative flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-3.5 shadow-(--shadow-card)"
    >
      {/* TOP ROW — no status pill (the group has none); the drill chevron alone,
          in the slot every other node puts it in. */}
      <div className="flex shrink-0 items-center gap-2">
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <ChevronRight
            className="size-4 shrink-0 text-(--el-text-muted)"
            aria-hidden="true"
            data-testid="drill-affordance"
          />
        </div>
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-muted)"
          aria-hidden="true"
        >
          <Layers className="size-4 text-(--el-text-secondary)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-(--el-text-secondary)">
              {count === 1 ? t('countOne') : t('count', { count })}
            </span>
          </div>
          <span
            data-node-title
            className="mt-0.5 line-clamp-2 text-sm leading-snug font-semibold text-(--el-text)"
          >
            {t('title')}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The direct-contents line a FOLDER card carries in its identifier slot (Bug
 * MOTIR-5710 · MOTIR-5741, design decision 3): `794 items` · `1 item` ·
 * `2 folders · 5 items` · `3 folders` · `Empty`. DIRECT, never recursive, and
 * never a status tally — a folder is a place, not a unit of work. Exported so the
 * aria label and the tests read the same sentence the card shows.
 */
export function useFolderContentsLabel(): (childFolderCount: number, itemCount: number) => string {
  const t = useTranslations('roadmap.canvas.folder');
  return (childFolderCount, itemCount) => {
    const items = itemCount === 1 ? t('itemsOne') : t('items', { count: itemCount });
    const folders =
      childFolderCount === 1 ? t('foldersOne') : t('folders', { count: childFolderCount });
    if (childFolderCount > 0 && itemCount > 0) return t('both', { folders, items });
    if (childFolderCount > 0) return folders;
    if (itemCount > 0) return items;
    return t('empty');
  };
}

/**
 * A FOLDER on the roadmap canvas (Bug MOTIR-5710 · MOTIR-5741; design
 * `design/roadmap/roadmap--folder-node.mock.html` sheet 2).
 *
 * It is {@link LevelGroupNode}'s BOX, slot for slot — the same `NODE_W`/`NODE_H`,
 * `--radius-card`, `--el-border`, `--el-surface`, `--shadow-card` — because it sits
 * on the same grid. The tile is the neutral `--el-muted` one behind the lucide
 * `folder` glyph (the `/items` folder vocabulary, MOTIR-5311); the identifier slot
 * carries the DIRECT contents; the title slot carries the name. There is NO status
 * pill, meter or readiness chrome: a folder carries no workflow, and each of those
 * would be a claim about work it does not own. It is always a DOOR (the drill
 * chevron is always drawn), even when empty — an empty folder is a real record a
 * person made, and its card says `Empty` so nobody drills in expecting work.
 *
 * Presentational: the consumer owns the level behind it.
 *
 * `changes` is the PLANNING canvases' one addition (Bug MOTIR-5782; design
 * `design/ai-planning/design-notes.md` Part XVIII decision 3): how many of a
 * pending plan's proposals will sit anywhere beneath this folder. A proposal is
 * drawn on the level where it will SIT, so a closed folder can hold changes the
 * reviewer has not seen; the badge says so, in the top-row slot a folder leaves
 * empty. `/roadmap` has no plan and never passes it.
 */
export function FolderNode({
  name,
  childFolderCount,
  itemCount,
  changes = 0,
}: {
  name: string;
  childFolderCount: number;
  itemCount: number;
  changes?: number;
}) {
  const t = useTranslations('roadmap.canvas.folder');
  const contentsLabel = useFolderContentsLabel();
  const contents = contentsLabel(childFolderCount, itemCount);
  const changesAria =
    changes > 0
      ? changes === 1
        ? t('changesAriaOne')
        : t('changesAria', { count: changes })
      : null;
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      data-node-state="folder"
      data-testid="folder-node"
      aria-label={`${t('aria', { name, contents })}${changesAria ? ` ${changesAria}` : ''}`}
      className="relative flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-3.5 shadow-(--shadow-card)"
    >
      {/* TOP ROW — no status pill (a folder has none); the drill chevron, and on a
          planning canvas the changes badge (the shipped `add` badge's pair). */}
      <div className="flex shrink-0 items-center gap-2">
        {changes > 0 ? (
          <span
            data-testid="folder-changes"
            className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-surface) px-1.5 py-0.5 text-[11px] font-semibold text-(--el-accent-on-surface)"
          >
            <FolderPen className="size-3" aria-hidden="true" />
            {changes === 1 ? t('changesOne') : t('changes', { count: changes })}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <ChevronRight
            className="size-4 shrink-0 text-(--el-text-muted)"
            aria-hidden="true"
            data-testid="drill-affordance"
          />
        </div>
      </div>
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-muted)"
          aria-hidden="true"
        >
          <Folder className="size-4 text-(--el-text-secondary)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-(--el-text-secondary)">{contents}</span>
          </div>
          <span
            data-node-title
            className="mt-0.5 line-clamp-2 text-sm leading-snug font-semibold text-(--el-text)"
          >
            {name}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * An EMPTY folder's drilled level (Bug MOTIR-5710 · MOTIR-5741; design sheet 6) —
 * the canvas's drilled-empty slot with folder copy. The generic `emptyDrilled`
 * ("This node has no children to show") is wrong for a folder, which is a place a
 * person files work into rather than a node with children.
 */
export function FolderEmptyLevel({ name }: { name: string }) {
  const t = useTranslations('roadmap.canvas.folder');
  return (
    <div className="max-w-[24rem] text-center" data-testid="folder-empty-level">
      <FolderOpen className="mx-auto size-8 text-(--el-text-secondary)" aria-hidden="true" />
      <p className="mt-2 text-sm font-semibold text-(--el-text-strong)">{t('emptyTitle')}</p>
      <p className="mt-1 text-sm text-(--el-text-secondary)">{t('emptyDescription', { name })}</p>
    </div>
  );
}

/**
 * The TRUNCATION tile for a level the read could not return whole (MOTIR-3490;
 * design decision 7).
 *
 * `TREE_LEVEL_MAX_TAKE` caps every level read at 200 rows under a key-ASCENDING
 * sort, so overflow discarded the HIGHEST keys — the most recently created epics —
 * with no cursor, no affordance and no error. The level simply stopped, and
 * nothing on the canvas said so. This tile is the saying-so.
 *
 * It is deliberately NOT a door: a drill chevron would promise a level behind it,
 * and what is behind it is more of THIS level. Activating it re-reads the level
 * with the raised ceiling (`?all=1`), which is the "Show all" the design draws.
 * The dashed `--el-border-strong` edge is the canvas's existing vocabulary for
 * "there is more of this than is drawn" — the onboarding init screen's
 * plan-preview cluster ends its epic strip the same way.
 */
export function LevelTruncationTile({ shown, total }: { shown: number; total: number }) {
  const t = useTranslations('roadmap.canvas.more');
  const remaining = Math.max(0, total - shown);
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      data-node-state="truncated"
      data-testid="level-truncation-tile"
      aria-label={t('aria', { shown, total })}
      className="relative flex flex-col items-center justify-center gap-1.5 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-3.5"
    >
      <span className="text-sm font-semibold text-(--el-text-strong)">
        {t('label', { count: remaining })}
      </span>
      <span className="text-xs text-(--el-text-secondary) tabular-nums">
        {t('showing', { shown, total })}
      </span>
      {/* A LABEL, not a nested button. A control drawn inside a canvas card has to
          fight the wrapper's keydown/drag handlers (notes.html #139); the canvas's
          own activation is the affordance, exactly as it is for every other node. */}
      <span className="mt-0.5 rounded-(--radius-badge) border border-(--el-border) bg-(--el-page-bg) px-3 py-0.5 text-xs font-medium text-(--el-text-strong)">
        {t('showAll')}
      </span>
    </div>
  );
}
