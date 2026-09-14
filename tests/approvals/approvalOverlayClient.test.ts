import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchApprovalGateOverlay } from '@/lib/approvals/approvalOverlayClient';

// THE APPROVAL OVERLAY'S CLIENT READ (Story MOTIR-5214 · Subtask MOTIR-5224).
//
// The overlay treats three outcomes differently, so the client must keep them
// apart: an answer (a DTO), NOTHING-YOU-MAY-SEE (`null` — the route's one 404 and
// its 400), and a real failure (a throw the overlay can tell from an absence).
// The route itself is exercised against real Postgres in
// `tests/api/approval-gate-route.test.ts`; this pins only the transport contract.

const fetchMock = vi.fn();

function respond(status: number, body: unknown = {}) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('fetchApprovalGateOverlay (MOTIR-5224)', () => {
  it('asks the route for ONE gate by key and kind, uncached', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(200, { workItem: { identifier: 'GATE-1' } });
    const controller = new AbortController();
    const read = await fetchApprovalGateOverlay('GATE-1', 'design_result', controller.signal);
    expect(read).toEqual({ workItem: { identifier: 'GATE-1' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/work-items/approval-gate?key=GATE-1&kind=design_result');
    expect(init).toMatchObject({ cache: 'no-store', signal: controller.signal });
  });

  it('encodes the key, so a pasted address cannot smuggle a second parameter', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(200);
    await fetchApprovalGateOverlay('A&kind=merge', 'design_result');
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/work-items/approval-gate?key=A%26kind%3Dmerge&kind=design_result',
    );
  });

  it('resolves null on the no-existence-leak 404', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(404, { code: 'NOT_FOUND' });
    await expect(fetchApprovalGateOverlay('ZZZ-9', 'design_result')).resolves.toBeNull();
  });

  it('resolves null on a 400 — an address the route will not read', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(400, { code: 'BAD_REQUEST' });
    await expect(fetchApprovalGateOverlay('GATE-1', 'design_result')).resolves.toBeNull();
  });

  it('THROWS on any other failure, so an outage is not read as a missing gate', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(500);
    await expect(fetchApprovalGateOverlay('GATE-1', 'design_result')).rejects.toThrow(
      'Approval gate read failed (500)',
    );
  });
});
