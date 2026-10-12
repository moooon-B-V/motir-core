import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { retryOnceOnTransactionStart } from '@/lib/monitoring/retryOnTransactionStart';

// MOTIR-8288 — one retry when a transaction could not START.

const MAX_WAIT = 'Transaction API error: Unable to start a transaction in the given time.';
const EXPIRED =
  'Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 30459 ms passed since the start of the transaction.';

function p2028(message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2028',
    clientVersion: 'test',
  });
}

describe('retryOnceOnTransactionStart (MOTIR-8288)', () => {
  it('returns the first answer without a second call', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    await expect(retryOnceOnTransactionStart(run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once after a maxWait P2028 and returns the second answer', async () => {
    const run = vi.fn().mockRejectedValueOnce(p2028(MAX_WAIT)).mockResolvedValueOnce('ok');
    await expect(retryOnceOnTransactionStart(run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retries a maxWait P2028 carried as the cause of another error', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('wrapped', { cause: p2028(MAX_WAIT) }))
      .mockResolvedValueOnce('ok');
    await expect(retryOnceOnTransactionStart(run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('propagates a second consecutive maxWait P2028 unchanged — no third attempt', async () => {
    const second = p2028(MAX_WAIT);
    const run = vi.fn().mockRejectedValueOnce(p2028(MAX_WAIT)).mockRejectedValueOnce(second);
    await expect(retryOnceOnTransactionStart(run)).rejects.toBe(second);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry the timeout half of P2028', async () => {
    const err = p2028(EXPIRED);
    const run = vi.fn().mockRejectedValue(err);
    await expect(retryOnceOnTransactionStart(run)).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not retry any other error', async () => {
    const err = new Error('boom');
    const run = vi.fn().mockRejectedValue(err);
    await expect(retryOnceOnTransactionStart(run)).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
