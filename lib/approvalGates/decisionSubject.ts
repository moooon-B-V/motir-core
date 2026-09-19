import type { DecisionDocOutcome } from '@/generated/prisma/client';

// THE DECISION GATE'S SUBJECT, from what the card's pull requests CAPTURED (Story
// MOTIR-4907 · Subtask MOTIR-5676; ADR `docs/decisions/approval-gates.md` §8's FIFTH
// AMENDMENT, clauses 1, 3 and 4).
//
// ⚠️ PURE, AND READ FROM THE MIRROR — NEVER FROM THE HOST. The decide door computes
// a gate's version inside its own transaction, under the gate's lock, and a
// transaction may not wait on GitHub. So the subject is built from the captured
// identity MOTIR-5674 writes onto each pull request (`decision_doc_*`), and the
// CONTENT — which does need the host — is a separate, later read through the
// resolver (`decisionDocumentResolver.ts`), made by a surface, outside any
// transaction.
//
// ⚠️ THE DOCUMENT IS ONE FILE ACROSS THE WHOLE DELIVERY SET, not one per pull
// request (clause 3). A card delivered by two pull requests with a decision file in
// each carries TWO documents, which is `several` — however clean each pull request
// looks on its own.

/** One OPEN pull request delivering the card, reduced to what the subject needs. */
export interface DecisionMember {
  /** `owner/name`. */
  repo: string;
  number: number;
  /** The capture's outcome; null when this pull request was never captured. */
  outcome: DecisionDocOutcome | null;
  path: string | null;
  blobSha: string | null;
  headSha: string | null;
}

/** Why a card's decision cannot be approved (clause 3). */
export type DecisionUnresolvableReason = Exclude<DecisionDocOutcome, 'one'>;

/** What the decision gate is asking about. */
export type DecisionIdentity =
  | {
      resolvable: true;
      repo: string;
      number: number;
      path: string;
      blobSha: string;
      headSha: string | null;
    }
  | {
      resolvable: false;
      reason: DecisionUnresolvableReason;
      /** The member the reason was read off — the first in canonical order. */
      repo: string;
      number: number;
      headSha: string | null;
    };

/** `owner/name#number` — the delivery set's canonical member order. */
const memberKey = (member: { repo: string; number: number }) => `${member.repo}#${member.number}`;

/**
 * The card's decision identity, or `null` when there is nothing to ask about yet —
 * no open pull request delivers the card, or none of them has been captured.
 *
 * The rules, in order (clause 3, and the reason for each):
 *
 *  1. **No open member, or NO member captured ⇒ `null`.** The question is not
 *     asked before the head has been looked at. (An `auto` project still HOLDS its
 *     merge in that window — clause 6 — which is the gate set's business, not this
 *     function's.)
 *  2. **Any member `several`, or two members `one` ⇒ `several`.** The document is
 *     ONE file across the set.
 *  3. **Any member `unreadable`, or captured beside one that is NOT ⇒
 *     `unreadable`.** An uncaptured member may carry a second document nobody has
 *     seen; the safe reading of *"not known yet"* is *"cannot be approved yet"*.
 *  4. **Exactly one `one` ⇒ resolvable** over that file.
 *  5. **Otherwise every member said `none` ⇒ `none`.**
 */
export function decisionIdentityOf(members: readonly DecisionMember[]): DecisionIdentity | null {
  const sorted = [...members].sort((a, b) => (memberKey(a) < memberKey(b) ? -1 : 1));
  const captured = sorted.filter((member) => member.outcome !== null);
  if (captured.length === 0) return null;

  const unresolvable = (
    reason: DecisionUnresolvableReason,
    at: DecisionMember = captured[0]!,
  ): DecisionIdentity => ({
    resolvable: false,
    reason,
    repo: at.repo,
    number: at.number,
    headSha: at.headSha,
  });

  const ones = captured.filter((member) => member.outcome === 'one');
  const several = captured.find((member) => member.outcome === 'several');
  if (several) return unresolvable('several', several);
  if (ones.length > 1) return unresolvable('several', ones[1]);

  const unreadable = captured.find((member) => member.outcome === 'unreadable');
  if (unreadable) return unresolvable('unreadable', unreadable);
  const uncaptured = sorted.find((member) => member.outcome === null);
  if (uncaptured) return unresolvable('unreadable', uncaptured);

  const [one] = ones;
  if (one && one.path && one.blobSha) {
    return {
      resolvable: true,
      repo: one.repo,
      number: one.number,
      path: one.path,
      blobSha: one.blobSha,
      headSha: one.headSha,
    };
  }
  // A `one` with no path or sha is a capture that broke its own invariant (the
  // repository writes the four columns together) — never approvable.
  if (one) return unresolvable('unreadable', one);
  return unresolvable('none');
}

/**
 * The gate's `subjectVersion` (clause 4).
 *
 * - resolvable → `owner/name:path@blobSha`. The BLOB, not the head: a push that
 *   leaves the document's bytes alone keeps the same version, so an accepted
 *   decision is not asked again because somebody fixed a test.
 * - unresolvable → `owner/name:unresolvable:<reason>@<headSha>`, so each head that
 *   cannot be approved is its own question and the push that fixes it raises a
 *   resolvable one.
 */
export function decisionSubjectVersion(identity: DecisionIdentity): string {
  if (identity.resolvable) return `${identity.repo}:${identity.path}@${identity.blobSha}`;
  return `${identity.repo}:unresolvable:${identity.reason}@${identity.headSha ?? 'unknown'}`;
}

/**
 * A document's TITLE from its file name — what a row can say with no host call.
 * `docs/decisions/approval-gates.md` → `Approval gates`.
 */
export function titleFromDecisionPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const words = name.replace(/[-_]+/g, ' ').trim();
  if (words.length === 0) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A document's first `#` heading, plain, or null when it has none — for a surface
 * that HAS read the content through the resolver. Only a level-1 heading counts:
 * an ADR's `##` headings are its sections, not its name.
 */
export function headingOf(markdown: string): string | null {
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return match[1]!.replace(/[*_`]/g, '').trim() || null;
  }
  return null;
}
