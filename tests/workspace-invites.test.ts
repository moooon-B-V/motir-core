import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock for getSession — the routes call it to read the signed-in
// user. The mock returns whatever `mockSession.current` holds at call
// time, so each test can swap the session by mutating that object.
const mockSession: { current: { user: { id: string; email: string; name: string } } | null } = {
  current: null,
};
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSession: async () => mockSession.current,
  };
});

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import {
  INVITE_IDENTIFIER_PREFIX,
  workspaceInvitesService,
} from '@/lib/services/workspaceInvitesService';
import { POST as sendInvitePOST } from '@/app/api/workspaces/[workspaceId]/invites/route';
import { GET as validateInviteGET } from '@/app/api/invites/[token]/route';
import { POST as acceptInvitePOST } from '@/app/api/invites/[token]/accept/route';
import { truncateAuthTables, truncateJobRuns } from './helpers/db';
import { captureConsoleEmails, captureEmailEvents, runEmailSendJob } from './helpers/jobs';

// Integration tests against a real Postgres. Hits the route handlers
// directly (so the request → service → repo → Prisma chain is
// exercised end-to-end), then asserts DB state via the service for
// reads where we already have a helper, and via `db.*` for raw row
// counts when no service helper exists. Per CLAUDE.md, reaching into
// `db.*` is allowed in tests for state assertions.

const BASE_URL = 'http://localhost:3000';

// Story 1.6.3: sendInvite no longer dispatches the email inline — it ENQUEUES
// an `email.send` event. So we capture the enqueued events (which also stops
// the publish from reaching a non-existent dev server) for the whole file:
// every helper that plants an invite (createInvite) goes through sendInvite,
// so the spy must be active in every block, not just the "send" describe.
let emailEvents: ReturnType<typeof captureEmailEvents>;

function paramsFor<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

function postInvite(workspaceId: string, body: unknown): Promise<Response> {
  return sendInvitePOST(
    new Request(`${BASE_URL}/api/workspaces/${workspaceId}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    paramsFor({ workspaceId }),
  );
}

function getValidate(token: string): Promise<Response> {
  return validateInviteGET(
    new Request(`${BASE_URL}/api/invites/${token}`, { method: 'GET' }),
    paramsFor({ token }),
  );
}

function postAccept(token: string): Promise<Response> {
  return acceptInvitePOST(
    new Request(`${BASE_URL}/api/invites/${token}/accept`, { method: 'POST' }),
    paramsFor({ token }),
  );
}

async function makeInviter(email = 'inviter@example.com', name = 'Inviter One') {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  const { workspace, membership } = await workspacesService.createWorkspace({
    name: 'Acme Co.',
    ownerUserId: user.id,
  });
  return { user, workspace, membership };
}

// Helper to plant an invite directly via the service when a test
// needs to set one up without going through the email path.
async function createInvite(args: {
  workspaceId: string;
  email: string;
  inviterUserId: string;
}): Promise<string> {
  await workspaceInvitesService.sendInvite({
    inviterUserId: args.inviterUserId,
    inviterName: 'Inviter',
    workspaceId: args.workspaceId,
    targetEmail: args.email,
  });
  const row = await db.verification.findFirstOrThrow({
    where: {
      identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
      value: { contains: args.email },
    },
  });
  return row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  mockSession.current = null;
  emailEvents = captureEmailEvents();
});

afterEach(() => {
  emailEvents.restore();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/workspaces/[workspaceId]/invites — send', () => {
  it('creates a Verification row and enqueues the invite email (happy path)', async () => {
    const { user, workspace } = await makeInviter();
    mockSession.current = { user: { id: user.id, email: user.email, name: user.name } };

    const res = await postInvite(workspace.id, { email: 'newbie@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await db.verification.findMany({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.value);
    expect(payload).toEqual({
      workspaceId: workspace.id,
      email: 'newbie@example.com',
      role: 'member',
      inviterUserId: user.id,
    });
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const token = rows[0]!.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);

    // Exactly one tenanted email.send event was enqueued for the invitee,
    // keyed by the invite token, with the workspace-invite template.
    expect(emailEvents.events).toHaveLength(1);
    const event = emailEvents.events[0]!;
    expect(event.data.template).toBe('workspace-invite');
    expect(event.data.to).toBe('newbie@example.com');
    expect(event.data.workspaceId).toBe(workspace.id);
    expect(event.data.idempotencyKey).toBe(token);

    // End-to-end: draining the queued event renders + sends the invite, with
    // the accept link unredacted in the plain-text body (dev-console contract
    // from 1.1.6).
    const emails = captureConsoleEmails();
    try {
      await runEmailSendJob(event.data);
      expect(emails.lines).toHaveLength(1);
      expect(emails.lines[0]).toContain('To: newbie@example.com');
      expect(emails.lines[0]).toContain("You're invited to join Acme Co. on Motir");
      expect(emails.lines[0]).toMatch(/Accept invite: https?:\/\/[^\s]+\/invite\/accept\?token=/);
    } finally {
      emails.restore();
    }
  });

  it('returns 422 ALREADY_MEMBER when target email is already in the workspace', async () => {
    const { user, workspace } = await makeInviter();
    const teammate = await usersService.createUser({
      email: 'teammate@example.com',
      password: 'hunter2hunter2',
      name: 'Teammate',
    });
    await workspacesService.addMember({ userId: teammate.id, workspaceId: workspace.id });
    mockSession.current = { user: { id: user.id, email: user.email, name: user.name } };

    const res = await postInvite(workspace.id, { email: 'teammate@example.com' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('ALREADY_MEMBER');

    const rows = await db.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toBe(0);
    expect(emailEvents.events).toHaveLength(0);
  });

  it('returns 404 NOT_FOUND when requester is not in the workspace (anti-enumeration)', async () => {
    // Subtask 1.2.7: cross-tenant invite attempts must NOT return 403. A 403
    // ("you're not a member") confirms the workspace exists; the route now
    // maps NotAMemberError → 404 so a probing attacker can't distinguish a
    // real-but-foreign workspace id from one that never existed.
    const { workspace } = await makeInviter();
    const outsider = await usersService.createUser({
      email: 'outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    mockSession.current = {
      user: { id: outsider.id, email: outsider.email, name: outsider.name },
    };

    const res = await postInvite(workspace.id, { email: 'newbie@example.com' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');

    const rows = await db.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toBe(0);
    expect(emailEvents.events).toHaveLength(0);
  });

  it('rate-limits: 3 invites in the window succeed, 4th returns 429 RATE_LIMITED', async () => {
    const { user, workspace } = await makeInviter();
    mockSession.current = { user: { id: user.id, email: user.email, name: user.name } };

    for (let i = 0; i < 3; i++) {
      const res = await postInvite(workspace.id, { email: 'spam-target@example.com' });
      expect(res.status).toBe(200);
    }
    const fourth = await postInvite(workspace.id, { email: 'spam-target@example.com' });
    expect(fourth.status).toBe(429);
    const body = await fourth.json();
    expect(body.code).toBe('RATE_LIMITED');

    const rows = await db.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toBe(3);
    expect(emailEvents.events).toHaveLength(3);
  });
});

describe('POST /api/invites/[token]/accept', () => {
  it('happy path: matching email → creates membership and consumes token', async () => {
    const { user: inviter, workspace } = await makeInviter();
    const invitee = await usersService.createUser({
      email: 'invitee@example.com',
      password: 'hunter2hunter2',
      name: 'Invitee',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: invitee.email,
      inviterUserId: inviter.id,
    });

    mockSession.current = {
      user: { id: invitee.id, email: invitee.email, name: invitee.name },
    };
    const res = await postAccept(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: workspace.id });

    const membership = await workspacesService.findMembership(invitee.id, workspace.id);
    expect(membership).not.toBeNull();

    const remaining = await db.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(remaining).toBe(0);
  });

  it('upward-auto-joins the invitee into the workspace’s ORG so the access gate grants access (Story 6.10.4)', async () => {
    // Regression: the org access gate (6.10.4) DENIES a workspace member who is
    // not an org member, so accepting a cross-org invite MUST also enrol the
    // invitee in the workspace's org — otherwise the post-accept active-workspace
    // resolution can't reach the joined workspace (the workspace-flows e2e timed
    // out on exactly this).
    const { user: inviter, workspace } = await makeInviter('inviter2@example.com', 'Inviter Two');
    const invitee = await usersService.createUser({
      email: 'crossorg@example.com',
      password: 'hunter2hunter2',
      name: 'Cross Org',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: invitee.email,
      inviterUserId: inviter.id,
    });

    mockSession.current = {
      user: { id: invitee.id, email: invitee.email, name: invitee.name },
    };
    const res = await postAccept(token);
    expect(res.status).toBe(200);

    // The invitee is now an ORG member (role member) of the workspace's org...
    const access = await organizationsService.resolveWorkspaceAccess(invitee.id, workspace.id);
    expect(access).not.toBeNull();
    expect(access!.orgRole).toBe('member');
    // ...and the active-workspace resolver can land them on the joined workspace.
    const resolved = await workspacesService.resolveActiveWorkspace(invitee.id, workspace.id);
    expect(resolved).toBe(workspace.id);
  });

  it('returns 403 INVITE_EMAIL_MISMATCH and preserves the token when email differs', async () => {
    const { user: inviter, workspace } = await makeInviter();
    const wrong = await usersService.createUser({
      email: 'wrong@example.com',
      password: 'hunter2hunter2',
      name: 'Wrong',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: 'target@example.com',
      inviterUserId: inviter.id,
    });

    mockSession.current = { user: { id: wrong.id, email: wrong.email, name: wrong.name } };
    const res = await postAccept(token);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVITE_EMAIL_MISMATCH');

    // Token survives — they can sign in with the right email and retry.
    const stillThere = await workspaceInvitesService.validateInvite(token);
    expect(stillThere).not.toBeNull();
    // No membership was created.
    const memberships = await workspacesService.findMembership(wrong.id, workspace.id);
    expect(memberships).toBeNull();
  });

  it('returns 404 INVITE_EXPIRED_OR_MISSING when the token is expired', async () => {
    const { user: inviter, workspace } = await makeInviter();
    const invitee = await usersService.createUser({
      email: 'late@example.com',
      password: 'hunter2hunter2',
      name: 'Late',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: invitee.email,
      inviterUserId: inviter.id,
    });
    // Backdate the row's expiresAt to simulate "clicked after 7 days".
    await db.verification.updateMany({
      where: { identifier: INVITE_IDENTIFIER_PREFIX + token },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    mockSession.current = {
      user: { id: invitee.id, email: invitee.email, name: invitee.name },
    };
    const res = await postAccept(token);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('INVITE_EXPIRED_OR_MISSING');
  });

  it('single-use: a second accept with the same token returns 404 (token consumed)', async () => {
    const { user: inviter, workspace } = await makeInviter();
    const invitee = await usersService.createUser({
      email: 'twice@example.com',
      password: 'hunter2hunter2',
      name: 'Twice',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: invitee.email,
      inviterUserId: inviter.id,
    });
    mockSession.current = {
      user: { id: invitee.id, email: invitee.email, name: invitee.name },
    };

    const first = await postAccept(token);
    expect(first.status).toBe(200);

    const second = await postAccept(token);
    expect(second.status).toBe(404);
    expect((await second.json()).code).toBe('INVITE_EXPIRED_OR_MISSING');
  });
});

describe('GET /api/invites/[token] — validate', () => {
  it('returns { workspaceName, inviterName, email } for a live token', async () => {
    const { user: inviter, workspace } = await makeInviter('boss@example.com', 'Ben Liu');
    const token = await createInvite({
      workspaceId: workspace.id,
      email: 'newbie@example.com',
      inviterUserId: inviter.id,
    });

    const res = await getValidate(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaceName: 'Acme Co.',
      inviterName: 'Ben Liu',
      email: 'newbie@example.com',
    });
  });
});
