import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import type { TokenScope } from '@/lib/mcp/scopes';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// POST /api/work-items/[id]/design-evidence{,/upload-token} (Story MOTIR-2664 ·
// Subtask MOTIR-2667) — the CI publish seam for a design result. The blob
// adapter is the ONE mocked external (no network); auth, resolution and every
// gate go through the real path against a real Postgres.
//
// ⚠️ NOTHING mocks an eligibility service here, and that absence is the point:
// unlike the acceptance routes beside them, these have no plan axis and no org
// toggle to consult (docs/decisions/design-result.md §2).

const store = new Map<string, { contentType: string; size: number }>();

// The OIDC seam, controllable per test. `null` = "the caller did not opt in",
// which is what makes the PAT fallback run — the default for every other test
// in this file.
const oidc = vi.hoisted(() => ({
  current: null as
    | null
    | { ok: true; userId: string; workspaceId: string }
    | {
        ok: false;
        status: number;
        reason: string;
      },
}));
vi.mock('@/lib/github/oidcAuth', () => ({
  authenticateGithubOidc: vi.fn(async () => oidc.current),
  GITHUB_OIDC_AUTH_MARKER: 'github-oidc',
}));

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { POST: MINT } = await import('@/app/api/work-items/[id]/design-evidence/upload-token/route');
const { POST: REGISTER } = await import('@/app/api/work-items/[id]/design-evidence/route');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { designPrefix } = await import('@/lib/services/designEvidenceService');

let fx: WorkItemFixture;
let card: WorkItem;

function req(path: string, token: string | null, body: unknown, identifier: string): Request {
  return new Request(`http://localhost/api/work-items/${identifier}/design-evidence${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const params = (identifier: string) => ({ params: Promise.resolve({ id: identifier }) });

/**
 * A CI token. MOTIR-2576 moved the publish off the `integration` SCOPE onto the
 * permission the operation actually asserts, so a token is minted with a GRANT;
 * `grantForLegacyScopes` is the same bridge the acceptance route tests use.
 */
async function integrationToken(f: WorkItemFixture, scopes: TokenScope[] = ['integration']) {
  const { token } = await apiTokensService.create(f.ownerId, f.workspaceId, {
    label: 'ci',
    fixedGrant: grantForLegacyScopes(scopes),
  });
  return token;
}

/** Put a fake object in the store, returning the asset entry for register. */
function seed(
  kind: 'mock' | 'image' | 'note_file',
  name: string,
  contentType: string,
  size = 1024,
) {
  const pathname = `${designPrefix(fx.ctx.workspaceId, card.id)}${name}`;
  store.set(pathname, { contentType, size });
  return { kind, sourcePath: `design/work-items/${name}`, pathname };
}

beforeEach(async () => {
  store.clear();
  oidc.current = null;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent story' });
  card = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Design — the panel',
    parentId: story.id,
  });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /design-evidence/upload-token', () => {
  it('mints one grant per declared file, each bound to its own key and content type', async () => {
    const token = await integrationToken(fx);
    const res = await MINT(
      req(
        '/upload-token',
        token,
        {
          files: [
            { kind: 'mock', sourcePath: 'design/work-items/p.mock.html', contentType: 'text/html' },
            { kind: 'image', sourcePath: 'design/work-items/p.png', contentType: 'image/png' },
          ],
        },
        card.identifier,
      ),
      params(card.identifier),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.targets).toHaveLength(2);
    for (const t of body.targets) {
      // Bound to this item's prefix — a grant can never write another item's key.
      expect(t.pathname.startsWith(designPrefix(fx.ctx.workspaceId, card.id))).toBe(true);
      expect(t.token).toBe(`token-for:${t.pathname}`);
      expect(t.maxBytes).toBeGreaterThan(0);
    }
    expect(body.targets[0].contentType).toBe('text/html');
    expect(body.targets[1].contentType).toBe('image/png');
    // The two grants are distinct objects, so same-basename files cannot collide.
    expect(body.targets[0].pathname).not.toBe(body.targets[1].pathname);
  });

  it('refuses to mint a key for a type outside the design allowlist', async () => {
    const token = await integrationToken(fx);
    const res = await MINT(
      req(
        '/upload-token',
        token,
        {
          files: [
            {
              kind: 'mock',
              sourcePath: 'design/work-items/x.svg',
              contentType: 'image/svg+xml',
            },
          ],
        },
        card.identifier,
      ),
      params(card.identifier),
    );
    // No key is minted at all — the rejection happens before a grant exists.
    expect(res.status).toBe(415);
  });

  it('drops malformed file entries and rejects when nothing usable is left', async () => {
    const token = await integrationToken(fx);
    const res = await MINT(
      req(
        '/upload-token',
        token,
        { files: [{ kind: 'mock' }, { sourcePath: '' }, null, 'nope'] },
        card.identifier,
      ),
      params(card.identifier),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-array `files`', async () => {
    const token = await integrationToken(fx);
    const res = await MINT(
      req('/upload-token', token, { files: 'all of them' }, card.identifier),
      params(card.identifier),
    );
    expect(res.status).toBe(400);
  });

  it('re-throws an unexpected mint failure rather than dressing it as a domain error', async () => {
    const token = await integrationToken(fx);
    const { mintPrivateUploadToken } = await import('@/lib/blob/uploader');
    vi.mocked(mintPrivateUploadToken).mockRejectedValueOnce(new Error('signer down'));

    await expect(
      MINT(
        req(
          '/upload-token',
          token,
          {
            files: [
              {
                kind: 'mock',
                sourcePath: 'design/work-items/s.mock.html',
                contentType: 'text/html',
              },
            ],
          },
          card.identifier,
        ),
        params(card.identifier),
      ),
    ).rejects.toThrow('signer down');
  });

  it('403s a caller who may reach the item but may not EDIT it', async () => {
    // The gate asserts `work_item:edit` on the project resolved from the ITEM,
    // not from the actor's active project — the hole MOTIR-2365 closed after a
    // token-MINTING endpoint turned out to be reachable with a session and an id.
    const token = await integrationToken(fx);
    const { projectAccessService } = await import('@/lib/services/projectAccessService');
    const { PermissionDeniedError } = await import('@/lib/projects/errors');
    const spy = vi
      .spyOn(projectAccessService, 'assertPermission')
      .mockRejectedValueOnce(new PermissionDeniedError('proj-1', 'work_item:edit'));

    const res = await MINT(
      req(
        '/upload-token',
        token,
        {
          files: [
            { kind: 'mock', sourcePath: 'design/work-items/d.mock.html', contentType: 'text/html' },
          ],
        },
        card.identifier,
      ),
      params(card.identifier),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).permission).toBe('work_item:edit');
    spy.mockRestore();
  });

  it('rejects an unparseable JSON body', async () => {
    const token = await integrationToken(fx);
    const bad = new Request(
      `http://localhost/api/work-items/${card.identifier}/design-evidence/upload-token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: 'not json',
      },
    );
    expect((await MINT(bad, params(card.identifier))).status).toBe(400);
  });

  it('rejects an empty or malformed body', async () => {
    const token = await integrationToken(fx);
    const res = await MINT(
      req('/upload-token', token, { files: [] }, card.identifier),
      params(card.identifier),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /design-evidence — auth', () => {
  it('401s with no credential at all', async () => {
    const res = await REGISTER(
      req('', null, { assets: [seed('mock', 'a.mock.html', 'text/html')] }, card.identifier),
      params(card.identifier),
    );
    expect(res.status).toBe(401);
  });

  it('403s a token without the integration scope', async () => {
    const token = await integrationToken(fx, ['read']);
    const res = await REGISTER(
      req('', token, { assets: [seed('mock', 'a.mock.html', 'text/html')] }, card.identifier),
      params(card.identifier),
    );
    expect(res.status).toBe(403);
  });

  it('404s a target in ANOTHER workspace — never 403, never a leak, nothing written', async () => {
    const other = await makeWorkItemFixture();
    const otherStory = await createTestWorkItem(other, { kind: 'story', title: 'Theirs' });
    // Push the other workspace's key sequence well past this one's, so the
    // identifier below exists ONLY over there. (Both fixtures use the same
    // project KEY, so an identifier low enough to exist in both would resolve to
    // the caller's own item — which is correct scoping, but proves nothing.)
    let otherCard = otherStory;
    for (let i = 0; i < 6; i++) {
      otherCard = await createTestWorkItem(other, {
        kind: 'subtask',
        title: `Their design ${i}`,
        parentId: otherStory.id,
      });
    }

    // A perfectly valid token — for the WRONG workspace.
    const token = await integrationToken(fx);
    const res = await REGISTER(
      req('', token, { assets: [seed('mock', 'a.mock.html', 'text/html')] }, otherCard.identifier),
      params(otherCard.identifier),
    );

    expect(res.status).toBe(404);
    // …and the other tenant's item is untouched.
    expect(await adminDb.designEvidence.count({ where: { workItemId: otherCard.id } })).toBe(0);
  });
});

describe('POST /design-evidence — keyless GitHub OIDC (the PRIMARY auth path)', () => {
  it('publishes with NO token at all when the OIDC identity resolves', async () => {
    // The whole point of keyless publish: a connected repo's CI needs no secret.
    oidc.current = { ok: true, userId: fx.ownerId, workspaceId: fx.workspaceId };

    const res = await REGISTER(
      req('', null, { assets: [seed('mock', 'o.mock.html', 'text/html')] }, card.identifier),
      params(card.identifier),
    );

    expect(res.status).toBe(201);
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(1);
  });

  it('401s an OIDC token that does not verify', async () => {
    oidc.current = { ok: false, status: 401, reason: 'missing_oidc_token' };
    const res = await REGISTER(
      req('', null, { assets: [seed('mock', 'o.mock.html', 'text/html')] }, card.identifier),
      params(card.identifier),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('missing_oidc_token');
  });

  it('403s a repo whose OIDC identity maps to no workspace', async () => {
    oidc.current = { ok: false, status: 403, reason: 'repository_not_connected' };
    const res = await REGISTER(
      req('', null, { assets: [seed('mock', 'o.mock.html', 'text/html')] }, card.identifier),
      params(card.identifier),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('repository_not_connected');
  });

  it('mints upload grants over OIDC too, with no token', async () => {
    oidc.current = { ok: true, userId: fx.ownerId, workspaceId: fx.workspaceId };
    const res = await MINT(
      req(
        '/upload-token',
        null,
        {
          files: [
            { kind: 'mock', sourcePath: 'design/work-items/o.mock.html', contentType: 'text/html' },
          ],
        },
        card.identifier,
      ),
      params(card.identifier),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).targets).toHaveLength(1);
  });
});

describe('POST /design-evidence — register', () => {
  it('records the result and returns 201 with the evidence', async () => {
    const token = await integrationToken(fx);
    const res = await REGISTER(
      req(
        '',
        token,
        {
          assets: [seed('mock', 'p.mock.html', 'text/html'), seed('image', 'p.png', 'image/png')],
          noteMd: '## The panel\n\nprose',
          commitSha: 'deadbee',
          ciRunUrl: 'https://ci.example/run/9',
          producedByKey: 'MOTIR-2669',
        },
        card.identifier,
      ),
      params(card.identifier),
    );

    expect(res.status).toBe(201);
    const { evidence } = await res.json();
    expect(evidence.workItemId).toBe(card.id);
    expect(evidence.assets).toHaveLength(2);
    expect(evidence.noteMd).toContain('## The panel');
    expect(evidence.commitSha).toBe('deadbee');
  });

  it('does NOT roll up to the parent story — the result lands on the card that produced it', async () => {
    const token = await integrationToken(fx);
    await REGISTER(
      req('', token, { assets: [seed('mock', 'r.mock.html', 'text/html')] }, card.identifier),
      params(card.identifier),
    );

    // On the subtask...
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(1);
    // ...and NOT on its parent story, which is where acceptance evidence would go.
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.parentId! } })).toBe(0);
  });

  it('422s a CONTAINER target — a story has many designs, one per design subtask', async () => {
    const token = await integrationToken(fx);
    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.parentId! } });
    const pathname = `${designPrefix(fx.ctx.workspaceId, story.id)}s.mock.html`;
    store.set(pathname, { contentType: 'text/html', size: 10 });

    const res = await REGISTER(
      req(
        '',
        token,
        { assets: [{ kind: 'mock', sourcePath: 'design/x/s.mock.html', pathname }] },
        story.identifier,
      ),
      params(story.identifier),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('DESIGN_EVIDENCE_NOT_A_LEAF');
  });

  it('422s a target that is a LEAF but not the declared container’s child (MOTIR-3177)', async () => {
    // A PARENT-RUN publish addresses each asset to the child whose COMMIT
    // produced it, reading the key out of that commit's subject — prose, written
    // by hand. A mistyped key resolves to a real, unrelated leaf that would
    // otherwise accept the publish, so only the tree can refuse it. The live
    // fixture: a commit on `parent/MOTIR-3068-…` subject-tagged `(MOTIR-3147)`,
    // a manual task in a different epic.
    const token = await integrationToken(fx);
    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.parentId! } });
    const stranger = await createTestWorkItem(fx, { kind: 'task', title: 'Somebody else’s card' });
    const pathname = `${designPrefix(fx.ctx.workspaceId, stranger.id)}x.mock.html`;
    store.set(pathname, { contentType: 'text/html', size: 10 });

    const res = await REGISTER(
      req(
        '',
        token,
        {
          assets: [{ kind: 'mock', sourcePath: 'design/x/x.mock.html', pathname }],
          withinParentKey: story.identifier,
        },
        stranger.identifier,
      ),
      params(stranger.identifier),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('DESIGN_EVIDENCE_NOT_A_CHILD');
    expect(await adminDb.designEvidence.count({ where: { workItemId: stranger.id } })).toBe(0);
  });

  it('accepts the SAME publish when the target really is that container’s child', async () => {
    const token = await integrationToken(fx);
    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.parentId! } });

    const res = await REGISTER(
      req(
        '',
        token,
        {
          assets: [seed('mock', 'ok.mock.html', 'text/html')],
          withinParentKey: story.identifier.toLowerCase(),
        },
        card.identifier,
      ),
      params(card.identifier),
    );

    expect(res.status).toBe(201);
  });

  it('422s a `withinParentKey` naming nothing — a claim the tree does not support', async () => {
    const token = await integrationToken(fx);
    const res = await REGISTER(
      req(
        '',
        token,
        {
          assets: [seed('mock', 'nope.mock.html', 'text/html')],
          withinParentKey: `${fx.projectIdentifier}-999999`,
        },
        card.identifier,
      ),
      params(card.identifier),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('DESIGN_EVIDENCE_NOT_A_CHILD');
  });

  it('400s an asset pathname outside this item’s prefix', async () => {
    const token = await integrationToken(fx);
    const foreign = `design/${fx.ctx.workspaceId}/somewhere-else/evil.mock.html`;
    store.set(foreign, { contentType: 'text/html', size: 10 });

    const res = await REGISTER(
      req(
        '',
        token,
        { assets: [{ kind: 'mock', sourcePath: 'design/x/evil.mock.html', pathname: foreign }] },
        card.identifier,
      ),
      params(card.identifier),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('DESIGN_EVIDENCE_INVALID_PATHNAME');
  });

  it('400s a malformed body and an empty asset list', async () => {
    const token = await integrationToken(fx);
    expect(
      (await REGISTER(req('', token, { assets: [] }, card.identifier), params(card.identifier)))
        .status,
    ).toBe(400);

    const bad = new Request(`http://localhost/api/work-items/${card.identifier}/design-evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'not json',
    });
    expect((await REGISTER(bad, params(card.identifier))).status).toBe(400);
  });

  it('403s a register from a caller who may not EDIT the item', async () => {
    const token = await integrationToken(fx);
    const { projectAccessService } = await import('@/lib/services/projectAccessService');
    const { PermissionDeniedError } = await import('@/lib/projects/errors');
    const spy = vi
      .spyOn(projectAccessService, 'assertPermission')
      .mockRejectedValueOnce(new PermissionDeniedError('proj-1', 'work_item:edit'));

    const res = await REGISTER(
      req('', token, { assets: [seed('mock', 'd.mock.html', 'text/html')] }, card.identifier),
      params(card.identifier),
    );

    expect(res.status).toBe(403);
    expect(await adminDb.designEvidence.count()).toBe(0);
    spy.mockRestore();
  });

  it('re-throws an unexpected project-lookup failure instead of reporting it as NOT FOUND', async () => {
    // A 404 means "no such item for you". A database outage does not, and
    // flattening one into the other would hide an incident behind a tidy answer.
    const token = await integrationToken(fx);
    const { projectsService } = await import('@/lib/services/projectsService');
    const spy = vi.spyOn(projectsService, 'getByKey').mockRejectedValueOnce(new Error('db down'));

    await expect(
      REGISTER(
        req('', token, { assets: [seed('mock', 'a.mock.html', 'text/html')] }, card.identifier),
        params(card.identifier),
      ),
    ).rejects.toThrow('db down');

    spy.mockRestore();
  });

  it('rejects a non-array `assets`', async () => {
    const token = await integrationToken(fx);
    const res = await REGISTER(
      req('', token, { assets: 'everything' }, card.identifier),
      params(card.identifier),
    );
    expect(res.status).toBe(400);
  });

  it('404s an identifier whose PROJECT does not exist', async () => {
    const token = await integrationToken(fx);
    const res = await REGISTER(
      req('', token, { assets: [seed('mock', 'a.mock.html', 'text/html')] }, 'NOSUCHPROJ-9'),
      params('NOSUCHPROJ-9'),
    );
    expect(res.status).toBe(404);
  });

  it('drops malformed asset entries rather than half-recording them', async () => {
    const token = await integrationToken(fx);
    const good = seed('mock', 'good.mock.html', 'text/html');
    const res = await REGISTER(
      req(
        '',
        token,
        {
          assets: [
            good,
            { kind: 'mock' }, // no sourcePath / pathname
            { kind: 'image', sourcePath: '', pathname: '' }, // blank
            null,
          ],
        },
        card.identifier,
      ),
      params(card.identifier),
    );

    expect(res.status).toBe(201);
    const { evidence } = await res.json();
    expect(evidence.assets).toHaveLength(1);
    expect(evidence.assets[0].sourcePath).toBe(good.sourcePath);
  });

  it('re-throws an unexpected store failure rather than dressing it as a domain error', async () => {
    const token = await integrationToken(fx);
    const { headPrivateBlob } = await import('@/lib/blob/uploader');
    vi.mocked(headPrivateBlob).mockRejectedValueOnce(new Error('store unreachable'));

    await expect(
      REGISTER(
        req('', token, { assets: [seed('mock', 'boom.mock.html', 'text/html')] }, card.identifier),
        params(card.identifier),
      ),
    ).rejects.toThrow('store unreachable');
  });

  it('does not change the item’s status — publishing is evidence, not a transition', async () => {
    const token = await integrationToken(fx);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });

    await REGISTER(
      req('', token, { assets: [seed('mock', 'z.mock.html', 'text/html')] }, card.identifier),
      params(card.identifier),
    );

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe(before.status);
  });
});
