import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE SYSTEM-EVENT DOORS (Story MOTIR-3415 · Subtask MOTIR-3456).
//
// `sendSystemEvent` and `dispatchSystemEvent` exist so the per-job cutover
// switch is consulted for the `system.*` namespace, which four emitters used to
// bypass by calling the Inngest client directly.
//
// ⚠️ WHAT THESE ASSERT IS THAT NOTHING OBSERVABLE MOVED. MOTIR-3413's boundary is
// "no job's OBSERVABLE behaviour changes", and routing four events through a new
// module is exactly the kind of change that quietly breaks that: the same event
// must still reach the same job with the same payload, and — the part most
// easily lost in a refactor — each caller's ERROR POLICY must survive. Two of
// the four deliberately do NOT swallow (one reports its outcome, one wants a
// step retry), which is why there are two doors rather than one.

const sendMock = vi.fn();
const dispatchToEngineMock = vi.fn();
const hasInngestSubscribersMock = vi.fn();

vi.mock('@/lib/jobs/client', () => ({ inngest: { send: (...a: unknown[]) => sendMock(...a) } }));
vi.mock('@/lib/jobs/engine/dispatcher', () => ({
  dispatchEventToEngine: (...a: unknown[]) => dispatchToEngineMock(...a),
  hasInngestSubscribers: (...a: unknown[]) => hasInngestSubscribersMock(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  dispatchToEngineMock.mockResolvedValue({
    eventId: null,
    enqueued: [],
    alreadyEnqueued: [],
    failed: [],
  });
  hasInngestSubscribersMock.mockReturnValue(true);
  sendMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The four events that used to bypass the switch, with the payload each carries. */
const CONVERTED = [
  { name: 'system.billing-seat-sync', data: { organizationId: 'org_1' } },
  {
    name: 'system.code-graph-index',
    data: {
      installationId: 'inst_1',
      workspaceId: 'ws_1',
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      defaultBranch: 'main',
    },
  },
  {
    name: 'system.code-graph-refresh',
    data: {
      installationId: 'inst_1',
      workspaceId: 'ws_1',
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      defaultBranch: 'main',
    },
  },
  { name: 'system.ci-runner-boot', data: { intentId: 'intent_1', workspaceId: null } },
] as const;

describe('sendSystemEvent — the best-effort door', () => {
  it.each(CONVERTED)(
    'consults the engine and reaches Inngest for $name',
    async ({ name, data }) => {
      const { sendSystemEvent } = await import('@/lib/jobs/sendEvent');
      await sendSystemEvent(name, data as never);

      // The switch is read on the engine arm — this is the whole point of the card.
      expect(dispatchToEngineMock).toHaveBeenCalledWith(name, data, { idempotencyKey: null });
      // …and with nothing routed, the event reaches Inngest exactly as before,
      // with a BYTE-IDENTICAL envelope.
      expect(sendMock).toHaveBeenCalledWith({ name, data });
    },
  );

  it('SKIPS the Inngest send once every subscriber of the event has moved', async () => {
    hasInngestSubscribersMock.mockReturnValue(false);
    const { sendSystemEvent } = await import('@/lib/jobs/sendEvent');
    await sendSystemEvent('system.billing-seat-sync', { organizationId: 'org_1' });

    expect(dispatchToEngineMock).toHaveBeenCalledOnce();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('SWALLOWS a transport failure — the caller emits post-commit', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendMock.mockRejectedValue(new Error('inngest unreachable'));
    const { sendSystemEvent } = await import('@/lib/jobs/sendEvent');

    await expect(
      sendSystemEvent('system.billing-seat-sync', { organizationId: 'org_1' }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it('SWALLOWS an engine failure AND still reaches Inngest', async () => {
    // The two lanes carry different subscribers, so giving up on the second
    // because the first failed would drop every job that has not moved.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dispatchToEngineMock.mockRejectedValue(new Error('engine down'));
    const { sendSystemEvent } = await import('@/lib/jobs/sendEvent');

    await expect(
      sendSystemEvent('system.code-graph-index', {
        installationId: 'i',
        workspaceId: 'w',
        repoOwner: 'o',
        repoName: 'r',
        defaultBranch: 'main',
      }),
    ).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalled();
  });
});

describe('dispatchSystemEvent — the strict door', () => {
  it('RETHROWS a transport failure, so a step retry and an outcome report still work', async () => {
    sendMock.mockRejectedValue(new Error('inngest unreachable'));
    const { dispatchSystemEvent } = await import('@/lib/jobs/sendEvent');

    await expect(
      dispatchSystemEvent('system.ci-runner-boot', { intentId: 'intent_1', workspaceId: null }),
    ).rejects.toThrow('inngest unreachable');
  });

  it('RETHROWS an engine failure too', async () => {
    dispatchToEngineMock.mockRejectedValue(new Error('engine down'));
    const { dispatchSystemEvent } = await import('@/lib/jobs/sendEvent');

    await expect(
      dispatchSystemEvent('system.ci-runner-boot', { intentId: 'intent_1', workspaceId: null }),
    ).rejects.toThrow('engine down');
  });

  it('is otherwise identical to the best-effort door on the happy path', async () => {
    const { dispatchSystemEvent } = await import('@/lib/jobs/sendEvent');
    await dispatchSystemEvent('system.ci-runner-boot', { intentId: 'intent_1', workspaceId: null });

    expect(sendMock).toHaveBeenCalledWith({
      name: 'system.ci-runner-boot',
      data: { intentId: 'intent_1', workspaceId: null },
    });
  });
});

describe('the converted call sites keep their existing error policy', () => {
  it('enqueueScaledTrackerSeatSync does not throw when the transport fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@/lib/billing/availability', () => ({ isCloudBilling: () => true }));
    sendMock.mockRejectedValue(new Error('down'));

    const { enqueueScaledTrackerSeatSync } = await import('@/lib/billing/seatSync');
    await expect(enqueueScaledTrackerSeatSync('org_1')).resolves.toBeUndefined();
  });

  it('dispatchCiRunnerBoot still REPORTS send_failed rather than swallowing silently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@/lib/orchestrator', () => ({ isOrchestratorConfigured: () => true }));
    sendMock.mockRejectedValue(new Error('down'));

    const { dispatchCiRunnerBoot } = await import('@/lib/ciFleet/bootDispatch');
    // The outcome is the seam this function exists to expose. If the strict door
    // had swallowed, this would read 'dispatched' and the caller would be lied to.
    await expect(dispatchCiRunnerBoot('intent_1')).resolves.toBe('send_failed');
  });

  it('enqueueCodeGraphIndex does not throw when the transport fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sendMock.mockRejectedValue(new Error('down'));

    const { enqueueCodeGraphIndex } = await import('@/lib/github/indexEnqueue');
    await expect(
      enqueueCodeGraphIndex({
        installationId: 'i',
        workspaceId: 'w',
        repoOwner: 'o',
        repoName: 'r',
        defaultBranch: 'main',
      }),
    ).resolves.toBeUndefined();
  });
});
