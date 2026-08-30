import { describe, expect, it } from 'vitest';
import {
  DispatchCardDisposition,
  DispatchEventKind,
  DispatchRunStatus,
  DispatchSkipReason,
} from '@/generated/prisma/client';
import {
  CARD_STEPS,
  DISPATCH_RUN_LIVE_STATUSES,
  DISPATCH_RUN_PAST_STATUSES,
  DISPOSITION_TONE,
  EVENT_STEP,
  RUN_IS_LIVE,
  RUN_STATUS_TONE,
  SKIP_REASON_KEY,
  isLiveRun,
} from '@/lib/runs/timeline';

// `lib/runs/timeline.ts` (Story MOTIR-1789 · MOTIR-1796) — the run surfaces'
// pure vocabulary, and the only place four enums become something drawable.
//
// ⚠️ WHAT THIS FILE ADDS THAT `satisfies` DOES NOT. The maps are written
// `as const satisfies Record<Enum, …>`, so a member added to the schema is
// already a COMPILE error — that is the primary guard and it is better than a
// test, because it fires in the editor. What the compiler cannot see is a map
// whose keys drifted from the enum's RUNTIME members: a hand-written union, a
// stale generated client, a member renamed in the schema but not regenerated.
// These assertions read `Object.keys` off the generated client, so they fail on
// exactly the case the type system is blind to.
//
// The failure they exist to prevent is stated in `design/runs/design-notes.md`:
// a step that renders as nothing because nobody wrote a case for a new kind is
// indistinguishable from a run that had no such step, and a disposition falling
// through to a plausible neighbour is worse — it says something FALSE.

describe('every map is TOTAL over its enum, measured against the generated client', () => {
  it('EVENT_STEP covers every DispatchEventKind', () => {
    expect(Object.keys(EVENT_STEP).sort()).toEqual(Object.keys(DispatchEventKind).sort());
  });

  it('DISPOSITION_TONE covers every DispatchCardDisposition', () => {
    expect(Object.keys(DISPOSITION_TONE).sort()).toEqual(
      Object.keys(DispatchCardDisposition).sort(),
    );
  });

  it('RUN_STATUS_TONE and RUN_IS_LIVE cover every DispatchRunStatus', () => {
    const statuses = Object.keys(DispatchRunStatus).sort();
    expect(Object.keys(RUN_STATUS_TONE).sort()).toEqual(statuses);
    expect(Object.keys(RUN_IS_LIVE).sort()).toEqual(statuses);
  });

  it('SKIP_REASON_KEY covers every DispatchSkipReason — and there are SEVEN', () => {
    // ⚠️ SEVEN, NOT SIX. `packages/cli/src/batchPlan.ts`'s `SKIP_LABEL` is
    // `Record<SnapshotSkipReason, string>` and carries six, so every count taken
    // from that file — including this story's own prose and its first design
    // asset — said six. The schema says `DispatchSkipReason` is "the union of
    // `SkipRecord.reason` and `SnapshotSkipReason`", and the seventh member
    // `blocked_in_scope` comes from the loop side: only a CLAIMED SCOPE can
    // produce it. This assertion is pinned to the number so the next person to
    // read the batch file and conclude six has something to disagree with.
    expect(Object.keys(DispatchSkipReason)).toHaveLength(7);
    expect(Object.keys(SKIP_REASON_KEY).sort()).toEqual(Object.keys(DispatchSkipReason).sort());
    expect(SKIP_REASON_KEY.blocked_in_scope).toBe('blockedInScope');
  });
});

describe('the maps say what the design says', () => {
  it('every CARD-scoped event advances a step, and every RUN-scoped one does not', () => {
    // The card's timeline is about THIS card. A run-scoped event rendered on it
    // would tell a reader something happened to their card when it did not.
    const runScoped = [
      'run_opened',
      'scope_claimed',
      'snapshot_frozen',
      'session_pr',
      'plan_approved',
      'run_closed',
    ] as const;
    for (const kind of runScoped) expect(EVENT_STEP[kind]).toBeNull();

    expect(EVENT_STEP.card_claimed).toBe('claimed');
    expect(EVENT_STEP.agent_exited).toBe('exit');
    expect(EVENT_STEP.delivery_linked).toBe('delivery');
    expect(EVENT_STEP.card_settled).toBe('settled');

    // The FINDINGS are the exception to "every card-scoped event advances a
    // step" (MOTIR-3981): they are card-scoped, because the record knows which
    // leg produced them, but they are what the run OBSERVED and wrote down
    // rather than a stage its leg passed through. A bug filed mid-agent must
    // not move the leg off `agent`.
    expect(EVENT_STEP.bug_filed).toBeNull();
    expect(EVENT_STEP.plan_submitted).toBeNull();
  });

  it('a CI observation advances no step — the delivery set owns that verdict', () => {
    // A second CI verdict on one page is how a person ends up with two answers
    // to *is it green*; `derivePrCiState` is the one derivation in the product.
    expect(EVENT_STEP.ci_verdict).toBeNull();
    expect(EVENT_STEP.ci_fix_attempt).toBeNull();
    expect(EVENT_STEP.ci_gave_up).toBeNull();
  });

  it('the opt-in log body is not a step — it belongs in the console', () => {
    expect(EVENT_STEP.log).toBeNull();
  });

  it('every step an event names is one the timeline actually draws', () => {
    for (const step of Object.values(EVENT_STEP)) {
      if (step !== null) expect(CARD_STEPS).toContain(step);
    }
  });

  it('not_reached shares queued’s tone, and the LABEL is what tells them apart', () => {
    expect(DISPOSITION_TONE.not_reached).toBe(DISPOSITION_TONE.queued);
  });

  it('a re-planned RUN reads as a success; the LEG is what says it was refused', () => {
    // The service derives a run's status from its stop reason and only `halted`
    // is a failure — so a run that ended in a re-plan succeeded, and the card's
    // own `replanned` disposition carries the other half of the fact.
    expect(RUN_STATUS_TONE.succeeded).toBe('implemented');
    expect(DISPOSITION_TONE.replanned).toBe('replanned');
  });
});

describe('the live / terminal partition, which decides whether a stream opens at all', () => {
  it('running is the only live status', () => {
    expect(DISPATCH_RUN_LIVE_STATUSES).toEqual(['running']);
    expect(isLiveRun('running')).toBe(true);
  });

  it('timed_out is TERMINAL — the reap wrote it, the process is not coming back', () => {
    expect(isLiveRun('timed_out')).toBe(false);
    expect(DISPATCH_RUN_PAST_STATUSES).toContain('timed_out');
  });

  it('the two halves partition the enum exactly — no status is in both or neither', () => {
    const all = Object.keys(DispatchRunStatus).sort();
    expect([...DISPATCH_RUN_LIVE_STATUSES, ...DISPATCH_RUN_PAST_STATUSES].sort()).toEqual(all);
    for (const s of DISPATCH_RUN_LIVE_STATUSES) {
      expect(DISPATCH_RUN_PAST_STATUSES).not.toContain(s);
    }
  });
});
