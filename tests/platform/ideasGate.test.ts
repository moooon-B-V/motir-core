import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The IDEAS gate (Story MOTIR-7662 · MOTIR-7673 · `docs/decisions/platform-staff-auth.md`
// §2, the 2026-10-07 amendment) — the one door where a staff member's personal
// access token stands in for their console session.
//
// Real Postgres, real tokens minted by the real service, real `platformRole`
// column. The single stub is `getSession()` — the repo's standing exception.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

// `requirePlatformStaff` is React-`cache()`d and the cache is process-wide in
// vitest, so each case gets a fresh module graph (see platformStaffGate.test.ts).
beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function freshGate() {
  const [gate, errors] = await Promise.all([
    import('@/lib/platform/ideasGate'),
    import('@/lib/platform/errors'),
  ]);
  return { ...gate, ...errors };
}

let seq = 0;

/** A user at `role` (or a tenant user for null) holding a fresh PAT in their own workspace. */
async function tokenHolder(role: PlatformRole | null) {
  const { owner, workspace } = await createTestWorkspace({
    name: `Ideas gate ${++seq}`,
  });
  if (role) await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: role } });
  const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-ideas',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  });
  return { owner, workspace, token, tokenId: dto.id };
}

function bearer(token: string, path = '/api/platform/ideas'): Request {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

const PLAIN = () => new Request('http://localhost/api/platform/ideas');

describe('requirePlatformStaffForIdeas — personal access token', () => {
  it.each([
    ['operator', 'operator'],
    ['superadmin', 'operator'],
    ['superadmin', 'superadmin'],
  ] as const)('admits a %s token at minimum %s, naming the token', async (role, minimum) => {
    const { owner, token, tokenId } = await tokenHolder(role);
    const { requirePlatformStaffForIdeas } = await freshGate();

    const actor = await requirePlatformStaffForIdeas(bearer(token), minimum);
    expect(actor).toEqual({
      userId: owner.id,
      email: owner.email,
      role,
      credential: { kind: 'token', apiTokenId: tokenId },
    });
  });

  it.each([
    ['support', 'operator'],
    ['operator', 'superadmin'],
  ] as const)('refuses a %s token at minimum %s', async (role, minimum) => {
    const { token } = await tokenHolder(role);
    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    await expect(requirePlatformStaffForIdeas(bearer(token), minimum)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });

  it('refuses a token whose owner is not platform staff — even a workspace owner', async () => {
    const { token } = await tokenHolder(null);
    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    await expect(requirePlatformStaffForIdeas(bearer(token), 'operator')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });

  it('refuses a staff member demoted after the token was minted, on the next call', async () => {
    const { owner, token } = await tokenHolder('operator');
    const first = await freshGate();
    await expect(
      first.requirePlatformStaffForIdeas(bearer(token), 'operator'),
    ).resolves.toMatchObject({ userId: owner.id });

    await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: null } });
    vi.resetModules();
    const second = await freshGate();
    await expect(
      second.requirePlatformStaffForIdeas(bearer(token), 'operator'),
    ).rejects.toBeInstanceOf(second.NotPlatformStaffError);
  });

  it('refuses an unknown token and a bearer that is not a personal access token', async () => {
    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    await expect(
      requirePlatformStaffForIdeas(bearer('motir_pat_not-a-real-token'), 'operator'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    await expect(
      requirePlatformStaffForIdeas(bearer('some-other-credential'), 'operator'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('refuses a revoked token', async () => {
    const { owner, token, tokenId } = await tokenHolder('superadmin');
    await apiTokensService.deleteToken(owner.id, tokenId);
    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    await expect(requirePlatformStaffForIdeas(bearer(token), 'operator')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });

  it('refuses an expired token', async () => {
    const { token, tokenId } = await tokenHolder('superadmin');
    await adminDb.apiToken.update({
      where: { id: tokenId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    await expect(requirePlatformStaffForIdeas(bearer(token), 'operator')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });

  it('refuses a token bound to a suspended organization', async () => {
    const { workspace, token } = await tokenHolder('superadmin');
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { suspendedAt: new Date(), suspendedReason: 'Abuse report' },
    });
    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    await expect(requirePlatformStaffForIdeas(bearer(token), 'operator')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });

  it('refuses a RUN token, even one dispatched by a superadmin', async () => {
    const fixture = await makeWorkItemFixture();
    await adminDb.user.update({
      where: { id: fixture.owner.id },
      data: { platformRole: 'superadmin' },
    });
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'task', title: 'a hosted card' },
      fixture.ctx,
    );
    const opened = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'hosted',
        cards: [{ key: item.identifier, disposition: 'queued' }],
      },
      fixture.ctx,
    );
    const minted = await runCredentialService.mintRunCredential({
      dispatchRunId: opened.run.id,
      dispatcherUserId: fixture.owner.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    await expect(
      requirePlatformStaffForIdeas(bearer(minted.token), 'operator'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('answers with the TOKEN even when a staff session is also present', async () => {
    const staff = await createTestUser({ email: `ops+ideas-session-${++seq}@moooon.net` });
    await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'superadmin' } });
    currentSession = { user: { id: staff.id } };
    const { token } = await tokenHolder(null);
    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    await expect(requirePlatformStaffForIdeas(bearer(token), 'operator')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });

  it('lets an unexpected failure through rather than masking it as a refusal', async () => {
    const { token } = await tokenHolder('operator');
    const { requirePlatformStaffForIdeas, NotPlatformStaffError } = await freshGate();
    const services = await import('@/lib/services/apiTokensService');
    vi.spyOn(services.apiTokensService, 'verify').mockRejectedValueOnce(new Error('db down'));
    const attempt = requirePlatformStaffForIdeas(bearer(token), 'operator');
    await expect(attempt).rejects.toThrow('db down');
    await expect(attempt).rejects.not.toBeInstanceOf(NotPlatformStaffError);
  });
});

describe('requirePlatformStaffForIdeas — console session', () => {
  async function sessionAs(role: PlatformRole | null) {
    const user = await createTestUser({ email: `ops+ideas-console-${++seq}@moooon.net` });
    if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
    currentSession = { user: { id: user.id } };
    return user;
  }

  it('falls back to the session, naming it as the credential', async () => {
    const user = await sessionAs('operator');
    const { requirePlatformStaffForIdeas } = await freshGate();
    expect(await requirePlatformStaffForIdeas(PLAIN(), 'operator')).toEqual({
      userId: user.id,
      email: user.email,
      role: 'operator',
      credential: { kind: 'session' },
    });
  });

  it('refuses an anonymous request, a tenant session and a session below the level', async () => {
    const anonymous = await freshGate();
    await expect(
      anonymous.requirePlatformStaffForIdeas(PLAIN(), 'operator'),
    ).rejects.toBeInstanceOf(anonymous.NotPlatformStaffError);

    await sessionAs(null);
    vi.resetModules();
    const tenant = await freshGate();
    await expect(tenant.requirePlatformStaffForIdeas(PLAIN(), 'support')).rejects.toBeInstanceOf(
      tenant.NotPlatformStaffError,
    );

    await sessionAs('operator');
    vi.resetModules();
    const below = await freshGate();
    await expect(below.requirePlatformStaffForIdeas(PLAIN(), 'superadmin')).rejects.toBeInstanceOf(
      below.NotPlatformStaffError,
    );
  });

  it('treats a non-Bearer Authorization header as no token — the session path', async () => {
    const user = await sessionAs('operator');
    const { requirePlatformStaffForIdeas } = await freshGate();
    const req = new Request('http://localhost/api/platform/ideas', {
      // Built at runtime: a literal base64 credential trips secret scanning (MOTIR-7816).
      headers: { authorization: `Basic ${btoa('ops:secret')}` },
    });
    expect(await requirePlatformStaffForIdeas(req, 'operator')).toMatchObject({
      userId: user.id,
      credential: { kind: 'session' },
    });
  });
});
