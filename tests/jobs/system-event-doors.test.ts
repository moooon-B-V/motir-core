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

// ⚠️ THE INNGEST CLIENT IS SPIED ON, NOT MODULE-MOCKED, and that is a consequence
// of MOTIR-3458 worth stating. `sendEvent` now side-effect-imports
// `./engine/subscribers`, which evaluates all 37 definition modules so the emit
// path can see its subscribers — and every one of them calls
// `inngest.createFunction` at module scope. A `vi.mock` supplying only `send`
// therefore breaks the import itself with `inngest.createFunction is not a
// function`, long before any assertion runs. Spying keeps the real client (so
// the definitions still build) while still observing the transport.
vi.mock('@/lib/jobs/engine/dispatcher', () => ({
  dispatchEventToEngine: (...a: unknown[]) => dispatchToEngineMock(...a),
  hasInngestSubscribers: (...a: unknown[]) => hasInngestSubscribersMock(...a),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  const { inngest } = await import('@/lib/jobs/client');
  vi.spyOn(inngest, 'send').mockImplementation((...a: unknown[]) => sendMock(...a));
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
  // ⚠️ THESE THREE RESET THE MODULE GRAPH BEFORE MOCKING, and that is not
  // ceremony. `sendEvent` now side-effect-imports the registry, which imports
  // `definitions/ciRunnerFleet.ts`, which imports `@/lib/ciFleet/bootDispatch` —
  // so by the time a `vi.doMock` ran at test time the module under test was
  // already cached and the mock did nothing. Two of these tests passed anyway,
  // for the worst possible reason: unmocked, `isCloudBilling()` returns false and
  // `enqueueScaledTrackerSeatSync` returns before it ever reaches the transport,
  // so the assertion "it does not throw" held vacuously. Each test below now
  // asserts the transport was actually REACHED.

  /** A fresh module graph with the gates open and the transport failing. */
  async function withFailingTransport(): Promise<{ send: ReturnType<typeof vi.fn> }> {
    vi.resetModules();
    // SPREAD the originals — these modules export more than the one gate each
    // test opens, and a wholesale replacement drops constants their siblings
    // read (`ORCHESTRATOR_REQUEST_TIMEOUT_MS`, which `ciRunnerBootService` needs
    // at module scope).
    vi.doMock('@/lib/billing/availability', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/billing/availability')>()),
      isCloudBilling: () => true,
    }));
    vi.doMock('@/lib/orchestrator', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/orchestrator')>()),
      isOrchestratorConfigured: () => true,
    }));
    vi.doMock('@/lib/jobs/engine/dispatcher', () => ({
      dispatchEventToEngine: async () => ({
        eventId: null,
        enqueued: [],
        alreadyEnqueued: [],
        failed: [],
      }),
      hasInngestSubscribers: () => true,
    }));
    const { inngest } = await import('@/lib/jobs/client');
    const send = vi.fn().mockRejectedValue(new Error('down'));
    vi.spyOn(inngest, 'send').mockImplementation((...a: unknown[]) => send(...a));
    return { send };
  }

  afterEach(() => {
    vi.doUnmock('@/lib/billing/availability');
    vi.doUnmock('@/lib/orchestrator');
    vi.doUnmock('@/lib/jobs/engine/dispatcher');
    vi.resetModules();
  });

  it('enqueueScaledTrackerSeatSync SWALLOWS a transport failure it actually reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = await withFailingTransport();

    const { enqueueScaledTrackerSeatSync } = await import('@/lib/billing/seatSync');
    await expect(enqueueScaledTrackerSeatSync('org_1')).resolves.toBeUndefined();
    // The part that makes the assertion above mean anything.
    expect(send).toHaveBeenCalledWith({
      name: 'system.billing-seat-sync',
      data: { organizationId: 'org_1' },
    });
  });

  it('dispatchCiRunnerBoot still REPORTS send_failed rather than swallowing silently', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = await withFailingTransport();

    const { dispatchCiRunnerBoot } = await import('@/lib/ciFleet/bootDispatch');
    // The outcome is the seam this function exists to expose. Had the strict door
    // swallowed, this would read 'dispatched' and the caller would be lied to.
    await expect(dispatchCiRunnerBoot('intent_1')).resolves.toBe('send_failed');
    expect(send).toHaveBeenCalledOnce();
  });

  it('enqueueCodeGraphIndex SWALLOWS a transport failure it actually reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = await withFailingTransport();

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
    expect(send).toHaveBeenCalledOnce();
  });
});
