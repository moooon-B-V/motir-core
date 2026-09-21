import type { ApprovalGateErrorTag, PendingPrimary } from '@/lib/approvalGates/errors';
import type { StampComponent } from '@/lib/approvalGates/stamp';

// THE REFUSAL SET THE APPROVAL FRAME RENDERS IN PLACE (Story MOTIR-4778 ·
// Subtask MOTIR-4792; design `design/work-items/approval-control.mock.html`
// panel `H`).
//
// ⚠️ THIS UNION MIRRORS A SHIPPED CLOSED TYPE — IT DOES NOT INVENT A SET. The
// service already decided what can go wrong and named each case
// (`ApprovalGateErrorTag`, `lib/approvalGates/errors.ts`). A second vocabulary on
// the client would let the two drift, and the whole claim of this story is that
// approving means ONE thing everywhere — which has to be true of the failures as
// much as of the verbs. So the discriminant IS the server's tag.
//
// ⚠️ AND IT IS TOTAL OVER THAT TAG, BY CONSTRUCTION rather than by care. The
// `RefusalTagsAreTotal` proof below fails the type-check the moment a tag is
// added to the service and not handled here, which is what keeps a new
// server-side failure from reaching this surface as a blank box. A `string`
// message field would have let anybody add a failure by writing a sentence, in
// whatever tone they were in that day; an exhaustive union makes each new one a
// deliberate addition with drawn copy.
//
// The extra `UNEXPECTED` member is NOT a hole in the totality — it is the arm
// for a transport failure that carries no tag at all (the action threw, the
// network died), which is a different thing from an unmapped tag and needs its
// own copy.

/**
 * One refusal, as the frame renders it. The `tag` is the server's own; the
 * extra fields are what that particular refusal can SAY beyond its name.
 */
export type GateRefusal =
  | {
      tag: 'APPROVAL_GATE_ALREADY_DECIDED';
      /**
       * WHO got there first, when the record can still name them. Null is a real
       * answer — a decider whose account has since been removed leaves
       * `decidedById` null and may leave no surviving label either — so the copy
       * has an unattributed arm rather than a placeholder name.
       */
      decidedByLabel: string | null;
    }
  | {
      tag: 'APPROVAL_GATE_SUPERSEDED';
      /**
       * WHY the question was withdrawn, when the refusing path read it under its
       * lock (Story MOTIR-5652 · Subtask MOTIR-5667; `design-result.md` AMENDMENT
       * 6 Q5). Null is a real answer — the caller had only the state — and the
       * copy then says a true, vaguer sentence rather than guessing one.
       *
       * ⚠️ A FIELD ON AN EXISTING MEMBER, not a new tag: `REFUSAL_TAGS_ARE_TOTAL`
       * is unchanged, which is MOTIR-5232's deliberate compile-break to make and
       * not this card's.
       */
      supersedeCause: string | null;
    }
  | {
      tag: 'APPROVAL_GATE_STALE_SUBJECT';
      /**
       * WHAT MOVED while the reader looked (Story MOTIR-5232 · Subtask MOTIR-5234) —
       * one or more of `subject` · `pull_requests` · `criteria`, in that order. The
       * frame names each (design `approval-control--stale-refusal.mock.html`). Never
       * empty: a refusal with nothing moved would not have been raised.
       *
       * ⚠️ THIS MEMBER IS THE DELIBERATE COMPILE-BREAK the story promised: the frame's
       * `useRefusalCopy` has no arm for it until MOTIR-5235 draws its copy.
       */
      moved: StampComponent[];
    }
  | { tag: 'APPROVAL_GATE_NOT_AUTHORISED' }
  | { tag: 'APPROVAL_GATE_NOT_FOUND' }
  | { tag: 'APPROVAL_GATE_KIND_UNREGISTERED' }
  // No single decision document to approve (MOTIR-5676). Its reason is drawn by the
  // port (MOTIR-5678), not by the refusal line, so the refusal carries none.
  | { tag: 'APPROVAL_GATE_DECISION_UNRESOLVABLE' }
  // A verb the gate does not offer (MOTIR-5893). The choice port only offers the
  // options it parsed, so a reader meets this only from a stale bundle or a crafted call.
  | { tag: 'APPROVAL_GATE_VERB_NOT_OFFERED' }
  | {
      tag: 'APPROVAL_GATE_PRIMARY_PENDING';
      /**
       * WHICH primary holds the merge (MOTIR-5785) — the copy names it, because *approve
       * the design above* and *accept the decision above* are different next actions.
       * Defaults to `design` when the caller could not say: the only primary on `main`.
       */
      primary: PendingPrimary;
    }
  | { tag: 'APPROVAL_GATE_ALREADY_AWAITING' }
  | { tag: 'APPROVAL_GATE_DECIDED_IMMUTABLE' }
  | { tag: 'APPROVAL_GATE_SYNCED_ACTOR_MISMATCH' }
  // ── THE MERGE REFUSALS (MOTIR-5512; `approval-gates.md` §4, second amendment
  // decision 8) — the host said no to the merge an approval performs.
  | { tag: 'MERGE_CHECKS_NOT_GREEN' }
  | { tag: 'MERGE_CONFLICT' }
  | {
      tag: 'MERGE_BRANCH_PROTECTED';
      /**
       * The host's own account of WHICH rule, when it gave one. Carried for the
       * record and deliberately NOT drawn: it is a host sentence, and a server
       * string on a decision surface is what this union exists to prevent. The
       * drawn copy names the next action without it.
       */
      reason?: string;
    }
  | { tag: 'MERGE_ALREADY_MERGED' }
  // Queue again lost the claim to another press (MOTIR-5634).
  | { tag: 'MERGE_ALREADY_REQUEUED' }
  // Queue again on a manual FAILURE exit (MOTIR-5802; `approval-gates.md` §4 FOURTH
  // AMENDMENT, point 4): the pull request left the queue for a failure, so the old
  // approval is not reused — a fresh approval of the re-asked gate re-queues it.
  | { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' }
  | {
      tag: 'MERGE_APP_PERMISSION_MISSING';
      /**
       * The permission GitHub said it needed (`X-Accepted-GitHub-Permissions`).
       * Null is a real answer — the header is not guaranteed — so the copy has an
       * unnamed arm rather than a blank in the sentence, the same disposition
       * `APPROVAL_GATE_ALREADY_DECIDED` gives a decider who left no label.
       */
      permission: string | null;
    }
  | { tag: 'UNEXPECTED' };

/** Every tag the frame handles. */
export type GateRefusalTag = GateRefusal['tag'];

/**
 * THE TOTALITY PROOF. `Exclude` of the server's tags by ours must be `never`;
 * anything left over is a tag this surface cannot render, and the assignment
 * below stops compiling.
 *
 * It is a type-level check with no runtime cost, asserted for real by
 * `tests/components/approval-gate-refusal-totality.test-d.ts`.
 */
export type UnhandledGateRefusalTags = Exclude<ApprovalGateErrorTag, GateRefusalTag>;
export const REFUSAL_TAGS_ARE_TOTAL: UnhandledGateRefusalTags extends never ? true : never = true;

/**
 * Read a refusal out of what the decide door returned.
 *
 * The door answers `{ code, error }` where `code` is the tag (the route's own
 * shape), so this is a narrowing rather than a translation — and an unrecognised
 * code becomes `UNEXPECTED` instead of being rendered raw, because a server
 * string on a decision surface is the one thing this union exists to prevent.
 */
export function toGateRefusal(
  code: unknown,
  extra?: {
    decidedByLabel?: string | null;
    permission?: string | null;
    reason?: string | null;
    supersedeCause?: string | null;
    moved?: readonly StampComponent[] | null;
    primary?: PendingPrimary | null;
  },
): GateRefusal {
  switch (code) {
    case 'APPROVAL_GATE_ALREADY_DECIDED':
      return {
        tag: 'APPROVAL_GATE_ALREADY_DECIDED',
        decidedByLabel: extra?.decidedByLabel ?? null,
      };
    case 'APPROVAL_GATE_SUPERSEDED':
      return { tag: 'APPROVAL_GATE_SUPERSEDED', supersedeCause: extra?.supersedeCause ?? null };
    case 'APPROVAL_GATE_STALE_SUBJECT':
      // A stale refusal that cannot say what moved names every component, which is
      // true of a stamp nobody can vouch for (`stampMoved`'s own rule) — never an
      // empty list the copy would have to invent a sentence for.
      return {
        tag: 'APPROVAL_GATE_STALE_SUBJECT',
        moved:
          extra?.moved && extra.moved.length > 0
            ? [...extra.moved]
            : ['subject', 'pull_requests', 'criteria'],
      };
    case 'APPROVAL_GATE_PRIMARY_PENDING':
      return { tag: code, primary: extra?.primary ?? 'design' };
    case 'APPROVAL_GATE_NOT_AUTHORISED':
    case 'APPROVAL_GATE_NOT_FOUND':
    case 'APPROVAL_GATE_KIND_UNREGISTERED':
    case 'APPROVAL_GATE_DECISION_UNRESOLVABLE':
    case 'APPROVAL_GATE_VERB_NOT_OFFERED':
    case 'APPROVAL_GATE_ALREADY_AWAITING':
    case 'APPROVAL_GATE_DECIDED_IMMUTABLE':
    case 'APPROVAL_GATE_SYNCED_ACTOR_MISMATCH':
    case 'MERGE_CHECKS_NOT_GREEN':
    case 'MERGE_CONFLICT':
    case 'MERGE_ALREADY_MERGED':
    case 'MERGE_ALREADY_REQUEUED':
    case 'MERGE_REQUEUE_NEEDS_APPROVAL':
      return { tag: code };
    case 'MERGE_BRANCH_PROTECTED':
      return extra?.reason ? { tag: code, reason: extra.reason } : { tag: code };
    case 'MERGE_APP_PERMISSION_MISSING':
      return { tag: code, permission: extra?.permission || null };
    default:
      return { tag: 'UNEXPECTED' };
  }
}
