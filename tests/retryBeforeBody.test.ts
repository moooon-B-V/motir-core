import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { retryOnceBeforeBody } from '@/lib/workspaces/retryBeforeBody';

// MOTIR-8333 — A BOUND TRANSACTION THAT DIES ON P2028 BEFORE ITS BODY STARTS IS
// RETRIED ONCE.
//
// Production, 2026-10-12T17:36:27Z (Sentry 7784896883, MOTIR-8332): the authed
// layout's `projectsService.listProjects` opened `withWorkspaceContext`, the web
// process stalled under host CPU steal, and the FIRST `set_config` bind was
// refused — "A query cannot be executed on an expired transaction … 5000 ms,
// however 8241 ms passed". The body never ran; the page failed with the client's
// digest-only Server Components error. MOTIR-8288 had covered the `maxWait` half
// in one resolver only.

const MAX_WAIT = 'Transaction API error: Unable to start a transaction in the given time.';
const EXPIRED =
  'Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 8241 ms passed since the start of the transaction.';

function p2028(message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2028',
    clientVersion: 'test',
  });
}

describe('retryOnceBeforeBody', () => {
  it('returns the first answer without a second attempt', async () => {
    const attempt = vi.fn(async (bodyStarted: () => void) => {
      bodyStarted();
      return 'ok';
    });
    await expect(retryOnceBeforeBody(attempt)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['maxWait', MAX_WAIT],
    ['timeout', EXPIRED],
  ])('retries the %s half once when it struck before the body', async (_half, message) => {
    const attempt = vi
      .fn<(bodyStarted: () => void) => Promise<string>>()
      .mockRejectedValueOnce(p2028(message))
      .mockResolvedValueOnce('ok');
    await expect(retryOnceBeforeBody(attempt)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('retries a P2028 carried as the cause of a translated error', async () => {
    const translated = new Error('wrapped', { cause: p2028(MAX_WAIT) });
    const attempt = vi
      .fn<(bodyStarted: () => void) => Promise<string>>()
      .mockRejectedValueOnce(translated)
      .mockResolvedValueOnce('ok');
    await expect(retryOnceBeforeBody(attempt)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('propagates a second consecutive failure — no third attempt', async () => {
    const second = p2028(MAX_WAIT);
    const attempt = vi
      .fn<(bodyStarted: () => void) => Promise<string>>()
      .mockRejectedValueOnce(p2028(EXPIRED))
      .mockRejectedValueOnce(second);
    await expect(retryOnceBeforeBody(attempt)).rejects.toBe(second);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('never retries once the body has started', async () => {
    const err = p2028(EXPIRED);
    const attempt = vi.fn(async (bodyStarted: () => void) => {
      bodyStarted();
      throw err;
    });
    await expect(retryOnceBeforeBody(attempt)).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error that is not a transaction timeout', async () => {
    const err = new Error('connection refused');
    const attempt = vi.fn<(bodyStarted: () => void) => Promise<string>>().mockRejectedValue(err);
    await expect(retryOnceBeforeBody(attempt)).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('the bound transaction helpers retry a P2028 raised before the body (real DB)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctx = { userId: 'user-8333', workspaceId: 'workspace-8333' };
  const readBoundWorkspace = async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT current_setting('app.workspace_id', true) AS id`;
    return rows[0]?.id;
  };

  it.each([
    ['timeout', EXPIRED],
    ['maxWait', MAX_WAIT],
  ])(
    'withWorkspaceContext answers after one %s refusal, in a fresh bound transaction',
    async (_half, message) => {
      const start = vi.spyOn(db, '$transaction').mockRejectedValueOnce(p2028(message));
      const body = vi.fn(readBoundWorkspace);

      await expect(withWorkspaceContext(ctx, body)).resolves.toBe(ctx.workspaceId);
      expect(start).toHaveBeenCalledTimes(2);
      expect(body).toHaveBeenCalledTimes(1);
    },
  );

  it('withUserContext answers after one refusal before its body', async () => {
    const start = vi.spyOn(db, '$transaction').mockRejectedValueOnce(p2028(EXPIRED));
    await expect(
      withUserContext(ctx.userId, async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT current_setting('app.user_id', true) AS id`;
        return rows[0]?.id;
      }),
    ).resolves.toBe(ctx.userId);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the transaction expired after the body ran', async () => {
    const realTransaction = db.$transaction.bind(db) as typeof db.$transaction;
    const start = vi.spyOn(db, '$transaction').mockImplementationOnce((async (
      ...args: Parameters<typeof db.$transaction>
    ) => {
      // The real transaction runs the binds and the body, then the commit is refused.
      await (realTransaction as (...a: unknown[]) => Promise<unknown>)(...args);
      throw p2028(EXPIRED);
    }) as unknown as typeof db.$transaction);
    const body = vi.fn(readBoundWorkspace);

    await expect(withWorkspaceContext(ctx, body)).rejects.toMatchObject({ code: 'P2028' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(1);
  });
});
