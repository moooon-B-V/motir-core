import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawUsageResponse } from '@/lib/ai/types';

// Transport tests for GET /api/organizations/[orgId]/usage — the org cost
// dashboard route (Story 7.2 · Subtask 7.2.11, locked by 7.2.12). The COMPANION
// service test (`aiUsageService.test.ts`) proves the 6.10.4 access gate + the
// server-side scope narrowing at the SERVICE layer; this file proves the things
// only the ROUTE owns and that the service test cannot reach:
//   - the session gate (401 before any service/motir-ai call),
//   - the typed-error → HTTP mapping (OrganizationNotFoundError → 404 RESPONSE,
//     not just a thrown error; a motir-ai outage → 502, never a misleading 0),
//   - the DTO actually serialized back through `NextResponse.json` (route → DTO),
//   - the query-param parsers (scope allow-list + positive-int drill paging).
// Real Postgres for org/workspace/project/membership (the no-mocks rule); the
// two sanctioned boundary mocks are `getSession` (no cookie in the test env) and
// the motir-ai HTTP client leaf `getOrgUsage` (an external network call).

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const getOrgUsageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: (q: unknown) => getOrgUsageMock(q),
}));

// Import the handler AFTER the mocks are registered.
const { GET } = await import('@/app/api/organizations/[orgId]/usage/route');
const { createTestWorkspace, createTestProject, createTestUser } = await import('./fixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { truncateAuthTables } = await import('./helpers/db');

function rawResponse(over: Partial<RawUsageResponse> = {}): RawUsageResponse {
  return {
    scope: 'org',
    coreOrganizationId: 'o',
    coreWorkspaceId: null,
    coreProjectId: null,
    balance: 12480,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 20000 },
    totalSpend: 147520,
    monthSpend: 7520,
    monthlyHistory: [{ yearMonth: '2026-06', credits: 7520 }],
    perModel: [{ model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 200, credits: 5180 }],
    recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
    ...over,
  };
}

function usageReq(orgId: string, query = '') {
  return {
    req: new Request(`http://localhost:3000/api/organizations/${orgId}/usage${query}`),
    ctx: { params: Promise.resolve({ orgId }) },
  };
}
function signInAs(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email } };
}

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  getOrgUsageMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/organizations/[orgId]/usage', () => {
  it('401 when signed out — no service / motir-ai call', async () => {
    const { req, ctx } = usageReq('any-org');
    const res = await GET(req, ctx);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(getOrgUsageMock).not.toHaveBeenCalled();
  });

  it('200 — serializes the org-admin DTO back through the route', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getOrgUsageMock.mockResolvedValue(rawResponse());

    signInAs(owner);
    const { req, ctx } = usageReq(workspace.organizationId, '?scope=org');
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access: { isAdmin: boolean };
      scope: string;
      org: { id: string };
      balance: number;
      hasUsage: boolean;
    };
    // The route returned the SERVICE's mapped DTO (not the raw motir-ai shape).
    expect(body.access.isAdmin).toBe(true);
    expect(body.scope).toBe('org');
    expect(body.org.id).toBe(workspace.organizationId);
    expect(body.balance).toBe(12480);
    expect(body.hasUsage).toBe(true);
    // The org admin's read went out to motir-ai at the org scope.
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'org', coreOrganizationId: workspace.organizationId }),
    );
    // project exists so the drill/enrichment path had a row to resolve.
    expect(project.id).toBeTruthy();
  });

  it('404 (no-leak) for a non-member — the route MAPS OrganizationNotFoundError', async () => {
    const { workspace } = await createTestWorkspace();
    const outsider = await createTestUser();
    signInAs(outsider);

    const { req, ctx } = usageReq(workspace.organizationId);
    const res = await GET(req, ctx);

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('ORGANIZATION_NOT_FOUND');
    // The gate refused before reaching out to motir-ai.
    expect(getOrgUsageMock).not.toHaveBeenCalled();
  });

  it('502 when motir-ai is unavailable — never a misleading zero', async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    signInAs(owner);
    const { req, ctx } = usageReq(workspace.organizationId);
    const res = await GET(req, ctx);

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('MOTIR_AI_UNAVAILABLE');
  });

  it('narrows a non-admin member to their project slice + parses the drill paging query', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    getOrgUsageMock.mockResolvedValue(
      rawResponse({ scope: 'project', coreProjectId: project.id, coreWorkspaceId: workspace.id }),
    );

    signInAs(member);
    // The member ASKS for org scope (refused server-side) and passes paging:
    // page=2 is a valid positive int; pageSize='abc' is invalid → undefined.
    const { req, ctx } = usageReq(workspace.organizationId, '?scope=org&page=2&pageSize=abc');
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access: { isAdmin: boolean }; scope: string };
    expect(body.access.isAdmin).toBe(false);
    expect(body.scope).toBe('project');
    // The route parsed page=2 (positive int) and dropped the non-numeric
    // pageSize → forwarded as undefined, never the raw 'abc' string.
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project',
        coreProjectId: project.id,
        page: 2,
        pageSize: undefined,
      }),
    );
  });

  it('rejects a bogus scope param (allow-list) — the service decides the default', async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(rawResponse());

    signInAs(owner);
    const { req, ctx } = usageReq(workspace.organizationId, '?scope=galaxy');
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    // 'galaxy' is not in the allow-list → parsed to undefined → the admin
    // default (org) is chosen by the service, never the attacker-supplied value.
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'org', coreOrganizationId: workspace.organizationId }),
    );
  });
});
