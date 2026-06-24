import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { pmTierForOrg } from '@/lib/billing/entitlements';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// Transport + end-to-end tests for POST /api/internal/billing/ai-included-seat
// (Subtask 8.1.24). Proves the service-bearer gate (401), the typed-error → HTTP
// mapping (400 malformed, 404 unknown org), the persisted flag, and — the whole
// point — that the flag LIFTS the §4 caps: an org on a paid AI plan resolves to
// `scaled` even with NO purchased scaled-tracker subscription (ADR §4, 8.1.22).
// Real Postgres; no session mock (service-to-service surface).

const TOKEN = 'test-service-token-8.1.24';

beforeEach(async () => {
  process.env['MOTIR_AI_TO_CORE_SERVICE_TOKEN'] = TOKEN;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const { POST } = await import('@/app/api/internal/billing/ai-included-seat/route');

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request('http://localhost:3000/api/internal/billing/ai-included-seat', {
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

describe('POST /api/internal/billing/ai-included-seat', () => {
  it('401 when the service bearer is missing / wrong', async () => {
    expect((await POST(req({ organizationId: 'o', included: true }, null))).status).toBe(401);
    expect((await POST(req({ organizationId: 'o', included: true }, 'nope'))).status).toBe(401);
  });

  it('400 when the body is malformed (non-boolean included / missing org)', async () => {
    expect((await POST(req({ organizationId: 'o', included: 'yes' }))).status).toBe(400);
    expect((await POST(req({ included: true }))).status).toBe(400);
    expect((await POST(req('not json'))).status).toBe(400);
  });

  it('404 for an unknown org', async () => {
    const res = await POST(req({ organizationId: 'org_missing', included: true }));
    expect(res.status).toBe(404);
  });

  it('sets the flag → the org resolves to `scaled` (caps lifted) with NO scaled-tracker sub', async () => {
    const orgId = await makeOrg();
    // Baseline: a fresh org is bounded `free`.
    expect(pmTierForOrg(await organizationRepository.findCapContext(orgId))).toBe('free');

    const res = await POST(req({ organizationId: orgId, included: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: orgId, aiIncludedSeat: true });

    // The paid-AI seat lifts the caps — distinct column from scaledTrackerSubscription.
    const ctx = await organizationRepository.findCapContext(orgId);
    expect(ctx.aiIncludedSeat).toBe(true);
    expect(ctx.scaledTrackerSubscription).toBeNull();
    expect(pmTierForOrg(ctx)).toBe('scaled');
  });

  it('clears the flag (included=false) → caps re-apply (`free`), idempotent', async () => {
    const orgId = await makeOrg();
    await POST(req({ organizationId: orgId, included: true }));
    const res = await POST(req({ organizationId: orgId, included: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: orgId, aiIncludedSeat: false });
    expect(pmTierForOrg(await organizationRepository.findCapContext(orgId))).toBe('free');
  });
});
