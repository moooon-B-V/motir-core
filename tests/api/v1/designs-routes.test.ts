import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import type { WorkItem } from '@/generated/prisma/client';
import { shaFor } from '../../helpers/commitShaFixtures';

// The blob STORE is the one mocked external — nothing else is. The permission
// gate, the verdict ladder, the presign and the cursor all run for real against
// real Postgres; mocking `designAccessService` would prove the routes call a
// stub, which is the one thing this file exists to disprove.
const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string, bytes: Buffer, contentType: string) => {
    store.set(pathname, { contentType, size: bytes.byteLength });
    return { pathname };
  }),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/${pathname}?sig=x`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { GET: GET_DESIGNS } = await import('@/app/api/v1/work-items/[key]/designs/route');
const { GET: GET_DESIGN } = await import('@/app/api/v1/work-items/[key]/design/route');
const { GET: LIST_DESIGNS } = await import('@/app/api/v1/projects/[projectKey]/designs/route');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { createV1ProjectCaller } = await import('../../fixtures/apiV1Fixtures');
const { truncateAuthTables } = await import('../../helpers/db');
const { adminDb } = await import('../../helpers/adminDb');
const { makeWorkWaitOn } = await import('../../helpers/designWaits');

// THE `/api/v1` DESIGN OPERATIONS (Story MOTIR-5553 · Subtask MOTIR-5560).
//
// The three reads the CLI — which speaks `/api/v1` and nothing else — uses to
// get an approved design to an agent. The verdict RULES belong to
// `designAccessService` and are driven in its own suite; what this file asserts
// is what only the route layer can be wrong about: the permission it asserts,
// the 404-not-403 answer, WHICH reads carry download links, and the cursor.

const BASE = 'http://localhost:3000/api/v1';

let caller: V1ProjectCaller;
let parentStoryId: string;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  caller = await createV1ProjectCaller();
  const story = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title: 'Holder' },
    caller.ctx,
  );
  parentStoryId = story.id;
});

async function designCard(title: string): Promise<WorkItem> {
  const card = await workItemsService.createWorkItem(
    {
      projectId: caller.fixture.projectId,
      kind: 'subtask',
      parentId: parentStoryId,
      title,
      type: 'design',
    },
    caller.ctx,
  );
  await workItemsService.updateStatus(card.id, 'in_progress', caller.ctx);
  await workItemsService.updateStatus(card.id, 'in_review', caller.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
}

async function publishAndApprove(card: WorkItem, label: string): Promise<string> {
  const prefix = designPrefix(caller.fixture.workspaceId, card.id);
  const assets = [
    {
      kind: 'mock' as const,
      sourcePath: `design/frame/${label}.mock.html`,
      pathname: `${prefix}${label}.mock.html`,
    },
    {
      kind: 'note_file' as const,
      sourcePath: 'design/frame/design-notes.md',
      pathname: `${prefix}${label}.md`,
    },
  ];
  for (const a of assets) store.set(a.pathname, { contentType: 'text/html', size: 64 });
  const evidence = await designEvidenceService.recordFromPathnames(
    { workItemId: card.id, assets, commitSha: shaFor(label) },
    caller.ctx,
  );
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidence.id, kind: 'design_result', state: 'awaiting' },
  });
  await approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
    caller.ctx,
  );
  return evidence.id;
}

const req = (url: string, headers: Record<string, string>) => new Request(url, { headers });

describe('GET /api/v1/work-items/{key}/designs', () => {
  it('returns a verdict per design blocker, with a link on every available asset', async () => {
    const design = await designCard('The surface');
    const dependent = await makeWorkWaitOn(design.id, caller.fixture, { title: 'Build it' });
    const evidenceId = await publishAndApprove(design, 'v1');

    const res = await GET_DESIGNS(
      req(`${BASE}/work-items/${dependent.key}/designs`, caller.headers),
      {
        params: Promise.resolve({ key: dependent.key }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.designs).toHaveLength(1);
    const verdict = body.designs[0];
    expect(verdict.verdict).toBe('approved');
    expect(verdict.design.evidenceId).toBe(evidenceId);
    expect(verdict.design.assets).toHaveLength(2);
    for (const asset of verdict.design.assets) {
      expect(asset.state).toBe('available');
      expect(asset.url).toMatch(/^https:\/\/store\.example\//);
      expect(Date.parse(asset.expiresAt)).toBeGreaterThan(Date.now());
    }
  });

  it('a NOT-approved verdict carries its reason and no design', async () => {
    const design = await designCard('Still pending');
    const dependent = await makeWorkWaitOn(design.id, caller.fixture, { title: 'Build it' });

    const res = await GET_DESIGNS(
      req(`${BASE}/work-items/${dependent.key}/designs`, caller.headers),
      {
        params: Promise.resolve({ key: dependent.key }),
      },
    );
    const body = await res.json();
    // `not_done` outranks `no_result`: the card's STATUS is checked before its
    // result is looked for, which is the honest order — a design card still in
    // review has nothing to say about a result yet.
    expect(body.designs[0]).toMatchObject({ verdict: 'not_approved', reason: 'not_done' });
    expect(body.designs[0].design).toBeUndefined();
  });

  it('an UNAVAILABLE asset carries neither url nor expiry, and is still reported', async () => {
    const design = await designCard('Reclaimed');
    const dependent = await makeWorkWaitOn(design.id, caller.fixture, { title: 'Build it' });
    const evidenceId = await publishAndApprove(design, 'v1');
    await adminDb.designAsset.updateMany({
      where: { designEvidenceId: evidenceId },
      data: { attachmentId: null },
    });

    const res = await GET_DESIGNS(
      req(`${BASE}/work-items/${dependent.key}/designs`, caller.headers),
      {
        params: Promise.resolve({ key: dependent.key }),
      },
    );
    const [verdict] = (await res.json()).designs;
    expect(verdict.verdict).toBe('approved');
    expect(verdict.design.assets).toHaveLength(2);
    for (const asset of verdict.design.assets) {
      expect(asset.state).toBe('unavailable');
      expect(asset.url).toBeUndefined();
      expect(asset.expiresAt).toBeUndefined();
    }
  });

  it('a token WITHOUT `project:browse` is refused', async () => {
    const narrow = await createV1ProjectCaller({ permissions: ['comment:add'] });
    const res = await GET_DESIGNS(
      req(`${BASE}/work-items/${narrow.projectKey}-1/designs`, narrow.headers),
      {
        params: Promise.resolve({ key: `${narrow.projectKey}-1` }),
      },
    );
    expect(res.status).toBe(403);
  });

  it('an unknown key and a work item in ANOTHER workspace both answer 404, never 403', async () => {
    const unknown = await GET_DESIGNS(
      req(`${BASE}/work-items/${caller.projectKey}-9999/designs`, caller.headers),
      { params: Promise.resolve({ key: `${caller.projectKey}-9999` }) },
    );
    expect(unknown.status).toBe(404);

    const other = await createV1ProjectCaller({ workspaceName: 'Other', identifier: 'OTHR' });
    const theirCard = await workItemsService.createWorkItem(
      { projectId: other.fixture.projectId, kind: 'task', title: 'Theirs', type: 'design' },
      other.ctx,
    );
    const cross = await GET_DESIGNS(
      req(`${BASE}/work-items/${theirCard.identifier}/designs`, caller.headers),
      { params: Promise.resolve({ key: theirCard.identifier }) },
    );
    expect(cross.status).toBe(404);
  });
});

describe('GET /api/v1/work-items/{key}/design', () => {
  it('reads ONE design card by its own key, with links', async () => {
    const design = await designCard('Addressed directly');
    await makeWorkWaitOn(design.id, caller.fixture, { title: 'Build it' });
    const evidenceId = await publishAndApprove(design, 'v1');

    const res = await GET_DESIGN(
      req(`${BASE}/work-items/${design.identifier}/design`, caller.headers),
      {
        params: Promise.resolve({ key: design.identifier }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ verdict: 'approved', designCardKey: design.identifier });
    expect(body.design.evidenceId).toBe(evidenceId);
    expect(body.design.assets.every((a: { url?: string }) => typeof a.url === 'string')).toBe(true);
  });
});

describe('GET /api/v1/projects/{projectKey}/designs', () => {
  async function seed(count: number): Promise<WorkItem[]> {
    const cards: WorkItem[] = [];
    for (let i = 0; i < count; i += 1) {
      const card = await designCard(`Surface ${i}`);
      await makeWorkWaitOn(card.id, caller.fixture, { title: `Build ${i}` });
      await publishAndApprove(card, `s${i}`);
      cards.push(card);
    }
    return cards;
  }

  const list = (query = '') =>
    LIST_DESIGNS(req(`${BASE}/projects/${caller.projectKey}/designs${query}`, caller.headers), {
      params: Promise.resolve({ projectKey: caller.projectKey }),
    });

  it('lists approved designs newest first and carries NO download links', async () => {
    const cards = await seed(2);
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].designCardKey).toBe(cards[1]!.identifier);
    // The whole point of the list/single split: a page mints no presigns.
    for (const design of body.items) {
      for (const asset of design.assets) {
        expect(asset.url).toBeUndefined();
        expect(asset.expiresAt).toBeUndefined();
        expect(asset.sourcePath).toBeTruthy();
      }
    }
  });

  it('pages with a signed cursor, and the second page continues where the first stopped', async () => {
    const cards = await seed(3);
    const first = await (await list('?limit=2')).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await (
      await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json();
    expect(second.items.map((d: { designCardKey: string }) => d.designCardKey)).toEqual([
      cards[0]!.identifier,
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('filters by pathPrefix and by title query, and refuses a bad limit', async () => {
    const cards = await seed(2);
    const byPath = await (await list('?pathPrefix=design/frame/s1')).json();
    expect(byPath.items.map((d: { designCardKey: string }) => d.designCardKey)).toEqual([
      cards[1]!.identifier,
    ]);

    const byQuery = await (await list('?query=surface%200')).json();
    expect(byQuery.items.map((d: { designCardKey: string }) => d.designCardKey)).toEqual([
      cards[0]!.identifier,
    ]);

    expect((await list('?limit=0')).status).toBe(422);
  });

  it('a cursor issued for ANOTHER collection is refused rather than decoded', async () => {
    await seed(1);
    const { encodeCollectionCursor } = await import('@/lib/api/v1/pagination');
    const foreign = encodeCollectionCursor('folders', { position: 'a0', id: 'x' });
    expect((await list(`?cursor=${encodeURIComponent(foreign)}`)).status).toBe(422);
  });
});
