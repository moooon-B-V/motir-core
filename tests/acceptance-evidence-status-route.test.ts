import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { GET } from '@/app/api/work-items/[id]/acceptance-evidence/route';
import {
  fetchApprovedStories,
  LaneGuardReadError,
  type StatusSource,
} from './helpers/acceptanceLaneGuard';
import type { NormalizedRepo } from '@/lib/git/types';

// GET /api/work-items/[id]/acceptance-evidence (MOTIR-4144) — the receipt-STATUS
// read, against a REAL Postgres and the REAL route handler.
//
// THIS FILE EXISTS BECAUSE OF WHAT ITS ABSENCE COST. MOTIR-2770's lane guard has
// fetched this URL since the day it shipped and the path had no GET handler, so
// every call was 405 and the guard's approved set was empty for eleven weeks.
// Every test of `fetchApprovedStories` passed it a `fetchImpl` STUB, so no test
// ever asked whether the URL it builds resolves — the stub answered the question
// the route was supposed to. The last describe here is the one that would have
// caught it: it drives the guard's own function over real HTTP into the shipped
// handler, so a URL that does not resolve fails the test rather than reporting
// "nothing is approved".

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'motir-acceptance-video';
const KID = 'status-read-key-1';

const REPO: NormalizedRepo = {
  providerRepoId: '4144',
  owner: 'moooon',
  name: 'motir-core-status-read',
  defaultBranch: 'main',
  archived: false,
};

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwksServer: Server;

/** A local JWKS the real `jose` verify resolves against — the same technique
 *  `tests/github/oidc-auth.test.ts` uses, so the keyless arm is exercised
 *  through the real verifier rather than a mock of it. */
beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const bodyText = JSON.stringify({ keys: [jwk] });

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(bodyText);
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = jwksServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  process.env.GITHUB_OIDC_ISSUER = ISSUER;
  process.env.GITHUB_OIDC_JWKS_URL = `http://127.0.0.1:${port}/jwks`;
  process.env.GITHUB_OIDC_AUDIENCE = AUDIENCE;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  delete process.env.GITHUB_OIDC_ISSUER;
  delete process.env.GITHUB_OIDC_JWKS_URL;
  delete process.env.GITHUB_OIDC_AUDIENCE;
  await db.$disconnect();
  await adminDb.$disconnect();
});

let fx: WorkItemFixture;
let story: WorkItem;

beforeEach(async () => {
  // TRUNCATE requires table OWNERSHIP, which the runtime role must never have —
  // the admin client is the only one that can reset between tests.
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  story = await createTestWorkItem(fx, { kind: 'story', title: 'Receipt story' });
});

async function readToken(fixture: WorkItemFixture = fx) {
  const { token } = await apiTokensService.create(fixture.ownerId, fixture.workspaceId, {
    label: 'lane-guard',
    // The permission the read asks for, and ONLY it — the guard's credential is
    // read-only, which is the argument for `project:browse` over `work_item:edit`.
    fixedGrant: ['project:browse'],
  });
  return token;
}

async function mintOidcToken(repository = `${REPO.owner}/${REPO.name}`): Promise<string> {
  return new SignJWT({ repository })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}

function statusReq(
  token: string | null,
  identifier: string = story.identifier,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/api/work-items/${identifier}/acceptance-evidence`, {
    method: 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
  });
}

const paramsFor = (item: Pick<WorkItem, 'identifier'>) => ({
  params: Promise.resolve({ id: item.identifier }),
});

/** Seed a receipt row directly — this file is about the READ, and the publish
 *  path has its own suite (`acceptance-evidence-publish-route.test.ts`). */
async function seedReceipt(target: WorkItem, status: 'pending' | 'approved' | 'changes_requested') {
  await adminDb.acceptanceEvidence.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: target.id,
      status,
      isCurrent: true,
      chapters: [],
      ...(status === 'approved' ? { approvedById: fx.ownerId, approvedAt: new Date() } : {}),
    },
  });
}

type StatusBody = { evidence: { status: string } | null };

describe('GET acceptance-evidence — the receipt status', () => {
  it('an APPROVED receipt reads `approved`', async () => {
    await seedReceipt(story, 'approved');
    const res = await GET(statusReq(await readToken()), paramsFor(story));

    expect(res.status).toBe(200);
    expect((await res.json()) as StatusBody).toEqual({ evidence: { status: 'approved' } });
  });

  it('a PENDING receipt does not read `approved`', async () => {
    await seedReceipt(story, 'pending');
    const res = await GET(statusReq(await readToken()), paramsFor(story));

    expect(res.status).toBe(200);
    expect(((await res.json()) as StatusBody).evidence?.status).toBe('pending');
  });

  it('a story with NO receipt reads 200 + `evidence: null` — never 404', async () => {
    // THE LOAD-BEARING CASE. It is what leaves 404 unambiguous, which is what
    // lets the guard treat every non-2xx as a defect in its own wiring.
    const res = await GET(statusReq(await readToken()), paramsFor(story));

    expect(res.status).toBe(200);
    expect((await res.json()) as StatusBody).toEqual({ evidence: null });
  });

  it('returns the STATUS and nothing else — no signed video path, no provenance', async () => {
    await seedReceipt(story, 'approved');
    const res = await GET(statusReq(await readToken()), paramsFor(story));

    const body = (await res.json()) as { evidence: Record<string, unknown> };
    expect(Object.keys(body.evidence)).toEqual(['status']);
  });

  it('a SUBTASK key resolves UP to its parent story — the same hop the publish makes', async () => {
    // The guard reads the receipt at the coordinate the publisher wrote it to.
    // Both go through `resolveAcceptanceStory`, so the two cannot disagree.
    await seedReceipt(story, 'approved');
    const subtask = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'acceptance E2E subtask',
      parentId: story.id,
    });

    const res = await GET(statusReq(await readToken(), subtask.identifier), paramsFor(subtask));
    expect(res.status).toBe(200);
    expect(((await res.json()) as StatusBody).evidence?.status).toBe('approved');
  });

  it('a leaf whose parent is NOT a story → 422, exactly as the publish refuses it', async () => {
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'a bug', parentId: story.id });
    const sub = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'subtask under a bug',
      parentId: bug.id,
    });

    const res = await GET(statusReq(await readToken(), sub.identifier), paramsFor(sub));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('ACCEPTANCE_EVIDENCE_NOT_A_STORY');
  });

  it('an unknown key → 404', async () => {
    const res = await GET(statusReq(await readToken(), 'MOTIR-999999'), {
      params: Promise.resolve({ id: 'MOTIR-999999' }),
    });
    expect(res.status).toBe(404);
  });

  it("another workspace's PROJECT reads 404, never 403 (finding #44)", async () => {
    // "You can't see it" must be indistinguishable from "it doesn't exist" — the
    // POST path's contract, and a READ is the one that could leak existence.
    const other = await makeWorkItemFixture({ name: 'Theirs', identifier: 'ELSE' });
    const otherStory = await createTestWorkItem(other, { kind: 'story', title: 'Theirs' });
    await seedReceiptFor(other.workspaceId, otherStory.id);

    const res = await GET(statusReq(await readToken(), otherStory.identifier), {
      params: Promise.resolve({ id: otherStory.identifier }),
    });
    expect(res.status).toBe(404);
  });

  it("another workspace's ITEM under the SAME project key reads 404 too", async () => {
    // The sharper half, and the one the project lookup cannot answer: two tenants
    // whose projects share a key. `getByKey` then resolves to MY project and the
    // refusal has to come from the item lookup being workspace-scoped. Without
    // this case the test above passes on the project gate alone and says nothing
    // about the row.
    //
    // The other tenant's items are numbered past anything in mine, so the
    // identifier under test exists in THEIR project and in no other.
    const other = await makeWorkItemFixture({ name: 'Same key, other tenant' });
    let theirs = await createTestWorkItem(other, { kind: 'story', title: 'Theirs 1' });
    for (let i = 2; i <= 6; i += 1) {
      theirs = await createTestWorkItem(other, { kind: 'story', title: `Theirs ${i}` });
    }
    await seedReceiptFor(other.workspaceId, theirs.id);

    // Precondition: the identifier is genuinely absent from the caller's project,
    // so a 404 means "hidden", not "we happened to look at my own item".
    const mine = await adminDb.workItem.findFirst({
      where: { projectId: fx.projectId, identifier: theirs.identifier },
    });
    expect(mine).toBeNull();

    const res = await GET(statusReq(await readToken(), theirs.identifier), {
      params: Promise.resolve({ id: theirs.identifier }),
    });
    expect(res.status).toBe(404);
  });
});

/** The cross-workspace seed — a second fixture's workspace, so the row exists
 *  and only the RLS scope hides it. */
async function seedReceiptFor(workspaceId: string, workItemId: string) {
  await adminDb.acceptanceEvidence.create({
    data: { workspaceId, workItemId, status: 'approved', isCurrent: true, chapters: [] },
  });
}

describe('GET acceptance-evidence — both auth arms', () => {
  it('the bearer-PAT arm: a token granted `project:browse` is admitted', async () => {
    await seedReceipt(story, 'approved');
    const res = await GET(statusReq(await readToken()), paramsFor(story));
    expect(res.status).toBe(200);
  });

  it('the keyless OIDC arm: a verified Actions token is admitted, with NO Motir token', async () => {
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: 'inst-4144',
        accountLogin: REPO.owner,
        accountType: 'Organization',
      },
      repos: [REPO],
    });
    await seedReceipt(story, 'approved');

    const res = await GET(
      statusReq(await mintOidcToken(), story.identifier, { 'x-motir-auth': 'github-oidc' }),
      paramsFor(story),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as StatusBody).evidence?.status).toBe('approved');
  });

  it('the OIDC marker WITHOUT a usable token → 401 (it does not fall through to the PAT arm)', async () => {
    const res = await GET(
      statusReq('not-a-jwt', story.identifier, { 'x-motir-auth': 'github-oidc' }),
      paramsFor(story),
    );
    expect(res.status).toBe(401);
  });

  it('no credential at all → 401', async () => {
    const res = await GET(statusReq(null), paramsFor(story));
    expect(res.status).toBe(401);
  });

  it('a token WITHOUT `project:browse` → 403', async () => {
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'comment-only',
      fixedGrant: ['comment:add'],
    });
    const res = await GET(statusReq(token), paramsFor(story));
    expect(res.status).toBe(403);
  });

  it('does NOT inherit the publish eligibility gate — an approved receipt stays readable', async () => {
    // `authorizeAcceptancePublish` refuses 402/403 on an org with no AI plan.
    // That is a question about a WRITE. Applying it to the read would make an
    // already-approved receipt unreadable the day a plan lapses, and the lane
    // guard's answer would silently flip from "approved" to "not approved" for a
    // reason that has nothing to do with the story. `billingService` is NOT
    // mocked here, so the ineligible off-cloud path is the one in play — the
    // publish suite has to mock it to reach 201, and this read does not.
    await seedReceipt(story, 'approved');
    const res = await GET(statusReq(await readToken()), paramsFor(story));

    expect(res.status).toBe(200);
    expect(((await res.json()) as StatusBody).evidence?.status).toBe('approved');
  });
});

describe('the LANE GUARD reaches the SHIPPED route — the criterion that would have caught it', () => {
  // Every other test of `fetchApprovedStories` hands it a `fetchImpl` stub, so
  // none of them can tell a resolving URL from a 405. This one puts the real
  // handler behind a real HTTP server and lets the guard build its own URL: a
  // path the route does not serve answers 405 and the guard now THROWS, so the
  // assertion below cannot pass on a URL that does not resolve.
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        // Route ONLY the shipped path — anything else is 405, exactly as Next
        // answers a method/path with no handler. This is what makes the guard's
        // URL construction the thing under test.
        const url = new URL(req.url ?? '/', 'http://localhost');
        const match = /^\/api\/work-items\/([^/]+)\/acceptance-evidence$/.exec(url.pathname);
        if (!match || req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'METHOD_NOT_ALLOWED' }));
          return;
        }
        const routeRes = await GET(
          new Request(`http://localhost${url.pathname}`, {
            method: 'GET',
            headers: Object.entries(req.headers).flatMap(([k, v]) =>
              typeof v === 'string' ? [[k, v] as [string, string]] : [],
            ),
          }),
          { params: Promise.resolve({ id: decodeURIComponent(match[1] ?? '') }) },
        );
        res.writeHead(routeRes.status, { 'content-type': 'application/json' });
        res.end(await routeRes.text());
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const sourceWith = (token: string): StatusSource => ({ baseUrl, token, authMode: 'bearer' });

  it('returns a NON-EMPTY approved set for an approved story, over real HTTP', async () => {
    await seedReceipt(story, 'approved');
    const approved = await fetchApprovedStories([story.identifier], sourceWith(await readToken()));
    expect([...approved]).toEqual([story.identifier]);
  });

  it('leaves an in-flight story OUT of the set — the lane keeps its legitimate member', async () => {
    await seedReceipt(story, 'pending');
    const approved = await fetchApprovedStories([story.identifier], sourceWith(await readToken()));
    expect([...approved]).toEqual([]);
  });

  it('THROWS when the guard asks a path the product does not serve', async () => {
    // The MOTIR-4144 defect, reproduced: point the guard one segment off and it
    // must go loud instead of concluding that nothing is approved. Before this
    // card, THIS is what every real call did.
    const token = await readToken();
    await expect(
      fetchApprovedStories([story.identifier], {
        baseUrl: `${baseUrl}/wrong-prefix`,
        token,
        authMode: 'bearer',
      }),
    ).rejects.toThrow(LaneGuardReadError);
  });

  it('reads the receipt the SERVICE recorded — the read and the write agree', async () => {
    // Not a seeded row this time: go through the service the publish path uses,
    // so the two halves of the seam are proven against each other rather than
    // against a fixture.
    await seedReceipt(story, 'pending');
    const ctx = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    const current = await acceptanceEvidenceService.getCurrentForStory(story.id, ctx);
    await acceptanceEvidenceService.setStatus(current!.id, 'approved', ctx);

    const approved = await fetchApprovedStories([story.identifier], sourceWith(await readToken()));
    expect([...approved]).toEqual([story.identifier]);
  });
});
