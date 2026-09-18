import { describe, expect, it } from 'vitest';
import {
  STAMP_COMPONENTS,
  computeGateStamp,
  movedAsReaderSees,
  stampMoved,
  type StampInputs,
} from '@/lib/approvalGates/stamp';

// THE STAMP, as a pure function (Story MOTIR-5232 · Subtask MOTIR-5234). The door's
// use of it — under the lock, after the state refusals — is asserted against real
// Postgres in `tests/approval-gate-stale-subject.test.ts`; this file pins the
// definition itself, which is the ONE place it lives.

const BASE: StampInputs = {
  subjectVersion: 'a1b2c3d4',
  companionSubjectVersion: 'acme/web#7@f00d',
  descriptionMd: '## Acceptance criteria\n\n- it works',
};

describe('computeGateStamp', () => {
  it('gives the same token for the same inputs', () => {
    expect(computeGateStamp(BASE)).toBe(computeGateStamp({ ...BASE }));
  });

  it('is opaque: one string, nothing a client could read the inputs back out of', () => {
    const token = computeGateStamp(BASE);
    expect(token).toMatch(/^v1\.[0-9a-f]{32}\.[0-9a-f]{32}\.[0-9a-f]{32}$/);
    expect(token).not.toContain(BASE.subjectVersion);
    expect(token).not.toContain('Acceptance');
  });

  it.each([
    ['subject', { subjectVersion: 'e5f6a7b8' }],
    ['pull_requests', { companionSubjectVersion: 'acme/web#7@beef' }],
    ['criteria', { descriptionMd: '## Acceptance criteria\n\n- it works, and fast' }],
  ] as const)('changing %s changes the token, and is reported as exactly that', (name, change) => {
    const shown = computeGateStamp(BASE);
    const now = { ...BASE, ...change };
    expect(computeGateStamp(now)).not.toBe(shown);
    expect(stampMoved(shown, now)).toEqual([name]);
  });

  it('tells an ABSENT value from an empty one — a companion appearing is a change', () => {
    const none = { ...BASE, companionSubjectVersion: null };
    expect(stampMoved(computeGateStamp(none), { ...none, companionSubjectVersion: '' })).toEqual([
      'pull_requests',
    ]);
  });
});

describe('stampMoved', () => {
  it('reports nothing when nothing moved', () => {
    expect(stampMoved(computeGateStamp(BASE), BASE)).toEqual([]);
  });

  it('reports every component that moved, in the one order', () => {
    const now = { subjectVersion: 'x', companionSubjectVersion: 'y', descriptionMd: 'z' };
    expect(stampMoved(computeGateStamp(BASE), now)).toEqual([...STAMP_COMPONENTS]);
  });

  it.each(['', 'garbage', 'v1.abc', 'v2.a.b.c', `${computeGateStamp(BASE)}.extra`])(
    'a token it cannot parse (%j) is refused as ALL moved, never waved through',
    (presented) => {
      expect(stampMoved(presented, BASE)).toEqual([...STAMP_COMPONENTS]);
    },
  );
});

describe('movedAsReaderSees', () => {
  it('names a pressed MERGE gate’s own subject as its pull requests', () => {
    expect(movedAsReaderSees(['subject'], 'pull_request_approval')).toEqual(['pull_requests']);
    expect(movedAsReaderSees(['subject', 'criteria'], 'pull_request_approval')).toEqual([
      'pull_requests',
      'criteria',
    ]);
  });

  it('leaves every other kind’s components as they are', () => {
    expect(movedAsReaderSees(['subject', 'pull_requests'], 'design_result')).toEqual([
      'subject',
      'pull_requests',
    ]);
  });
});
