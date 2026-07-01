'use client';

import {
  ArrowUpRight,
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleDot,
  CirclePlay,
  Eye,
  Flag,
  MapPin,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import type { IssueType } from '@/lib/issues/parentRules';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';

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
// drilled-in node the sprint did not commit to is shown with a neutral dotted
// edge + a receded fill + a "not in sprint" tag — an informational signal, kept
// deliberately distinct from the red cross-blocked (broken-dependency) chrome.

/** A container's subtree done/total roll-up — the data behind the progress meter
 *  (Subtask 7.20.6 / MOTIR-1013). Mirrors `RoadmapProgress` in `roadmapClient`;
 *  kept local so the presentational node has no upward data dependency. */
export interface WorkItemProgress {
  done: number;
  total: number;
}

export type WorkItemStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export interface WorkItemNodeData {
  id: string;
  identifier: string;
  title: string;
  kind: IssueType;
  status: WorkItemStatus;
  assigneeName?: string | null;
}

export const STATUS_LABELS: Record<WorkItemStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

interface StatusMeta {
  icon: LucideIcon;
  tint: string;
  text: string;
}

const STATUS_META: Record<WorkItemStatus, StatusMeta> = {
  done: { icon: Check, tint: 'bg-(--el-tint-mint)', text: 'text-(--el-text-strong)' },
  in_progress: { icon: CircleDot, tint: 'bg-(--el-tint-sky)', text: 'text-(--el-text-strong)' },
  in_review: { icon: Eye, tint: 'bg-(--el-tint-lavender)', text: 'text-(--el-text-strong)' },
  blocked: { icon: Ban, tint: 'bg-(--el-tint-peach)', text: 'text-(--el-text-strong)' },
  todo: { icon: CircleDashed, tint: 'bg-(--el-muted)', text: 'text-(--el-text-secondary)' },
  cancelled: { icon: XCircle, tint: 'bg-(--el-muted)', text: 'text-(--el-text-secondary)' },
};

const KIND_TINT: Record<IssueType, string> = {
  epic: 'bg-(--el-tint-rose)',
  story: 'bg-(--el-tint-mint)',
  task: 'bg-(--el-tint-sky)',
  bug: 'bg-(--el-tint-peach)',
  subtask: 'bg-(--el-tint-lavender)',
};

export function WorkItemStatusPill({ status }: { status: WorkItemStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) px-1.5 py-0.5 text-[11px] font-medium ${meta.tint} ${meta.text}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function WorkItemNode({
  item,
  drillable = false,
  crossBlocked = false,
  crossBlockedLabel = 'cross-story',
  notInSprint = false,
  progress = null,
  here = false,
  ready = false,
}: {
  item: WorkItemNodeData;
  /** Has children — clicking DRILLS in; show the affordance. */
  drillable?: boolean;
  /** Blocked by an off-level dependency — flag it (MOTIR-1331). In project scope a
   *  bad-plan tangle; in sprint scope an out-of-sprint, not-done dependency. */
  crossBlocked?: boolean;
  /** The flag's copy — `'cross-story'` (project scope) or `'not in sprint'`
   *  (sprint scope, MOTIR-1379). */
  crossBlockedLabel?: string;
  /** NOT a member of the active sprint (MOTIR-1379 follow-up) — sprint scope only.
   *  A drilled-in node under a committed root that the sprint did not itself
   *  commit to. An INFORMATIONAL, non-error signal (unlike `crossBlocked`, which is
   *  a real dependency problem): the card takes a NEUTRAL dotted edge + a receded
   *  `--el-muted` fill and a small "not in sprint" tag, so the committed unit stays
   *  visually distinct from the rest of its subtree. The louder `crossBlocked` /
   *  `here` chromes win the border; the tag still shows alongside `here`. */
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
}) {
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
  // border, so the dotted neutral edge + receded fill applies only OUTSIDE them;
  // the "not in sprint" tag itself still shows alongside `here` (only the red
  // cross-blocked flag suppresses it, to avoid a double tag).
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
    <div
      // Fixed height (= the layout's NODE_H) so a long, two-line title can never
      // grow the card into the row below it — the deterministic layout spaces rows
      // by NODE_H, so the card must honour it exactly. Compact: tight padding + a
      // small status chip, no wasted space (MOTIR-1194 review).
      style={{ width: NODE_W, height: NODE_H }}
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
      // NOT-IN-SPRINT (MOTIR-1379 follow-up): a NEUTRAL dotted edge marks the card
      // as "part of the subtree, not the committed sprint" — never the red
      // cross-blocked chrome. On a done/ready node the dotted edge rides on top of
      // its status fill; a plain node also recedes to the fainter `--el-muted` fill
      // (lighter than the raised `--el-surface` committed siblings use).
      className={`relative flex flex-col overflow-hidden rounded-(--radius-card) border p-3.5 ${
        crossBlocked
          ? 'border-(--el-danger) bg-(--el-surface) shadow-[0_0_0_1px_var(--el-danger)_inset] shadow-(--shadow-card)'
          : here
            ? 'border-(--el-accent) bg-(--el-surface) shadow-(--shadow-card)'
            : showDone
              ? `${notInSprintChrome ? 'border-dotted ' : ''}border-(--el-border) bg-(--el-tint-sky) shadow-(--shadow-subtle)`
              : showReadyWash
                ? `${notInSprintChrome ? 'border-dotted ' : ''}border-(--el-border) bg-(--el-tint-mint) shadow-(--shadow-card)`
                : notInSprintChrome
                  ? 'border-dotted border-(--el-border-strong) bg-(--el-muted) shadow-(--shadow-subtle)'
                  : 'border-(--el-border) bg-(--el-surface) shadow-(--shadow-card)'
      }`}
    >
      {/* TOP ROW — the compact STATUS chip (top-left) — REPLACED by the accent
          "You are here" pill on the current-position node, the success "Ready" pill
          on a ready-to-start node, or the neutral "Done" pill on a done node — and
          the cross-link tag (or the has-children hint) pushed to the right. The
          READY treatment is now the whole-card mint wash (MOTIR-1422), not a 3px bar. */}
      <div className="flex shrink-0 items-center gap-2">
        {here ? (
          <HerePill />
        ) : showReady ? (
          <ReadyPill />
        ) : showDone ? (
          <DonePill />
        ) : (
          <WorkItemStatusPill status={item.status} />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* The "not in sprint" tag (MOTIR-1379 follow-up) — a QUIET neutral chip,
              NOT the red cross-blocked flag: this node is simply outside the
              committed sprint, not a broken dependency. Suppressed when the card is
              cross-blocked (its own flag already reads "not in sprint" in sprint
              scope), so the card never carries two tags. */}
          {showNotInSprintTag ? (
            <span
              data-testid="not-in-sprint-tag"
              className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-dotted border-(--el-border-strong) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-secondary)"
            >
              <CircleDashed className="size-3" aria-hidden="true" />
              not in sprint
            </span>
          ) : null}
          {crossBlocked ? (
            <span
              data-testid="cross-blocked-flag"
              className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-danger-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-danger-text)"
            >
              <Flag className="size-3" aria-hidden="true" />
              {crossBlockedLabel}
            </span>
          ) : drillable ? (
            <ChevronRight
              className="size-4 shrink-0 text-(--el-text-muted)"
              aria-hidden="true"
              data-testid="drill-affordance"
            />
          ) : null}
        </div>
      </div>

      {/* BODY — the kind tile + identifier + title; the title gets the room. */}
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) ${KIND_TINT[item.kind]}`}
          aria-hidden="true"
        >
          <IssueTypeIcon type={item.kind} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-xs text-(--el-text-faint)">{item.identifier}</span>
          <span
            className={`mt-0.5 line-clamp-2 block text-sm leading-snug font-semibold ${
              showDone ? 'text-(--el-text-muted) line-through' : 'text-(--el-text)'
            }`}
          >
            {item.title}
          </span>
        </div>
      </div>

      {/* PROGRESS METER (Subtask 7.20.6 / MOTIR-1013) — a thin done/total bar on a
          container node: `--el-success` fill over the `--el-muted` track, with the
          count beside it. Leaves (no `progress`) and `0`-total containers omit it. */}
      {showMeter ? (
        <div className="mt-2 flex shrink-0 items-center gap-2" data-testid="progress-meter">
          <div
            role="progressbar"
            aria-label="Subtree progress"
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
          <span className="shrink-0 text-xs font-medium text-(--el-text-muted) tabular-nums">
            {progress.done} / {progress.total}
          </span>
        </div>
      ) : item.assigneeName ? (
        <span className="shrink-0 truncate pt-1.5 text-right text-xs text-(--el-text-muted)">
          {item.assigneeName}
        </span>
      ) : null}
    </div>
  );
}

/** The "You are here" current-position pill (Subtask 7.20.6 / MOTIR-1013) — an
 *  accent map-pin chip in the StationCard's active-state language; it takes the
 *  status pill's slot on the active node. */
function HerePill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-accent) px-1.5 py-0.5 text-[11px] font-medium text-(--el-accent-text)">
      <MapPin className="size-3" aria-hidden="true" />
      You are here
    </span>
  );
}

/** The "Ready" pill (MOTIR-1417) — a success-toned chip in the status slot for a
 *  ready-to-start node (a to-do whose blockers are all done). Replaces the dim
 *  "To do" pill; the card also gets a `--el-success` left accent bar. */
function ReadyPill() {
  return (
    <span
      data-testid="ready-pill"
      // A white chip on the mint card wash (MOTIR-1422) — the success icon carries
      // the "go" hue; the chip surface lifts off the tint for contrast.
      className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-(--el-border) bg-(--el-page-bg) px-1.5 py-0.5 text-[11px] font-medium text-(--el-text-strong)"
    >
      <CirclePlay className="size-3 text-(--el-success)" aria-hidden="true" />
      Ready
    </span>
  );
}

/** The "Done" stamp (MOTIR-1422) — a SOLID DARK chip. Deliberately NOT
 *  success-green (so it can't be confused with the ready highlight) AND far heavier
 *  than the light "To do" chip (so done can't be confused with todo — the redo). The
 *  card itself takes a distinct `--el-tint-sky` fill + a struck title, so done
 *  reads as the opposite of ready's mint-forward wash. */
function DonePill() {
  return (
    <span
      data-testid="done-pill"
      className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-text-secondary) px-1.5 py-0.5 text-[11px] font-medium text-(--el-text-inverted)"
    >
      <CheckCircle2 className="size-3 text-(--el-text-inverted)" aria-hidden="true" />
      Done
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
  outOfSprint = false,
}: {
  identifier: string;
  title: string;
  parentTitle: string | null;
  /** Sprint scope (MOTIR-1379): the anchor reads "not in this sprint" — the
   *  blocker is an out-of-sprint, not-done dependency, not a cross-story tangle. */
  outOfSprint?: boolean;
}) {
  return (
    <div
      style={{
        width: 200,
        backgroundImage:
          'repeating-linear-gradient(135deg, var(--el-surface), var(--el-surface) 7px, var(--el-danger-surface) 7px, var(--el-danger-surface) 9px)',
      }}
      className="rounded-(--radius-card) border border-dashed border-(--el-danger) p-(--spacing-card-padding)"
    >
      <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-(--el-danger-text)">
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
        {identifier}
      </span>
      <span className="mt-1 line-clamp-1 block text-xs text-(--el-text-secondary)">{title}</span>
      {outOfSprint ? (
        <span className="mt-0.5 block text-xs text-(--el-danger)">not in this sprint ↗</span>
      ) : parentTitle ? (
        <span className="mt-0.5 block text-xs text-(--el-danger)">in {parentTitle} ↗</span>
      ) : (
        <span className="mt-0.5 block text-xs text-(--el-danger)">elsewhere in the plan ↗</span>
      )}
    </div>
  );
}
