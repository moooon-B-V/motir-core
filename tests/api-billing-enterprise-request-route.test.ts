import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';

// Transport tests for /api/organizations/[orgId]/billing/enterprise-request —
// the Enterprise card's Contact sales (Story MOTIR-7602 · Subtask MOTIR-7605).
// The companion service suite (`tests/billing/enterprise-request-service.test.ts`)
// proves the gates, the schema and the one-open-per-org race; this file proves
// what only the ROUTE owns: the session gate, the body parse, the status codes
// each typed error maps to, and the 201 on create. Real Postgres; the one mock is
// `getSession` (no cookie in the test environment).

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const { GET, POST } =
  await import('@/app/api/organizations/[orgId]/billing/enterprise-request/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');

function url(orgId: string) {
  return `http://localhost:3000/api/organizations/${orgId}/billing/enterprise-request`;
}

function post(orgId: string, body: string) {
  return POST(
    new Request(url(orgId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

function get(orgId: string) {
  return GET(new Request(url(orgId)), { params: Promise.resolve({ orgId }) });
}

function signInAs(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email } };
}

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  return { organizationId, owner, member };
}

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  process.env['MOTIR_CLOUD'] = 'true';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/organizations/[orgId]/billing/enterprise-request', () => {
  it('401 when signed out', async () => {
    const res = await post('any-org', JSON.stringify({ note: 'x' }));
    expect(res.status).toBe(401);
  });

  it('201 with the request as the org sees it, contact defaulted to the sender', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);

    const res = await post(
      organizationId,
      JSON.stringify({ note: 'Talk to us', teamSize: 'size_11_50' }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'received',
      contact: owner.email,
      note: 'Talk to us',
      teamSize: 'size_11_50',
    });
  });

  it('400 ENTERPRISE_REQUEST_INVALID naming the field, for a malformed or invalid body', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);

    const notJson = await post(organizationId, '{not json');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({
      code: 'ENTERPRISE_REQUEST_INVALID',
      field: 'body',
    });

    const badEnum = await post(organizationId, JSON.stringify({ note: 'x', agentPath: 'robots' }));
    expect(badEnum.status).toBe(400);
    expect(await badEnum.json()).toMatchObject({ field: 'agentPath' });
  });

  it('403 BILLING_FORBIDDEN for a member without manageBilling', async () => {
    const { organizationId, member } = await makeOrg();
    signInAs(member);
    const res = await post(organizationId, JSON.stringify({ note: 'x' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'BILLING_FORBIDDEN' });
  });

  it('409 ENTERPRISE_REQUEST_OPEN carrying the open request id', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    const first = await (await post(organizationId, JSON.stringify({ note: 'one' }))).json();

    const res = await post(organizationId, JSON.stringify({ note: 'two' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'ENTERPRISE_REQUEST_OPEN',
      openRequestId: first.id,
    });
  });

  it('404 off-cloud, for both verbs', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    delete process.env['MOTIR_CLOUD'];

    expect((await post(organizationId, JSON.stringify({ note: 'x' }))).status).toBe(404);
    expect((await get(organizationId)).status).toBe(404);
  });
});

describe('GET /api/organizations/[orgId]/billing/enterprise-request', () => {
  it('401 when signed out', async () => {
    expect((await get('any-org')).status).toBe(401);
  });

  it('null when nothing is open, then the open request', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);

    const none = await get(organizationId);
    expect(none.status).toBe(200);
    expect(await none.json()).toBeNull();

    const sent = await (await post(organizationId, JSON.stringify({ note: 'x' }))).json();
    const open = await get(organizationId);
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual(sent);
  });

  it('403 for a member without manageBilling', async () => {
    const { organizationId, member } = await makeOrg();
    signInAs(member);
    expect((await get(organizationId)).status).toBe(403);
  });
});
