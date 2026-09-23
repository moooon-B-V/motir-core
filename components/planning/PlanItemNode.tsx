'use client';

import { AlertTriangle, ArchiveX, ChevronRight, Pencil, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import {
  CrossBlockedFlag,
  GhostAnchor,
  WorkItemStatusPill,
} from '@/components/planning/WorkItemNode';
import type { IssueType } from '@/lib/issues/parentRules';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import type { PlanItemChangeDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import {
  changeToText,
  isFolderPlacementChange,
  PlacementLine,
  PlacementSide,
} from '@/components/planning/FolderPlacement';
import type { StaleReason } from '@/lib/dto/plans';

// The CONTENT of a proposed PlanItem node on the plan-detail canvas (Subtask
// 7.4.5 / MOTIR-847). It draws the SAME compact card language as the shipped
// `WorkItemNode`, layered with the op treatment from the ai-planning design
// (§3 Panel B) — three DISTINCT, non-colliding visual languages that never reuse
// the red dashed/hatched language the canvas reserves for cross-story deps:
//   • add    → dashed ACCENT border + lavender (accent) tint + "add" badge.
//   • modify → the existing node + a solid INFO (sky) ring + "change" badge + an
//              inline old→new diff (old read live, new from the patch; SAME id).
//   • remove → a dimmed, NEUTRAL "will be archived" treatment (muted fill +
//              strike-through title), deliberately not red (archive is reversible).
// Stale items carry a warning badge with the reason. Tokens only; the status pill
// carries TEXT (not colour only); per-kind `IssueTypeIcon`.
//
// ⚠️ A DECIDED plan adds a FOURTH AXIS that CROSSES those three, rather than
// joining them (`design/ai-planning/design-notes.md` Part VI; bug MOTIR-3154).
// Every op can be accepted and every op can be declined, so there are six
// renderings and a fourth `op` member could only express three. The outcome
// therefore rides two channels the op treatments do not use at all — they
// already consume border style, border colour, fill, the ring, opacity and the
// strike:
//   • the op badge gains a second SEGMENT carrying the WORD (`accepted` /
//     `declined`), which is the whole of the meaning; and
//   • a solid spine on the node's inline-start edge, decorative (`aria-hidden`),
//     so the outcome survives a zoom-out where 10.5px chip text does not.
// The spine's two values are the review rail's OWN outcome colours one component
// down (`--el-success` on "Added N items to your backlog"; the neutral on "Plan
// declined"), so this introduces no vocabulary. No reserved canvas language is
// approached: each of those is a border STYLE (dashed pending / dotted skippable
// / dashed not-in-sprint) or a red CHIP (blocked elsewhere), and this is neither.

// ⚠️ THE THIRD COPY OF THE STATUS SET USED TO LIVE HERE, AND IT IS GONE (bug
// MOTIR-3170). It was a six-member literal that coerced anything outside itself
// to `todo`, so a `modify` proposal whose live target sat at `implemented` drew
// on the plan canvas as **To Do** — a confident false statement about a card
// whose pull request was open. The status KEY now travels verbatim to the ONE
// shared chip (`WorkItemStatusPill` → `lib/workflows/canvasStatusMeta.ts`), and
// there is deliberately no mapping left in `components/planning/` to forget to
// update the next time a status is added.
const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);

function toKind(raw: string): IssueType {
  return KNOWN_KINDS.has(raw as IssueType) ? (raw as IssueType) : 'task';
}

const KIND_TINT: Record<IssueType, string> = {
  epic: 'bg-(--el-tint-rose)',
  story: 'bg-(--el-tint-mint)',
  task: 'bg-(--el-tint-sky)',
  bug: 'bg-(--el-tint-peach)',
  subtask: 'bg-(--el-tint-lavender)',
};

function staleReasonLabel(r: StaleReason, t: ReturnType<typeof useTranslations>): string {
  switch (r.code) {
    case 'parent_removed':
      return t('staleParentRemoved');
    case 'blocker_removed':
      return t('staleBlockerRemoved');
    case 'base_revision_drift':
      return t(`staleDrift_${r.change}`);
  }
}

// ⚠️ The node carries NO edit affordance (MOTIR-3084). MOTIR-1370's inline-edit
// pencil and its modal are REMOVED: a proposal is READ — the canvas peek — and
// changed by re-planning, not hand-corrected in a five-field form. The design
// records the supersession in `design/ai-planning/design-notes.md` Part V §3.
/** The plan's decision, once it has one. `null` while the plan is still
 *  `planned` — which is every rendering that shipped before MOTIR-3161. */
export type PlanItemOutcome = 'accepted' | 'declined';

export function PlanItemNode({
  item,
  outcome = null,
  crossBlocked = false,
}: {
  item: PlanReviewItemDto;
  outcome?: PlanItemOutcome | null;
  /**
   * Blocked by a card OFF this level (bug MOTIR-5387) — the dependent's half of
   * the roadmap's off-level treatment, drawn with the roadmap's own chip and in
   * the slot `WorkItemNode` gives it. It is a DEPENDENCY fact, so it crosses
   * every op and outcome rather than joining them: an `add` that will be blocked
   * from another container is exactly the bad plan the legend warns about, and
   * the warning belongs before approve.
   */
  crossBlocked?: boolean;
}) {
  const t = useTranslations('planReview');
  const kind = toKind(item.kind);
  // THE BOTTOM SLOT (Part XVII §17.2, amended by Part XVIII decision 2). A
  // `modify` spends it on its diff line; a proposal naming a DELETED folder spends
  // it on saying so. At most one tenant.
  //
  // ⚠️ A FILED `add` NO LONGER SPENDS IT ON ITS FOLDER (Bug MOTIR-5782). Part XVII
  // drew the placement line because a filed proposal was drawn among the ROOTS —
  // no canvas level was a folder. Both planning canvases now draw it ON its
  // folder's level, where the breadcrumb already says where the reader is
  // standing, so the line would repeat the crumb and cost the title its second
  // line. The LIST body keeps its `in [folder]` fact (§17.3), unchanged.
  const showDiff = item.op === 'modify' && item.changes.length > 0;
  const showPlacement = !showDiff && item.folderMissing;
  // A `remove`'s REASON (MOTIR-6055 · Part XIX §19.5): a remove never spent the
  // slot, so its reason takes it — after a stale folder, which is the one tenant
  // a remove could already have. No reason ⇒ no slot, byte-identical to before.
  const showReason = !showDiff && !showPlacement && item.op === 'remove' && !!item.removeReason;
  const hasSlot = showDiff || showPlacement || showReason;
  // A deleted folder is a STALE fact the staleness read does not report (MOTIR-5415
  // carries it as `folderMissing`), so the node adds its reason beside the shipped ones.
  const staleReasons = item.staleReasons.map((r) => staleReasonLabel(r, t));
  if (item.folderMissing) staleReasons.push(t('staleFolderRemoved'));
  const showStale = item.stale || item.folderMissing;

  // Op-specific frame. None reuses the cross-story red dashed/hatch language.
  const frame =
    item.op === 'add'
      ? 'border border-dashed border-(--el-accent) bg-(--el-tint-lavender) shadow-(--shadow-card)'
      : item.op === 'remove'
        ? // ⚠️ NO `opacity` ON EITHER ARM (MOTIR-4475). A DECIDED `remove` already
          // dropped the fade (Part VI §3, MOTIR-4260); the PENDING one carried
          // `opacity-80` on this same element, which paints the fill — and CSS
          // `opacity` composites the element AND ITS WHOLE SUBTREE against the
          // backdrop, so the frame and every string inside it were mixed at 0.8
          // over the board's `--el-canvas`. Measured on the composed DOM: the
          // title at 3.95:1, the identifier at 3.95:1, the status pill at 3.95:1
          // and the op badge at 3.98:1, all under AA's 4.50 — and all of it
          // SURVIVING MOTIR-4260's re-inking, because opacity scales whatever ink
          // you pick. That is MOTIR-2495's rule at a second site: "no ink choice
          // can fix it", and its remedy is to carry the state as COLOUR.
          //
          // Nothing is lost by removing it, which is what makes colour the whole
          // remedy here rather than half of one. `remove` already speaks through
          // three other channels — the strong border, the muted fill and the
          // strike — and the PENDING/DECIDED distinction is carried by the two
          // signals a decided node ADDS: the outcome spine below and the outcome
          // segment fused onto its op badge. That is exactly how `add` and
          // `modify` distinguish the same two states, and neither of them dims.
          //
          // `tests/components/composed-surface-ink.test.tsx` mounts the pending
          // node on its own `--el-canvas` board and measures the composite, so a
          // re-introduced `opacity-*` on a text-bearing subtree goes red here
          // rather than on somebody's screen.
          'border border-(--el-border-strong) bg-(--el-muted) shadow-(--shadow-subtle)'
        : 'border border-(--el-border) bg-(--el-surface) ring-2 ring-(--el-info) shadow-(--shadow-card)';

  return (
    <div
      // Fixed footprint (= the layout's NODE_W/NODE_H) so a node never grows into
      // the row below — the deterministic layout spaces rows by NODE_H.
      style={{ width: NODE_W, height: NODE_H }}
      className={`relative flex flex-col overflow-hidden rounded-(--radius-card) p-3 ${frame}`}
      data-op={item.op}
      data-outcome={outcome ?? undefined}
      data-testid="plan-item-node"
    >
      {/* The outcome SPINE — decorative reinforcement only; the word in the op
          chip carries the meaning, which is what keeps this off colour-alone and
          discharges 1.4.11 on the bar itself. */}
      {outcome ? (
        <span
          aria-hidden="true"
          data-testid="plan-item-outcome-spine"
          className={`absolute inset-y-0 start-0 w-1 ${
            outcome === 'accepted' ? 'bg-(--el-success)' : 'bg-(--el-text-muted)'
          }`}
        />
      ) : null}
      {/* TOP ROW — the op badge (left) + the status pill / stale flag (right). */}
      <div className="flex shrink-0 items-center gap-2">
        <OpBadge op={item.op} outcome={outcome} t={t} />
        <div className="ml-auto flex items-center gap-1.5">
          {showStale ? (
            <span
              data-testid="stale-badge"
              title={staleReasons.join(' · ')}
              className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-yellow) px-1.5 py-0.5 text-[11px] font-semibold text-(--el-text-strong)"
            >
              <AlertTriangle className="size-3" aria-hidden="true" />
              {t('staleBadge')}
            </span>
          ) : null}
          {item.status ? (
            <WorkItemStatusPill
              status={item.status}
              label={item.statusLabel}
              category={item.statusCategory}
            />
          ) : null}
          {crossBlocked ? (
            <CrossBlockedFlag />
          ) : item.hasChildren ? (
            <ChevronRight
              className="size-4 shrink-0 text-(--el-text-muted)"
              aria-hidden="true"
              data-testid="drill-affordance"
            />
          ) : null}
        </div>
      </div>

      {/* BODY — the kind tile + identifier + title. */}
      <div className="mt-1.5 flex min-h-0 flex-1 items-start gap-2 overflow-hidden">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) ${KIND_TINT[kind]}`}
          aria-hidden="true"
        >
          <IssueTypeIcon type={kind} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-xs text-(--el-text-secondary)">
            {item.identifier ?? t('newItem')}
          </span>
          <span
            // ⚠️ ONE LINE WHENEVER THE BOTTOM SLOT IS SPENT (Part XVII §17.2). The
            // node is a fixed 280 × 124: a two-line title plus the key plus a 16px
            // slot does not fit, and the body's `overflow-hidden` cut the second
            // title line through its middle — which a `modify`'s diff line already
            // did before any folder existed. One clean ellipsis, the full title in
            // `title`.
            // MOTIR-5459 — `block` rides WITH `truncate`, never beside `line-clamp-2`:
            // `truncate` needs a block box for its ellipsis, while `.block` is emitted
            // after `.line-clamp-2` and would take `display` back from its
            // `-webkit-box`, leaving the two-line clamp inert.
            title={hasSlot ? item.title : undefined}
            className={`mt-0.5 text-sm leading-snug font-semibold ${hasSlot ? 'block truncate' : 'line-clamp-2'} ${
              // MOTIR-4260 — `--el-text-secondary`, not `--el-text-muted`: the
              // `remove` frame six elements up paints `bg-(--el-muted)`, where
              // the muted ink is 4.12:1 in light (AA is 4.5) and secondary is
              // 6.18:1. Secondary clears AA on every background in both themes,
              // so this ink does not have to know which frame the node drew.
              // It is also what `design/ai-planning`'s `.node.remove .ttl`
              // specified; the implementation had drifted. The `line-through`
              // is unchanged — it is the second signal for `removed`, and a
              // strike RULE is a graphic rather than text.
              item.op === 'remove' ? 'text-(--el-text-secondary) line-through' : 'text-(--el-text)'
            }`}
          >
            {item.title}
          </span>
        </div>
      </div>

      {/* MODIFY diff — a compact old→new line (the first change; "+N" when more). */}
      {showDiff ? <DiffLine changes={item.changes} t={t} /> : null}
      {showPlacement ? (
        <PlacementLine folderPath={item.folderPath} folderMissing={item.folderMissing} />
      ) : null}
      {showReason ? <ReasonLine reason={item.removeReason!} label={t('removeReason')} /> : null}
    </div>
  );
}

/** The remove's reason on ONE line — the node is a glance; the list row and the
 *  peek carry it in full, and so does `title` here. Written by the planner for
 *  the reviewer, so it is shown verbatim, never translated. */
function ReasonLine({ reason, label }: { reason: string; label: string }) {
  return (
    <div
      data-testid="remove-reason"
      className="mt-1.5 flex shrink-0 items-center gap-1 overflow-hidden text-xs text-(--el-text-secondary)"
    >
      <span className="shrink-0 font-medium text-(--el-text-secondary)">{label}</span>
      <span className="truncate text-(--el-text)" title={reason}>
        {reason}
      </span>
    </div>
  );
}

/**
 * The op badge, with the OUTCOME fused to its trailing edge once the plan is
 * decided — so the chip reads `op × outcome` (Part VI §3).
 *
 * Segment 1 is the SHIPPED op tone, unchanged; segment 2 is the outcome. The
 * word is the whole of the meaning, which is what keeps the decided state off
 * colour-alone (Part I §4's a11y rule) — the spine on the node is decorative
 * reinforcement for a zoom-out, never the signal.
 */
function OpBadge({
  op,
  outcome,
  t,
}: {
  op: PlanReviewItemDto['op'];
  outcome?: PlanItemOutcome | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const seg = 'inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold';
  const opSeg =
    op === 'add'
      ? `${seg} bg-(--el-surface) text-(--el-accent-on-surface)`
      : op === 'remove'
        ? `${seg} bg-(--el-surface) text-(--el-text-secondary)`
        : `${seg} bg-(--el-tint-sky) text-(--el-text-strong)`;
  const glyph =
    op === 'add' ? (
      <Plus className="size-3" aria-hidden="true" />
    ) : op === 'remove' ? (
      <ArchiveX className="size-3" aria-hidden="true" />
    ) : (
      <Pencil className="size-3" aria-hidden="true" />
    );
  const label = op === 'add' ? t('opAdd') : op === 'remove' ? t('opRemove') : t('opModify');

  // Undecided: exactly the shipped badge, byte for byte.
  if (!outcome) {
    return (
      <span className={`${opSeg} rounded-(--radius-badge)`}>
        {glyph}
        {label}
      </span>
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-stretch overflow-hidden rounded-(--radius-badge)"
      data-testid="plan-item-op-chip"
    >
      <span className={opSeg}>
        {glyph}
        {label}
      </span>
      <span
        data-testid="plan-item-outcome"
        className={`${seg} border-s border-(--el-border-soft) ${
          outcome === 'accepted'
            ? 'bg-(--el-tint-mint) text-(--el-text-strong)'
            : 'bg-(--el-muted) text-(--el-text-secondary)'
        }`}
      >
        {outcome === 'accepted' ? t('outcomeAccepted') : t('outcomeDeclined')}
      </span>
    </span>
  );
}

/** The label for a changed field, degrading to the field's own WIRE NAME when
 *  the catalog has no message for it (MOTIR-3151).
 *
 *  The key is INTERPOLATED (`field_<name>`), so nothing checks it at build time:
 *  `buildChanges` grew `storyPoints` / `estimateMinutes` in MOTIR-1532 and the
 *  labels never followed, and with no `getMessageFallback` configured
 *  (`i18n/request.ts`) `t()` renders the KEY PATH — a reader of the approve
 *  screen saw `planReview.field_storyPoints` where a word belongs. `t.has()`
 *  asks the catalog first, so the NEXT field somebody teaches `buildChanges` to
 *  emit degrades to something readable instead of leaking a key. This is the
 *  same fallback the (since retired, MOTIR-4261) `PlanEditsReviewDock` had,
 *  which is why its own gap was cosmetic and this one was not.
 *
 *  The copy itself is still owed — `plan-change-field-labels.test.tsx` fails
 *  when a `PLAN_ITEM_CHANGE_FIELDS` member has no message. */
function fieldLabel(t: ReturnType<typeof useTranslations>, field: string): string {
  const key = `field_${field}`;
  return t.has(key) ? t(key) : field;
}

function DiffLine({
  changes,
  t,
}: {
  changes: PlanItemChangeDto[];
  t: ReturnType<typeof useTranslations>;
}) {
  const first = changes[0]!;
  const more = changes.length - 1;
  // A move into or out of a FOLDER is labelled `Placement` and draws its folder
  // side with the glyph and path (Part XVII §17.4); a work-item → work-item move
  // keeps the shipped `Parent` row byte for byte.
  const placement = isFolderPlacementChange(first) ? first.placement : undefined;
  // A move under a PROPOSED parent names it `New · <title>` (Part XIX §19.3); on
  // the 280px node it may ellipsize, so the full string rides `title`.
  const to = changeToText(first, t('proposedCrumb'));
  return (
    <div
      data-testid="diff-line"
      className="mt-1.5 flex shrink-0 items-center gap-1 overflow-hidden text-xs text-(--el-text-secondary)"
    >
      <span className="shrink-0 font-medium text-(--el-text-secondary)">
        {placement ? t('field_placement') : fieldLabel(t, first.field)}
      </span>
      {placement ? (
        <>
          <PlacementSide
            side={placement.from}
            fallback={first.from}
            max={3}
            className="text-(--el-text-secondary)"
            segmentClassName="line-through"
          />
          <ChevronRight className="size-3 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
          <PlacementSide
            side={placement.to}
            fallback={first.to}
            max={3}
            className="font-medium text-(--el-text)"
          />
        </>
      ) : (
        <>
          {first.from != null ? (
            <span className="truncate text-(--el-text-secondary) line-through">{first.from}</span>
          ) : null}
          <ChevronRight className="size-3 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
          <span className="truncate font-medium text-(--el-text)" title={to ?? undefined}>
            {to ?? '—'}
          </span>
        </>
      )}
      {more > 0 ? (
        <span className="ml-auto shrink-0 text-(--el-text-secondary)">
          {t('moreChanges', { n: more })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The ghost anchor for an off-level blocker that is itself an un-materialized
 * PROPOSAL (bug MOTIR-5387).
 *
 * Such a card has no key by construction, and a placeholder key would assert a
 * work item that does not exist. So the anchor keeps the roadmap's `KEY / title`
 * grammar and puts the proposed word in the key's SLOT — the substitution the
 * breadcrumb already makes (`design/ai-planning/design-notes.md` Part IX §1.3).
 */
export function ProposedBlockerAnchor({ title }: { title: string }) {
  const t = useTranslations('planReview');
  return <GhostAnchor identifier={t('proposedCrumb')} title={title} />;
}
