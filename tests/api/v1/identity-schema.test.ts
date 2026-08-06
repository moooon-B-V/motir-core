import { describe, expect, it } from 'vitest';
import {
  meSchema,
  presentMe,
  presentWorkspaceSummary,
  workspaceSummarySchema,
} from '@/lib/api/v1/identity/schema';

// The v1 identity/workspace MAPPERS (Story 11.1 · Subtask 11.1.7 — MOTIR-2202).
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT.
// The endpoints' contracts are asserted against the REAL routes with REAL PATs
// in `me-route.test.ts` / `workspaces-route.test.ts`, and the schemas are proven
// honest against real responses in `openapi-operations-coverage.test.ts`. None
// of those is replaced here, and this file is not the evidence the responses are
// right — a fixture built from the same assumption as the code under test is
// exactly the shape that lets a drift pass green (`notes.html` #217).
//
// What this file proves is the ONE property the route tests structurally cannot:
// that a raw Prisma row WIDER than the contract still yields only the contract.
// A route test can only pass the rows the schema actually has today, so it can
// never exercise "a later migration added a column". Here the extra columns are
// supplied on purpose.

/** A `User` row as the service really hands it over, plus columns the wire must never see. */
function userRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'user_1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    // Real `User` columns that are NOT contract, and must not become contract.
    emailVerified: true,
    image: 'https://example.com/ada.png' as string | null,
    lastActiveProjectId: null as string | null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...extra,
  };
}

function workspaceRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'ws_1',
    name: 'Moooon',
    slug: 'moooon',
    createdAt: new Date('2026-03-04T05:06:07.008Z'),
    // Real `Workspace` columns that are NOT contract.
    updatedAt: new Date('2026-03-05T00:00:00.000Z'),
    organizationId: 'org_1',
    ...extra,
  };
}

describe('presentMe', () => {
  it('emits exactly the identity contract — user.{id,name,email}, workspaceId, scopes', () => {
    const payload = presentMe({
      user: userRow(),
      workspaceId: 'ws_1',
      scopes: ['read', 'work_items:write'],
    } as Parameters<typeof presentMe>[0]);

    expect(payload).toEqual({
      user: { id: 'user_1', name: 'Ada Lovelace', email: 'ada@example.com' },
      workspaceId: 'ws_1',
      scopes: ['read', 'work_items:write'],
    });
    expect(Object.keys(payload).sort()).toEqual(['scopes', 'user', 'workspaceId']);
    expect(Object.keys(payload.user).sort()).toEqual(['email', 'id', 'name']);
  });

  // The property the route tests cannot reach: the row grows, the wire does not.
  it('a column added to the `User` row cannot reach the response', () => {
    const payload = presentMe({
      user: userRow({ ssn: '000-00-0000', internalRiskScore: 42 }),
      workspaceId: 'ws_1',
      scopes: ['read'],
    } as Parameters<typeof presentMe>[0]);

    expect(Object.keys(payload.user).sort()).toEqual(['email', 'id', 'name']);
    expect(JSON.stringify(payload)).not.toContain('000-00-0000');
    expect(JSON.stringify(payload)).not.toContain('internalRiskScore');
  });

  // The mapper's OUTPUT is what the published document promises, so it must
  // satisfy the schema's `.strict()` parse — the same parse the document is
  // generated from.
  it('its output satisfies `meSchema` strictly', () => {
    const payload = presentMe({
      user: userRow({ image: null }),
      workspaceId: 'ws_1',
      scopes: [],
    } as Parameters<typeof presentMe>[0]);

    expect(() => meSchema.parse(payload)).not.toThrow();
  });

  // MOTIR-2275 put the contract version on the TRANSPORT, deliberately NOT in
  // this body: a client that has to call one endpoint to learn the version
  // cannot learn it from the response that just failed. This asserts the road
  // not taken stayed not taken — `meSchema` still has exactly its three keys,
  // and `.strict()` still refuses a fourth.
  it('is UNCHANGED — exactly three keys, and a version field is refused', () => {
    expect(Object.keys(meSchema.shape).sort()).toEqual(['scopes', 'user', 'workspaceId']);

    const valid = { user: { id: 'u', name: 'n', email: 'e' }, workspaceId: 'ws', scopes: [] };
    expect(meSchema.safeParse(valid).success).toBe(true);
    expect(meSchema.safeParse({ ...valid, version: '1.1.0' }).success).toBe(false);
    expect(meSchema.safeParse({ ...valid, apiVersion: '1.1.0' }).success).toBe(false);
  });
});

describe('presentWorkspaceSummary', () => {
  it('emits exactly the workspace row contract, with `createdAt` as an ISO string', () => {
    const row = presentWorkspaceSummary(
      workspaceRow() as Parameters<typeof presentWorkspaceSummary>[0],
    );

    expect(row).toEqual({
      id: 'ws_1',
      name: 'Moooon',
      slug: 'moooon',
      createdAt: '2026-03-04T05:06:07.008Z',
    });
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'name', 'slug']);
    // Serialised by the MAPPER, not by `JSON.stringify` happening to do it —
    // that is what makes the ISO string the mapper's output type.
    expect(typeof row.createdAt).toBe('string');
  });

  it('a column added to the `Workspace` row cannot reach the response', () => {
    const row = presentWorkspaceSummary(
      workspaceRow({ billingPlan: 'enterprise', deletedAt: null }) as Parameters<
        typeof presentWorkspaceSummary
      >[0],
    );

    expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'name', 'slug']);
    expect(JSON.stringify(row)).not.toContain('enterprise');
  });

  it('its output satisfies `workspaceSummarySchema` strictly', () => {
    const row = presentWorkspaceSummary(
      workspaceRow() as Parameters<typeof presentWorkspaceSummary>[0],
    );

    expect(() => workspaceSummarySchema.parse(row)).not.toThrow();
  });
});
