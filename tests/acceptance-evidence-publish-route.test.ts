import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import type { WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from './fixtures';
import { truncateAuthTables } from './helpers/db';

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

async function integrationToken(fx: WorkItemFixture, scopes: string[] = ['integration']) {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'ci',
    scopes,
  });
  return token;
}

const paramsFor = (story: WorkItem) => ({ params: Promise.resolve({ id: story.identifier }) });

let fx: WorkItemFixture;
let story: WorkItem;

beforeEach(async () => {
  aiAccess.current = access({ applicable: false, organizationId: null });
  blobHead.current = { size: 1024, contentType: 'video/webm' };
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  story = await createTestWorkItem(fx, { kind: 'story', title: 'Gate story' });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST acceptance-evidence (register)', () => {
  it('valid integration token + eligible (ungated off-cloud) → 201 pending, story stays in_review', async () => {
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(token, { videoPathname: videoPathname(), commitSha: 'c1' }),
      paramsFor(story),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { evidence: { status: string; workItemId: string } };
    expect(body.evidence.status).toBe('pending');
    expect(body.evidence.workItemId).toBe(story.id);

    const row = await db.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(row.status).not.toBe('done');
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
    expect(await db.acceptanceEvidence.count()).toBe(0);
  });

  it('a pathname whose blob does not exist → 400 (head confirms the upload)', async () => {
    blobHead.current = null;
    const token = await integrationToken(fx);
    const res = await POST(publishReq(token, { videoPathname: videoPathname() }), paramsFor(story));
    expect(res.status).toBe(400);
    expect(await db.acceptanceEvidence.count()).toBe(0);
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
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    aiAccess.current = access({ organizationId: ws.organizationId, hasPaidAiPlan: false });
    const token = await integrationToken(fx);
    const res = await POST(publishReq(token, { videoPathname: videoPathname() }), paramsFor(story));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('no_plan');
    expect(await db.acceptanceEvidence.count()).toBe(0);
  });

  it('idempotent redelivery — same commit twice → one current, same evidence', async () => {
    const token = await integrationToken(fx);
    const first = await POST(
      publishReq(token, {
        videoPathname: videoPathname(),
        commitSha: 'dead',
        producedByKey: 'MOTIR-1638',
      }),
      paramsFor(story),
    );
    const firstBody = (await first.json()) as { evidence: { id: string } };
    const second = await POST(
      publishReq(token, {
        videoPathname: videoPathname(),
        commitSha: 'dead',
        producedByKey: 'MOTIR-1638',
      }),
      paramsFor(story),
    );
    const secondBody = (await second.json()) as { evidence: { id: string } };

    expect(secondBody.evidence.id).toBe(firstBody.evidence.id);
    expect(await db.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(1);
  });
});
