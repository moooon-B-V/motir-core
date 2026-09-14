import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntitlementExceededError } from '@/lib/billing/errors';

// MOTIR-5444 — a §4 cap refusal on the item page's Attachments panel door.
//
// `POST /api/work-items/[id]/attachments` reaches `uploadAttachment` through
// `attachToWorkItem`, where `assertWithinStorageCap` throws
// `EntitlementExceededError('storage' | 'file_size', …)`. The route's error
// mapper predated the cap and rethrew it, so the refusal escaped as a 500 and
// the panel told the reader to "try again". It now answers 402 with the same
// body `app/api/upload/issue-attachment/route.ts` returns for the same error.
//
// The session gate and the service are stubbed: what is pinned is the route's
// own error → status mapping, not the cap arithmetic (8.1.11's tests own that).

const { requireCompliantWorkspaceContext, attachToWorkItem } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
  attachToWorkItem: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));
vi.mock('@/lib/services/attachmentsService', () => ({
  attachmentsService: { attachToWorkItem },
}));

const { POST } = await import('@/app/api/work-items/[id]/attachments/route');

function upload(): Request {
  const form = new FormData();
  form.append('file', new File(['x'], 'big.png', { type: 'image/png' }));
  return new Request('http://localhost/api/work-items/wi-1/attachments', {
    method: 'POST',
    body: form,
  });
}

const params = { params: Promise.resolve({ id: 'wi-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireCompliantWorkspaceContext.mockResolvedValue({
    ok: true,
    ctx: { userId: 'user-1', workspaceId: 'ws-1' },
  });
});

describe('POST /api/work-items/[id]/attachments — a cap refusal', () => {
  it.each([
    ['storage', { limit: 1_073_741_824, usage: 1_073_741_000 }],
    ['file_size', { limit: 10_485_760 }],
  ] as const)('answers 402 with the upgrade payload for %s', async (entitlement, detail) => {
    const err = new EntitlementExceededError(entitlement, detail);
    attachToWorkItem.mockRejectedValueOnce(err);

    const res = await POST(upload(), params);

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      code: 'ENTITLEMENT_EXCEEDED',
      error: err.message,
      entitlement,
      detail,
    });
  });

  it('still rethrows an error it does not map', async () => {
    attachToWorkItem.mockRejectedValueOnce(new Error('boom'));
    await expect(POST(upload(), params)).rejects.toThrow('boom');
  });
});
