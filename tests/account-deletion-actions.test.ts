import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { accountDeletionService } from '@/lib/services/accountDeletionService';
import { erasureDueAt } from '@/lib/users/dataSubjectRequests';
import { createTestUser } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE TWO DOORS ONTO THE DELETION WRITE (Story 8.4 · Subtask MOTIR-3704) —
// `app/(authed)/_account-deletion-actions.ts`, against the real Postgres.
//
// `tests/account-deletion-schedule.test.ts` owns the SERVICE: the row, the
// deadline, the refusals, the race, the sign-out's placement. This suite owns
// the transport layer above it, and it is worth its own file because a Server
// Action can be wrong in ways the service cannot:
//
//   1. IT REACHES THE RIGHT USER. The action resolves the session itself, so
//      an action that read the wrong id would schedule somebody else's
//      deletion — the one failure mode the service can never have, because it
//      is handed the id.
//   2. THE TYPED DOMAIN ERRORS BECOME DISCRIMINATED RESULTS, not throws. Each
//      arm is driven by producing the REAL condition against the real database
//      rather than by making the service throw, so a mapping that silently
//      stopped matching would fail here.
//   3. ⚠️ ONE ACT, TWO DOORS. Design DECISION 4 needs the pane's cancel and the
//      app-wide banner's cancel to be the same act; there is exactly one
//      exported cancel, and this suite drives it as both.
//
// `getSession` is the single `vi.mock` the project convention allows (the test
// environment has no cookies). `next/cache` is mocked because `revalidatePath`
// throws outside a request scope — the CALL is asserted, since the pane's
// repaint on a later navigation depends on it.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}));

import {
  cancelAccountDeletionAction,
  scheduleAccountDeletionAction,
} from '@/app/(authed)/_account-deletion-actions';

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Sign the given user in, as far as these actions can observe it. */
function signedInAs(userId: string, email = 'reader@example.com'): void {
  getSession.mockResolvedValue({ user: { id: userId, email } });
}

describe('scheduleAccountDeletionAction', () => {
  it('writes the request for the SESSION’s user and returns the row the copy interpolates', async () => {
    const user = await createTestUser();
    signedInAs(user.id);

    const result = await scheduleAccountDeletionAction();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.request.status).toBe('scheduled');
    // The deadline the confirmation and the banner render — derived from the
    // published constant through its own helper, never a retyped number.
    expect(result.request.erasureDueAt).toBe(
      erasureDueAt(new Date(result.request.requestedAt)).toISOString(),
    );

    // ⚠️ THE ROW BELONGS TO THE SIGNED-IN READER. Read back through the service
    // rather than trusting the returned DTO: this is the assertion that an
    // action reading the wrong id would fail.
    const open = await accountDeletionService.findOpenDeletion(user.id);
    expect(open?.id).toBe(result.request.id);
  });

  it('revalidates the pane so a later navigation does not read a stale card', async () => {
    const user = await createTestUser();
    signedInAs(user.id);

    await scheduleAccountDeletionAction();

    expect(revalidatePath).toHaveBeenCalledWith('/settings/account/data');
  });

  it('maps a SECOND request to ALREADY_SCHEDULED instead of throwing', async () => {
    const user = await createTestUser();
    signedInAs(user.id);
    await scheduleAccountDeletionAction();

    const again = await scheduleAccountDeletionAction();

    expect(again).toEqual({ ok: false, code: 'ALREADY_SCHEDULED' });
    // And it left the first request exactly as it was.
    expect(await accountDeletionService.findOpenDeletion(user.id)).not.toBeNull();
  });

  it('sends an anonymous caller to /sign-in and writes nothing', async () => {
    getSession.mockResolvedValue(null);

    await expect(scheduleAccountDeletionAction()).rejects.toThrow('NEXT_REDIRECT:/sign-in');
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('cancelAccountDeletionAction — ONE act, reached from BOTH doors', () => {
  it('cancels an open request and revalidates the pane', async () => {
    const user = await createTestUser();
    signedInAs(user.id);
    await scheduleAccountDeletionAction();

    const result = await cancelAccountDeletionAction();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.request.status).toBe('cancelled');
    expect(result.request.cancelledAt).not.toBeNull();
    // The row is what makes the banner disappear on the refresh: gone, not
    // merely hidden.
    expect(await accountDeletionService.findOpenDeletion(user.id)).toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith('/settings/account/data');
  });

  it('⚠️ is the SAME act from either door — the second caller finds nothing open', async () => {
    // Design DECISION 4 draws two doors onto ONE act. Whichever surface calls
    // first, the other must see the deletion already taken back rather than
    // cancelling a second time — which is exactly what a per-surface copy of
    // this action would get wrong.
    const user = await createTestUser();
    signedInAs(user.id);
    await scheduleAccountDeletionAction();

    const fromTheBanner = await cancelAccountDeletionAction();
    const fromThePane = await cancelAccountDeletionAction();

    expect(fromTheBanner.ok).toBe(true);
    expect(fromThePane).toEqual({ ok: false, code: 'NONE_OPEN' });
  });

  it('says NONE_OPEN — not FAILED — when nothing was ever scheduled', async () => {
    const user = await createTestUser();
    signedInAs(user.id);

    expect(await cancelAccountDeletionAction()).toEqual({ ok: false, code: 'NONE_OPEN' });
  });

  it('distinguishes an ALREADY_COMPLETED erasure from nothing scheduled', async () => {
    // Opposite answers to the reader, and the surface renders different copy
    // for each: *"nothing is scheduled"* is reassurance, *"it has already been
    // erased"* is not. Driven by the real terminal state rather than a stub.
    const user = await createTestUser();
    signedInAs(user.id);
    await scheduleAccountDeletionAction();
    await adminDb.$executeRawUnsafe(
      `UPDATE "account_deletion_request" SET status = 'completed', completed_at = NOW() WHERE user_id = $1`,
      user.id,
    );

    expect(await cancelAccountDeletionAction()).toEqual({ ok: false, code: 'ALREADY_COMPLETED' });
  });

  it('sends an anonymous caller to /sign-in', async () => {
    getSession.mockResolvedValue(null);
    await expect(cancelAccountDeletionAction()).rejects.toThrow('NEXT_REDIRECT:/sign-in');
  });
});
