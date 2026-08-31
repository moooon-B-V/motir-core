'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RotateCw } from 'lucide-react';

import { Pill } from '@/components/ui/Pill';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { StatusPill } from '@/components/issues/StatusPill';
import { ProposalQuickView } from '@/components/planning/ProposalQuickView';
import type { IssueType } from '@/lib/issues/parentRules';
import type { PlanItemChangeDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanItemOpDto } from '@/lib/dto/plans';

// The plan detail's LIST body (MOTIR-3239, built to
// `design/ai-planning/design-notes.md` Part VIII §3 and
// `plan-detail-list-view.mock.html` panel 2).
//
// A SECOND BODY in the same pane, never a re-drawing of the first. The canvas
// answers where a proposal LANDS; this answers what exactly is being approved,
// which is a question about a SET.
//
// Presentational: every field comes off the `PlanReviewItemDto`s the island
// already holds, so this adds no read, no route and no service method. The row is
// the shipped `ChildList` row GRAMMAR — kind glyph, identifier, title, a facts
// line, a right-hand chip — so a reader who has read the Children list has read
// this one, and the shape routes through `--radius-control` /
// `--spacing-control-x|y` exactly as that row does.

/** The three sections, in the order Part VIII draws them. Each renders only when
 *  it is non-empty. */
const SECTIONS = [
  {
    op: 'add',
    key: 'listAdds',
    decidedKey: 'listCreated',
    chip: 'opAdd',
    decidedChip: 'opCreated',
  },
  {
    op: 'modify',
    key: 'listUpdates',
    decidedKey: 'listApplied',
    chip: 'opModify',
    decidedChip: 'opApplied',
  },
  {
    op: 'remove',
    key: 'listArchives',
    decidedKey: 'listArchived',
    chip: 'opRemove',
    decidedChip: 'opArchived',
  },
] as const;

// ⚠️ TOTAL over `PlanItemOpDto`, at BUILD time (MOTIR-3242). The list renders one
// section per op, so an op the sections do not cover is a proposal that silently
// never appears — under a plan item COUNT that includes it, which is exactly the
// self-contradiction the three-section decision exists to prevent. A fourth op
// must therefore be a compile error here, not a row nobody sees. Same shape as
// `lib/dto/plans.ts`'s `PLAN_DECISION_REASONS`.
type AssertTotalListOps = [Exclude<PlanItemOpDto, (typeof SECTIONS)[number]['op']>] extends [never]
  ? true
  : never;
const _planListOpsTotal: AssertTotalListOps = true;
void _planListOpsTotal;

const KNOWN_KINDS: readonly IssueType[] = ['epic', 'story', 'task', 'bug', 'subtask'];

function issueTypeOf(kind: string): IssueType {
  return (KNOWN_KINDS as readonly string[]).includes(kind) ? (kind as IssueType) : 'task';
}

/** The op chip — panel B's own vocabulary, unchanged. The list introduces no
 *  fourth language for the same three facts. */
function OpChip({ op, decided }: { op: string; decided: boolean }) {
  const t = useTranslations('planReview');
  const section = SECTIONS.find((s) => s.op === op);
  if (!section) return null;
  // ⚠️ The CHIP carries panel B's own op vocabulary — the SHIPPED
  // `planReview.opAdd` / `opModify` / `opRemove` strings the canvas badges
  // already use (`add` / `change` / `remove`) — and the SECTION HEADER carries
  // the list's own (`Adds` / `Updates` / `Archives`). They are deliberately different words: the header names a GROUP,
  // the chip names what will happen to THIS card, and giving them one string made
  // the row read as an echo of the heading above it.
  //
  // A DECIDED plan's list is a RECORD, in the same tense Part VI gave the canvas,
  // so both move: `created` / `applied` / `archived`.
  const label = t(decided ? section.decidedChip : section.chip);
  if (op === 'add') return <Pill severity="info">{label}</Pill>;
  if (op === 'modify') return <Pill status="planned">{label}</Pill>;
  return <Pill tone="archived">{label}</Pill>;
}

/**
 * A `modify`'s changed fields, old → new — as TWO-LINE TEXT, one line per field.
 *
 * ⚠️ Deliberately NOT the canvas's inline diff overlay. That overlay answers
 * *this node is changing*, inside a node card ~280px wide: it is a SIGNAL. This
 * answers *changing to WHAT*, at the full width of the pane, for a reader
 * deciding whether to approve. So the list is the only surface that spells a
 * change out and the canvas is the only surface that marks a node — neither is
 * built twice.
 *
 * A field whose new value is a BODY (`description`, `explanation`) is NAMED, not
 * quoted: a rewritten description is not a diff a review list can carry, and a
 * truncated one is worse than a pointer.
 */
const BODY_FIELDS = new Set(['description', 'explanation']);

/** The field's human LABEL, not its wire name (MOTIR-3242).
 *
 *  ⚠️ The key is INTERPOLATED (`field_<name>`), so nothing checks it at build
 *  time — which is how the canvas once rendered `planReview.field_storyPoints`
 *  to a person deciding whether to approve a plan, with nothing red anywhere
 *  (MOTIR-3151). `t.has()` degrades to the wire name, which is at least a word;
 *  `tests/components/plan-change-field-labels.test.tsx` is what keeps every
 *  member of `PLAN_ITEM_CHANGE_FIELDS` from needing that fallback, and this list
 *  is the FOURTH surface it now covers rather than a fifth copy of the idea. */
function fieldLabel(t: ReturnType<typeof useTranslations>, field: string): string {
  const key = `field_${field}`;
  return t.has(key) ? t(key) : field;
}

function ChangeLines({ changes }: { changes: PlanItemChangeDto[] }) {
  const t = useTranslations('planReview');
  if (changes.length === 0) return null;
  return (
    <dl className="mt-1.5 grid gap-0.5 text-xs">
      {changes.map((change) => (
        <div key={change.field} className="grid grid-cols-[6rem_1fr] items-baseline gap-2">
          <dt className="truncate font-medium tracking-wide text-(--el-text-secondary) uppercase">
            {fieldLabel(t, change.field)}
          </dt>
          <dd className="min-w-0">
            {BODY_FIELDS.has(change.field) ? (
              <span className="font-semibold text-(--el-text-strong)">
                {t('listBodyRewritten')}
              </span>
            ) : (
              <>
                {change.from ? (
                  <span className="text-(--el-text-secondary) line-through">{change.from}</span>
                ) : null}
                {change.from ? (
                  <span className="px-1.5 text-(--el-text-secondary)" aria-hidden>
                    →
                  </span>
                ) : null}
                <span className="font-semibold text-(--el-text-strong)">{change.to ?? '—'}</span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ProposalRow({
  item,
  decided,
  onOpen,
}: {
  item: PlanReviewItemDto;
  decided: boolean;
  onOpen: (item: PlanReviewItemDto, trigger: HTMLButtonElement) => void;
}) {
  const t = useTranslations('planReview');
  const facts = [
    item.kind,
    item.type,
    item.storyPoints != null ? t('listPoints', { n: item.storyPoints }) : null,
    item.estimateMinutes != null ? t('listMinutes', { n: item.estimateMinutes }) : null,
    item.targetRepo,
  ].filter(Boolean) as string[];

  // WHERE it lands. An INTRA-PLAN parent is marked, because that container does
  // not exist yet either and a reader deciding on this row should know.
  const parent = item.parentTitle ?? item.parentIdentifier;
  const intraPlanParent = item.parentNodeId != null && item.parentIdentifier == null;

  // THE ROW OPENS ITS PROPOSAL (MOTIR-4022, design Part XIII §7).
  //
  // ONE control per row, and it is the TITLE with a stretched `::after` — not a
  // wrapper around the whole row. Three constraints decide that shape and each
  // rules out the obvious alternative:
  //   • it may not become a row of BUTTONS (the shipped listbox-rows a11y
  //     lesson), so there is exactly one interactive element and one tab stop;
  //   • `<button>` takes PHRASING content and the change lines are a `<dl>`,
  //     which is flow — so wrapping the row would be invalid markup, and the
  //     `<dl>` stays a sibling while `after:inset-0` still makes it clickable;
  //   • the ring belongs on the ROW, not on the title's text box, so the focus
  //     outline frames the target — hence `focus-within` on the `<li>`.
  //
  // This is `ChildList`'s row grammar with a `<button>` where its `<a>` is,
  // because a proposal has no page and therefore no `href` — the one place the
  // two rows must differ.
  const name = item.identifier
    ? `${item.identifier} · ${item.title}`
    : `${t('newItem')} · ${item.title}`;

  return (
    <li
      className={
        'relative grid grid-cols-[1.125rem_1fr_auto] items-start gap-3 rounded-(--radius-control) ' +
        'px-(--spacing-control-x) py-(--spacing-control-y) hover:bg-(--el-surface) ' +
        'focus-within:ring-2 focus-within:ring-(--focus-ring-color) active:bg-(--el-surface-soft)'
      }
    >
      <IssueTypeIcon type={issueTypeOf(item.kind)} className="mt-0.5 h-4 w-4" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          {item.identifier ? (
            <span className="shrink-0 font-mono text-xs font-semibold text-(--el-text-secondary)">
              {item.identifier}
            </span>
          ) : (
            // An `add` has NO KEY until approve materializes it. An empty slot in
            // a column of keys reads as a missing value; this reads as the fact.
            <span className="shrink-0 font-mono text-xs font-semibold text-(--el-text-secondary)">
              {t('listNoKey')}
            </span>
          )}
          <button
            type="button"
            aria-label={t('rowOpenAria', { name })}
            onClick={(event) => onOpen(item, event.currentTarget)}
            className={
              'truncate text-left text-sm font-semibold text-(--el-text) ' +
              'after:absolute after:inset-0 hover:underline focus-visible:outline-none' +
              (item.op === 'remove' ? ' line-through' : '')
            }
          >
            {item.title}
          </button>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--el-text-secondary)">
          {facts.length > 0 ? <span>{facts.join(' · ')}</span> : null}
          {parent ? (
            <span>
              {t('listUnder', { parent })}
              {intraPlanParent ? <em className="not-italic"> {t('listProposedParent')}</em> : null}
            </span>
          ) : null}
        </div>
        <ChangeLines changes={item.changes} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* MOVED in the plan's latest revision (Part XII §E). The SHIPPED `Pill`
            in the SHIPPED slot, in front of the op chip — the same cluster the
            stale pill uses, which is also a "something happened to this row"
            marker. It contains its own WORD, so no row's state is carried by
            colour alone, and the op chip is untouched: op says WHICH kind of
            change this is, the pill says THAT this one moved. */}
        {item.revised ? (
          <Pill severity="info">
            <RotateCw className="h-3 w-3" aria-hidden />
            {t('listRevised')}
          </Pill>
        ) : null}
        {item.stale ? (
          <Pill severity="warning">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {t('listStale')}
          </Pill>
        ) : null}
        {item.statusLabel ? (
          <StatusPill
            statusKey={item.status}
            category={item.statusCategory}
            label={item.statusLabel}
          />
        ) : null}
        <OpChip op={item.op} decided={decided} />
      </div>
    </li>
  );
}

export interface PlanProposalListProps {
  items: PlanReviewItemDto[];
  /** A decided plan's list is a RECORD, in the past tense (Part VI / Part VIII §3). */
  decided: boolean;
}

export function PlanProposalList({ items, decided }: PlanProposalListProps) {
  const t = useTranslations('planReview');
  // The SAME read modal the canvas's View pill opens — this body does not gain a
  // second read view, which is the property Part XIII §7 is about. It is mounted
  // HERE rather than lifted to the island because the two bodies are mutually
  // exclusive (only one renders at a time, so the two mounts can never both be
  // open) and the canvas's peek state is a compound one — a proposal OR a
  // committed key — of which a list row can only ever be the first.
  const [peeked, setPeeked] = useState<PlanReviewItemDto | null>(null);
  // ⚠️ FOCUS RETURN IS EXPLICIT HERE, and it is not redundant with the modal's own
  // (MOTIR-4022). The dialog is mounted INSIDE this list, so closing it unmounts
  // the dialog in the same commit that re-renders the rows — and the restore the
  // shipped `Modal` performs on unmount lands before the row it should return to
  // is settled, leaving focus on the body. Measured: a keyboard user who opened a
  // row with Enter and pressed Escape was returned to nothing and had to Tab from
  // the top of the page. Remembering the trigger and refocusing it after the close
  // is one ref and closes that.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openPeek = useCallback((item: PlanReviewItemDto, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setPeeked(item);
  }, []);
  const closePeek = useCallback(() => {
    setPeeked(null);
    // After the close has flushed, so the restore is not racing the unmount.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-sm font-semibold text-(--el-text)">{t('listEmptyTitle')}</p>
          <p className="mt-1 text-xs text-(--el-text-secondary)">{t('listEmptyBody')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3" data-testid="plan-proposal-list">
      {SECTIONS.map((section) => {
        const rows = items.filter((item) => item.op === section.op);
        // ⚠️ ALL THREE SECTIONS, and each only when non-empty. A list showing two
        // ops under a row whose item count includes three is a surface arguing
        // with itself — and that count is on the row that got the reader here.
        // `remove` is rare, not excluded.
        if (rows.length === 0) return null;
        return (
          <section key={section.op} className="mb-4 last:mb-0">
            <h3 className="mb-1.5 flex items-center gap-2 px-(--spacing-control-x) text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
              {t(decided ? section.decidedKey : section.key)}
              <Pill tone="neutral">{rows.length}</Pill>
            </h3>
            <ul className="flex flex-col">
              {rows.map((item) => (
                <ProposalRow
                  key={item.planItemId}
                  item={item}
                  decided={decided}
                  onOpen={openPeek}
                />
              ))}
            </ul>
          </section>
        );
      })}
      <ProposalQuickView item={peeked} onClose={closePeek} />
    </div>
  );
}
