import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotAMemberError, WorkspaceForbiddenError } from '@/lib/workspaces/errors';

// The WORKSPACE Security control's Server Action (Story MOTIR-1215 · Subtask
// MOTIR-3647).
//
// Transport only, so this asserts transport. The one thing worth stating twice:
// the UI renders read-only for a `member` / `viewer`, but this action is a
// public entry point and the SERVICE is the gate — a member invoking it directly
// is refused by `setWorkspacePolicy`'s own `isWorkspaceManager` check
// (`tests/twoFactorPolicy.test.ts`), and this file asserts the action reports
// that refusal rather than leaking it.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { getWorkspaceContext } = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));
const { setWorkspacePolicy } = vi.hoisted(() => ({ setWorkspacePolicy: vi.fn() }));
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
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext,
}));
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: { setWorkspacePolicy },
}));

async function action() {
  const mod = await import('@/app/(authed)/settings/workspace/security/actions');
  return mod.setWorkspaceRequireTwoFactorAction;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getWorkspaceContext.mockResolvedValue({ workspaceId: 'ws_eng', userId: 'u1' });
  setWorkspacePolicy.mockResolvedValue({ workspaceId: 'ws_eng', requiresTwoFactor: true });
});
// ⚠️ NO `vi.resetModules()` here. The action is imported dynamically and the
// error classes statically; resetting the registry between tests gives them two
// DIFFERENT copies of `OrgForbiddenError`, so the action's `instanceof` check
// misses and a handled refusal surfaces as a throw. Nothing in this file carries
// per-test module state, so one registry is both correct and cheaper.
afterEach(() => vi.clearAllMocks());

describe('setWorkspaceRequireTwoFactorAction', () => {
  it('passes the ABSOLUTE value through to the service', async () => {
    const run = await action();
    await expect(run(true)).resolves.toEqual({ ok: true });

    expect(setWorkspacePolicy).toHaveBeenCalledWith({
      workspaceId: 'ws_eng',
      actorUserId: 'u1',
      requiresTwoFactor: true,
    });
  });

  it('passes FALSE through unchanged — there is no flip anywhere on the path', async () => {
    const run = await action();
    await run(false);
    expect(setWorkspacePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ requiresTwoFactor: false }),
    );
  });

  it('revalidates BOTH homes, because the control has two', async () => {
    // The standalone pane above the tier-reveal threshold, and the fold-in on
    // `/settings/organization` below it. Only one exists at a time, and
    // revalidating a 404 path is a no-op — which is what makes sending both the
    // correct thing rather than a hedge.
    const run = await action();
    await run(true);
    expect(revalidatePath).toHaveBeenCalledWith('/settings/workspace/security');
    expect(revalidatePath).toHaveBeenCalledWith('/settings/organization');
  });

  it('⚠️ translates the SERVICE\u2019s refusal of a member/viewer — the UI is not the gate', async () => {
    setWorkspacePolicy.mockRejectedValue(new WorkspaceForbiddenError('u1', 'ws_eng'));
    const run = await action();

    const result = await run(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Only owners and admins of a workspace can change its security settings.',
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('translates NotAMemberError the same way — 404-not-403 stays intact', async () => {
    setWorkspacePolicy.mockRejectedValue(new NotAMemberError('u1', 'ws_eng'));
    const run = await action();
    await expect(run(true)).resolves.toEqual({
      ok: false,
      error: 'Only owners and admins of a workspace can change its security settings.',
    });
  });

  it('⚠️ RETHROWS anything else — a failed write must not report as a handled refusal', async () => {
    setWorkspacePolicy.mockRejectedValue(new Error('connection reset'));
    const run = await action();
    await expect(run(true)).rejects.toThrow('connection reset');
  });

  it('redirects an anonymous caller to /sign-in', async () => {
    getSession.mockResolvedValue(null);
    const run = await action();
    await expect(run(true)).rejects.toThrow('NEXT_REDIRECT:/sign-in');
    expect(setWorkspacePolicy).not.toHaveBeenCalled();
  });

  it('redirects to /dashboard when there is no active workspace', async () => {
    getWorkspaceContext.mockResolvedValue(null);
    const run = await action();
    await expect(run(true)).rejects.toThrow('NEXT_REDIRECT:/dashboard');
    expect(setWorkspacePolicy).not.toHaveBeenCalled();
  });
});
