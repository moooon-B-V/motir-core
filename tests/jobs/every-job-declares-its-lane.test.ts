import { describe, expect, it } from 'vitest';
import { engineJobs } from '@/lib/jobs/engine/registry';
// The REAL registry, for its side effect — every definition module evaluated, so
// this walks the shipped set rather than a fixture.
import '@/lib/jobs/registry';

// EVERY JOB DECLARES ITS LANE (Bug MOTIR-3682).
//
// ===========================================================================
// WHAT THIS CATCHES, AND WHY THE EXISTING GUARDS DID NOT
// ===========================================================================
// The per-job cutover switch (`lib/jobs/engine/cutover.ts`) defaults an
// unnamed job to Inngest, deliberately: "a job nobody has thought about cannot
// be silently migrated." That default is a SAFETY property and it worked every
// time. What it cannot do is tell anyone the job was added.
//
// In ~24 hours during the production cutover, THREE jobs were added to this
// registry by two pull requests, and all three sat outside the routed set with
// nothing red:
//
//   #2344  system.public-follow-digest-tick   a cron
//   #2344  public-follow/digest               its delivery consumer
//   #2309  plan-drift/transitioned            a fifth fast-lane consumer
//
// Each was found by a person reading a log line or reconciling by hand. None of
// the existing guards fires on this:
//   - `scheduled-cutover-story-gate` §3c walks the registry, but asserts each
//     cron equals its NAMED CONSTANT — it is about WHEN a job runs, not WHERE.
//   - `fast-lane-latency-budget` asserts the lane's membership set, which is
//     why `plan-drift/transitioned` was admitted deliberately — and being in the
//     lane says nothing about being routed.
//
// ===========================================================================
// WHY THE ASSERTION IS AGAINST A CHECKED-IN LIST AND NOT AGAINST PRODUCTION
// ===========================================================================
// The live routing set is a Fly secret (`MOTIR_POSTGRES_JOB_IDS`). A test
// cannot read it, and should not: CI would then fail for an operator action
// taken minutes earlier, and go green again when somebody changed production
// rather than the code.
//
// So this asserts the thing CI can own — that every registered job has had its
// lane DECLARED by a human, in the repository, under review. Adding a job now
// fails this test until its author names the lane, which is precisely the
// moment the decision is cheapest and the context is freshest. Keeping the
// declaration equal to the live secret remains an operator duty; this guard
// makes the declaration exist at all.
//
// ⚠️ TO FIX A FAILURE: add the id to ONE of the two lists below. Do not delete
// the assertion. If the job belongs on the engine, it also needs adding to
// `MOTIR_POSTGRES_JOB_IDS` in production — the list here records intent, and a
// PR is not a deploy.

/** Jobs intended to run on the Postgres engine. Kept equal to the production secret. */
const MIGRATED_TO_ENGINE = [
  'automation-engine/commented',
  'automation-engine/created',
  'automation-engine/field.changed',
  'automation-engine/transitioned',
  'email.send',
  'filter-subscription/deliver',
  'notification-fan-in/comment.created',
  'notification-fan-in/mentioned',
  'notification-fan-in/transitioned',
  'outward-bug-telemetry/created',
  'plan-drift/transitioned',
  'public-follow/digest',
  'status-derivation/child-set-changed',
  'status-derivation/created',
  'status-derivation/requested',
  'status-derivation/transitioned',
  'system.abandoned-plan-sweep',
  'system.attachment-gc',
  'system.auto-plan-cadence-tick',
  'system.automation-retention-sweep',
  'system.billing-seat-sync',
  'system.ci-actions-gate-sweep',
  'system.ci-minutes-reconcile',
  'system.ci-runner-provision-sweep',
  'system.ci-runner-reap',
  'system.code-graph-offboard-sweep',
  'system.daily-health-check',
  'system.filter-subscription-tick',
  'system.migrate-onboarding-sweep',
  'system.plan-target-lock-sweep',
  'system.public-follow-digest-tick',
  'system.rate-limit-sweep',
  'watcher-notify/comment.created',
  'watcher-notify/transitioned',
  'work-item/comment.created',
  'work-item/embedding.requested',
  'work-item/mentioned',
] as const;

/**
 * Jobs deliberately still on Inngest, each with the card that owns moving it.
 * An entry here is a DECISION, not a backlog: it says somebody looked.
 */
const DELIBERATELY_ON_INNGEST: ReadonlyArray<{ id: string; because: string }> = [
  { id: 'system.code-graph-index', because: 'container supervisor — MOTIR-3489 owns the flip' },
  { id: 'system.code-graph-refresh', because: 'container supervisor — MOTIR-3489 owns the flip' },
  { id: 'system.ci-runner-boot', because: 'container supervisor — MOTIR-3489 owns the flip' },
];

describe('every registered job declares which lane it runs on', () => {
  const registered = engineJobs().map((d) => d.id);
  const migrated = new Set<string>(MIGRATED_TO_ENGINE);
  const excluded = new Set(DELIBERATELY_ON_INNGEST.map((e) => e.id));

  it('the registry is non-empty (the guard is walking the real set)', () => {
    // Without this, an import that silently evaluated nothing would make every
    // assertion below vacuously true — the failure mode this whole card is about.
    expect(registered.length).toBeGreaterThan(30);
  });

  it('declares a lane for EVERY registered job', () => {
    const undeclared = registered.filter((id) => !migrated.has(id) && !excluded.has(id));
    expect(
      undeclared,
      `these jobs are in the registry but declare no lane. Add each to MIGRATED_TO_ENGINE ` +
        `(and to MOTIR_POSTGRES_JOB_IDS in production) or to DELIBERATELY_ON_INNGEST with a reason`,
    ).toEqual([]);
  });

  it('declares no lane for a job that does not exist', () => {
    // The other direction: a renamed or deleted job leaves a stale declaration,
    // and a stale MIGRATED entry reads as coverage it no longer has.
    const known = new Set(registered);
    const orphaned = [...migrated, ...excluded].filter((id) => !known.has(id));
    expect(orphaned, 'declared but not registered — the job was renamed or removed').toEqual([]);
  });

  it('never declares the same job twice', () => {
    const both = [...migrated].filter((id) => excluded.has(id));
    expect(both, 'a job cannot be both migrated and deliberately on Inngest').toEqual([]);
    expect(new Set(MIGRATED_TO_ENGINE).size, 'MIGRATED_TO_ENGINE has a duplicate').toBe(
      MIGRATED_TO_ENGINE.length,
    );
  });

  it('gives every deliberate exclusion a reason', () => {
    const unreasoned = DELIBERATELY_ON_INNGEST.filter((e) => e.because.trim().length < 10);
    expect(unreasoned, 'an exclusion without a reason is an omission wearing a list entry').toEqual(
      [],
    );
  });
});
