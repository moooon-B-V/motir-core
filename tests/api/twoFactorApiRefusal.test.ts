import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Story MOTIR-1215 · Subtask MOTIR-3653 — the API gate's BEHAVIOUR, against
// real Postgres and the real policy predicate.
//
// `tests/api/two-factor-api-gate.test.ts` proves every route is WIRED to the
// gate. This proves the gate ANSWERS correctly, and the two assertions it exists
// for are opposites:
//
//   · a held member is refused on a scoped route (403, typed, naming the tier)
//   · a held member can still ENROL — the deadlock check, and the one that must
//     not be skipped, because getting it wrong makes the hold permanent
//
// Only `getSession` is mocked (the suite has no cookies — CLAUDE.md's single
// sanctioned mock). Compliance is decided by the shipped
// `twoFactorPolicyService` reading real rows, so a change to the predicate
// surfaces here rather than being mocked away.

// The workspace door reads a cookie for the ACTIVE workspace. The suite has no
// request scope, so the store is a plain map — left EMPTY, which exercises the
// resolver's fallback (`resolveWorkspaceFromIds` with a null cookie), the same
// path a first request after sign-in takes.
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }),
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: vi.fn() };
});

const { db } = await import('@/lib/db');
const { getSession } = await import('@/lib/auth');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { TWO_FACTOR_REQUIRED_PATH } = await import('@/lib/auth/twoFactorGate');
const {
  requireCompliantSession,
  requireCompliantWorkspaceContext,
  refuseIfNonCompliant,
  resolveTwoFactorHold,
} = await import('@/lib/auth/requireCompliantSession');

// A GATED route, folded onto `requireCompliantSession` by this card's sweep.
// Personal and session-scoped, so it needs no workspace cookie — which is what
// makes it the cheap end-to-end sample.
const appearance = await import('@/app/api/appearance-preference/route');

// The three routes the ESCAPE HATCH is made of — every one of them exempt.
const twoFactorStatus = await import('@/app/api/account/two-factor/status/route');
const trustedDevices = await import('@/app/api/account/two-factor/trusted-devices/route');
const backupCodes = await import('@/app/api/account/two-factor/backup-codes/route');

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** One org, one workspace, one owner — the shape every account starts in. */
async function makeMember(name = 'Acme') {
  const user = await usersService.createUser({
    email: `two-factor-api-${++seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Ada',
  });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: user.id });
  vi.mocked(getSession).mockResolvedValue({
    user: { id: user.id, email: `two-factor-api-${seq}@example.com`, name: 'Ada' },
  } as never);
  return { user, workspace, organizationId: workspace.organizationId };
}

const requireOrg2FA = (organizationId: string) =>
  adminDb.organization.update({ where: { id: organizationId }, data: { requiresTwoFactor: true } });
const requireWorkspace2FA = (workspaceId: string) =>
  adminDb.workspace.update({ where: { id: workspaceId }, data: { requiresTwoFactor: true } });

/** Enrol by PASSKEY — deliberately, since it leaves `twoFactorEnabled` false. */
const enrolByPasskey = (userId: string) =>
  adminDb.passkey.create({
    data: {
      id: `pk_${userId}`,
      name: 'YubiKey',
      publicKey: 'pub',
      userId,
      credentialID: `cred_${userId}`,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: 'usb',
    },
  });

// ── The refusal ─────────────────────────────────────────────────────────────

describe('a held member is REFUSED on a scoped route', () => {
  it('403 with a typed body naming the ORGANIZATION that is asking', async () => {
    const { organizationId } = await makeMember('Acme');
    await requireOrg2FA(organizationId);

    const res = await appearance.GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: 'TWO_FACTOR_REQUIRED',
      tier: 'organization',
      tierName: 'Acme',
      enrolAt: TWO_FACTOR_REQUIRED_PATH,
    });
  });

  it('names the WORKSPACE when only a workspace requires it', async () => {
    const { workspace } = await makeMember('Acme');
    await requireWorkspace2FA(workspace.id);

    const res = await appearance.GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ tier: 'workspace', tierName: workspace.name });
  });

  it('⚠️ refuses the WRITE too, not only the read', async () => {
    // A gate on GET alone would leave the mutation open, which is the worse
    // half: a held member could still change state through `fetch`.
    const { organizationId } = await makeMember();
    await requireOrg2FA(organizationId);

    const res = await appearance.PATCH(
      new Request('http://localhost/api/appearance-preference', {
        method: 'PATCH',
        body: JSON.stringify({ pattern: 'dark' }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('TWO_FACTOR_REQUIRED');
  });

  it('⚠️ 403 is DISTINCT from 401 — no session is not a 2FA problem', async () => {
    // Answering an anonymous caller with TWO_FACTOR_REQUIRED would tell somebody
    // who is not signed in to go and enrol.
    vi.mocked(getSession).mockResolvedValue(null as never);

    const res = await appearance.GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
});

// ── The pair ────────────────────────────────────────────────────────────────

describe('the SAME member, once enrolled, is let through', () => {
  it('403 before, 200 after — nothing else changed', async () => {
    const { user, organizationId } = await makeMember();
    await requireOrg2FA(organizationId);

    expect((await appearance.GET()).status).toBe(403);

    await enrolByPasskey(user.id);

    const after = await appearance.GET();
    expect(after.status).toBe(200);
    expect(await after.json()).toHaveProperty('preference');
  });

  it('⚠️ a PASSKEY satisfies it — `twoFactorEnabled` stays false', async () => {
    // The regression this story owns. Compliance is "has a second factor", not
    // "flipped the TOTP flag"; a naive check locks a passkey-only account out of
    // the entire product with no way back in.
    const { user, organizationId } = await makeMember();
    await requireOrg2FA(organizationId);
    await enrolByPasskey(user.id);

    expect((await adminDb.user.findUnique({ where: { id: user.id } }))!.twoFactorEnabled).toBe(
      false,
    );
    expect((await appearance.GET()).status).toBe(200);
  });

  it('a member nobody is asking anything of is untouched', async () => {
    await makeMember();
    expect((await appearance.GET()).status).toBe(200);
  });
});

// ── ⚠️ THE DEADLOCK CHECK ───────────────────────────────────────────────────

describe('⚠️ a held member can still complete enrolment END TO END', () => {
  it('reaches all three enrolment routes while held, then becomes compliant', async () => {
    // The check that must not be skipped. If any route the Security pane needs
    // is gated, the hold has no exit: the member is refused everywhere, refused
    // on the way to enrolling, and the only remedy is an admin turning the
    // policy off. That is worse than never having held them.
    const { user, organizationId } = await makeMember();
    await requireOrg2FA(organizationId);

    // Held everywhere else…
    expect((await appearance.GET()).status).toBe(403);

    // …and NOT held on the escape hatch.
    const status = await twoFactorStatus.GET();
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ enabled: false });

    // The pane's device list is cleared through DELETE — the only method this
    // route carries — and it must not be held either.
    const devices = await trustedDevices.DELETE(
      new Request('http://localhost/api/account/two-factor/trusted-devices', { method: 'DELETE' }),
    );
    expect(devices.status).not.toBe(403);

    // Enrol, exactly as the pane does.
    await enrolByPasskey(user.id);

    // Recovery codes — the last step of enrolment — and then the way back in.
    const codes = await backupCodes.POST();
    expect(codes.status).not.toBe(403);
    expect((await appearance.GET()).status).toBe(200);
  });

  it('the escape hatch answers the SESSION user, so it cannot leak', async () => {
    // Exempt from the hold is not exempt from authentication.
    vi.mocked(getSession).mockResolvedValue(null as never);
    expect((await twoFactorStatus.GET()).status).toBe(401);
    expect(
      (
        await trustedDevices.DELETE(
          new Request('http://localhost/api/account/two-factor/trusted-devices', {
            method: 'DELETE',
          }),
        )
      ).status,
    ).toBe(401);
  });
});

// ── The workspace door ──────────────────────────────────────────────────────

describe('requireCompliantWorkspaceContext — the tenant-scoped twin', () => {
  it('401s with no session, before any policy read', async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    const gate = await requireCompliantWorkspaceContext();
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.response.status).toBe(401);
  });

  it('refuses a held member with the same typed 403', async () => {
    const { organizationId } = await makeMember('Acme');
    await requireOrg2FA(organizationId);

    const gate = await requireCompliantWorkspaceContext();
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(403);
    expect(await gate.response.json()).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
      tierName: 'Acme',
    });
  });

  it('hands back the context — under the same name — for a compliant member', async () => {
    const { user, workspace } = await makeMember();
    const gate = await requireCompliantWorkspaceContext();
    expect(gate.ok).toBe(true);
    expect(gate.ok && gate.ctx).toEqual({ userId: user.id, workspaceId: workspace.id });
  });
});

// ── The shared verdict ──────────────────────────────────────────────────────

describe('the shapers agree with the verdict they share', () => {
  it('`resolveTwoFactorHold` returns null for a compliant member and a body for a held one', async () => {
    const { user, organizationId } = await makeMember('Acme');
    expect(await resolveTwoFactorHold(user.id)).toBeNull();

    await requireOrg2FA(organizationId);
    expect(await resolveTwoFactorHold(user.id)).toEqual({
      code: 'TWO_FACTOR_REQUIRED',
      tier: 'organization',
      tierName: 'Acme',
      enrolAt: TWO_FACTOR_REQUIRED_PATH,
    });
  });

  it('`refuseIfNonCompliant` is that verdict as a 403, or null', async () => {
    const { user, organizationId } = await makeMember();
    expect(await refuseIfNonCompliant(user.id)).toBeNull();

    await requireOrg2FA(organizationId);
    const refusal = await refuseIfNonCompliant(user.id);
    expect(refusal!.status).toBe(403);
  });

  it('`requireCompliantSession` carries the session through on the ok arm', async () => {
    const { user } = await makeMember();
    const gate = await requireCompliantSession();
    expect(gate.ok).toBe(true);
    expect(gate.ok && gate.session.user.id).toBe(user.id);
  });
});

// ── The PAT path ────────────────────────────────────────────────────────────

describe('⚠️ a PAT-authenticated /api/v1 call is UNAFFECTED', () => {
  it('answers 200 for a token owner whose organization requires 2FA', async () => {
    // The scope decision this card made, asserted rather than assumed. A PAT is
    // not a browser session: it carries its own grant, it is revocable on its
    // own, and it belongs to scripts and CI that have no way to present a second
    // factor. Holding it behind an enrolment screen would break every
    // integration the moment an admin turns the policy on, with no remedy short
    // of turning it off again.
    //
    // Structurally it cannot be held either — `app/api/v1/**` never calls any of
    // the three doors, which `tests/api/two-factor-api-gate.test.ts` asserts
    // over the tree. This is the same fact measured end to end, against a real
    // token and a real policy row.
    const { GET: meRoute } = await import('@/app/api/v1/me/route');
    const { createV1Caller } = await import('../fixtures/apiV1Fixtures');

    const caller = await createV1Caller({ scopes: ['read'] });
    await requireOrg2FA(caller.workspace.organizationId);

    // Nobody has enrolled this owner, and the org demands it — the browser
    // session for this same person is being refused right now.
    expect(await resolveTwoFactorHold(caller.user.id)).not.toBeNull();

    const res = await meRoute(
      new Request('http://localhost:3000/api/v1/me', {
        headers: caller.headers,
      }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).user.id).toBe(caller.user.id);
  });
});
