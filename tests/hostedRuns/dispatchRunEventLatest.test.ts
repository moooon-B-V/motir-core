import { describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';

// The hosted stall read (MOTIR-690): when a run's newest event was written, or
// null for a run that has written none yet — which the supervisor reads as "no
// output so far", never as a crash. Pinned against a stub transaction so both
// arms are exercised without seeding a run.

function stub(row: { createdAt: Date } | null) {
  const calls: unknown[] = [];
  const tx = {
    dispatchRunEvent: {
      findFirst: async (args: unknown) => {
        calls.push(args);
        return row;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

describe('dispatchRunEventRepository.findLatestCreatedAt', () => {
  it("returns the newest event's time, reading by seq descending", async () => {
    const at = new Date('2026-09-27T10:00:00Z');
    const { tx, calls } = stub({ createdAt: at });
    expect(await dispatchRunEventRepository.findLatestCreatedAt('run-1', tx)).toEqual(at);
    expect(calls).toEqual([
      { where: { dispatchRunId: 'run-1' }, orderBy: { seq: 'desc' }, select: { createdAt: true } },
    ]);
  });

  it('returns null for a run with no events', async () => {
    const { tx } = stub(null);
    expect(await dispatchRunEventRepository.findLatestCreatedAt('run-1', tx)).toBeNull();
  });
});
