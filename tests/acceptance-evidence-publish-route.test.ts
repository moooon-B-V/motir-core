import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import type { WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from './fixtures';
import { truncateAuthTables } from './helpers/db';

// POST /api/work-items/[key]/acceptance-evidence (Story MOTIR-1627 · Subtask
// MOTIR-1631) — the token-authed CI publish route, against a REAL Postgres. The
// blob adapter is mocked (no network); billingService is mocked at the
// getAiAccessForContext seam so the ineligibility branches are reachable
// off-cloud (where real billing is inert).

vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({
      url: `https://store1.public.blob.vercel-storage.com/${p}-${++seq}`,
    })),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const aiAccess = vi.hoisted(() => ({ current: null as AiAccessDTO | null }));
vi.mock('@/lib/services/billingService', () => ({
  billingService: { getAiAccessForContext: vi.fn(async () => aiAccess.current) },
}));

const { POST } = await import('@/app/api/work-items/[key]/acceptance-evidence/route');
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

const videoBlob = (name = 'run.webm', type = 'video/webm', bytes = 1024) =>
  new File([new Uint8Array(bytes)], name, { type });

function publishReq(
  token: string | null,
  parts: { video?: File; commitSha?: string; producedByKey?: string; chapters?: unknown } = {},
): Request {
  const form = new FormData();
  if (parts.video !== undefined) form.set('video', parts.video);
  if (parts.commitSha) form.set('commitSha', parts.commitSha);
  if (parts.producedByKey) form.set('producedByKey', parts.producedByKey);
  if (parts.chapters) form.set('chapters', JSON.stringify(parts.chapters));
  return new Request('http://localhost/api/work-items/PROD-1/acceptance-evidence', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

async function integrationToken(fx: WorkItemFixture, scopes: string[] = ['integration']) {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'ci',
    scopes,
  });
  return token;
}

const paramsFor = (story: WorkItem) => ({ params: Promise.resolve({ key: story.identifier }) });

let fx: WorkItemFixture;
let story: WorkItem;

beforeEach(async () => {
  // Default: off-cloud (not applicable) → the feature is ungated, so publishing
  // succeeds without a plan. Cases that need a cloud gate override this.
  aiAccess.current = access({ applicable: false, organizationId: null });
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

describe('POST acceptance-evidence', () => {
  it('valid integration token + eligible (ungated off-cloud) → 201 pending, story stays in_review', async () => {
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(token, { video: videoBlob(), commitSha: 'c1' }),
      paramsFor(story),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { evidence: { status: string; workItemId: string } };
    expect(body.evidence.status).toBe('pending');
    expect(body.evidence.workItemId).toBe(story.id);

    // The endpoint never advances the gate.
    const row = await db.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(row.status).not.toBe('done');
  });

  it('no token → 401', async () => {
    const res = await POST(publishReq(null, { video: videoBlob() }), paramsFor(story));
    expect(res.status).toBe(401);
  });

  it('token without the integration scope → 403', async () => {
    const token = await integrationToken(fx, ['read']);
    const res = await POST(publishReq(token, { video: videoBlob() }), paramsFor(story));
    expect(res.status).toBe(403);
  });

  it('missing `video` → 400', async () => {
    const token = await integrationToken(fx);
    const res = await POST(publishReq(token, {}), paramsFor(story));
    expect(res.status).toBe(400);
  });

  it('unknown story key → 404', async () => {
    const token = await integrationToken(fx);
    const req = new Request('http://localhost/api/work-items/PROD-999/acceptance-evidence', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: (() => {
        const f = new FormData();
        f.set('video', videoBlob());
        return f;
      })(),
    });
    const res = await POST(req, { params: Promise.resolve({ key: 'PROD-999' }) });
    expect(res.status).toBe(404);
  });

  it('non-video MIME → 415', async () => {
    const token = await integrationToken(fx);
    const res = await POST(
      publishReq(token, { video: videoBlob('x.png', 'image/png') }),
      paramsFor(story),
    );
    expect(res.status).toBe(415);
  });

  it('org has no paid plan → 402 no_plan (no blob, no evidence)', async () => {
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    aiAccess.current = access({ organizationId: ws.organizationId, hasPaidAiPlan: false });
    const token = await integrationToken(fx);
    const res = await POST(publishReq(token, { video: videoBlob() }), paramsFor(story));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('no_plan');
    expect(await db.acceptanceEvidence.count()).toBe(0);
  });

  it('idempotent redelivery — same commit twice → one current, same evidence', async () => {
    const token = await integrationToken(fx);
    const first = await POST(
      publishReq(token, { video: videoBlob(), commitSha: 'dead', producedByKey: 'MOTIR-1638' }),
      paramsFor(story),
    );
    const firstBody = (await first.json()) as { evidence: { id: string } };
    const second = await POST(
      publishReq(token, { video: videoBlob(), commitSha: 'dead', producedByKey: 'MOTIR-1638' }),
      paramsFor(story),
    );
    const secondBody = (await second.json()) as { evidence: { id: string } };

    expect(secondBody.evidence.id).toBe(firstBody.evidence.id);
    expect(await db.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(1);
  });
});
