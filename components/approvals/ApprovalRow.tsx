'use client';

import { Children, useCallback, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { CircleDashed, GitPullRequest, Pencil, Scale, Signpost, Video } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { usePeekRowClick } from '@/app/(authed)/items/_components/IssueQuickView';
import { useDecidedGateState } from '@/lib/approvals/decidedGates';
import type {
  ApprovalGateKindDTO,
  ApprovalGateStateDTO,
  ApprovalGateSubjectSummaryDTO,
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
  ChosenOptionDTO,
  ConfirmedRecordDTO,
  DecisionApprovalSubjectSummaryDTO,
  DesignResultSubjectSummaryDTO,
  PullRequestApprovalSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';

// THE APPROVALS ROW — the ONE row both approval lists render: the Workbench's
// To-approve tab (Story MOTIR-4879 · MOTIR-4794) and the Approval records room
// (Story MOTIR-5299 · MOTIR-5302). Built to `design/workbench/approvals-row.mock.html`
// and § 20 of `design/workbench/design-notes.md`, as amended by § 22 (the row OPENS
// the approval overlay), and — for the room — `design/approvals/design-notes.md`
// § The ROW, which COMPOSES this row rather than redrawing it.
//
// ⚠️ EXTRACTED FROM `ApprovalsList.tsx`, NOT WRITTEN BESIDE IT (MOTIR-5302). A
// second row grammar for one object is how two views start disagreeing about what
// a settled gate looks like. An `awaiting` row with no person column renders
// exactly the markup the tab rendered before the move; the room's additions are
// CONDITIONAL ELEMENTS of this one row:
//   · a `decided` record — the decided time in the time cell, *on <version>* in the
//     subject meta, and its state pill in the Decide cell;
//   · a PERSON cell before the Decide cell, only when the list passes `person`
//     (the room's full view: *Asked of* / *Decided by*).
//
// ⚠️ THE ROW OPENS THE APPROVAL FULL SCREEN (Subtask MOTIR-5225). The whole row is a
// real `<a href="/items/<key>">` whose PLAIN PRIMARY click writes the approval
// overlay's address (`?approval=<key>&approvalKind=<kind>`, § 22) with
// `shallowPush`, so the host list never re-renders and closing returns to exactly
// this page of it. A modified, middle or secondary click opens the card in a new
// tab — `usePeekRowClick`'s exact contract. The row writes `approval`, never
// `peek`, so the two cannot collide. A DECIDED row opens it too (§ 22 Panels 8a–8b
// draw the decided states); nothing in either list decides.
//
// ⚠️ THE ROW READS AS A SENTENCE ABOUT THE WORK ITEM (Story MOTIR-5996 · MOTIR-5999;
// `design/workbench/approvals-row--plain-words.mock.html`, design-notes § 28). It
// used to lead with the gate KIND and a host meta line — *Pull requests*,
// `motir-core · #412` — which a non-technical reader had to translate. The first cell
// is now glyph · SENTENCE · key (*Design for {title}*, *{title} is finished*), the
// second cell the DETAILS, and no visible text names a host's vocabulary: repository
// numbers live in the details' `title` attribute. The KIND label is gone from the
// row; `workbench.approvals.kind.*` stays, because the overlay's dialog name reads it.
//
// ⚠️ AN AWAITING ROW DECIDED IN THE OVERLAY SETTLES IN PLACE — it does not vanish
// under the cursor. A row whose gate the overlay decided swaps its Decide cell for
// the state pill, through the signal in `lib/approvals/decidedGates.ts` (§ 22
// planning flag 2) — `router.refresh()` cannot reach a client island.

/**
 * The tab's column set — design-notes § 20, RE-WEIGHTED by § 28 (MOTIR-5999): the
 * sentence is the row's main content now, so the DETAILS track gave it 48px. The
 * room's own-records view uses it unchanged.
 */
export const APPROVALS_GRID_TEMPLATE = 'minmax(12rem,1fr) 220px 88px 132px';

/**
 * The room's FULL-VIEW column set (`design/approvals` § The grid): the tab's, with
 * the details track narrowed to 200px and a 144px person track before the Decide
 * cell (§ 28 re-weighted it from 228px, for the same reason as the tab's).
 */
export const APPROVALS_FULL_VIEW_GRID_TEMPLATE = 'minmax(12rem,1fr) 200px 88px 144px 132px';

/**
 * WHICH SENTENCE each gate kind reads as (§ 28, DECISION 1) — TOTAL over
 * `ApprovalGateKindDTO`, so a new kind is a compile error here rather than a row that
 * silently falls through to a kind label nobody wrote. A kind this build cannot render
 * takes the neutral *Approval for {title}*: the build has no word for it.
 */
const SENTENCE_KEY: Record<ApprovalGateKindDTO, SentenceKey> = {
  design_result: 'design_result',
  acceptance_result: 'acceptance_result',
  pull_request_approval: 'pull_request_approval',
  decision_approval: 'decision_approval',
  decision_choice: 'decision_choice',
  decision_confirmation: 'decision_confirmation',
  // Superseded everywhere (MOTIR-5614): a row reached by URL is one this build does not draw.
  pull_request_merge: 'other',
};

type SentenceKey =
  | 'design_result'
  | 'acceptance_result'
  | 'pull_request_approval'
  | 'decision_approval'
  | 'decision_choice'
  | 'decision_confirmation'
  | 'other';

/** The kinds whose subject this build renders — the rest take the neutral sentence. */
const RENDERABLE_KINDS: ReadonlySet<string> = new Set([
  'design_result',
  'acceptance_result',
  'pull_request_approval',
  'decision_approval',
  'decision_choice',
  'decision_confirmation',
]);

/** The sentence a row reads as: its kind's, or the neutral one for a kind not drawn. */
function sentenceKeyOf(kind: ApprovalGateKindDTO): SentenceKey {
  return RENDERABLE_KINDS.has(kind) ? SENTENCE_KEY[kind] : 'other';
}

/**
 * THE SENTENCE (§ 28, DECISION 1) — one ICU message per kind with a `<title>` tag, so
 * the ORDER is the catalogue's (zh puts the title first) and nothing is concatenated.
 * The frame words are `shrink-0` and never cut; the title TRUNCATES inside the
 * sentence, so *… is finished* is always read. The title is the quick-view door
 * (MOTIR-6001).
 */
function Sentence({
  sentenceKey,
  title,
  identifier,
  quiet,
}: {
  sentenceKey: SentenceKey;
  title: string;
  /** The work item's key — the title door's `href` and the quick view it opens. */
  identifier: string;
  /** A settled or unrenderable row — § 20's settled ink on both halves. */
  quiet: boolean;
}) {
  const t = useTranslations('workbench.approvals.sentence');
  const peekRowClick = usePeekRowClick();
  // The ARGUMENT is `name` and the TAG is `title`: next-intl reads both from one
  // values object, so the two cannot share a name.
  const parts: ReactNode = t.rich(sentenceKey, {
    name: title,
    // THE TITLE IS A DOOR (Story MOTIR-5996 · MOTIR-6001; § 28, DECISION 3): the work
    // item's QUICK VIEW, with the exact contract every title link in the product has —
    // `usePeekRowClick`, so a modified / middle / secondary click keeps the real `href`
    // (the card in a new tab). It sits ABOVE the stretched row door on `z-10`, so the
    // rest of the row still opens the approval. No ring of its own: the row draws
    // `focus-within:ring-2` around itself, and the underline says which door has it.
    title: (chunks) => (
      <Link
        key="title"
        href={`/items/${identifier}`}
        onClick={(e) => peekRowClick(e, identifier)}
        className={cn(
          'relative z-10 min-w-0 truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none',
          quiet ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
        )}
      >
        {chunks}
      </Link>
    ),
  });
  return (
    <span className="flex min-w-0 items-center gap-1 text-sm">
      {/* The frame words keep the catalogue's own spaces, so the sentence's TEXT reads
          *Design for Pricing page* (copy, a screen reader, a text locator); the space
          at a flex item's edge collapses visually, and `gap-1` does the spacing. */}
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
  );
}

/** What one row renders: a live question, or a decided record. */
export type ApprovalRowRecord =
  | { section: 'awaiting'; row: ApprovalQueueRowDto }
  | { section: 'decided'; row: ApprovalRecordDecidedRowDto }
  /**
   * HELD — the row left the awaiting set while the reader was looking at it, and
   * this surface does not know where it went (Story MOTIR-5238 · MOTIR-5242;
   * `design/workbench/design-notes.md` § 26, DECISION 1).
   *
   * ⚠️ IT IS A THIRD SECTION RATHER THAN AN `awaiting` ROW WITH A FLAG, because
   * it answers the state question differently from both of the others. A
   * `decided` row carries the state it reached; an `awaiting` row reaches one
   * through the announcement store when THIS reader decides it. A held row has
   * neither: the tab reads `state = awaiting`, so all the surface knows is that
   * the row is no longer in the set. Drawing a state it cannot read would be the
   * surface guessing, and `approved` / `changes requested` / `withdrawn` are
   * three different pieces of news.
   */
  | { section: 'held'; row: ApprovalQueueRowDto };

/** Relative time — "4 days", in the active locale; the absolute date goes on hover. */
function useRelativeLabel(): (iso: string) => string {
  const locale = useLocale();
  return (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    const hours = Math.round(ms / 3_600_000);
    const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
    // Clamped at 0 in both units: a clock skew must not render "in 2 hours" on a
    // list of things that have already happened.
    return hours < 48
      ? fmt.format(-Math.max(hours, 0), 'hour')
      : fmt.format(-Math.max(Math.round(hours / 24), 0), 'day');
  };
}

/**
 * Open a row's approval over the page the list is on.
 *
 * The host page's own query — the tab, the page of the list — is kept, so the
 * overlay's close lands back on exactly it.
 */
function useOpenApproval(): (row: {
  workItem: { identifier: string };
  kind: ApprovalGateKindDTO;
}) => void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (row) => {
      const qs = searchParams.toString();
      shallowPush(
        withApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`, {
          itemKey: row.workItem.identifier,
          kind: row.kind,
        }),
      );
    },
    [pathname, searchParams],
  );
}

/** A row's glyph: the shipped design-type mark for the one registered kind. */
function KindGlyph({ kind }: { kind: ApprovalGateKindDTO }) {
  if (kind === 'pull_request_approval') {
    // A LIVE kind's mark (design-notes § 23, Story MOTIR-4909 · MOTIR-5485): the
    // pull-request glyph in the accent ink — never the unregistered row's faint
    // dashed circle, which says the kind is not built.
    return (
      <GitPullRequest className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
    );
  }
  if (kind === 'acceptance_result') {
    // A story's acceptance receipt (MOTIR-4950): the recording's mark in the STORY
    // hue — the question is about the story, so the row reads as one.
    return <Video className="h-4 w-4 shrink-0 text-(--el-type-story)" aria-hidden />;
  }
  if (kind === 'decision_choice') {
    // The choice TYPE's own mark and hue (MOTIR-5897; `approvals-row--choice.mock.html`) —
    // a choice gate is only ever raised on a `type: choice` card.
    return <Signpost className="h-4 w-4 shrink-0 text-(--el-type-choice)" aria-hidden />;
  }
  if (kind === 'decision_approval' || kind === 'decision_confirmation') {
    // A decision to CONFIRM takes the same mark (MOTIR-5961; `approvals-row--decision-
    // confirm.mock.html`) — it is raised only on a `type: decision` card; its KIND label,
    // *Confirm decision*, is what tells the two apart in one list.
    // The decision TYPE's own mark and hue (MOTIR-5679; `design/workbench` § 27) — exactly
    // as a design row takes the design type's pencil, so the reader already knows it.
    return <Scale className="h-4 w-4 shrink-0 text-(--el-type-decision)" aria-hidden />;
  }
  return kind === 'design_result' ? (
    // `lib/issues/workItemTypeMeta.ts`'s own glyph + hue for `design` — a design
    // result IS a design, so the reader already knows this mark.
    <Pencil className="h-4 w-4 shrink-0 text-(--el-type-design)" aria-hidden />
  ) : (
    // Colourless, and deliberately NOT another kind's mark: this row exists to
    // say the kind is not built yet. `--el-text-faint` is legal here because the
    // glyph is `aria-hidden` and the words beside it carry the meaning.
    <CircleDashed className="h-4 w-4 shrink-0 text-(--el-text-faint)" aria-hidden />
  );
}

/**
 * The pull-request SET an approve-and-merge gate asks about (design-notes § 23, as
 * § 28 amends it): the REPOSITORIES by name — *In motir-core, motir-ai* — two in full,
 * three or more the first two and then *+n more*. ⚠️ No host numbering in the visible
 * text (§ 28, DECISION 2): a GitLab team calls these something else, and a reader who
 * is not a developer should not have to translate. The cell's `title` carries every
 * member as `owner/name · #n`, in the set's canonical order, for the reader who asks.
 */
function PullRequestSetLine({ subject }: { subject: PullRequestApprovalSubjectSummaryDTO }) {
  const t = useTranslations('workbench.approvals.pullRequest');
  const names = subject.members.map((member) => member.repo.split('/').pop() ?? member.repo);
  const repos =
    names.length > 2
      ? `${names.slice(0, 2).join(t('separator'))}${t('moreSeparator')}${t('more', { count: names.length - 2 })}`
      : names.join(t('separator'));
  return (
    <span
      className="truncate text-xs text-(--el-text-secondary)"
      title={subject.members.map((member) => `${member.repo} · #${member.number}`).join(', ')}
    >
      {t('repos', { repos })}
    </span>
  );
}

/**
 * THE DECISION'S SUBJECT LINE (Story MOTIR-4907 · Subtask MOTIR-5679; `design/workbench`
 * § 27, Panels 7a–7c). Read from the capture's summary — NO host call per row, so the
 * title is the file name's (`titleFromDecisionPath`, Panel 7b) and the row never waits on
 * GitHub to draw. An unresolvable decision still lists, and says why in words.
 */
function DecisionSubjectLine({ subject }: { subject: DecisionApprovalSubjectSummaryDTO }) {
  const t = useTranslations('workbench.approvals.decisionSubject');
  const pr = `${subject.repo} · #${subject.number}`;
  if (subject.outcome === 'one' && subject.path) {
    return (
      <span
        className="truncate text-xs text-(--el-text-secondary)"
        title={
          subject.blobSha
            ? t('title', { path: subject.path, blob: subject.blobSha.slice(0, 7) })
            : subject.path
        }
      >
        {subject.title ? `${subject.title} · ${subject.path}` : subject.path}
      </span>
    );
  }
  // The pull request moves to the `title` (§ 28, DECISION 2) — the visible line
  // says only why the decision cannot be approved.
  const line =
    subject.outcome === 'several'
      ? t('several', { count: subject.documentCount })
      : subject.outcome === 'none'
        ? t('none')
        : t('unreadable');
  return (
    <span className="truncate text-xs text-(--el-text-secondary)" title={pr}>
      {line}
    </span>
  );
}

/** What the row says about the thing being decided, per kind. */
function SubjectMeta({
  subject,
  decidedVersion,
  chosenOption,
  decided,
}: {
  subject: ApprovalGateSubjectSummaryDTO | null;
  /** Set on a DECIDED record: the version the decision was made against. */
  decidedVersion?: string | null;
  /** Set on a DECIDED CHOICE: what was picked, off the immutable row (MOTIR-5897). */
  chosenOption?: ChosenOptionDTO | null;
  /** Set on a DECIDED record: its state and, for a confirmed decision, the record stamp. */
  decided?: { state: ApprovalGateStateDTO; confirmedRecord: ConfirmedRecordDTO | null };
}) {
  const t = useTranslations('workbench.approvals');
  const tConfirm = useTranslations('approvalGate.decisionConfirm');
  // A DECIDED CHOICE names its pick from the RECORD, never from the body — which may
  // have changed, or stopped parsing, since. It is read before the subject check for
  // exactly that reason: a chosen option is still a fact about a body that is gone.
  if (chosenOption) {
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">
        {t.rich('choiceDecided', {
          label: () => <span className="font-medium text-(--el-text)">{chosenOption.label}</span>,
          bestFor: chosenOption.bestFor,
        })}
      </span>
    );
  }
  if (subject === null) {
    // The gate's subject no longer resolves — a DIFFERENT fact from not-built-yet
    // (design-notes § 20). The first is a feature that has not shipped; the
    // second is a gate worth withdrawing, and collapsing them would report a
    // shipped kind as unbuilt.
    return <span className="truncate text-xs text-(--el-text-secondary)">{t('subjectGone')}</span>;
  }
  if (subject.kind === 'pull_request_approval') {
    // The SET names the decision for a live question AND for a decided record: its
    // version is `owner/name#n@sha,…`, whose first 8 characters identify nothing, so
    // the record keeps the set line rather than the design result's *on <version>*.
    return <PullRequestSetLine subject={subject} />;
  }
  if (subject.kind === 'acceptance_result' && decidedVersion === undefined) {
    // THE RECORDING the question is about (MOTIR-4950): how many chapters it walks
    // through, and the commit the recorded run was at.
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">
        {t('acceptanceMeta', {
          chapters: subject.chapterCount,
          version: subject.commitSha ? subject.commitSha.slice(0, 8) : t('noVersion'),
        })}
      </span>
    );
  }
  if (subject.kind === 'decision_choice') {
    // A waiting choice: how many options and the question (MOTIR-5897). A decided one
    // that picked nothing — *None of these* — says so; its pick returned above.
    return (
      <span className="truncate text-xs text-(--el-text-secondary)" title={subject.question}>
        {decidedVersion !== undefined
          ? t('choiceNoneChosen', { count: subject.optionCount })
          : t('choiceMeta', { count: subject.optionCount, question: subject.question })}
      </span>
    );
  }
  if (subject.kind === 'decision_confirmation') {
    // A DECISION TO CONFIRM (MOTIR-5961; `approvals-row--decision-confirm.mock.html`): a
    // waiting one names its changes, how much it supersedes and the decision's first line;
    // a decided one says what happened — the record read from the STAMP.
    const count = subject.supersedesCount;
    const line =
      decided?.state === 'overturned'
        ? tConfirm('row.overturned', { count })
        : decided?.state === 'approved'
          ? decided.confirmedRecord?.kind === 'attachment'
            ? tConfirm('row.confirmedWith', { count })
            : tConfirm('row.confirmedWithout', { count })
          : tConfirm('row.awaiting', {
              changes: subject.changes.map((change) => tConfirm(`change.${change}`)).join(' · '),
              count,
              decision: subject.decision,
            });
    return (
      <span className="truncate text-xs text-(--el-text-secondary)" title={subject.decision}>
        {line}
      </span>
    );
  }
  if (subject.kind === 'decision_approval') {
    // The DOCUMENT names the decision for a live question and a decided record alike: the
    // version is `owner/name:path@blob`, whose first 8 characters identify nothing.
    return <DecisionSubjectLine subject={subject} />;
  }
  if (decidedVersion !== undefined) {
    // A RECORD says WHICH bytes were decided (`design/approvals` § The ROW,
    // addition 3): the first 8 characters, the whole value on hover. The tab's
    // meta reads the subject's CURRENT sha, which is wrong for a decision made
    // against an earlier one.
    return (
      <span
        className="truncate text-xs text-(--el-text-secondary)"
        title={decidedVersion ?? undefined}
      >
        {decidedVersion
          ? t.rich('decidedOn', {
              version: decidedVersion.slice(0, 8),
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })
          : t('noVersion')}
      </span>
    );
  }
  // ⚠️ `pull_request_merge` HAS NO ARM HERE ANY MORE (MOTIR-5615; the delta mock
  // `design/workbench/approvals-row--one-gate.mock.html`, panel 2). A card holds ONE
  // approve-to-merge gate over its whole delivery set, so there is no per-pull-request
  // row to name: nothing raises the kind (MOTIR-5611), every row it left is superseded
  // (MOTIR-5614), and the one row the card contributes is the `pull_request_approval`
  // row above, whose subject names every member. A superseded row reached by URL falls
  // to `notRenderable` below with the rest of the kinds this build does not draw.
  if (subject.kind !== 'design_result' && subject.kind !== 'acceptance_result') {
    return (
      <span className="truncate text-xs text-(--el-text-secondary)">{t('notRenderable')}</span>
    );
  }
  if (subject.kind === 'acceptance_result') return null;
  const design: DesignResultSubjectSummaryDTO = subject;
  return (
    <span className="truncate text-xs text-(--el-text-secondary)">
      {t('subjectMeta', {
        files: design.assetCount,
        version: design.commitSha ? design.commitSha.slice(0, 8) : t('noVersion'),
      })}
    </span>
  );
}

/**
 * A Decide-cell pill NEVER WRAPS (§ 28, DECISION 4, added on review 2026-09-22):
 * *Changes requested* fits the 132px track on one line, and a pill allowed to shrink
 * in its `min-w-0` cell broke onto two and doubled the row.
 */
const DECIDE_PILL = 'whitespace-nowrap';

/** The state pill a SETTLED row carries in its Decide cell. */
function StatePill({ state, kind }: { state: ApprovalGateStateDTO; kind: ApprovalGateKindDTO }) {
  const t = useTranslations('approvalGate.state');
  // A CHOICE that was answered reads *Chosen*, not *Approved* — nothing was approved,
  // an option was picked (MOTIR-5897; the frame's own pill says the same).
  const tChoice = useTranslations('approvalGate.choice.state');
  // A decision that was CONFIRMED reads *Confirmed*, not *Approved* (MOTIR-5961).
  const tConfirm = useTranslations('approvalGate.decisionConfirm.state');
  if (state === 'approved' && kind === 'decision_choice') {
    return (
      <Pill severity="success" className={DECIDE_PILL}>
        {tChoice('chosen')}
      </Pill>
    );
  }
  if (state === 'approved' && kind === 'decision_confirmation') {
    return (
      <Pill severity="success" className={DECIDE_PILL}>
        {tConfirm('confirmed')}
      </Pill>
    );
  }
  switch (state) {
    // ⚠️ THE SAME PILL RECIPES THE FRAME PICKS, so a settled row and the frame
    // in the overlay above it cannot disagree about what a state looks like.
    case 'approved':
      return (
        <Pill severity="success" className={DECIDE_PILL}>
          {t('approved')}
        </Pill>
      );
    case 'changes_requested':
      return (
        <Pill severity="warning" className={DECIDE_PILL}>
          {t('changesRequested')}
        </Pill>
      );
    // A refused DIRECTION (MOTIR-5956) — its OWN pill, never *Changes requested*:
    // nothing will be revised and re-asked. The design's peach, the warning tint.
    case 'overturned':
      return (
        <Pill severity="warning" className={DECIDE_PILL}>
          {t('overturned')}
        </Pill>
      );
    // ⚠️ COLOURLESS, and that is the design's decision rather than a fallback.
    // `superseded` is written by the PRODUCT, never by a person, so a tinted
    // pill would let the audit read a withdrawn question as somebody's answer.
    // `tone="archived"` is the frame's own choice for the same row.
    case 'superseded':
      return (
        <Pill tone="archived" className={DECIDE_PILL}>
          {t('withdrawn')}
        </Pill>
      );
    /* v8 ignore next 2 -- UNREACHABLE: `awaiting` is the one state left, and
       `announceGateDecided` refuses it (`tests/approvals/decidedGates.test.tsx`,
       "does not treat `awaiting` as a decision"). */
    default:
      return null;
  }
}

/** ONE row — and the door to its approval. */
export function ApprovalRow({
  record,
  gridTemplate = APPROVALS_GRID_TEMPLATE,
  person,
  arrived = false,
}: {
  record: ApprovalRowRecord;
  gridTemplate?: string;
  /**
   * The room's full-view PERSON cell (`design/approvals` § The ROW, addition 1).
   * `undefined` renders no cell at all — the tab, and the room's own-records view.
   */
  person?: { label: string; value: string };
  /**
   * This row ARRIVED while the reader was looking (design-notes § 26, Panel 1) —
   * it carries `New` until the next load. A WORD in the shipped neutral `Pill`,
   * never a tint and never an animation: a sudden silent insertion teaches a
   * reader to distrust what they have already read, and a flash moves a surface
   * whose whole promise is that it can be left alone.
   */
  arrived?: boolean;
}) {
  const t = useTranslations('workbench.approvals');
  const tSentence = useTranslations('workbench.approvals.sentence');
  const tGate = useTranslations('approvalGate');
  const relativeLabel = useRelativeLabel();
  const openApproval = useOpenApproval();
  const { row } = record;
  const announcedState = useDecidedGateState(row.gateId);

  // A kind with no renderer, or a subject that is gone, still HAS the door — the
  // overlay draws both (§ 22 Panels 4a / 4b). What they lack is anything to
  // decide, so their Decide cell says why in a colourless pill.
  const gone = row.subject === null;
  const renderable = row.subject !== null && RENDERABLE_KINDS.has(row.subject.kind);
  const sentenceKey = gone ? SENTENCE_KEY[row.kind] : sentenceKeyOf(row.kind);
  // The sentence as plain text — the row door's accessible name reads it (MOTIR-5999).
  const sentenceText = tSentence.markup(sentenceKey, {
    name: row.workItem.title,
    title: (chunks: string) => chunks,
  });
  const settledState: ApprovalGateStateDTO | null =
    record.section === 'decided' ? record.row.state : announcedState;
  // A HELD row is settled with no state to show: it has left the awaiting set,
  // so nothing is left to press, and the surface does not know what it became.
  const settled = settledState !== null || record.section === 'held';
  const timeIso = record.section === 'decided' ? record.row.decidedAt : record.row.waitingSince;

  function onRowClick(e: MouseEvent<HTMLAnchorElement>) {
    // `usePeekRowClick`'s exact condition (`IssueQuickView.tsx`): a modifier or
    // non-primary click keeps its native meaning — the card, in a new tab —
    // which is why the row's href has to be real. Keyboard Enter on the anchor
    // dispatches a primary click, so it takes this same path.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openApproval(row);
  }

  return (
    <div
      role="row"
      data-testid={`approval-row-${row.gateId}`}
      className={cn(
        'group relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0',
        'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
        'md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0 md:py-0 md:pr-4 md:pl-4',
      )}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {/* THE DOOR (§ 22 Panel 9), stretched behind the cells. The one link that
            visibly leaves the list is the work-item cell, which sits ABOVE this
            on `z-10` so it survives.
            ⚠️ NAMED FOR THE ROW, not "Review". The Decide cell carries a visible
            Review button, and two controls with the SAME accessible name in one
            row is a screen reader reading "Review, Review" with no way to tell
            them apart — the same reason `WorkbenchList`'s row link is labelled
            with the item. */}
        <Link
          href={`/items/${row.workItem.identifier}`}
          aria-haspopup="dialog"
          aria-label={t('reviewRow', { key: row.workItem.identifier, sentence: sentenceText })}
          onClick={onRowClick}
          className="absolute inset-0 z-0 focus:outline-none"
        />
        <KindGlyph kind={row.kind} />
        <Sentence
          sentenceKey={sentenceKey}
          title={row.workItem.title}
          identifier={row.workItem.identifier}
          quiet={settled || !renderable}
        />
        {/* The key FOLLOWS the sentence (§ 28, DECISION 1) — `--el-text-secondary`,
            not muted: this row's hover fill is `--el-surface`, where muted is 4.17:1. */}
        <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
          {row.workItem.identifier}
        </span>
        {/* It ARRIVED while the reader was looking (§ 26, Panel 1) — at the END
            of the sentence cell, which at `< md` is the end of the row's first
            line and so is already reading order. */}
        {arrived ? <Pill tone="neutral">{t('live.new')}</Pill> : null}
      </div>

      <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
        <div role="cell" className="flex min-w-0 items-center">
          {/* THE DETAILS (§ 28, DECISION 2) — what the kind used to print after its
              label, now in the track the work-item cell held. */}
          {record.section === 'decided' ? (
            <SubjectMeta
              subject={row.subject}
              decidedVersion={record.row.subjectVersion}
              chosenOption={record.row.chosenOption}
              decided={{ state: record.row.state, confirmedRecord: record.row.confirmedRecord }}
            />
          ) : (
            <SubjectMeta subject={row.subject} />
          )}
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          {/* Relative in the cell, ABSOLUTE in the title — the absolute one is
              what a person quotes. A record's time is when it was DECIDED; a
              question's is how long it has waited. */}
          <span
            className="truncate text-xs text-(--el-text-secondary)"
            title={new Date(timeIso).toLocaleString()}
          >
            {relativeLabel(timeIso)}
          </span>
        </div>
        {person === undefined ? null : (
          <div role="cell" className="flex min-w-0 items-center">
            {/* Below `md` the column header is gone, so the cell carries its own
                label and is never an unlabelled name (`design/approvals` § Narrow). */}
            <span className="truncate text-xs text-(--el-text-secondary)" title={person.value}>
              <span className="md:sr-only">{person.label}: </span>
              {person.value}
            </span>
          </div>
        )}
        <div role="cell" className="flex min-w-0 items-center md:justify-end">
          {settled ? (
            settledState !== null ? (
              <StatePill state={settledState} kind={row.kind} />
            ) : (
              /* HELD, outcome unknown (§ 26, DECISION 1). Colourless for § 20's
                 own reason, one case over: this was written by somebody else's
                 press, and a tinted pill would let a reader take it for their
                 own answer. The row still OPENS — the overlay reads the gate by
                 (item, kind) and shows the real record. */
              <Pill tone="neutral" className={DECIDE_PILL}>
                {t('live.decidedElsewhere')}
              </Pill>
            )
          ) : gone ? (
            /* A SUBJECT THAT IS GONE is not a kind that is unbuilt (§ 20: "look
               alike and are opposite"; corrected on the record by § 28, DECISION 4).
               The kind is known, so the row keeps its kind's sentence and says the
               subject is gone. */
            <Pill tone="archived" className={DECIDE_PILL}>
              {t('subjectGonePill')}
            </Pill>
          ) : !renderable ? (
            <Pill tone="archived" className={DECIDE_PILL}>
              {t('notBuiltYet')}
            </Pill>
          ) : record.section === 'awaiting' && !record.row.canDecide ? (
            /* SEE but not DECIDE — the row states what it is and carries no
               decide control. The door STAYS: what is withheld is the DECISION,
               never the look, and the overlay draws the frame's state `B`. */
            <Pill tone="awaiting" className={DECIDE_PILL}>
              {tGate('state.awaiting')}
            </Pill>
          ) : (
            /* The labelled door a keyboard and a screen reader find (§ 22
               Panel 9) — the same address as the row. */
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-haspopup="dialog"
              className="relative z-10"
              onClick={() => openApproval(row)}
            >
              {t('review')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
