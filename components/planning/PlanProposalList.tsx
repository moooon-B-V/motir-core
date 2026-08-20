'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';

import { Pill } from '@/components/ui/Pill';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { StatusPill } from '@/components/issues/StatusPill';
import type { IssueType } from '@/lib/issues/parentRules';
import type { PlanItemChangeDto, PlanReviewItemDto } from '@/lib/dto/planReview';

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

function ChangeLines({ changes }: { changes: PlanItemChangeDto[] }) {
  const t = useTranslations('planReview');
  if (changes.length === 0) return null;
  return (
    <dl className="mt-1.5 grid gap-0.5 text-xs">
      {changes.map((change) => (
        <div key={change.field} className="grid grid-cols-[6rem_1fr] items-baseline gap-2">
          <dt className="truncate font-medium tracking-wide text-(--el-text-secondary) uppercase">
            {change.field}
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

function ProposalRow({ item, decided }: { item: PlanReviewItemDto; decided: boolean }) {
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

  return (
    <li
      className={
        'grid grid-cols-[1.125rem_1fr_auto] items-start gap-3 rounded-(--radius-control) ' +
        'px-(--spacing-control-x) py-(--spacing-control-y)'
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
          <span
            className={
              'truncate text-sm font-semibold text-(--el-text)' +
              (item.op === 'remove' ? ' line-through' : '')
            }
          >
            {item.title}
          </span>
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
                <ProposalRow key={item.planItemId} item={item} decided={decided} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
