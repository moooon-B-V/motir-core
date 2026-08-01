import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { ciPeriodChargeRepository } from '@/lib/repositories/ciPeriodChargeRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import { periodStartFor } from '@/lib/ciMetering/period';
import { truncateAuthTables } from '../helpers/db';

// The CI-minutes ENTITLEMENT against real Postgres (Story MOTIR-1775 ·
// MOTIR-1901) — `docs/decisions/ci-minutes-allowance.md` §1, §2, §4, §6, §8.6.
//
// The motir-ai HTTP boundary is stubbed (global `fetch`, the convention the
// meter's suite established); the row lock, the RLS contexts, the watermark and
// the membership count all run for real, because every acceptance criterion here
// is about what the DATABASE does under contention.
//
// ⚠️ THE CLOCK IS PINNED (MOTIR-1950). Every fixture here meters into a FIXED
// period (`JULY_2026`), and `getEntitlementState` / `chargeForMeteredRun` are
// handed that period explicitly — but `assertDispatchAllowed` takes no period:
// it resolves its own from `new Date()` (`ciAllowanceService.ts` —
// `getEntitlementState(organizationId, new Date())`). So without a pinned clock
// the fixtures' rows and the gate's period agree ONLY while the real calendar
// happens to sit inside July 2026. It did until 2026-08-01T00:00 UTC, at which
// point the current period held zero consumption, the gate stopped refusing, and
// the whole suite's dispatch coverage silently changed meaning: the one test
// asserting a REFUSAL went red, and the six asserting "does NOT refuse" started
// passing VACUOUSLY. Pinning `now` inside the metered period is what makes every
// one of them exercise the real branch again, on any date the suite is run.
//
// This is the convention the sibling gate suite (`ciDispatchGate.test.ts`)
// already follows — *"the period the fixture's consumption lands in must be the
// one the gate reads"* — pinning the very same instant. This file was the only
// one in the CI-metering set that omitted it. A test that needs to cross the
// boundary moves the clock itself with `vi.setSystemTime` (see the §4.5 guard).

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');
const AUGUST_2026 = new Date('2026-08-01T00:00:00.000Z');
/** A fixed instant INSIDE `JULY_2026` — the period every fixture meters into. */
const NOW_WITHIN_JULY_2026 = new Date('2026-07-15T12:00:00.000Z');

/**
 * The period the GATE will actually read (MOTIR-1951).
 *
 * `assertDispatchAllowed` is the one entry point that takes no date: it asks for
 * `getEntitlementState(orgId, new Date())`, which `periodStartFor` truncates to
 * the CURRENT UTC month. So a test that seeds usage into a hardcoded month only
 * exercises the gate during that month — and from the 1st of the next one it
 * silently stops: the gate reads an empty period, never refuses, and every
 * `.resolves.toBeUndefined()` assertion below passes vacuously while the one
 * `.rejects` assertion turns red. That is exactly what happened on 2026-08-01,
 * when this file had pinned every gate test to `JULY_2026`.
 *
 * So gate-path tests meter HERE, derived from the same function the code uses,
 * which makes them correct in any month. The explicit `JULY_2026` /
 * `AUGUST_2026` literals stay where a test is deliberately ABOUT a specific
 * period (the boundary reset, the charge/state assertions) — those pass their
 * period in explicitly, so they never depend on the wall clock.
 *
 * ⚠️ IT IS A FUNCTION, NOT A CONST, AND THAT IS LOAD-BEARING. A module-level
 * `const … = periodStartFor(new Date())` is evaluated at IMPORT time — before
 * `beforeEach` pins the clock (MOTIR-1950) — so it would capture the REAL month
 * while the gate, running under the pinned clock, reads the pinned one. The two
 * halves would disagree and re-create the very bug both of them fixed: that
 * combination landed on `main` on 2026-08-01 and turned it red again within the
 * hour. Resolving it per-call keeps it consistent with whatever clock is in
 * force at the moment the gate is exercised — pinned or real.
 */
function currentGatePeriod(): Date {
  return periodStartFor(new Date());
}

interface Fixture {
  organizationId: string;
  workspaceId: string;
  ownerUserId: string;
}

/** An org with `members` memberships and one workspace. */
async function seedOrg(options?: { members?: number; isMeta?: boolean }): Promise<Fixture> {
  const suffix = Math.floor(Math.random() * 1_000_000);
  const owner = await usersService.createUser({
    email: `ci-allowance-${suffix}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: owner.id,
  });

  for (let i = 1; i < (options?.members ?? 1); i += 1) {
    const member = await usersService.createUser({
      email: `ci-allowance-${suffix}-m${i}@example.com`,
      password: PASSWORD,
      name: `Member ${i}`,
    });
    await organizationsService.addMember({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
      userId: member.id,
      role: 'member',
    });
  }

  if (options?.isMeta) {
    await db.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }

  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    ownerUserId: owner.id,
  };
}

/** Put `minutes` of metered consumption into the org's period rollup — i.e. put
 *  the meter's output in place without driving a whole webhook delivery. */
async function meter(fx: Fixture, minutes: number, periodStart = JULY_2026): Promise<void> {
  await withSystemContext((tx) =>
    ciPeriodUsageRepository.incrementForPeriod(
      {
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        periodStart,
        billableMinutes: Math.ceil(minutes),
        rawWallClockSeconds: minutes * 60,
        linearEquivalentMinutes: minutes,
      },
      tx,
    ),
  );
}

function chargeRow(fx: Fixture, periodStart = JULY_2026) {
  return withOrgServiceWriteContext(fx.organizationId, (tx) =>
    ciPeriodChargeRepository.findForPeriod(fx.organizationId, periodStart, tx),
  );
}

/** Every motir-ai call this service makes: the balance read and the debit.
 *  Returns the recorded debit bodies so a test can assert what was charged. */
function stubMotirAi(options?: { balance?: number; debitStatus?: number; debitThrows?: boolean }): {
  debits: Array<Record<string, unknown>>;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const debits: Array<Record<string, unknown>> = [];
  const seenRefs = new Map<string, number>();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes('/v1/usage')) {
      return new Response(JSON.stringify({ balance: options?.balance ?? 1000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/v1/credits/ci-overage')) {
      if (options?.debitThrows) throw new Error('ECONNRESET');
      if (options?.debitStatus && options.debitStatus >= 400) {
        return new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'boom',
            status: options.debitStatus,
            code: 'internal_error',
          }),
          { status: options.debitStatus, headers: { 'content-type': 'application/json' } },
        );
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      debits.push(body);
      // Mirror motir-ai's real idempotency: a repeated externalRef writes nothing.
      const ref = String(body.externalRef);
      const replay = seenRefs.has(ref);
      if (!replay) seenRefs.set(ref, Number(body.credits));
      return new Response(
        JSON.stringify({
          transactionId: `tx_${seenRefs.size}`,
          aiOrganizationId: 'ai_org',
          credits: -Number(body.credits),
          balanceAfter: (options?.balance ?? 1000) - Number(body.credits),
          exhausted: (options?.balance ?? 1000) - Number(body.credits) <= 0,
          idempotent: replay,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { debits, fetchMock };
}

beforeEach(async () => {
  await truncateAuthTables();
  // Pin `now` inside the metered period — see the header. Same convention as the
  // sibling gate suite (`ciDispatchGate.test.ts`), which pins the same instant.
  vi.setSystemTime(NOW_WITHIN_JULY_2026);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the pool is derived from MEMBERSHIP (§1, §4.2, §4.3)', () => {
  it('a solo org gets the 1,000-minute FLOOR, not 300', async () => {
    const fx = await seedOrg({ members: 1 });
    stubMotirAi();

    const state = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);

    expect(state.memberCount).toBe(1);
    expect(state.poolMinutes).toBe(1000);
    expect(state.floorApplied).toBe(true);
  });

  it('a 4-member org clears the floor at 300 x 4 = 1,200 (§1.2 crossover)', async () => {
    const fx = await seedOrg({ members: 4 });
    stubMotirAi();

    const state = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);

    expect(state.memberCount).toBe(4);
    expect(state.poolMinutes).toBe(1200);
    expect(state.floorApplied).toBe(false);
  });

  it('an org with NO scaled-tracker subscription still gets a pool (§4.3)', async () => {
    // Nothing in this fixture ever bought a subscription — the formula is the
    // same one, because a subscription-gated pool would refuse dispatches to an
    // org that holds a paid AI plan on a free tracker.
    const fx = await seedOrg({ members: 2 });
    stubMotirAi();

    const state = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);
    expect(state.applicable).toBe(true);
    expect(state.poolMinutes).toBe(1000);
  });

  it('the META org is bypassed entirely — no pool, no charge, no refusal (§4.4)', async () => {
    const fx = await seedOrg({ members: 3, isMeta: true });
    stubMotirAi({ balance: -500 });
    await meter(fx, 5000);

    const state = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);
    expect(state.applicable).toBe(false);
    expect(state.state).toBe('bypassed');

    const charged = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
      isMeta: true,
    });
    expect(charged).toEqual({ outcome: 'bypassed', reason: 'meta' });
    expect(await chargeRow(fx)).toBeNull();

    // And it is never refused, even at a negative balance. Meter into the
    // period the GATE reads too, so this asserts the meta bypass rather than an
    // empty period (MOTIR-1951).
    await meter(fx, 5000, currentGatePeriod());
    await expect(
      ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      }),
    ).resolves.toBeUndefined();
  });

  it('off-cloud the whole entitlement is inert (§8.5)', async () => {
    const fx = await seedOrg();
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const { fetchMock } = stubMotirAi();

    const state = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);
    expect(state).toMatchObject({ applicable: false, state: 'bypassed', poolMinutes: 0 });
    // Not merely "returns bypassed" — it must not TALK to motir-ai at all.
    expect(fetchMock).not.toHaveBeenCalled();

    expect(
      await ciAllowanceService.chargeForMeteredRun({
        organizationId: fx.organizationId,
        periodStart: JULY_2026,
      }),
    ).toEqual({ outcome: 'bypassed', reason: 'disabled' });
  });
});

describe('consumption INSIDE the pool debits nothing (the AC that proves the allowance is real)', () => {
  it('meters 900 minutes against a 1,000 pool and leaves the ledger untouched', async () => {
    const fx = await seedOrg({ members: 1 });
    const { debits } = stubMotirAi();
    await meter(fx, 900);

    const result = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    expect(result).toMatchObject({ outcome: 'within_allowance', poolMinutes: 1000 });
    expect(debits).toHaveLength(0);

    const row = await chargeRow(fx);
    expect(row?.chargedCredits).toBe(0);
    expect(row?.chargedMinutes).toBe(0);
    // The watermark still advanced — that is what makes the NEXT run incremental.
    expect(row?.accountedMinutes).toBe(900);
  });
});

describe('consumption BEYOND the pool debits exactly the excess (§2, §4.6)', () => {
  it('charges only the minutes past the pool on the run that crosses it', async () => {
    const fx = await seedOrg({ members: 1 });
    const { debits } = stubMotirAi();

    await meter(fx, 900);
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });
    await meter(fx, 250); // 1,150 total: 100 free, 150 over

    const result = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    expect(result).toMatchObject({ outcome: 'charged', creditsToDebit: 150 });
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ coreOrganizationId: fx.organizationId, credits: 150 });

    const row = await chargeRow(fx);
    expect(row?.chargedCredits).toBe(150);
    expect(row?.debitedCredits).toBe(150);
    expect(row?.pendingDebitRef).toBeNull();
  });

  it('DUPLICATE REPORT — re-charging the same consumption debits exactly once', async () => {
    const fx = await seedOrg({ members: 1 });
    const { debits } = stubMotirAi();
    await meter(fx, 1150);

    const first = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });
    const replay = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    expect(first).toMatchObject({ outcome: 'charged', creditsToDebit: 150 });
    expect(replay).toEqual({ outcome: 'no_new_consumption' });
    expect(debits).toHaveLength(1);
    expect((await chargeRow(fx))?.chargedCredits).toBe(150);
  });

  it('a mid-period seat REMOVAL never back-bills minutes that were free (§4.6)', async () => {
    // 4 members → a 1,200 pool. Burn all 1,200: nothing chargeable.
    const fx = await seedOrg({ members: 4 });
    const { debits } = stubMotirAi();
    await meter(fx, 1200);
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });
    expect(debits).toHaveLength(0);

    // A member leaves → the pool drops to 1,000, BELOW the 1,200 already consumed.
    // A period re-sum would now bill 200 minutes that were free when they ran.
    const members = await db.organizationMembership.findMany({
      where: { organizationId: fx.organizationId, role: 'member' },
      take: 1,
    });
    await db.organizationMembership.delete({ where: { id: members[0]!.id } });

    await meter(fx, 50);
    const result = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    // Only the 50 NEW minutes are chargeable — not 250.
    expect(result).toMatchObject({ outcome: 'charged', creditsToDebit: 50 });
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ credits: 50 });
  });

  it('carries a sub-credit remainder rather than rounding it away', async () => {
    const fx = await seedOrg({ members: 1 });
    const { debits } = stubMotirAi();
    await meter(fx, 1000.4);

    const result = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    expect(result).toMatchObject({ outcome: 'carried' });
    expect(debits).toHaveLength(0);
    const row = await chargeRow(fx);
    expect(row?.chargedMinutes).toBeCloseTo(0.4, 2);
    expect(row?.chargedCredits).toBe(0);
  });
});

describe('the period boundary resets the pool (§4.5)', () => {
  it('August starts from zero consumption and an unspent pool', async () => {
    const fx = await seedOrg({ members: 1 });
    const { debits } = stubMotirAi();

    await meter(fx, 1150, JULY_2026);
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });
    expect(debits).toHaveLength(1);

    // A 400-minute August run: inside the fresh pool, so nothing is charged even
    // though July ended over it.
    await meter(fx, 400, AUGUST_2026);
    const august = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: AUGUST_2026,
    });

    expect(august).toMatchObject({ outcome: 'within_allowance' });
    expect(debits).toHaveLength(1); // still just July's

    const augustState = await ciAllowanceService.getEntitlementState(
      fx.organizationId,
      new Date('2026-08-15T00:00:00.000Z'),
    );
    expect(augustState.consumedMinutes).toBe(400);
    expect(augustState.remainingMinutes).toBe(600);
    expect(augustState.state).toBe('within_allowance');
    expect(augustState.periodStart).toBe(AUGUST_2026.toISOString());
    expect(augustState.periodEnd).toBe('2026-09-01T00:00:00.000Z');

    // July's own row is untouched by August's activity.
    expect((await chargeRow(fx, JULY_2026))?.chargedCredits).toBe(150);
    expect((await chargeRow(fx, AUGUST_2026))?.chargedCredits).toBe(0);
  });
});

describe('REAL CONCURRENCY — two charges racing on one period (§Consequences)', () => {
  it('two simultaneous charges never double-bill the same minutes', async () => {
    const fx = await seedOrg({ members: 1 });
    const { debits } = stubMotirAi();
    await meter(fx, 1150); // 150 chargeable, once

    // Both callers see the same consumption; only the row lock decides who
    // accounts for it. Without `SELECT … FOR UPDATE` both read accountedMinutes=0
    // and both debit 150 — the lost update this test exists to catch.
    const [a, b] = await Promise.all([
      ciAllowanceService.chargeForMeteredRun({
        organizationId: fx.organizationId,
        periodStart: JULY_2026,
      }),
      ciAllowanceService.chargeForMeteredRun({
        organizationId: fx.organizationId,
        periodStart: JULY_2026,
      }),
    ]);

    // Every legitimate outcome is accepted (the concurrency-test rule): whichever
    // one won charged 150, the other found nothing new. What is NOT legitimate is
    // two debits, or a total other than 150.
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['charged', 'no_new_consumption']);
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ credits: 150 });
    expect((await chargeRow(fx))?.chargedCredits).toBe(150);
  });

  it('eight concurrent charges over separate meterings bill the total exactly once', async () => {
    const fx = await seedOrg({ members: 1 });
    const { debits } = stubMotirAi();
    // 1,000 free + 8 x 100 = 800 chargeable in total.
    await meter(fx, 1000);
    for (let i = 0; i < 8; i += 1) await meter(fx, 100);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        ciAllowanceService.chargeForMeteredRun({
          organizationId: fx.organizationId,
          periodStart: JULY_2026,
        }),
      ),
    );

    const totalDebited = debits.reduce((sum, d) => sum + Number(d.credits), 0);
    expect(totalDebited).toBe(800);
    const row = await chargeRow(fx);
    expect(row?.chargedCredits).toBe(800);
    expect(row?.debitedCredits).toBe(800);
    expect(row?.accountedMinutes).toBe(1800);
  });
});

describe('the DEBIT is a post-commit side effect (§8.6)', () => {
  it('a boundary failure leaves the metering + local charge intact and does not throw', async () => {
    const fx = await seedOrg({ members: 1 });
    stubMotirAi({ debitThrows: true });
    await meter(fx, 1150);

    const result = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    // Reported, never thrown — the meter's write must not roll back and the
    // webhook must still ack.
    expect(result).toMatchObject({ outcome: 'debit_pending', creditsToDebit: 150 });

    const row = await chargeRow(fx);
    expect(row?.chargedCredits).toBe(150); // booked locally
    expect(row?.debitedCredits).toBe(0); // not yet confirmed
    expect(row?.pendingDebitRef).not.toBeNull();
    expect(row?.pendingDebitCredits).toBe(150);

    // The consumption the meter wrote is untouched.
    const consumption = await withSystemContext((tx) =>
      ciPeriodUsageRepository.sumForOrgPeriod(fx.organizationId, JULY_2026, tx),
    );
    expect(consumption.linearEquivalentMinutes).toBe(1150);
  });

  it('the NEXT metering event retries the pending debit with its EXACT ref', async () => {
    const fx = await seedOrg({ members: 1 });
    stubMotirAi({ debitThrows: true });
    await meter(fx, 1150);
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });
    const pendingRef = (await chargeRow(fx))?.pendingDebitRef;
    expect(pendingRef).toBeTruthy();

    // motir-ai comes back. A further run arrives.
    vi.unstubAllGlobals();
    const { debits } = stubMotirAi();
    await meter(fx, 50);
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    // The retry reproduces the SAME ref — which is what makes it safe against a
    // first attempt that had actually landed (motir-ai replays it as a no-op).
    expect(debits[0]).toMatchObject({ externalRef: pendingRef, credits: 150 });
    // …and the same event then sends the 50 new minutes, so the ledger catches up
    // fully rather than in two separate hops.
    expect(debits[1]).toMatchObject({ credits: 50 });
    const row = await chargeRow(fx);
    expect(row?.pendingDebitRef).toBeNull();
    expect(row?.debitedCredits).toBe(200);
  });

  it('credits booked WHILE a debit is pending are never stranded', async () => {
    // The regression this exists for: if the amount debited were this event's own
    // increment rather than the gap to what motir-ai has CONFIRMED, credits
    // booked during an outage would be skipped forever — no later event revisits
    // them, and the org would silently under-pay.
    const fx = await seedOrg({ members: 1 });
    stubMotirAi({ debitThrows: true });
    await meter(fx, 1150); // 150 over
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });
    expect((await chargeRow(fx))?.debitedCredits).toBe(0);

    // Still down: another 100 minutes accrue and are booked but not debited.
    await meter(fx, 100);
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });
    const midway = await chargeRow(fx);
    expect(midway?.chargedCredits).toBe(250);
    expect(midway?.debitedCredits).toBe(0);

    // motir-ai recovers; a further 50 minutes arrive. The pending 150 settles,
    // then the REMAINING 100 + 50 go out together — 250 total, not 50.
    vi.unstubAllGlobals();
    const { debits } = stubMotirAi();
    await meter(fx, 50);
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    const totalDebited = debits.reduce((sum, d) => sum + Number(d.credits), 0);
    expect(totalDebited).toBe(300); // 150 (retry) + 150 (100 stranded + 50 new)
    const row = await chargeRow(fx);
    expect(row?.chargedCredits).toBe(300);
    expect(row?.debitedCredits).toBe(300);
    expect(row?.pendingDebitRef).toBeNull();
  });

  it('a non-Error thrown at the boundary is still reported, not swallowed', async () => {
    const fx = await seedOrg({ members: 1 });
    // A rejected promise need not carry an Error — the handler must describe it
    // rather than log "[object Object]" and lose the only diagnostic there is.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/v1/usage')) {
          return new Response(JSON.stringify({ balance: 1000 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw 'socket hang up';
      }),
    );
    await meter(fx, 1150);

    const result = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    // The client's own boundary mapping turns it into a typed
    // `MotirAiUnavailableError` first, so the reason survives into the pending
    // record instead of being lost as "[object Object]".
    expect(result).toMatchObject({
      outcome: 'debit_pending',
      detail: 'motir-ai is unavailable: socket hang up',
    });
  });

  it('settlePendingDebit is a no-op when there is nothing pending', async () => {
    const fx = await seedOrg({ members: 1 });
    const { debits } = stubMotirAi();

    await expect(
      ciAllowanceService.settlePendingDebit(fx.organizationId, JULY_2026, {
        pendingDebitRef: null,
        pendingDebitCredits: 0,
        debitedCredits: 0,
      }),
    ).resolves.toBe(true);
    expect(debits).toHaveLength(0);
  });

  it('a non-2xx from motir-ai is handled the same way as a transport failure', async () => {
    const fx = await seedOrg({ members: 1 });
    stubMotirAi({ debitStatus: 500 });
    await meter(fx, 1150);

    const result = await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });

    expect(result.outcome).toBe('debit_pending');
    expect((await chargeRow(fx))?.debitedCredits).toBe(0);
  });
});

describe('the REFUSAL at zero balance (§6.2, §6.3)', () => {
  it('refuses dispatch with a typed error carrying WHY', async () => {
    const fx = await seedOrg({ members: 1 });
    stubMotirAi({ balance: 0 });
    await meter(fx, 1200, currentGatePeriod());

    await expect(
      ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      }),
    ).rejects.toThrow(CiCreditsExhaustedError);

    try {
      await ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      });
      expect.unreachable('the gate should have refused');
    } catch (err) {
      const e = err as CiCreditsExhaustedError;
      expect(e.code).toBe('CI_CREDITS_EXHAUSTED');
      // §6.3 — enough for the surface to say why, not a generic failure.
      expect(e.detail).toMatchObject({
        organizationId: fx.organizationId,
        state: 'ci_credits_exhausted',
        consumedMinutes: 1200,
        poolMinutes: 1000,
        balance: 0,
      });
    }
  });

  // MOTIR-1950 — the guard for the whole class. The gate resolves its period from
  // the wall clock, so this pins BOTH sides of that boundary in one test: exhausted
  // inside the metered period, allowed again the instant the calendar rolls over
  // and §4.5 resets the pool. It fails if the clock pin is ever removed (the
  // refusal half stops holding off-July), and it fails if the gate stops reading
  // the CURRENT period (the reset half stops holding) — which is exactly the pair
  // of regressions that let this suite go quietly vacuous for a month.
  it('resolves the refusal against the CURRENT period — and the period reset lifts it (§4.5)', async () => {
    const fx = await seedOrg({ members: 1 });
    stubMotirAi({ balance: 0 });
    await meter(fx, 1200); // consumption lands in JULY_2026, the pinned period

    await expect(
      ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      }),
    ).rejects.toThrow(CiCreditsExhaustedError);

    // Roll the calendar into the next month: the pool resets, July's consumption
    // no longer counts against it, and the same org is dispatchable again.
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    await expect(
      ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      }),
    ).resolves.toBeUndefined();
  });

  it('does NOT refuse while merely drawing on credits — the two thresholds are distinct (§6.1)', async () => {
    const fx = await seedOrg({ members: 1 });
    stubMotirAi({ balance: 500 });
    await meter(fx, 1200, currentGatePeriod());

    await expect(
      ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      }),
    ).resolves.toBeUndefined();
  });

  it('does NOT refuse inside the allowance even at a zero balance', async () => {
    const fx = await seedOrg({ members: 1 });
    stubMotirAi({ balance: 0 });
    await meter(fx, 500, currentGatePeriod());

    await expect(
      ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      }),
    ).resolves.toBeUndefined();
  });

  it('FAILS OPEN when motir-ai is unreachable — an outage must not block the loop', async () => {
    const fx = await seedOrg({ members: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    await meter(fx, 1200, currentGatePeriod());

    await expect(
      ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      }),
    ).resolves.toBeUndefined();
  });

  it('is inert off-cloud', async () => {
    const fx = await seedOrg({ members: 1 });
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const { fetchMock } = stubMotirAi({ balance: -100 });

    await expect(
      ciAllowanceService.assertDispatchAllowed({
        userId: fx.ownerUserId,
        workspaceId: fx.workspaceId,
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the STATE is a readable value MOTIR-1907 + the billing panel consume', () => {
  it('reports every field §7.3 renders, in each of the three states', async () => {
    const fx = await seedOrg({ members: 6 });

    stubMotirAi({ balance: 900 });
    await meter(fx, 1240);
    const drawing = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);
    expect(drawing).toMatchObject({
      applicable: true,
      memberCount: 6,
      poolMinutes: 1800, // "300 min x 6 seats"
      floorApplied: false,
      consumedMinutes: 1240,
      remainingMinutes: 560,
      overageMinutes: 0,
      balance: 900,
      state: 'within_allowance',
    });

    await meter(fx, 980); // 2,220 total — 420 over the 1,800 pool
    await ciAllowanceService.chargeForMeteredRun({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
    });
    const over = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);
    expect(over).toMatchObject({
      consumedMinutes: 2220,
      remainingMinutes: 0,
      overageMinutes: 420,
      chargedCredits: 420, // §7.3.4 — "420 credits drawn this period"
      state: 'drawing_on_credits',
    });

    vi.unstubAllGlobals();
    stubMotirAi({ balance: 0 });
    const exhausted = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);
    expect(exhausted.state).toBe('ci_credits_exhausted');
  });

  it('an unreachable motir-ai reports balance null, never a misleading zero', async () => {
    const fx = await seedOrg({ members: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    await meter(fx, 1200);

    const state = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);
    expect(state.balance).toBeNull();
    expect(state.state).toBe('drawing_on_credits');
  });

  it('an org id that no longer resolves reads as non-meta on the FLOOR, never as bypassed', async () => {
    // A stale/deleted org must not silently take the meta bypass — that would
    // turn "we cannot see this org" into "this org is exempt from billing", the
    // safe direction being to account rather than to waive. Mirrors the default
    // `resolveTenantOrg` and the meter already use.
    stubMotirAi();
    const state = await ciAllowanceService.getEntitlementState('org_does_not_exist', JULY_2026);

    expect(state.applicable).toBe(true);
    expect(state.state).not.toBe('bypassed');
    expect(state.memberCount).toBe(0);
    expect(state.poolMinutes).toBe(1000);
  });

  it('an org with no metered runs reads as a clean, unspent pool', async () => {
    const fx = await seedOrg({ members: 2 });
    stubMotirAi();

    const state = await ciAllowanceService.getEntitlementState(fx.organizationId, JULY_2026);
    expect(state).toMatchObject({
      consumedMinutes: 0,
      remainingMinutes: 1000,
      overageMinutes: 0,
      chargedCredits: 0,
      state: 'within_allowance',
    });
  });
});
