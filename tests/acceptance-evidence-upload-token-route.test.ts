import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import type { WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from './fixtures';
import { truncateAuthTables } from './helpers/db';

// POST /api/work-items/[id]/acceptance-evidence/upload-token (MOTIR-1681) — mint
// scoped client upload tokens so CI uploads the acceptance video DIRECTLY to
// Blob. Same auth + eligibility gate as the register route. The blob token mint
// is mocked (no network); billingService is mocked at the eligibility seam.

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const aiAccess = vi.hoisted(() => ({ current: null as AiAccessDTO | null }));
vi.mock('@/lib/services/billingService', () => ({
  billingService: { getAiAccessForContext: vi.fn(async () => aiAccess.current) },
}));

const { POST } = await import('@/app/api/work-items/[id]/acceptance-evidence/upload-token/route');
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

function tokenReq(
  token: string | null,
  body: Record<string, unknown> = {},
  identifier: string = story.identifier,
): Request {
  return new Request(
    `http://localhost/api/work-items/${identifier}/acceptance-evidence/upload-token`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

async function integrationToken(fx: WorkItemFixture, scopes: string[] = ['integration']) {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'ci',
    scopes,
  });
  return token;
}

const paramsFor = (s: WorkItem) => ({ params: Promise.resolve({ id: s.identifier }) });

let fx: WorkItemFixture;
let story: WorkItem;

beforeEach(async () => {
  aiAccess.current = access({ applicable: false, organizationId: null });
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  story = await createTestWorkItem(fx, { kind: 'story', title: 'Gate story' });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST acceptance-evidence/upload-token', () => {
  it('valid integration token → 200 with a video target scoped to the story prefix', async () => {
    const token = await integrationToken(fx);
    const res = await POST(tokenReq(token, {}), paramsFor(story));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      video: { pathname: string; token: string; contentType: string };
      trace: unknown;
    };
    expect(body.video.pathname.startsWith(`acceptance/${fx.workspaceId}/${story.id}/`)).toBe(true);
    expect(body.video.pathname.endsWith('.webm')).toBe(true);
    expect(body.video.contentType).toBe('video/webm');
    expect(body.video.token).toBe(`token-for:${body.video.pathname}`);
    expect(body.trace).toBeNull();
  });

  it('hasTrace:true → also mints a trace target (application/zip) sharing the prefix', async () => {
    const token = await integrationToken(fx);
    const res = await POST(tokenReq(token, { hasTrace: true }), paramsFor(story));
    const body = (await res.json()) as {
      trace: { pathname: string; token: string; contentType: string } | null;
    };
    expect(body.trace).not.toBeNull();
    expect(body.trace!.pathname.startsWith(`acceptance/${fx.workspaceId}/${story.id}/`)).toBe(true);
    expect(body.trace!.pathname.endsWith('.zip')).toBe(true);
    expect(body.trace!.contentType).toBe('application/zip');
  });

  it('no token → 401', async () => {
    const res = await POST(tokenReq(null), paramsFor(story));
    expect(res.status).toBe(401);
  });

  it('token without the integration scope → 403', async () => {
    const token = await integrationToken(fx, ['read']);
    const res = await POST(tokenReq(token), paramsFor(story));
    expect(res.status).toBe(403);
  });

  it('org has no paid plan → 402 (no token minted)', async () => {
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    aiAccess.current = access({ organizationId: ws.organizationId, hasPaidAiPlan: false });
    const token = await integrationToken(fx);
    const res = await POST(tokenReq(token), paramsFor(story));
    expect(res.status).toBe(402);
  });

  it('unknown story key → 404', async () => {
    const token = await integrationToken(fx);
    const res = await POST(tokenReq(token, {}, 'PROD-999'), {
      params: Promise.resolve({ id: 'PROD-999' }),
    });
    expect(res.status).toBe(404);
  });
});
