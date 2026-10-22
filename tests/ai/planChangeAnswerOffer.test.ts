import { describe, expect, it } from 'vitest';
import type { PlanChangeTurn } from '@/generated/prisma/client';
import { toPlanChangeTurnDto } from '@/lib/mappers/planChangeMappers';

// THE ANSWER OFFER'S NARROWING (Story MOTIR-9219 · MOTIR-9288). The stored
// `answer_offer` JSON reads back field for field, or — when any part of it cannot be
// read — as NO offer. An unknown `kind` is never read back as a `plan` offer.

const UNDECIDED = {
  kind: 'plan',
  requestMd: 'Plan a fix for the CSV export dropping custom fields.',
  targetKey: 'ACME-42',
  declinedAt: null,
  declinedById: null,
  confirmedAt: null,
  confirmedById: null,
  confirmedSessionId: null,
};

function row(answerOffer: unknown): PlanChangeTurn {
  return {
    id: 't1',
    workspaceId: 'w1',
    sessionId: 's1',
    seq: 1,
    role: 'assistant',
    body: 'I can plan that.',
    jobId: 'job-1',
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    debugLandingClaimedAt: null,
    anchorKey: null,
    debugLanding: null,
    guideLandingClaimedAt: null,
    guideTurn: null,
    confirm: null,
    citations: [],
    attachmentIds: [],
    runJobId: null,
    codeUnreadable: null,
    codeUnsearchable: null,
    forwardOffer: null,
    answerOffer,
    forwardedEntryId: null,
    revisedLateJobId: null,
    authorId: null,
    createdAt: new Date('2026-10-22T19:00:00Z'),
  } as PlanChangeTurn;
}

const offerOf = (value: unknown) => toPlanChangeTurnDto(row(value)).offer;

describe('toPlanChangeTurnDto — the answer offer', () => {
  it('round-trips an undecided offer field for field', () => {
    expect(offerOf(UNDECIDED)).toEqual(UNDECIDED);
  });

  it('round-trips a decided offer and a targetless one', () => {
    const confirmed = {
      ...UNDECIDED,
      targetKey: null,
      confirmedAt: '2026-10-22T19:14:00.000Z',
      confirmedById: 'u1',
      confirmedSessionId: 's2',
    };
    expect(offerOf(confirmed)).toEqual(confirmed);
    const declined = { ...UNDECIDED, declinedAt: '2026-10-22T19:15:00.000Z', declinedById: 'u1' };
    expect(offerOf(declined)).toEqual(declined);
  });

  it('reads a turn written before the column (null) as no offer', () => {
    expect(offerOf(null)).toBeNull();
  });

  it('reads a stored offer missing its disposition keys as undecided', () => {
    const { kind, requestMd, targetKey } = UNDECIDED;
    expect(offerOf({ kind, requestMd, targetKey })).toEqual(UNDECIDED);
  });

  it.each([
    ['a string', 'plan'],
    ['an array', [UNDECIDED]],
    ['a number', 7],
  ])('reads %s as no offer', (_l, value) => {
    expect(offerOf(value)).toBeNull();
  });

  it.each([
    ['missing requestMd', { ...UNDECIDED, requestMd: undefined }],
    ['blank requestMd', { ...UNDECIDED, requestMd: '   ' }],
    ['non-string requestMd', { ...UNDECIDED, requestMd: 42 }],
    ['a numeric targetKey', { ...UNDECIDED, targetKey: 42 }],
    ['an object declinedAt', { ...UNDECIDED, declinedAt: {} }],
    ['a boolean declinedById', { ...UNDECIDED, declinedById: true }],
    ['a numeric confirmedAt', { ...UNDECIDED, confirmedAt: 1 }],
    ['an array confirmedById', { ...UNDECIDED, confirmedById: ['u1'] }],
    ['a numeric confirmedSessionId', { ...UNDECIDED, confirmedSessionId: 3 }],
  ])('reads an offer with %s as no offer', (_l, value) => {
    expect(offerOf(value)).toBeNull();
  });

  it.each([['log_bug'], ['PLAN'], [''], [undefined], [1]])(
    'reads an offer of kind %j as no offer — never as a plan offer',
    (kind) => {
      expect(offerOf({ ...UNDECIDED, kind })).toBeNull();
    },
  );
});
