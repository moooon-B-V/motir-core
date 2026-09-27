import type { ApprovalGate } from '@/generated/prisma/client';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { RepairPullRequestDto } from '@/lib/dto/workItemRepair';
import { routedToDisplayName } from '@/lib/approvalGates/routing';

// THE PURE HALF of a card's to-fix answer (Story MOTIR-6588 · MOTIR-6600). The reads
// live in `fixReasonService`; everything here is a function of what they returned, so
// the priority and the detail can be pinned without a database.

/**
 * The four reasons in PRIORITY order — the first that holds is the one to repair first
 * and the one stored. It is also the enum's declaration order (`WorkItemFixReason`),
 * and a test asserts the two are the same list.
 *
 * Why this order: a queue failure and a conflict both mean the members cannot land AS
 * THEY ARE, and a green re-run fixes neither; a red build usually shares a cause with
 * them and is re-judged by the same push; a reviewer's refusal is last because a push
 * that answers any of the first three also withdraws what they were refusing.
 */
export const FIX_REASON_PRIORITY: readonly WorkItemFixReasonDto[] = [
  'queue_failed',
  'conflicted',
  'ci_failed',
  'changes_requested',
];

/** How long a reviewer's note may run in the row's reason line. */
export const FIX_NOTE_PREVIEW_MAX = 140;

/** The stored answer: both columns, `null` together when there is nothing to repair. */
export interface FixReasonValue {
  fixReason: WorkItemFixReasonDto | null;
  fixDetail: FixDetailDto | null;
}

export const NOTHING_TO_FIX: FixReasonValue = { fixReason: null, fixDetail: null };

const EMPTY_DETAIL: Omit<FixDetailDto, 'repair' | 'affected' | 'total'> = {
  check: null,
  queueReason: null,
  base: null,
  reviewerName: null,
  notePreview: null,
  gate: null,
};

/**
 * The first non-empty line of a reviewer's note, trimmed and cut to
 * {@link FIX_NOTE_PREVIEW_MAX} characters with an ellipsis; null when there is none.
 */
export function notePreviewOf(noteMd: string | null): string | null {
  const line = (noteMd ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > FIX_NOTE_PREVIEW_MAX ? `${line.slice(0, FIX_NOTE_PREVIEW_MAX - 1)}…` : line;
}

/**
 * The PULL-REQUEST reason of a set of members the repair predicate handed over, or
 * null when none of them is failing.
 *
 * Each member is classed by the SAME three facts the predicate admitted it on —
 * `queueExit` (a standing queue failure at its head), `conflicted`, and its own `ci` —
 * so a member is never listed for a reason the predicate did not see. `affected` counts
 * the members carrying the stored reason; `total` is every open member.
 */
export function pullRequestReasonOf(
  members: readonly RepairPullRequestDto[],
  total: number,
): FixReasonValue | null {
  const queued = members.filter((m) => m.queueExit !== null);
  if (queued.length > 0) {
    const exit = queued[0]!.queueExit!;
    return {
      fixReason: 'queue_failed',
      fixDetail: {
        ...EMPTY_DETAIL,
        repair: 'fix',
        check: exit.failingCheckName,
        queueReason: exit.rawReason,
        affected: queued.length,
        total,
      },
    };
  }
  const conflicted = members.filter((m) => m.conflicted);
  if (conflicted.length > 0) {
    return {
      fixReason: 'conflicted',
      fixDetail: {
        ...EMPTY_DETAIL,
        repair: 'fix',
        base: conflicted[0]!.baseRef,
        affected: conflicted.length,
        total,
      },
    };
  }
  const red = members.filter((m) => m.ci === 'failing');
  if (red.length > 0) {
    return {
      fixReason: 'ci_failed',
      fixDetail: {
        ...EMPTY_DETAIL,
        repair: 'fix',
        check: red[0]!.failingChecks[0] ?? null,
        affected: red.length,
        total,
      },
    };
  }
  return null;
}

/**
 * A REFUSAL the card is still waiting on — `changes_requested`, from the gate the
 * reviewer decided.
 *
 * `repair` follows what `motir fix` would do with it: an acceptance Re-run is a repair
 * class of its own (`acceptance_rerun`), so it is `fix`; an approve-to-merge Request
 * changes is not claimable at all, so it is `run`, whose prompt carries the note.
 */
export function changesRequestedOf(
  refusal: {
    gate: 'pull_request_approval' | 'acceptance_result';
    /** The reviewer as a SURFACE draws them — `reviewerNameOf`, never the audit label. */
    reviewerName: string | null;
    noteMd: string | null;
  },
  total: number,
): FixReasonValue {
  return {
    fixReason: 'changes_requested',
    fixDetail: {
      ...EMPTY_DETAIL,
      repair: refusal.gate === 'acceptance_result' ? 'fix' : 'run',
      reviewerName: refusal.reviewerName,
      notePreview: notePreviewOf(refusal.noteMd),
      gate: refusal.gate,
      affected: total,
      total,
    },
  };
}

/**
 * The reviewer's name as the To fix row draws it.
 *
 * ⚠️ NOT `decidedByLabel` AS STORED. That column is the gate's AUDIT string —
 * `Name <email>`, denormalised at decision time so an auditor can resolve a person
 * who has since gone (`lib/approvalGates/routing.ts`) — and an email in the middle of
 * the row's sentence is noise. The live user row answers first, through the same
 * `routedToDisplayName` a routed name uses; a reviewer whose row no longer resolves
 * falls back to the audit label with its `<email>` suffix removed.
 */
export function reviewerNameOf(
  user: { name: string; email: string } | null,
  decidedByLabel: string | null,
): string | null {
  const live = routedToDisplayName(user);
  if (live) return live;
  if (decidedByLabel === null) return null;
  return decidedByLabel.replace(/\s*<[^<>]*>\s*$/, '').trim() || decidedByLabel;
}

/**
 * Does `latest` — the card's most recently DECIDED gate of any kind — still stand as an
 * approve-to-merge Request changes over the set as it is NOW?
 *
 * It is `approvalGatesService.latestRefusalFor`'s question (the last thing a person
 * decided about this card, across kinds), narrowed two ways. To the
 * `pull_request_approval` kind, because a refused design or decision is not a repair of
 * the pull requests. And to a refusal whose `subjectVersion` still names the members'
 * CURRENT heads: a new commit is the answer to a refusal, so from that commit on the
 * card waits on CI like any other, and a set with an unknown head (`currentVersion`
 * null) has no version a refusal could still be about.
 */
export function standingMergeRefusalOf(
  latest: Pick<ApprovalGate, 'kind' | 'state' | 'subjectVersion'> | null,
  currentVersion: string | null,
): boolean {
  if (latest === null || latest.kind !== 'pull_request_approval') return false;
  if (latest.state !== 'changes_requested') return false;
  return currentVersion !== null && latest.subjectVersion === currentVersion;
}

/** The detail's fields, in one fixed order — what {@link sameFixReason} compares. */
const FIX_DETAIL_FIELDS = [
  'repair',
  'check',
  'queueReason',
  'base',
  'reviewerName',
  'notePreview',
  'gate',
  'affected',
  'total',
] as const satisfies readonly (keyof FixDetailDto)[];

/**
 * Two stored answers are the same — the recompute writes only when this is false.
 *
 * ⚠️ FIELD BY FIELD, NEVER BY SERIALISING THE WHOLE OBJECT: the column is `jsonb`, which
 * stores its keys in its own order, so a detail read back never stringifies the way it
 * was written and a string compare would rewrite every card on every event.
 */
export function sameFixReason(
  a: { fixReason: string | null; fixDetail: unknown },
  b: FixReasonValue,
): boolean {
  if (a.fixReason !== b.fixReason) return false;
  if (b.fixDetail === null || a.fixDetail === null || typeof a.fixDetail !== 'object') {
    return (a.fixDetail ?? null) === b.fixDetail;
  }
  const stored = a.fixDetail as Record<string, unknown>;
  return FIX_DETAIL_FIELDS.every((field) => (stored[field] ?? null) === b.fixDetail![field]);
}
