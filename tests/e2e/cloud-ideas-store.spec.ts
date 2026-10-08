import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { PlatformRole } from '@/generated/prisma/client';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { makeWorkItemFixture } from '@/tests/fixtures/workItemFixtures';
import { createTestWorkspace } from '@/tests/fixtures/workspaceFixtures';
import { applyIdeaSeed } from '@/tests/ideas/_helpers';
import { adminDb, resetDatabase } from './_helpers/db-reset';

/**
 * THE IDEA STORE, END TO END (Story MOTIR-7662 · MOTIR-7678) — the two walks its
 * consumers will take against the running app: the `motir-ideas` skill writing
 * over `/api/platform/ideas` with a staff member's personal access token, and
 * motir.co reading `/api/public/ideas` anonymously while ideas appear, change and
 * disappear. The story has no screen, so this drives HTTP, not a browser, and
 * records no acceptance video.
 *
 * ⚠️ IN THE CLOUD LANE ON PURPOSE. `/api/public/**` is a cloud-only capability
 * (`lib/publicProjects/cloudGate.ts`): off-cloud every public route answers 404,
 * so the anonymous half of this walk does not exist in the main lane.
 *
 * Every wait is on the response itself — its status and its body. Nothing here
 * sleeps.
 */

test.describe.configure({ timeout: 120_000 });

const CACHE = 'public, s-maxage=300, stale-while-revalidate=3300';

let seq = 0;

/** A PAT whose owner holds `role` (null: a tenant user). */
async function tokenFor(role: PlatformRole | null): Promise<string> {
  const { owner, workspace } = await createTestWorkspace({ name: `Ideas E2E ${++seq}` });
  if (role) await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: role } });
  const { token } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-ideas',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  });
  return token;
}

/** A RUN token dispatched by a superadmin — refused anyway. */
async function runTokenOfSuperadmin(): Promise<string> {
  const fixture = await makeWorkItemFixture({ name: 'Ideas E2E run' });
  await adminDb.user.update({
    where: { id: fixture.owner.id },
    data: { platformRole: 'superadmin' },
  });
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title: 'a hosted card' },
    fixture.ctx,
  );
  const opened = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      origin: 'hosted',
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    fixture.ctx,
  );
  const minted = await runCredentialService.mintRunCredential({
    dispatchRunId: opened.run.id,
    dispatcherUserId: fixture.owner.id,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return minted.token;
}

const bearer = (token: string | null): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

async function body<T = Record<string, unknown>>(res: APIResponse): Promise<T> {
  return (await res.json()) as T;
}

async function publicSlugs(request: APIRequestContext, qs = ''): Promise<string[]> {
  const res = await request.get(`/api/public/ideas${qs}`);
  expect(res.status()).toBe(200);
  return (await body<{ items: { slug: string }[] }>(res)).items.map((i) => i.slug);
}

function direction(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    title: `Direction ${slug}`,
    pitch: `The pitch of ${slug}.`,
    kind: 'direction',
    category: 'logistics',
    tags: ['smb'],
    evidence: [
      {
        claim: 'A sourced claim.',
        sourceName: 'A source, October 2026',
        url: 'https://example.com/source',
        sourceDate: '2026-10-01',
      },
    ],
    gap: 'Nobody serves it yet.',
    ...extra,
  };
}

test.beforeEach(async () => {
  await resetDatabase();
  await applyIdeaSeed();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test('an anonymous reader sees the 15 seeded ideas, filtered and cacheable', async ({
  request,
}) => {
  // The seed is the premise of everything below, so it is asserted first.
  const list = await request.get('/api/public/ideas');
  expect(list.status()).toBe(200);
  expect(list.headers()['cache-control']).toBe(CACHE);
  const all = await body<{ total: number; items: { kind: string }[] }>(list);
  expect(all.total).toBe(15);

  expect(await publicSlugs(request, '?category=ecommerce')).toHaveLength(2);
  expect(await publicSlugs(request, '?kind=motir_buys')).toHaveLength(6);

  const tags = await request.get('/api/public/ideas/tags');
  expect(tags.status()).toBe(200);
  expect((await body<{ tags: unknown[] }>(tags)).tags.length).toBeGreaterThanOrEqual(10);

  const one = await request.get('/api/public/ideas/a-care-team-app-for-families');
  expect(one.status()).toBe(200);
  expect(one.headers()['cache-control']).toBe(CACHE);
  expect(await body(one)).toMatchObject({
    slug: 'a-care-team-app-for-families',
    category: { slug: 'family_care' },
  });
  expect(await body(one)).not.toHaveProperty('status');

  expect((await request.get('/api/public/ideas?category=astrology')).status()).toBe(400);
});

test('a staff token adds, edits and retires ideas while the public list follows', async ({
  request,
}) => {
  const operator = await tokenFor('operator');
  const superadmin = await tokenFor('superadmin');

  // ── Add two: both appear on the anonymous list.
  const added = await request.post('/api/platform/ideas', {
    headers: bearer(operator),
    data: { reason: 'E2E research run', ideas: [direction('e2e-one'), direction('e2e-two')] },
  });
  expect(added.status()).toBe(201);
  expect(await body(added)).toEqual({ slugs: ['e2e-one', 'e2e-two'] });
  expect(await publicSlugs(request, '?category=logistics')).toEqual(
    expect.arrayContaining(['e2e-one', 'e2e-two']),
  );

  // ── A duplicate slug is refused, naming it.
  const dup = await request.post('/api/platform/ideas', {
    headers: bearer(operator),
    data: { ideas: [direction('e2e-one')] },
  });
  expect(dup.status()).toBe(409);
  expect(await body(dup)).toEqual({ code: 'IDEA_SLUG_TAKEN', slugs: ['e2e-one'] });

  // ── Edit one: the change shows publicly.
  const patched = await request.patch('/api/platform/ideas/e2e-one', {
    headers: bearer(operator),
    data: { pitch: 'A sharper pitch.' },
  });
  expect(patched.status()).toBe(200);
  const read = await request.get('/api/public/ideas/e2e-one');
  expect((await body<{ pitch: string }>(read)).pitch).toBe('A sharper pitch.');

  // ── Retire it: gone publicly, present (retired) to staff; a second retire is refused.
  const retired = await request.post('/api/platform/ideas/e2e-one/retire', {
    headers: bearer(operator),
    data: { reason: 'A funded company now serves it.' },
  });
  expect(retired.status()).toBe(200);
  expect(await publicSlugs(request, '?category=logistics')).toEqual(['e2e-two']);
  expect((await request.get('/api/public/ideas/e2e-one')).status()).toBe(404);
  const staffList = await request.get('/api/platform/ideas?status=retired', {
    headers: bearer(operator),
  });
  expect(staffList.status()).toBe(200);
  expect(staffList.headers()['cache-control']).toBe('no-store');
  expect(
    (await body<{ items: { slug: string; retiredReason: string }[] }>(staffList)).items,
  ).toEqual([
    expect.objectContaining({ slug: 'e2e-one', retiredReason: 'A funded company now serves it.' }),
  ]);
  const again = await request.post('/api/platform/ideas/e2e-one/retire', {
    headers: bearer(operator),
    data: { reason: 'Twice.' },
  });
  expect(again.status()).toBe(409);
  expect(await body(again)).toEqual({ code: 'IDEA_NOT_ACTIVE' });

  // ── Delete: an operator gets the gate's 404; a superadmin removes it everywhere.
  const refused = await request.delete('/api/platform/ideas/e2e-two', {
    headers: bearer(operator),
    data: { reason: 'Cleanup' },
  });
  expect(refused.status()).toBe(404);
  expect(await publicSlugs(request, '?category=logistics')).toEqual(['e2e-two']);
  const deleted = await request.delete('/api/platform/ideas/e2e-two', {
    headers: bearer(superadmin),
    data: { reason: 'Cleanup' },
  });
  expect(deleted.status()).toBe(200);
  expect(await publicSlugs(request, '?category=logistics')).toEqual([]);
  expect(
    (await request.get('/api/platform/ideas/e2e-two', { headers: bearer(superadmin) })).status(),
  ).toBe(404);

  // ── The research-run log.
  const run = await request.post('/api/platform/ideas/runs', {
    headers: bearer(operator),
    data: { areasCovered: ['logistics'], addedCount: 2, retiredCount: 1, reportMd: '# E2E run' },
  });
  expect(run.status()).toBe(201);
  const runs = await request.get('/api/platform/ideas/runs', { headers: bearer(operator) });
  expect(await body<unknown[]>(runs)).toEqual([
    expect.objectContaining({ areasCovered: ['logistics'], addedCount: 2, retiredCount: 1 }),
  ]);
});

test('every other credential gets the same 404, and the token opens nothing else', async ({
  request,
}) => {
  const tenant = await tokenFor(null);
  const runToken = await runTokenOfSuperadmin();
  const operator = await tokenFor('operator');

  const probes: [string, string, unknown?][] = [
    ['GET', '/api/platform/ideas'],
    ['POST', '/api/platform/ideas', { ideas: [direction('never')] }],
    ['GET', '/api/platform/ideas/a-care-team-app-for-families'],
    ['PATCH', '/api/platform/ideas/a-care-team-app-for-families', { pitch: 'x' }],
    ['DELETE', '/api/platform/ideas/a-care-team-app-for-families', { reason: 'x' }],
    ['POST', '/api/platform/ideas/a-care-team-app-for-families/retire', { reason: 'x' }],
    ['GET', '/api/platform/ideas/tags'],
    ['POST', '/api/platform/ideas/tags', { slug: 'x', label: 'X', description: 'x' }],
    ['GET', '/api/platform/ideas/runs'],
    [
      'POST',
      '/api/platform/ideas/runs',
      { areasCovered: [], addedCount: 0, retiredCount: 0, reportMd: 'x' },
    ],
  ];
  for (const token of [tenant, runToken, null]) {
    for (const [method, url, data] of probes) {
      const res = await request.fetch(url, { method, headers: bearer(token), data });
      expect({ method, url, status: res.status() }).toEqual({ method, url, status: 404 });
      expect(await body(res)).toEqual({ code: 'NOT_FOUND' });
    }
  }
  // Nothing was written by any of them.
  expect(await adminDb.idea.count()).toBe(15);
  expect(await adminDb.ideaResearchRun.count()).toBe(0);

  // The operator's token is a credential for the ideas endpoints ONLY: an
  // existing console page answers it as the ordinary 404.
  const consolePage = await request.get('/admin/audit-log', { headers: bearer(operator) });
  expect(consolePage.status()).toBe(404);
});
