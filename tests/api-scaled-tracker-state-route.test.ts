import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// Transport tests for POST /api/internal/billing/scaled-tracker-state (Subtask
// 8.1.4c). The COMPANION service test (billing-propagation-service.test.ts)
// proves persistence + the RLS contract at the service layer; this file proves
// what only the ROUTE owns: the service-bearer gate (401 before any DB work),
// the typed-error → HTTP mapping (400 malformed, 404 unknown org), and the DTO
// actually serialized back through NextResponse.json. Real Postgres for the org;
// no session mock (this surface is service-to-service, never a cookie session).

const TOKEN = 'test-service-token-8.1.4c';

beforeEach(async () => {
  process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'] = TOKEN;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const { POST } = await import('@/app/api/internal/billing/scaled-tracker-state/route');

const STATE = { status: 'active', priceId: 'tracker_monthly', currentPeriodEnd: 1893456000 };

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request('http://localhost:3000/api/internal/billing/scaled-tracker-state', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function makeOrg(): Promise<string> {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  return (await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).organizationId;
}

describe('POST /api/internal/billing/scaled-tracker-state — auth gate', () => {
  it('401 when the service bearer is missing', async () => {
    const res = await POST(req({ organizationId: 'o', scaledTrackerSubscription: STATE }, null));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('service_unauthorized');
  });

  it('401 when the service bearer is wrong', async () => {
    const res = await POST(req({ organizationId: 'o', scaledTrackerSubscription: STATE }, 'nope'));
    expect(res.status).toBe(401);
  });

  it('auth is checked BEFORE body validation (bad bearer + bad body → 401)', async () => {
    const res = await POST(req({ garbage: true }, 'nope'));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/internal/billing/scaled-tracker-state — happy path', () => {
  it('200 + confirmation DTO when authed with a valid body and a real org', async () => {
    const orgId = await makeOrg();
    const res = await POST(req({ organizationId: orgId, scaledTrackerSubscription: STATE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: orgId, scaledTrackerSubscription: STATE });
  });

  it('200 and clears the column when scaledTrackerSubscription is null', async () => {
    const orgId = await makeOrg();
    await POST(req({ organizationId: orgId, scaledTrackerSubscription: STATE }));
    const res = await POST(req({ organizationId: orgId, scaledTrackerSubscription: null }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: orgId, scaledTrackerSubscription: null });
  });
});

describe('POST /api/internal/billing/scaled-tracker-state — error mapping', () => {
  it('400 on a malformed body (unknown status enum)', async () => {
    const orgId = await makeOrg();
    const res = await POST(
      req({ organizationId: orgId, scaledTrackerSubscription: { ...STATE, status: 'bogus' } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('SCALED_TRACKER_STATE_INVALID');
  });

  it('400 when scaledTrackerSubscription is omitted entirely', async () => {
    const orgId = await makeOrg();
    const res = await POST(req({ organizationId: orgId }));
    expect(res.status).toBe(400);
  });

  it('400 on a non-JSON body', async () => {
    const res = await POST(req('not json{', TOKEN));
    expect(res.status).toBe(400);
  });

  it('404 when the org does not exist', async () => {
    const res = await POST(
      req({ organizationId: 'org_missing', scaledTrackerSubscription: STATE }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('ORGANIZATION_NOT_FOUND');
  });
});
