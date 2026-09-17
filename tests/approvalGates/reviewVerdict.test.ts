import { describe, expect, it } from 'vitest';
import {
  countableReviewsAtHead,
  countingReviewNote,
  parseDeliverySetVersion,
  setVerdict,
  type CountableReview,
  type MemberReviews,
} from '@/lib/approvalGates/reviewVerdict';
import { deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';

// THE SET RULE, as a pure function (Story MOTIR-4910 · MOTIR-5597;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decisions 1 and 2).
// No database and no service: these are the rule's own cases.

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const OLD = 'c'.repeat(40);

let seq = 0;
function review(
  o: Partial<CountableReview> & { state?: CountableReview['state'] } = {},
): CountableReview {
  seq += 1;
  return {
    githubReviewId: o.githubReviewId ?? `r-${String(seq).padStart(4, '0')}`,
    reviewerGithubUserId: o.reviewerGithubUserId ?? '4242',
    reviewerLogin: o.reviewerLogin ?? 'ada-l',
    state: o.state ?? 'approved',
    commitSha: o.commitSha ?? HEAD_A,
    reviewerPermission: o.reviewerPermission ?? 'write',
    submittedAt:
      o.submittedAt ?? new Date(`2026-09-16T09:${String(seq % 60).padStart(2, '0')}:00Z`),
  };
}

const member = (repo: string, number: number, headSha: string) => ({
  subjectVersion: `${repo}#${number}@${headSha}`,
  repo,
  number,
  headSha,
});

describe('parseDeliverySetVersion (MOTIR-5597)', () => {
  it('round-trips with deliverySetVersion', () => {
    const members = [`moooon/motir-core#131@${HEAD_A}`, `moooon/motir-ai#88@${HEAD_B}`];
    const version = deliverySetVersion(members)!;
    expect(parseDeliverySetVersion(version)).toEqual(
      // sorted, as the version is
      [...members].sort().map((raw) => {
        const at = raw.lastIndexOf('@');
        const hash = raw.lastIndexOf('#', at);
        return member(raw.slice(0, hash), Number(raw.slice(hash + 1, at)), raw.slice(at + 1));
      }),
    );
  });

  it('is empty for null, and DROPS a member it cannot parse rather than guessing', () => {
    expect(parseDeliverySetVersion(null)).toEqual([]);
    expect(parseDeliverySetVersion('')).toEqual([]);
    expect(parseDeliverySetVersion('nonsense')).toEqual([]);
    expect(parseDeliverySetVersion(`owner/name#notanumber@${HEAD_A}`)).toEqual([]);
    expect(parseDeliverySetVersion('owner/name#1@')).toEqual([]);
    // A repository name containing a '#' or '@' would be the ambiguous case; the parse
    // takes the LAST of each, which is what the writer's format guarantees.
    expect(parseDeliverySetVersion(`o/n#12@${HEAD_A}`)).toEqual([member('o/n', 12, HEAD_A)]);
  });
});

describe('countableReviewsAtHead (MOTIR-5597, decision 2)', () => {
  it('drops commented, the wrong head, and a reviewer who cannot write', () => {
    const rows = [
      review({ state: 'commented' }),
      review({ commitSha: OLD }),
      review({ reviewerPermission: 'read', reviewerGithubUserId: '1' }),
      review({ reviewerPermission: 'triage', reviewerGithubUserId: '2' }),
      review({ reviewerPermission: 'none', reviewerGithubUserId: '3' }),
      // `unknown` means Motir could not READ the permission — safe direction, counts
      // for nothing, and it stays distinguishable from `none`.
      review({ reviewerPermission: 'unknown', reviewerGithubUserId: '4' }),
    ];
    expect(countableReviewsAtHead(rows, HEAD_A)).toEqual([]);
  });

  it('counts admin, maintain and write', () => {
    const rows = [
      review({ reviewerPermission: 'admin', reviewerGithubUserId: '1' }),
      review({ reviewerPermission: 'maintain', reviewerGithubUserId: '2' }),
      review({ reviewerPermission: 'write', reviewerGithubUserId: '3' }),
    ];
    expect(countableReviewsAtHead(rows, HEAD_A)).toHaveLength(3);
  });

  it('keeps each reviewer’s LATEST, so approve-then-request-changes is changes_requested', () => {
    const approved = review({ submittedAt: new Date('2026-09-16T09:00:00Z') });
    const later = review({
      state: 'changes_requested',
      submittedAt: new Date('2026-09-16T10:00:00Z'),
    });
    const counted = countableReviewsAtHead([approved, later], HEAD_A);
    expect(counted).toHaveLength(1);
    expect(counted[0]!.state).toBe('changes_requested');
  });

  it('drops a reviewer whose LATEST is dismissed — without promoting their earlier approval', () => {
    // The order of the filters is the rule: dismissed rows stay in the pool long enough to
    // WIN the per-reviewer latest, and only then drop out.
    const approved = review({ submittedAt: new Date('2026-09-16T09:00:00Z') });
    const dismissed = review({ state: 'dismissed', submittedAt: new Date('2026-09-16T10:00:00Z') });
    expect(countableReviewsAtHead([approved, dismissed], HEAD_A)).toEqual([]);
  });

  it('breaks a same-instant tie on the host’s review id, totally and stably', () => {
    const at = new Date('2026-09-16T09:00:00Z');
    const a = review({ githubReviewId: 'r-1', state: 'approved', submittedAt: at });
    const b = review({ githubReviewId: 'r-2', state: 'changes_requested', submittedAt: at });
    expect(countableReviewsAtHead([a, b], HEAD_A)[0]!.githubReviewId).toBe('r-2');
    expect(countableReviewsAtHead([b, a], HEAD_A)[0]!.githubReviewId).toBe('r-2');
  });
});

describe('setVerdict (MOTIR-5597, decision 1)', () => {
  const core = member('moooon/motir-core', 131, HEAD_A);
  const ai = member('moooon/motir-ai', 88, HEAD_B);

  const set = (a: CountableReview[], b: CountableReview[]): MemberReviews[] => [
    { member: core, rows: a },
    { member: ai, rows: b },
  ];

  it('is PENDING when one of two members is approved', () => {
    const v = setVerdict(set([review()], []));
    expect(v.verdict).toBe('pending');
    expect(v.verdict === 'pending' && v.unapproved).toEqual([ai]);
  });

  it('is APPROVED when both are, with the LATER approval as the decider', () => {
    const first = review({ submittedAt: new Date('2026-09-16T09:00:00Z'), reviewerLogin: 'first' });
    const second = review({
      commitSha: HEAD_B,
      submittedAt: new Date('2026-09-16T10:00:00Z'),
      reviewerLogin: 'second',
    });
    const v = setVerdict(set([first], [second]));
    expect(v.verdict).toBe('approved');
    // The decider is the review that COMPLETED the set.
    expect(v.verdict === 'approved' && v.decider.reviewerLogin).toBe('second');
    expect(v.verdict === 'approved' && v.counting).toHaveLength(2);
  });

  it('is CHANGES_REQUESTED on EITHER member, even when the other is approved', () => {
    // One reviewer asking for changes is already the answer, whichever member they are on.
    // Each arrangement puts the objection at ITS OWN member's head, so both are decisive.
    const objectionOnCore = review({
      commitSha: HEAD_A,
      state: 'changes_requested',
      reviewerGithubUserId: '777',
      reviewerLogin: 'objector',
    });
    const approvedOnAi = review({ commitSha: HEAD_B });
    const first = setVerdict(set([objectionOnCore], [approvedOnAi]));
    expect(first.verdict).toBe('changes_requested');
    expect(first.verdict === 'changes_requested' && first.decider.reviewerLogin).toBe('objector');

    const approvedOnCore = review({ commitSha: HEAD_A });
    const objectionOnAi = review({
      commitSha: HEAD_B,
      state: 'changes_requested',
      reviewerGithubUserId: '778',
      reviewerLogin: 'objector-two',
    });
    const second = setVerdict(set([approvedOnCore], [objectionOnAi]));
    expect(second.verdict).toBe('changes_requested');
    expect(second.verdict === 'changes_requested' && second.decider.reviewerLogin).toBe(
      'objector-two',
    );
  });

  it('counts an approval at an OLDER commit for nothing', () => {
    const stale = review({ commitSha: OLD });
    const fresh = review({ commitSha: HEAD_B });
    const v = setVerdict(set([stale], [fresh]));
    expect(v.verdict).toBe('pending');
    expect(v.verdict === 'pending' && v.unapproved).toEqual([core]);
  });

  it('counts an approval from a reader, or an unreadable permission, for nothing', () => {
    const reader = review({ reviewerPermission: 'read' });
    const unknown = review({ commitSha: HEAD_B, reviewerPermission: 'unknown' });
    expect(setVerdict(set([reader], [unknown])).verdict).toBe('pending');
  });

  it('leaves an approval counting when a COMMENT arrives after it', () => {
    const approved = review({ submittedAt: new Date('2026-09-16T09:00:00Z') });
    const commented = review({ state: 'commented', submittedAt: new Date('2026-09-16T11:00:00Z') });
    const other = review({ commitSha: HEAD_B });
    const v = setVerdict(set([approved, commented], [other]));
    expect(v.verdict).toBe('approved');
  });

  it('is PENDING for an empty set — a gate about nothing approves nothing', () => {
    expect(setVerdict([]).verdict).toBe('pending');
  });
});

describe('countingReviewNote (MOTIR-5597, decision 3)', () => {
  it('names every member’s counting review, one per line', () => {
    const note = countingReviewNote([
      {
        member: member('moooon/motir-core', 131, HEAD_A),
        review: review({ reviewerLogin: 'ada-l' }),
      },
      { member: member('moooon/motir-ai', 88, HEAD_B), review: review({ reviewerLogin: 'octo' }) },
    ]);
    expect(note.split('\n')).toEqual([
      `moooon/motir-core#131@${HEAD_A} — approved by @ada-l`,
      `moooon/motir-ai#88@${HEAD_B} — approved by @octo`,
    ]);
  });
});
