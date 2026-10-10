import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '@/messages/en.json';
import {
  DlqEntryNotFoundError,
  SystemReplayForbiddenError,
  SystemReplayWorkspaceRowError,
} from '@/lib/jobs/errors';

// MOTIR-8083 — the operator replay's TRANSPORT: the session, ONE service call,
// typed errors to copy, and both doors revalidated. The gate itself (operator
// only, no workspace on the row) is the service's and is proven against a real
// Postgres in `dashboard-system-replay.test.ts`; this file holds the action to
// being a thin layer over it.

const getSession = vi.fn();
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext: vi.fn() }));

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

// The real English `errors` catalogue, so the copy asserted is the copy shipped.
vi.mock('@/lib/i18n/errorsTranslator', () => ({
  getErrorsTranslator: async () => (key: string) =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown>)[part],
        enMessages.errors,
      ) as string,
}));

const replaySystemDLQ = vi.fn();
vi.mock('@/lib/services/jobsDashboardService', () => ({
  jobsDashboardService: { replaySystemDLQ: (...a: unknown[]) => replaySystemDLQ(...a) },
}));

import { replaySystemDlqAction } from '@/app/(authed)/settings/workspace/jobs/actions';

const SESSION = { user: { id: 'u-op', email: 'operator@motir.test' } };

beforeEach(() => {
  getSession.mockResolvedValue(SESSION);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('replaySystemDlqAction', () => {
  it('passes the SESSION user — id and email — to the service, never anything the client sent', async () => {
    replaySystemDLQ.mockResolvedValue({ outcome: 'replayed' });

    const result = await replaySystemDlqAction('dlq-1');

    expect(replaySystemDLQ).toHaveBeenCalledTimes(1);
    expect(replaySystemDLQ).toHaveBeenCalledWith({
      dlqId: 'dlq-1',
      userId: 'u-op',
      userEmail: 'operator@motir.test',
    });
    expect(result).toEqual({ ok: true, alreadyReplayed: false });
  });

  it('reports an already-replayed row as a success, not a failure', async () => {
    replaySystemDLQ.mockResolvedValue({ outcome: 'already-replayed' });
    expect(await replaySystemDlqAction('dlq-1')).toEqual({ ok: true, alreadyReplayed: true });
  });

  it('revalidates BOTH doors onto the System tab, so the row it stamped is re-read', async () => {
    replaySystemDLQ.mockResolvedValue({ outcome: 'replayed' });
    await replaySystemDlqAction('dlq-1');
    expect(revalidatePath.mock.calls.map(([p]) => p).sort()).toEqual([
      '/settings/organization',
      '/settings/workspace/jobs',
    ]);
  });

  it('sends a signed-out caller to sign in and calls nothing', async () => {
    getSession.mockResolvedValue(null);
    await expect(replaySystemDlqAction('dlq-1')).rejects.toThrow('NEXT_REDIRECT:/sign-in');
    expect(replaySystemDLQ).not.toHaveBeenCalled();
  });

  it('refuses an empty id without calling the service', async () => {
    expect(await replaySystemDlqAction('')).toEqual({
      ok: false,
      error: 'Missing dead-letter id.',
    });
    expect(replaySystemDLQ).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a non-operator',
      new SystemReplayForbiddenError('u-x'),
      'Only the platform operator can replay system dead letters.',
    ],
    [
      'a row that has a workspace — names the door that takes it',
      new SystemReplayWorkspaceRowError('dlq-9'),
      "That dead letter belongs to a workspace — replay it from that workspace's Dead letter tab.",
    ],
    [
      'a row deleted meanwhile',
      new DlqEntryNotFoundError('dlq-9'),
      'That dead-letter entry no longer exists.',
    ],
  ])('turns %s into its copy, and revalidates nothing', async (_name, error, copy) => {
    replaySystemDLQ.mockRejectedValue(error);

    expect(await replaySystemDlqAction('dlq-9')).toEqual({ ok: false, error: copy });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('lets an unexpected error through — a raw failure is not dressed up as a refusal', async () => {
    replaySystemDLQ.mockRejectedValue(new Error('connection reset'));
    await expect(replaySystemDlqAction('dlq-1')).rejects.toThrow('connection reset');
  });
});
