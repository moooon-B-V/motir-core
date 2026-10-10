import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstanceBootData } from '@/lib/jobs/types';

// WHEN AN ORG'S AI PLAN LAPSES, ITS AGENTS ARE DELETED AFTER 30 DAYS' NOTICE
// (Story MOTIR-6914 · MOTIR-6921; `docs/decisions/agent-instance-storage.md` §4, §5)
// — the push motir-ai's Stripe webhook makes (`setAiIncludedSeat`), the schedule on
// every live agent, the one notice per owner, the sweep deleting at the date and
// not before, and re-subscribing clearing it. Real services and a real Postgres,
// the instance fleet on the FAKE persistent orchestrator, motir-ai stubbed at
// `fetch` (the shared harness). One seam more is stubbed, the conventional one:
// `sendEvent`, the durable email queue, so the test sees what was enqueued and can
// make it fail.

const sendEventImpl = vi.hoisted(() => ({
  current: vi.fn(async (_name: string, _data: Record<string, unknown>) => undefined),
}));
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: (name: string, data: Record<string, unknown>) => sendEventImpl.current(name, data),
}));

const { db } = await import('@/lib/db');
const { deliverBootEvent } = await import('../helpers/agentBootDriver');
const { billingPropagationService } = await import('@/lib/services/billingPropagationService');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');
const { agentInstanceSweepService: sweeper } =
  await import('@/lib/services/agentInstanceSweepService');
const { agentInstanceLapseService } = await import('@/lib/services/agentInstanceLapseService');
const { deletionDateFor } = await import('@/lib/agentInstances/planLapse');
const { agentsDeletionScheduledEmail } =
  await import('@/lib/emailTemplates/agentsDeletionScheduled');
const { EMAIL_TEMPLATE_CLASS } = await import('@/lib/services/emailService');
const { adminDb } = await import('../helpers/adminDb');
const harness = await import('./_harness');
const { MIN, clock, debits, intervals, otherMember, setUpHarness, tearDownHarness } = harness;
/** The harness re-binds its fixture per test, so read it through the module. */
const fx = () => harness.fx;

const DAY_MS = 24 * 60 * 60 * 1000;

type Sent = { to: string; template: string; idempotencyKey: string; data: Record<string, unknown> };
const sent = (): Sent[] =>
  sendEventImpl.current.mock.calls
    .filter(([name]) => name === 'email.send')
    .map(([, data]) => data as unknown as Sent);

beforeEach(async () => {
  await setUpHarness();
  sendEventImpl.current.mockReset();
  // The boot event goes to the in-process driver, as the harness routes it.
  sendEventImpl.current.mockImplementation(async (name: string, data: unknown) => {
    if (name === 'agent-instance/boot') await deliverBootEvent(data as AgentInstanceBootData);
  });
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx().projectIdentifier;
const org = () =>
  adminDb.organization.findUniqueOrThrow({ where: { id: fx().workspace.organizationId } });
const live = () => adminDb.agentInstance.findMany({ where: { deletedAt: null } });
const push = (included: boolean) =>
  billingPropagationService.setAiIncludedSeat({
    organizationId: fx().workspace.organizationId,
    included,
  });

/** Two agents, two owners: the fixture's owner (running) and a colleague (hibernated). */
async function twoAgents() {
  const mine = await lifecycle.create(KEY(), { name: 'yue-claude', profileId: 'claude' }, fx().ctx);
  const colleague = await otherMember();
  const theirs = await lifecycle.create(
    KEY(),
    { name: 'their-codex', profileId: 'codex' },
    colleague,
  );
  await lifecycle.hibernate(KEY(), theirs.id, colleague);
  return { mine, theirs, colleague };
}

describe('the lapse: a seat-off push schedules every agent and tells each owner once', () => {
  it('records the lapse, schedules both agents at the start of the UTC day 30 days on, and emails each owner one notice', async () => {
    await twoAgents();
    await push(false);

    const lapsedAt = (await org()).aiPlanLapsedAt;
    expect(lapsedAt).not.toBeNull();
    const expected = deletionDateFor(lapsedAt!);
    expect(expected.getUTCHours()).toBe(0);
    expect(expected.getTime() - lapsedAt!.getTime()).toBeGreaterThan(29 * DAY_MS);
    expect(expected.getTime() - lapsedAt!.getTime()).toBeLessThanOrEqual(30 * DAY_MS);
    const rows = await live();
    expect(rows.map((r) => r.scheduledDeletionAt?.toISOString())).toEqual([
      expected.toISOString(),
      expected.toISOString(),
    ]);
    expect(rows.every((r) => r.deletionNoticedAt !== null)).toBe(true);

    const mail = sent();
    expect(mail).toHaveLength(2);
    expect(new Set(mail.map((m) => m.to)).size).toBe(2);
    for (const m of mail) {
      expect(m.template).toBe('agents-deletion-scheduled');
      expect(m.data).toMatchObject({
        deletionDate: expected.toLocaleString('en-US', {
          timeZone: 'UTC',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }),
        billingUrl: expect.stringMatching(/\/settings\/organization\/billing$/),
      });
    }
    expect(mail.map((m) => (m.data['agentNames'] as string[]).join()).sort()).toEqual([
      'their-codex',
      'yue-claude',
    ]);
  });

  it('a repeated push sends no second email and keeps the first date', async () => {
    await twoAgents();
    await push(false);
    const first = (await live()).map((r) => r.scheduledDeletionAt?.toISOString());
    const lapsedAt = (await org()).aiPlanLapsedAt;
    await push(false);
    expect(sent()).toHaveLength(2);
    expect((await live()).map((r) => r.scheduledDeletionAt?.toISOString())).toEqual(first);
    expect((await org()).aiPlanLapsedAt).toEqual(lapsedAt);
  });

  it('a notice that failed to send is owed, not lost: the sweep sends it once', async () => {
    await twoAgents();
    sendEventImpl.current.mockImplementationOnce(async () => {
      throw new Error('queue down');
    });
    await push(false);
    // One owner's send failed, the other's went out — one failure never skips another.
    expect(sent()).toHaveLength(2);
    expect((await live()).filter((r) => r.deletionNoticedAt === null)).toHaveLength(1);
    // The schedule stands regardless: commit first, then the effect.
    expect((await live()).every((r) => r.scheduledDeletionAt !== null)).toBe(true);

    const pass = await sweeper.sweepPlanLapse();
    expect(pass).toMatchObject({ noticed: 1, deleted: 0 });
    expect(sent()).toHaveLength(3);
    expect((await live()).every((r) => r.deletionNoticedAt !== null)).toBe(true);
    expect((await sweeper.sweepPlanLapse()).noticed).toBe(0);
  });

  it('the page shows the banner date and each row’s date', async () => {
    const { mine } = await twoAgents();
    expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx().ctx)).planLapse).toBeNull();
    await push(false);
    const deletesOn = deletionDateFor((await org()).aiPlanLapsedAt!).toISOString();
    const page = await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx().ctx);
    expect(page.planLapse).toEqual({ deletesOn });
    expect(page.instances.find((i) => i.id === mine.id)!.scheduledDeletionAt).toBe(deletesOn);
  });
});

describe('restored: a seat-on push before the date clears it', () => {
  it('clears the lapse and every schedule, and the page shows no notice', async () => {
    await twoAgents();
    await push(false);
    await push(true);
    expect((await org()).aiPlanLapsedAt).toBeNull();
    expect((await live()).map((r) => [r.scheduledDeletionAt, r.deletionNoticedAt])).toEqual([
      [null, null],
      [null, null],
    ]);
    const page = await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx().ctx);
    expect(page.planLapse).toBeNull();
    expect(page.instances.every((i) => i.scheduledDeletionAt === null)).toBe(true);
    // Nothing is left to delete, however far the clock runs.
    clock.advance(40 * DAY_MS);
    expect((await sweeper.sweepPlanLapse()).deleted).toBe(0);
    expect(await live()).toHaveLength(2);
  });

  it('a later lapse is a fresh one: new date, new notice', async () => {
    await twoAgents();
    await push(false);
    await push(true);
    await push(false);
    expect(sent()).toHaveLength(4);
  });
});

describe('the deletion: the sweep deletes at the date, through the ordinary delete', () => {
  it('deletes nothing before the date, and both agents after it — the running one’s final interval charged', async () => {
    const { mine } = await twoAgents();
    await push(false);
    const deletesOn = deletionDateFor((await org()).aiPlanLapsedAt!);

    // One minute short of the date.
    clock.advance(deletesOn.getTime() - clock.now().getTime() - MIN);
    await lifecycle.touchActivity(mine.id); // keep it running, so the idle sweep leaves it
    expect((await sweeper.sweepPlanLapse()).deleted).toBe(0);
    expect(await live()).toHaveLength(2);

    clock.advance(2 * MIN);
    const debitsBefore = debits().length;
    const pass = await sweeper.sweepPlanLapse();
    expect(pass).toMatchObject({ deleted: 2, errors: 0 });
    expect(await live()).toEqual([]);
    const all = await adminDb.agentInstance.findMany({});
    expect(all.every((r) => r.state === 'deleting' && r.deletedAt !== null)).toBe(true);
    const last = (await intervals()).filter((i) => i.agentInstanceId === mine.id).at(-1)!;
    expect(last).toMatchObject({ endReason: 'deleted', chargeOutcome: 'charged' });
    expect(debits().length).toBeGreaterThan(debitsBefore);
  });
});

describe('Motir’s own organisations are never scheduled (§5)', () => {
  for (const flag of ['isMeta', 'internalBilling'] as const) {
    it(`an ${flag} org: a seat-off push records no lapse, schedules nothing and sends nothing`, async () => {
      await adminDb.organization.update({
        where: { id: fx().workspace.organizationId },
        data: { [flag]: true },
      });
      await twoAgents();
      await push(false);
      expect((await org()).aiPlanLapsedAt).toBeNull();
      expect((await live()).every((r) => r.scheduledDeletionAt === null)).toBe(true);
      expect(sent()).toEqual([]);
      expect((await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx().ctx)).planLapse).toBeNull();
    });
  }

  it('the sweep deletes none of their agents — an org classified internal after its lapse keeps them, and its schedule is cleared', async () => {
    await twoAgents();
    await push(false);
    await adminDb.organization.update({
      where: { id: fx().workspace.organizationId },
      data: { internalBilling: true },
    });
    // Past the DATE, not "40 days on": the lapse date is cut from the REAL clock and
    // the harness clock is pinned in September, so a fixed advance goes stale as the
    // real date moves (it did on 2026-10-10 — the date moved past the pinned clock + 40d).
    const deletesOn = deletionDateFor((await org()).aiPlanLapsedAt!);
    clock.advance(deletesOn.getTime() - clock.now().getTime() + MIN);
    expect((await sweeper.sweepPlanLapse()).deleted).toBe(0);
    expect(await live()).toHaveLength(2);
    expect((await live()).every((r) => r.scheduledDeletionAt === null)).toBe(true);
    expect((await org()).aiPlanLapsedAt).toBeNull();
  });
});

describe('the notice email', () => {
  it('is essential mail, never budgeted away', () => {
    expect(EMAIL_TEMPLATE_CLASS['agents-deletion-scheduled']).toBe('essential');
  });

  it('names the organisation and the date in the subject, lists the agents, and links Billing & plans', async () => {
    const rendered = await agentsDeletionScheduledEmail({
      recipientName: 'Yue',
      organizationName: 'Acme',
      deletionDate: 'Oct 29, 2026',
      agentNames: ['yue-claude', 'yue-codex'],
      billingUrl: 'https://app.motir.test/settings/organization/billing',
    });
    expect(rendered.subject).toBe('Your agents in Acme will be deleted on Oct 29, 2026');
    expect(rendered.text).toContain(
      'Your organization’s AI plan has ended. Your agents will be deleted on Oct 29, 2026 unless the plan is renewed.',
    );
    expect(rendered.text).toContain('These 2 agents of yours in Acme will be deleted');
    expect(rendered.text).toContain('- yue-claude\n- yue-codex');
    expect(rendered.text).toContain(
      'Renew the AI plan: https://app.motir.test/settings/organization/billing',
    );
    expect(rendered.html).toContain('https://app.motir.test/settings/organization/billing');

    const one = await agentsDeletionScheduledEmail({
      recipientName: 'Yue',
      organizationName: 'Acme',
      deletionDate: 'Oct 29, 2026',
      agentNames: ['yue-claude'],
      billingUrl: 'https://app.motir.test/settings/organization/billing',
      locale: 'zh',
    });
    expect(one.subject).toBe('你在 Acme 的智能体将于 Oct 29, 2026 被删除');
  });

  it('a lapse on an org that has no agents sends nothing and still records the lapse', async () => {
    await push(false);
    expect((await org()).aiPlanLapsedAt).not.toBeNull();
    expect(sent()).toEqual([]);
    expect(await agentInstanceLapseService.sendPendingNotices()).toBe(0);
  });
});
