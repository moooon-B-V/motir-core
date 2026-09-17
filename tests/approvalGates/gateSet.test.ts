import { describe, expect, it } from 'vitest';
import { deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import {
  resolveGateSet,
  type ExistingGate,
  type GateSetInput,
  type GateSetMember,
} from '@/lib/approvalGates/gateSet';

// THE GATE-SET PREDICATE (Story MOTIR-5652 · Subtask MOTIR-5660; `design-result.md`
// AMENDMENT 6).
//
// Every case below is a CARD STATE, not a call site — which is the claim the module
// makes. The six defects in this family were each fixed at the raiser or withdrawer
// that produced them, and the rate did not fall, because the next one arrived
// somewhere nobody had touched. Asking the states proves a defect is unreachable
// from ANY direction, including directions nobody has built yet.

const WORK_ITEM = 'wi_1';

const member = (version: string | null, isMergeCandidate = true): GateSetMember => ({
  memberVersion: version,
  isMergeCandidate,
});

const GREEN_ONE = [member('moooon/motir-core#10@aaa1')];
const GREEN_TWO = [member('moooon/motir-core#10@aaa1'), member('moooon/motir-ai#4@bbb2')];

const input = (over: Partial<GateSetInput> = {}): GateSetInput => ({
  currentDesignEvidence: null,
  latestDesignGate: null,
  latestMergeGate: null,
  members: [],
  prMergeMode: 'manual',
  cardIsTerminal: false,
  designApprovalStandsForMerge: false,
  workItemId: WORK_ITEM,
  ...over,
});

const decided = (
  subjectId: string,
  subjectVersion: string | null,
  state: ExistingGate['state'] = 'approved',
): ExistingGate => ({ state, subjectId, subjectVersion });

describe('resolveGateSet — the states with nothing to decide', () => {
  it('asks nothing when the card has neither a design result nor a delivery set', () => {
    expect(resolveGateSet(input())).toEqual({ awaited: [], primary: null });
  });

  it('asks nothing on a TERMINAL card, whatever it holds', () => {
    const set = resolveGateSet(
      input({
        cardIsTerminal: true,
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        members: GREEN_ONE,
      }),
    );
    expect(set).toEqual({ awaited: [], primary: null });
  });

  it('asks no MERGE question in an `auto` project — Motir merges with no person', () => {
    const set = resolveGateSet(input({ prMergeMode: 'auto', members: GREEN_ONE }));
    expect(set.awaited).toEqual([]);
  });

  it('asks no MERGE question while a member is not a merge candidate (MOTIR-5604)', () => {
    const set = resolveGateSet(input({ members: [member('moooon/motir-core#10@aaa1', false)] }));
    expect(set.awaited).toEqual([]);
  });

  it('asks no MERGE question while any member has an unknown head', () => {
    const set = resolveGateSet(
      input({ members: [member('moooon/motir-core#10@aaa1'), member(null)] }),
    );
    expect(set.awaited).toEqual([]);
  });
});

describe('resolveGateSet — the DESIGN question stands on its own', () => {
  it('asks it for a published result with NO pull request', () => {
    const set = resolveGateSet(
      input({ currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' } }),
    );
    expect(set).toEqual({
      awaited: [{ kind: 'design_result', subjectId: 'ev_1', subjectVersion: 'c0ffee' }],
      primary: 'design_result',
    });
  });

  it('asks it for a result with no commit behind it — an unknown version is not no question', () => {
    const set = resolveGateSet(input({ currentDesignEvidence: { id: 'ev_1', commitSha: null } }));
    expect(set.awaited).toEqual([
      { kind: 'design_result', subjectId: 'ev_1', subjectVersion: null },
    ]);
  });

  it('stops asking it once a decision has answered THAT version', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        latestDesignGate: decided('ev_1', 'c0ffee'),
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('asks AGAIN when a republish moved the version the decision answered', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_2', commitSha: 'deadbee' },
        latestDesignGate: decided('ev_1', 'c0ffee'),
      }),
    );
    expect(set.awaited).toEqual([
      { kind: 'design_result', subjectId: 'ev_2', subjectVersion: 'deadbee' },
    ]);
  });

  it('keeps asking while its own gate is merely AWAITING — a caller leaves that row alone', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        latestDesignGate: { state: 'awaiting', subjectId: 'ev_1', subjectVersion: 'c0ffee' },
      }),
    );
    expect(set.primary).toBe('design_result');
  });

  it('treats CHANGES REQUESTED as an answer, not an open question', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        latestDesignGate: decided('ev_1', 'c0ffee', 'changes_requested'),
      }),
    );
    expect(set.awaited).toEqual([]);
  });
});

describe('resolveGateSet — MOTIR-5652: a design result AND open pull requests is TWO gates', () => {
  it('asks BOTH, with the design gate PRIMARY (AMENDMENT 6 Q1)', () => {
    const set = resolveGateSet(
      input({ currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' }, members: GREEN_ONE }),
    );
    expect(set.awaited).toEqual([
      { kind: 'design_result', subjectId: 'ev_1', subjectVersion: 'c0ffee' },
      {
        kind: 'pull_request_approval',
        subjectId: WORK_ITEM,
        subjectVersion: 'moooon/motir-core#10@aaa1',
      },
    ]);
    expect(set.primary).toBe('design_result');
  });

  it('does the same across two repositories', () => {
    const set = resolveGateSet(
      input({ currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' }, members: GREEN_TWO }),
    );
    expect(set.awaited.map((gate) => gate.kind)).toEqual([
      'design_result',
      'pull_request_approval',
    ]);
    expect(set.primary).toBe('design_result');
  });

  it('NEVER depends on who holds the run target — it is not an input at all', () => {
    // MOTIR-5652's second refusal was `resolveRunTargetFor(...).kind === 'ancestor'`,
    // which every child of a parent run resolves to. A card with something to decide
    // has a gate regardless of it, so the fact is absent from this module's inputs
    // and this test is the record of that being deliberate.
    expect(Object.keys(input())).not.toContain('runTarget');
  });
});

describe('resolveGateSet — MOTIR-5603: at most ONE merge gate, ever', () => {
  it('asks exactly one merge question however many pull requests the card delivers', () => {
    const set = resolveGateSet(input({ members: GREEN_TWO }));
    expect(set.awaited.filter((gate) => gate.kind === 'pull_request_approval')).toHaveLength(1);
  });

  it('names the whole SET as its subject version, sorted and joined', () => {
    const set = resolveGateSet(input({ members: GREEN_TWO }));
    expect(set.awaited[0]?.subjectVersion).toBe('moooon/motir-ai#4@bbb2,moooon/motir-core#10@aaa1');
  });

  it('gives the same version whatever order the rows were read in', () => {
    const forward = resolveGateSet(input({ members: GREEN_TWO }));
    const reversed = resolveGateSet(input({ members: [...GREEN_TWO].reverse() }));
    expect(reversed.awaited[0]?.subjectVersion).toBe(forward.awaited[0]?.subjectVersion);
  });

  it('agrees with `deliverySetVersion`, which three other places already use', () => {
    const set = resolveGateSet(input({ members: GREEN_TWO }));
    expect(set.awaited[0]?.subjectVersion).toBe(
      deliverySetVersion(GREEN_TWO.map((m) => m.memberVersion)),
    );
  });
});

describe('resolveGateSet — MOTIR-5632: the same commits are never asked about twice', () => {
  it('stops asking once a decision answered THIS set', () => {
    const version = deliverySetVersion(GREEN_ONE.map((m) => m.memberVersion));
    const set = resolveGateSet(
      input({ members: GREEN_ONE, latestMergeGate: decided(WORK_ITEM, version) }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('asks again once a push moved a head (MOTIR-5604)', () => {
    const answered = deliverySetVersion(GREEN_ONE.map((m) => m.memberVersion));
    const pushed = [member('moooon/motir-core#10@bbb2')];
    const set = resolveGateSet(
      input({ members: pushed, latestMergeGate: decided(WORK_ITEM, answered) }),
    );
    expect(set.awaited).toEqual([
      {
        kind: 'pull_request_approval',
        subjectId: WORK_ITEM,
        subjectVersion: 'moooon/motir-core#10@bbb2',
      },
    ]);
  });
});

describe('resolveGateSet — AMENDMENT 6 Q2: the merge gate re-opens ALONE', () => {
  it('asks the merge question by itself once the design has been decided', () => {
    // The state after an approval whose merge was then ejected: the design answer
    // stands, the commits are a live question again, and nobody is re-asked about
    // the mock they already approved.
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        latestDesignGate: decided('ev_1', 'c0ffee'),
        members: GREEN_ONE,
      }),
    );
    expect(set.awaited).toEqual([
      {
        kind: 'pull_request_approval',
        subjectId: WORK_ITEM,
        subjectVersion: 'moooon/motir-core#10@aaa1',
      },
    ]);
    expect(set.primary).toBe('pull_request_approval');
  });
});

describe('resolveGateSet — AMENDMENT 6 Q4: the design question does not wait for CI', () => {
  it('asks the design question while the set is NOT yet a merge candidate', () => {
    // The press is not refused before green; only the MERGE is held. Refusing it is
    // the silent stall MOTIR-5652 was filed about, arriving through a door we built.
    const set = resolveGateSet(
      input({
        currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' },
        members: [member('moooon/motir-core#10@aaa1', false)],
      }),
    );
    expect(set.awaited).toEqual([
      { kind: 'design_result', subjectId: 'ev_1', subjectVersion: 'c0ffee' },
    ]);
    expect(set.primary).toBe('design_result');
  });
});

describe('resolveGateSet — MOTIR-5574: a withdrawn result leaves nothing asking about it', () => {
  it('asks no design question when the card has no current result', () => {
    // `currentDesignEvidence` is the card's CURRENT non-withdrawn row, so a
    // withdrawal is expressed by its absence — and the question goes with it.
    const set = resolveGateSet(input({ latestDesignGate: decided('ev_1', 'c0ffee') }));
    expect(set.awaited.filter((gate) => gate.kind === 'design_result')).toEqual([]);
  });
});

describe('resolveGateSet — purity', () => {
  it('does not mutate what it is handed', () => {
    const members = [...GREEN_TWO];
    const args = input({ members });
    const frozen = JSON.stringify(args);
    resolveGateSet(args);
    expect(JSON.stringify(args)).toBe(frozen);
    expect(members.map((m) => m.memberVersion)).toEqual(GREEN_TWO.map((m) => m.memberVersion));
  });
});

describe("resolveGateSet — MOTIR-5666: Q4's carry is ONE-TIME", () => {
  const evidence = { id: 'ev-1', commitSha: 'sha-design' };

  it('a standing design approval carries the merge while the card has never held a merge gate', () => {
    const set = resolveGateSet(
      input({
        currentDesignEvidence: evidence,
        latestDesignGate: decided('ev-1', 'sha-design'),
        designApprovalStandsForMerge: true,
        members: GREEN_ONE,
      }),
    );

    expect(set.awaited.map((g) => g.kind)).toEqual([]);
  });

  it('…and stops carrying it the moment a merge gate has existed — a PUSH is a new question', () => {
    // Without this the design approval would go on authorising every future green,
    // merging code nobody approved. Found by building the ejection card, from a
    // push after an ejection raising nothing.
    const set = resolveGateSet(
      input({
        currentDesignEvidence: evidence,
        latestDesignGate: decided('ev-1', 'sha-design'),
        designApprovalStandsForMerge: true,
        latestMergeGate: decided(WORK_ITEM, 'moooon/motir-core#10@old'),
        members: GREEN_ONE,
      }),
    );

    expect(set.awaited.map((g) => g.kind)).toEqual(['pull_request_approval']);
    expect(set.awaited[0]!.subjectVersion).toBe('moooon/motir-core#10@aaa1');
  });
});
