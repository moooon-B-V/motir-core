import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';

// The org Security pane's Server Action (Story MOTIR-1215 · Subtask MOTIR-3646).
//
// Transport only, so this asserts transport: which service method it calls, with
// what, which typed errors it translates rather than leaks, and which paths it
// revalidates. The policy itself is `tests/twoFactorPolicy.test.ts`'s.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { resolveActiveOrganization } = vi.hoisted(() => ({ resolveActiveOrganization: vi.fn() }));
const { setOrganizationPolicy } = vi.hoisted(() => ({ setOrganizationPolicy: vi.fn() }));
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
const orgCookie = vi.hoisted(() => ({ value: 'org_acme' as string | null }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (orgCookie.value === null ? undefined : { value: orgCookie.value }),
  }),
}));
vi.mock('@/lib/services/organizationsService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/organizationsService')>()),
  organizationsService: { resolveActiveOrganization },
}));
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: { setOrganizationPolicy },
}));

const ORG = { id: 'org_acme', name: 'Acme', slug: 'acme' };

async function action() {
  const mod = await import('@/app/(authed)/settings/organization/security/actions');
  return mod.setOrganizationRequireTwoFactorAction;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  resolveActiveOrganization.mockResolvedValue({ organization: ORG, role: 'owner' });
  setOrganizationPolicy.mockResolvedValue({ organizationId: ORG.id, requiresTwoFactor: true });
  orgCookie.value = 'org_acme';
});
// ⚠️ NO `vi.resetModules()` here. The action is imported dynamically and the
// error classes statically; resetting the registry between tests gives them two
// DIFFERENT copies of `OrgForbiddenError`, so the action's `instanceof` check
// misses and a handled refusal surfaces as a throw. Nothing in this file carries
// per-test module state, so one registry is both correct and cheaper.
afterEach(() => vi.clearAllMocks());

describe('setOrganizationRequireTwoFactorAction', () => {
  it('passes the ABSOLUTE value through to the service', async () => {
    const run = await action();
    await expect(run(true)).resolves.toEqual({ ok: true });

    expect(setOrganizationPolicy).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      actorUserId: 'u1',
      requiresTwoFactor: true,
    });
  });

  it('passes FALSE through unchanged — there is no flip anywhere on the path', async () => {
    const run = await action();
    await run(false);
    expect(setOrganizationPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ requiresTwoFactor: false }),
    );
  });

  it('revalidates BOTH the pane and the org settings home', async () => {
    // The home matters because MOTIR-3647 folds the WORKSPACE control onto it
    // below the tier-reveal threshold, and that control's locked state is
    // computed from the value written here — so a save on this pane changes what
    // that page shows.
    const run = await action();
    await run(true);
    expect(revalidatePath).toHaveBeenCalledWith('/settings/organization/security');
    expect(revalidatePath).toHaveBeenCalledWith('/settings/organization');
  });

  it('translates OrgForbiddenError into a handled refusal, never a throw', async () => {
    setOrganizationPolicy.mockRejectedValue(new OrgForbiddenError('u1', 'org_acme'));
    const run = await action();

    const result = await run(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Only owners and admins of an organization can change its security settings.',
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('translates OrganizationNotFoundError the same way — 404-not-403 stays intact', async () => {
    setOrganizationPolicy.mockRejectedValue(new OrganizationNotFoundError('org_acme'));
    const run = await action();
    await expect(run(true)).resolves.toEqual({
      ok: false,
      error: 'Only owners and admins of an organization can change its security settings.',
    });
  });

  it('⚠️ RETHROWS anything else — a failed write must not report as a handled refusal', async () => {
    setOrganizationPolicy.mockRejectedValue(new Error('connection reset'));
    const run = await action();
    await expect(run(true)).rejects.toThrow('connection reset');
  });

  it('redirects an anonymous caller to /sign-in', async () => {
    getSession.mockResolvedValue(null);
    const run = await action();
    await expect(run(true)).rejects.toThrow('NEXT_REDIRECT:/sign-in');
    expect(setOrganizationPolicy).not.toHaveBeenCalled();
  });

  it('resolves the active org with NO cookie — the org-only-member arm', async () => {
    // `resolveActiveOrganization` takes `null` as "no preference" and picks the
    // actor's own org. The arm exists for a member whose browser has never set
    // the cookie, and it must reach the service rather than short-circuit.
    orgCookie.value = null;
    const run = await action();
    await expect(run(true)).resolves.toEqual({ ok: true });
    expect(resolveActiveOrganization).toHaveBeenCalledWith('u1', null);
  });

  it('redirects to /dashboard when no active org resolves', async () => {
    resolveActiveOrganization.mockResolvedValue(null);
    const run = await action();
    await expect(run(true)).rejects.toThrow('NEXT_REDIRECT:/dashboard');
    expect(setOrganizationPolicy).not.toHaveBeenCalled();
  });
});
