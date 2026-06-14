import { afterEach, describe, expect, it, vi } from 'vitest';
import { inngest } from '@/lib/jobs/client';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { WorkItemTransitionedData } from '@/lib/jobs/types';

// `sendEvent` is the canonical post-commit event emit. Its transport (the
// Inngest enqueue) is BEST-EFFORT: every caller emits AFTER its transaction has
// committed, so a failed enqueue must never propagate — otherwise an
// already-committed mutation surfaces as a 500 and the caller's optimistic UI
// REVERTS a change the database kept (the board-drag / status inline-edit
// "snaps back but a refresh shows it moved" bug — PROD-443).

const PAYLOAD: WorkItemTransitionedData = {
  workspaceId: 'ws-1',
  workItemId: 'wi-1',
  actorId: 'user-1',
  fromStatusKey: 'in_progress',
  toStatusKey: 'in_review',
  revisionId: 'rev-1',
};

describe('sendEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enqueues the event through the inngest client on the happy path', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    await sendEvent('work-item/transitioned', PAYLOAD);
    expect(send).toHaveBeenCalledWith({ name: 'work-item/transitioned', data: PAYLOAD });
  });

  it('is BEST-EFFORT: a transport failure resolves (does NOT throw) and is logged', async () => {
    vi.spyOn(inngest, 'send').mockRejectedValue(
      new Error('Inngest API Error: 404 Event key not found'),
    );
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The committed mutation must not be undone — resolving (not throwing) is the contract.
    await expect(sendEvent('work-item/transitioned', PAYLOAD)).resolves.toBeUndefined();
    expect(errLog).toHaveBeenCalled();
  });

  it('still THROWS on a missing workspaceId — a programming error, not a transport one', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    await expect(
      sendEvent('work-item/transitioned', { ...PAYLOAD, workspaceId: '' }),
    ).rejects.toThrow(/requires an explicit workspaceId/);
    expect(send).not.toHaveBeenCalled();
  });
});
