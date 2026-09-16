import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import type { TokenScope } from '@/lib/mcp/scopes';

// POST /api/work-items/[id]/acceptance-evidence (Story MOTIR-1627 · Subtask
// MOTIR-1631; direct-to-Blob MOTIR-1681) — the token-authed CI REGISTER route,
// against a REAL Postgres. The video is already client-uploaded to Blob, so the
// route takes a JSON body of pathnames; the blob adapter is mocked (no network —
// `headPrivateBlob` supplies the authoritative size/contentType), and
// billingService is mocked at the getAiAccessForContext seam so the
// ineligibility branches are reachable off-cloud.

const blobHead = vi.hoisted(() => ({
  current: { size: 1024, contentType: 'video/webm' } as {
    size: number;
    contentType: string;
  } | null,
}));
vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({
      url: `https://store1.public.blob.vercel-storage.com/${p}-${++seq}`,
    })),
    putPrivateAttachment: vi.fn(async (p: string) => ({ pathname: `${p}-${++seq}` })),
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
    mintPrivateUploadToken: vi.fn(async () => 'client-token'),
    headPrivateBlob: vi.fn(async () => blobHead.current),
  };
});

const aiAccess = vi.hoisted(() => ({ current: null as AiAccessDTO | null }));
vi.mock('@/lib/services/billingService', () => ({
  billingService: { getAiAccessForContext: vi.fn(async () => aiAccess.current) },
}));

const { POST } = await import('@/app/api/work-items/[id]/acceptance-evidence/route');
const { apiTokensService } = await import('@/lib/services/apiTokensService');

function access(partial: Partial<AiAccessDTO>): AiAccessDTO {
  return {
    applicable: true,
    organizationId: null,
    organizationName: 'Acme',
    canManageBilling: false,
    hasPaidAiPlan: false,
    balance: 0,
    tierName: null,
    tierAllotment: null,
    renewsAt: null,
    ...partial,
  };
}

/** A JSON register request to the given story's endpoint. */
function publishReq(
  token: string | null,
  body: Record<string, unknown> = {},
  identifier: string = story.identifier,
): Request {
  return new Request(`http://localhost/api/work-items/${identifier}/acceptance-evidence`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** A video pathname WITHIN the current story's acceptance prefix (accepted). */
const videoPathname = () => `acceptance/${fx.workspaceId}/${story.id}/uuid-acceptance.webm`;

async function integrationToken(fx: WorkItemFixture, scopes: TokenScope[] = ['integration']) {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'ci',
    fixedGrant: grantForLegacyScopes(scopes),
  });
  return token;
}

const paramsFor = (story: WorkItem) => ({ params: Promise.resolve({ id: story.identifier }) });

let fx: WorkItemFixture;
let story: WorkItem;

beforeEach(async () => {
  aiAccess.current = access({ applicable: false, organizationId: null });
  blobHead.current = { size: 1024, contentType: 'video/webm' };
  // TRUNCATE requires table OWNERSHIP, which the runtime role must never have —
  // the admin client is the only one that can reset between tests.
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  story = await createTestWorkItem(fx, { kind: 'story', title: 'Gate story' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST acceptance-evidence (register)', () => {
  it('valid integration token + eligible (ungated off-cloud) → 201 pending, story stays in_review', async () => {
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(token, { videoPathname: videoPathname(), commitSha: 'c1c1c1c' }),
      paramsFor(story),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { evidence: { status: string; workItemId: string } };
    expect(body.evidence.status).toBe('pending');
    expect(body.evidence.workItemId).toBe(story.id);

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(row.status).not.toBe('done');
  });

  it('a SUBTASK key resolves to its parent story — the video attaches to the story (MOTIR-1684)', async () => {
    // The PR-derived target is the subtask's own MOTIR-<id> (the status-sync
    // convention); acceptance is story-level (Principle #18), so the endpoint
    // resolves UP to the parent story. The pathname is within the STORY's prefix.
    const subtask = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'acceptance E2E subtask',
      parentId: story.id,
    });
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(
        token,
        { videoPathname: videoPathname(), commitSha: 'c2c2c2c' },
        subtask.identifier,
      ),
      { params: Promise.resolve({ id: subtask.identifier }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { evidence: { workItemId: string } };
    expect(body.evidence.workItemId).toBe(story.id);
  });

  it('a subtask whose parent is NOT a story stays unresolved → 422 not-a-story', async () => {
    // A leaf whose parent is not a story (here: a subtask under a bug) is left
    // as-is; the service rejects a non-story acceptance target.
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'a bug', parentId: story.id });
    const sub = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'subtask under a bug',
      parentId: bug.id,
    });
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(
        token,
        { videoPathname: `acceptance/${fx.workspaceId}/${sub.id}/x.webm` },
        sub.identifier,
      ),
      { params: Promise.resolve({ id: sub.identifier }) },
    );
    expect(res.status).toBe(422);
  });

  it('no token → 401', async () => {
    const res = await POST(publishReq(null, { videoPathname: videoPathname() }), paramsFor(story));
    expect(res.status).toBe(401);
  });

  it('token without the integration scope → 403', async () => {
    const token = await integrationToken(fx, ['read']);
    const res = await POST(publishReq(token, { videoPathname: videoPathname() }), paramsFor(story));
    expect(res.status).toBe(403);
  });

  it('missing `videoPathname` → 400', async () => {
    const token = await integrationToken(fx);
    const res = await POST(publishReq(token, {}), paramsFor(story));
    expect(res.status).toBe(400);
  });

  it('a pathname OUTSIDE the story acceptance prefix → 400 (never registers a foreign blob)', async () => {
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(token, { videoPathname: `acceptance/other-ws/other-story/evil.webm` }),
      paramsFor(story),
    );
    expect(res.status).toBe(400);
    const acceptanceEvidenceCount = await adminDb.acceptanceEvidence.count();
    expect(acceptanceEvidenceCount).toBe(0);
  });

  it('a pathname whose blob does not exist → 400 (head confirms the upload)', async () => {
    blobHead.current = null;
    const token = await integrationToken(fx);
    const res = await POST(publishReq(token, { videoPathname: videoPathname() }), paramsFor(story));
    expect(res.status).toBe(400);
    const acceptanceEvidenceCount = await adminDb.acceptanceEvidence.count();
    expect(acceptanceEvidenceCount).toBe(0);
  });

  it('unknown story key → 404', async () => {
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(token, { videoPathname: 'acceptance/x/y/z.webm' }, 'PROD-999'),
      { params: Promise.resolve({ id: 'PROD-999' }) },
    );
    expect(res.status).toBe(404);
  });

  it('non-video MIME (per head) → 415', async () => {
    blobHead.current = { size: 1024, contentType: 'image/png' };
    const token = await integrationToken(fx);
    const res = await POST(publishReq(token, { videoPathname: videoPathname() }), paramsFor(story));
    expect(res.status).toBe(415);
  });

  it('org has no paid plan → 402 no_plan (no evidence)', async () => {
    const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    aiAccess.current = access({ organizationId: ws.organizationId, hasPaidAiPlan: false });
    const token = await integrationToken(fx);
    const res = await POST(publishReq(token, { videoPathname: videoPathname() }), paramsFor(story));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('no_plan');
    const acceptanceEvidenceCount = await adminDb.acceptanceEvidence.count();
    expect(acceptanceEvidenceCount).toBe(0);
  });

  it('idempotent redelivery — same commit twice → one current, same evidence', async () => {
    const token = await integrationToken(fx);
    const first = await POST(
      publishReq(token, {
        videoPathname: videoPathname(),
        commitSha: 'deaddead',
        producedByKey: 'MOTIR-1638',
      }),
      paramsFor(story),
    );
    const firstBody = (await first.json()) as { evidence: { id: string } };
    const second = await POST(
      publishReq(token, {
        videoPathname: videoPathname(),
        commitSha: 'deaddead',
        producedByKey: 'MOTIR-1638',
      }),
      paramsFor(story),
    );
    const secondBody = (await second.json()) as { evidence: { id: string } };

    expect(secondBody.evidence.id).toBe(firstBody.evidence.id);
    const acceptanceEvidenceCount = await adminDb.acceptanceEvidence.count({
      where: { workItemId: story.id },
    });
    expect(acceptanceEvidenceCount).toBe(1);
  });
});

// ── The commit CITATION, on the HTTP door (MOTIR-5619) ───────────────────────
// The refusal is raised on the SERVICE, so this asserts the HTTP door surfaces
// it — the route maps the abstract `AcceptanceEvidenceError` to its own `status`,
// which is what makes one throw answer on both doors. The MCP door's half is
// `tests/mcp/publishAcceptanceResultTool.test.ts`.

describe('POST acceptance-evidence — commitSha', () => {
  const SHA = '832026b77b2b276ae9ba028b47e603274a4072cd';

  it('a commitSha that is not a commit id → 400 naming the field, nothing written', async () => {
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(token, { videoPathname: videoPathname(), commitSha: 'not-a-commit' }),
      paramsFor(story),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('ACCEPTANCE_EVIDENCE_INVALID_COMMIT_SHA');
    expect(body.error).toContain('commitSha');

    expect(await adminDb.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(0);
  });

  it('a whitespace-padded, upper-case commitSha → 201 with the id stored NORMALISED', async () => {
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(token, {
        videoPathname: videoPathname(),
        commitSha: `  ${SHA.toUpperCase()}\n`,
      }),
      paramsFor(story),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { evidence: { id: string; commitSha: string | null } };
    expect(body.evidence.commitSha).toBe(SHA);

    const row = await adminDb.acceptanceEvidence.findUniqueOrThrow({
      where: { id: body.evidence.id },
    });
    expect(row.commitSha).toBe(SHA);
  });
});
