import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { decodeInstallState } from '@/lib/github/installState';
import { NotAMemberError } from '@/lib/workspaces/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-8241 · MOTIR-8471 — GET /api/github/install/start: the onboarding
// Connect step starts the Motir App install itself, and the signed state it
// mints sends the person back to that step with the step's own query.
//
// Membership is checked against a REAL Postgres. The mocks are `getSession`
// (the test env has no cookies), the 2FA policy every route resolves first, and
// `getActiveProject`, whose cookie/header read has no request scope here — the
// route's only use of it is the workspace it names, which the test supplies.

const SECRET = 'test-better-auth-secret-abcdef0123456789';
const PASSWORD = 'hunter2hunter2';

const session: { current: { user: { id: string } } | null } = { current: null };
const active: { current: { userId: string; workspaceId: string; projectId: string } | null } = {
  current: null,
};

vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => active.current }));

const { GET } = await import('@/app/api/github/install/start/route');

const STEP_QUERY =
  'from=onboardingMigrateConnect&via=onboard_existing_project&steps=connect%2Cindex&backKind=work-item&backItem=MOTIR-12';

function startReq(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/github/install/start?${query}`);
}

async function member(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  vi.stubEnv('GITHUB_APP_SLUG', 'motir-test');
  session.current = null;
  active.current = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/github/install/start', () => {
  it("302s to GitHub's install screen with a state naming the actor, the workspace, the step and its query", async () => {
    const { user, workspace } = await member('start-ok@example.com');
    session.current = { user: { id: user.id } };
    active.current = { userId: user.id, workspaceId: workspace.id, projectId: 'p1' };

    const res = await GET(startReq(`${STEP_QUERY}&stray=https%3A%2F%2Fevil.example`));
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/apps/motir-test/installations/new',
    );
    const state = decodeInstallState(url.searchParams.get('state')!);
    // Exactly this object: no `organizationId` (the callback must take the
    // workspace branch), and nothing off the query that is not the step's own.
    expect(state).toStrictEqual({
      workspaceId: workspace.id,
      userId: user.id,
      origin: 'onboardingMigrateConnect',
      context: {
        via: 'onboard_existing_project',
        steps: 'connect,index',
        backKind: 'work-item',
        backItem: 'MOTIR-12',
      },
    });
  });

  it('carries no context when the step was reached by another door', async () => {
    const { user, workspace } = await member('start-bare@example.com');
    session.current = { user: { id: user.id } };
    active.current = { userId: user.id, workspaceId: workspace.id, projectId: 'p1' };

    const res = await GET(startReq('from=onboardingMigrateConnect'));
    const state = decodeInstallState(
      new URL(res.headers.get('location')!).searchParams.get('state')!,
    );
    expect(state).toStrictEqual({
      workspaceId: workspace.id,
      userId: user.id,
      origin: 'onboardingMigrateConnect',
    });
  });

  it('bounces an unauthenticated visitor to sign-in with the query preserved', async () => {
    const res = await GET(startReq(STEP_QUERY));
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toContain('/sign-in?next=');
    const next = new URL(location).searchParams.get('next')!;
    expect(next).toBe(`/api/github/install/start?${STEP_QUERY}`);
  });

  it('with the App slug unset, returns to the step with not_configured — and its query', async () => {
    const { user, workspace } = await member('start-unset@example.com');
    session.current = { user: { id: user.id } };
    active.current = { userId: user.id, workspaceId: workspace.id, projectId: 'p1' };
    vi.stubEnv('GITHUB_APP_SLUG', '');

    const res = await GET(startReq(STEP_QUERY));
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(`${url.pathname}${url.search}`).toBe(
      '/onboarding/migrate?via=onboard_existing_project&steps=connect%2Cindex&backKind=work-item&backItem=MOTIR-12&github=not_configured',
    );
  });
});

describe('installUrlForOnboardingConnect', () => {
  it('refuses a workspace the actor is not a member of', async () => {
    const owner = await member('start-owner@example.com');
    const stranger = await usersService.createUser({
      email: 'start-stranger@example.com',
      password: PASSWORD,
      name: 'Stranger',
    });
    await expect(
      githubInstallationService.installUrlForOnboardingConnect({
        workspaceId: owner.workspace.id,
        actorUserId: stranger.id,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  it('answers null when the App is not configured', async () => {
    const { user, workspace } = await member('start-null@example.com');
    vi.stubEnv('GITHUB_APP_SLUG', '');
    expect(
      await githubInstallationService.installUrlForOnboardingConnect({
        workspaceId: workspace.id,
        actorUserId: user.id,
      }),
    ).toBeNull();
  });
});
