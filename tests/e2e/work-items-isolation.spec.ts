// E2E: work-item cross-project / cross-workspace isolation + dependency
// scenarios — the Story-closing spec of Story 1.4 (Subtask 1.4.8).
//
// @smoke. Proves Story 1.4's structural invariants hold end-to-end over real
// HTTP, across realistic multi-workspace / multi-project scenarios, by driving
// the data layer through the throwaway `app/api/_test/*` endpoints (Story 1.4
// ships NO production routes — those are Epic 2's territory; 1.4.8 establishes
// the `_test` pattern fresh, where 1.2.7 / 1.3.6 used the real routes those
// stories shipped).
//
// ─── DB-RESET AUDIT VERDICT (Subtask 1.4.8) ─────────────────────────────────
// `resetDatabase()` (tests/e2e/_helpers/db-reset.ts) truncates only the auth
// roots (user / workspace / session / account / verification). work_item,
// work_item_link, and work_item_revision all FK to workspace (+ user), so they
// CASCADE-truncate with those roots. Verified empirically AND locked by a
// regression test (tests/db-reset-cascade.test.ts). VERDICT: the cascade is
// sufficient — resetDatabase() needed NO change for the work-item tables.
//
// ─── ISOLATION MECHANISM (read this before editing an assertion) ────────────
// The dev/CI server connects as the `prodect` superuser, which has BYPASSRLS —
// so the work_item RLS policies (1.4.5) are INERT here. Cross-tenant isolation
// in these scenarios is enforced at the APPLICATION layer: the `_test` routes
// gate every read/mutation with an explicit workspaceId check
// (workItemsService.getWorkItem / getLink, projectsService.assertProjectInWorkspace)
// that returns 404 (NOT 403 — the no-existence-leak contract from 1.2.7) on a
// tenant miss. RLS remains the structural backstop, proven directly under the
// non-bypass prodect_app role in tests/work-item-rls.test.ts.
//
// Speed: uses Playwright's `request` fixture (no browser) — sign-up + every
// work-item op is a bare HTTP call. Auth via /api/auth/sign-up/email (the
// 1.2.7 / 1.3.6 credential path), one APIRequestContext per user so cookie
// jars don't cross.
//
// NOT covered here: production-build gating (NODE_ENV=production → 404). That's
// a unit-test concern (the E2E dev server runs in development, gate open) and
// lives in tests/_test-route-gating.test.ts.

import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, createProject, type ProjectRef, type TestUser } from './_helpers/work-item-setup';

// Contexts created via request.newContext() are NOT auto-disposed — track and
// dispose them per test so pg's pool doesn't accumulate connections.
const opened: APIRequestContext[] = [];

async function newUser(email: string): Promise<TestUser> {
  const user = await signUp(email);
  opened.push(user.ctx);
  return user;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterEach(async () => {
  await Promise.all(opened.map((c) => c.dispose()));
  opened.length = 0;
});

test.afterAll(async () => {
  // Release the worktree-side Prisma pool so the runner doesn't hang (mirrors
  // multi-tenant-isolation.spec.ts / project-isolation.spec.ts).
  await db.$disconnect();
});

// ── HTTP wrappers over the `_test` endpoints ─────────────────────────────────

const ITEMS = '/api/_test/work-items';
const LINKS = '/api/_test/work-item-links';

function createWorkItem(u: TestUser, body: Record<string, unknown>): Promise<APIResponse> {
  return u.ctx.post(ITEMS, { data: body });
}
function getWorkItem(u: TestUser, id: string, extra = ''): Promise<APIResponse> {
  return u.ctx.get(`${ITEMS}?id=${id}${extra}`);
}
function listWorkItems(u: TestUser, projectId: string): Promise<APIResponse> {
  return u.ctx.get(`${ITEMS}?projectId=${projectId}`);
}
function patchWorkItem(
  u: TestUser,
  id: string,
  body: Record<string, unknown>,
): Promise<APIResponse> {
  return u.ctx.patch(`${ITEMS}?id=${id}`, { data: body });
}
function archiveWorkItem(u: TestUser, id: string): Promise<APIResponse> {
  return u.ctx.delete(`${ITEMS}?id=${id}`);
}
function linkWorkItems(u: TestUser, body: Record<string, unknown>): Promise<APIResponse> {
  return u.ctx.post(LINKS, { data: body });
}
function unlink(u: TestUser, linkId: string): Promise<APIResponse> {
  return u.ctx.delete(`${LINKS}?id=${linkId}`);
}
function blockers(u: TestUser, workItemId: string): Promise<APIResponse> {
  return u.ctx.get(`${LINKS}?workItemId=${workItemId}&direction=blockers`);
}
function blocking(u: TestUser, workItemId: string): Promise<APIResponse> {
  return u.ctx.get(`${LINKS}?workItemId=${workItemId}&direction=blocking`);
}
function isReady(u: TestUser, workItemId: string): Promise<APIResponse> {
  return u.ctx.get(`${LINKS}?workItemId=${workItemId}&ready=1`);
}

/** POST a work item and return its id, asserting 201. */
async function createId(u: TestUser, body: Record<string, unknown>): Promise<string> {
  const res = await createWorkItem(u, body);
  expect(res.status(), `create ${JSON.stringify(body)} → 201`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

// ── Visibility within a workspace ────────────────────────────────────────────

test.describe('@smoke work-items: same-workspace visibility', () => {
  test('same-workspace, same-project: list returns exactly the items created in that project', async () => {
    const a = await newUser('wi-vis-a@example.com');
    const p1 = await createProject(a, 'Alpha', 'ALPHA');

    for (const title of ['One', 'Two', 'Three']) {
      await createId(a, { projectId: p1.id, kind: 'task', title });
    }

    const res = await listWorkItems(a, p1.id);
    expect(res.status()).toBe(200);
    const items = (await res.json()) as unknown[];
    expect(items.length).toBe(3);
  });

  test('same-workspace, sibling-project: each project list is narrowed to its own items', async () => {
    const a = await newUser('wi-sib-a@example.com');
    const p1 = await createProject(a, 'Proj One', 'P1ONE');
    const p2 = await createProject(a, 'Proj Two', 'P2TWO');

    for (const title of ['A', 'B', 'C']) {
      await createId(a, { projectId: p1.id, kind: 'task', title: `P1-${title}` });
      await createId(a, { projectId: p2.id, kind: 'task', title: `P2-${title}` });
    }

    const list1 = (await (await listWorkItems(a, p1.id)).json()) as unknown[];
    const list2 = (await (await listWorkItems(a, p2.id)).json()) as unknown[];
    expect(list1.length, 'P1 list shows only P1 items').toBe(3);
    expect(list2.length, 'P2 list shows only P2 items').toBe(3);
  });
});

// ── Cross-workspace / cross-project isolation (no existence leak) ────────────

test.describe('@smoke work-items: cross-tenant isolation returns 404 (not 403)', () => {
  async function twoTenants(): Promise<{
    a: TestUser;
    p1: ProjectRef;
    b: TestUser;
    p3: ProjectRef;
    bItemId: string;
  }> {
    const a = await newUser('wi-iso-a@example.com');
    const p1 = await createProject(a, 'A Project', 'AAA');
    const b = await newUser('wi-iso-b@example.com');
    const p3 = await createProject(b, 'B Project', 'BBB');
    const bItemId = await createId(b, { projectId: p3.id, kind: 'epic', title: "B's secret" });
    return { a, p1, b, p3, bItemId };
  }

  test('cross-workspace GET by id is 404 (indistinguishable from never-existed)', async () => {
    const { a, b, bItemId } = await twoTenants();
    const res = await getWorkItem(a, bItemId);
    expect(res.status(), 'A reading B item by exact id must be 404, never 403').toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('NOT_FOUND');
    // Sanity: the owner CAN read it (proves the 404 is tenancy-gated, not broken).
    expect((await getWorkItem(b, bItemId)).status()).toBe(200);
  });

  test('cross-workspace PATCH by id is 404 and does not mutate', async () => {
    const { a, b, bItemId } = await twoTenants();
    const res = await patchWorkItem(a, bItemId, { title: 'hijacked by A' });
    expect(res.status()).toBe(404);
    const owner = (await (await getWorkItem(b, bItemId)).json()) as { title: string };
    expect(owner.title, "B's title must be untouched").toBe("B's secret");
  });

  test('create with a foreign projectId is 404 (project not in active workspace)', async () => {
    const { a, p3 } = await twoTenants();
    const res = await createWorkItem(a, { projectId: p3.id, kind: 'task', title: 'smuggled' });
    expect(res.status(), 'A creating in B project must 404 before the row is written').toBe(404);
  });
});

// ── Tree shape ───────────────────────────────────────────────────────────────

test.describe('@smoke work-items: tree query + archive', () => {
  test('subtree query returns the full 3-level chain with correct depths', async () => {
    const a = await newUser('wi-tree-a@example.com');
    const p1 = await createProject(a, 'Tree', 'TREE');

    const epicId = await createId(a, { projectId: p1.id, kind: 'epic', title: 'Epic' });
    const storyId = await createId(a, {
      projectId: p1.id,
      kind: 'story',
      title: 'Story',
      parentId: epicId,
    });
    const subtaskId = await createId(a, {
      projectId: p1.id,
      kind: 'subtask',
      title: 'Subtask',
      parentId: storyId,
    });

    const res = await getWorkItem(a, epicId, '&subtree=1');
    expect(res.status()).toBe(200);
    const rows = (await res.json()) as Array<{ id: string; depth: number }>;
    expect(rows.length, 'epic + story + subtask').toBe(3);
    const byId = new Map(rows.map((r) => [r.id, r.depth]));
    expect(byId.get(epicId)).toBe(1);
    expect(byId.get(storyId)).toBe(2);
    expect(byId.get(subtaskId)).toBe(3);
  });

  test('archiving the epic does NOT cascade — its child stays visible (Linear shape)', async () => {
    const a = await newUser('wi-arch-a@example.com');
    const p1 = await createProject(a, 'Arch', 'ARCH');

    const epicId = await createId(a, { projectId: p1.id, kind: 'epic', title: 'Epic' });
    const storyId = await createId(a, {
      projectId: p1.id,
      kind: 'story',
      title: 'Story',
      parentId: epicId,
    });

    expect((await archiveWorkItem(a, epicId)).status()).toBe(204);

    const list = (await (await listWorkItems(a, p1.id)).json()) as Array<{ id: string }>;
    const ids = list.map((r) => r.id);
    expect(ids, 'archived epic drops out of the active list').not.toContain(epicId);
    expect(ids, 'the child survives the parent archive').toContain(storyId);
  });
});

// ── Revision feed isolation ──────────────────────────────────────────────────

test.describe('@smoke work-items: revision feed isolation', () => {
  test('owner sees the diff; another workspace gets 404 on the same item', async () => {
    const a = await newUser('wi-rev-a@example.com');
    const p1 = await createProject(a, 'Rev', 'REVA');
    const b = await newUser('wi-rev-b@example.com');

    const itemId = await createId(a, { projectId: p1.id, kind: 'task', title: 'Original' });
    expect((await patchWorkItem(a, itemId, { title: 'Renamed' })).status()).toBe(200);

    const feed = (await (await getWorkItem(a, itemId, '&revisions=1')).json()) as Array<{
      changeKind: string;
      diff: Record<string, { from: unknown; to: unknown }>;
    }>;
    expect(feed.length, 'created + updated').toBe(2);
    expect(feed[0]!.changeKind).toBe('updated');
    expect(feed[0]!.diff.title).toMatchObject({ from: 'Original', to: 'Renamed' });
    expect(feed[1]!.changeKind).toBe('created');

    // B cannot read A's revision feed.
    expect((await getWorkItem(b, itemId, '&revisions=1')).status()).toBe(404);
  });
});

// ── Dependencies ─────────────────────────────────────────────────────────────

test.describe('@smoke work-items: dependency / ready-set', () => {
  test('is_blocked_by: blockers/blocking/isReady transition through a terminal status + unlink', async () => {
    const a = await newUser('wi-dep-a@example.com');
    const p1 = await createProject(a, 'Dep', 'DEPP');

    const x = await createId(a, { projectId: p1.id, kind: 'task', title: 'X' });
    const y = await createId(a, { projectId: p1.id, kind: 'task', title: 'Y' });
    const z = await createId(a, { projectId: p1.id, kind: 'task', title: 'Z' });

    const linkXY = await linkWorkItems(a, { fromId: x, toId: y, kind: 'is_blocked_by' });
    expect(linkXY.status()).toBe(201);
    const linkXYId = ((await linkXY.json()) as { id: string }).id;
    expect((await linkWorkItems(a, { fromId: x, toId: z, kind: 'is_blocked_by' })).status()).toBe(
      201,
    );

    // getBlockers(X) → [Y, Z] (sorted by key asc — Y created before Z).
    const xBlockers = (await (await blockers(a, x)).json()) as Array<{ id: string }>;
    expect(xBlockers.map((r) => r.id)).toEqual([y, z]);

    // getBlocking(Y) → [X].
    const yBlocking = (await (await blocking(a, y)).json()) as Array<{ id: string }>;
    expect(yBlocking.map((r) => r.id)).toEqual([x]);

    const ready = async (): Promise<boolean> =>
      ((await (await isReady(a, x)).json()) as { ready: boolean }).ready;

    // Resolve blockers via the GATED status path (2.3.6/finding #46: status is
    // no longer a free-form body patch). `todo → cancelled` is a legal default
    // transition, and `cancelled` is category=done → it resolves the block.
    const resolve = (id: string) => a.ctx.patch(`${ITEMS}?id=${id}&status=cancelled`);
    expect(await ready(), 'X blocked by two open items').toBe(false);
    expect((await resolve(y)).status()).toBe(200);
    expect(await ready(), 'Z still open → X still blocked').toBe(false);
    expect((await resolve(z)).status()).toBe(200);
    expect(await ready(), 'both blockers terminal → X ready').toBe(true);

    // Unlink X→Y; only Z remains (already terminal) → X stays ready.
    expect((await unlink(a, linkXYId)).status()).toBe(204);
    expect(await ready(), 'only Z remains, and Z is terminal').toBe(true);
    const afterUnlink = (await (await blockers(a, x)).json()) as Array<{ id: string }>;
    expect(afterUnlink.map((r) => r.id)).toEqual([z]);
  });

  test('cross-project dependency: link across sibling projects in one workspace; B cannot see it', async () => {
    const a = await newUser('wi-xdep-a@example.com');
    const p1 = await createProject(a, 'XP One', 'XPONE');
    const p2 = await createProject(a, 'XP Two', 'XPTWO');
    const b = await newUser('wi-xdep-b@example.com');

    const x = await createId(a, { projectId: p1.id, kind: 'task', title: 'X in P1' });
    const y = await createId(a, { projectId: p2.id, kind: 'task', title: 'Y in P2' });

    // Cross-project link inside one workspace is allowed (link table is
    // workspace-scoped, not project-narrowed).
    expect((await linkWorkItems(a, { fromId: x, toId: y, kind: 'is_blocked_by' })).status()).toBe(
      201,
    );

    const xBlockers = (await (await blockers(a, x)).json()) as Array<{ id: string }>;
    expect(
      xBlockers.map((r) => r.id),
      'blockers span projects',
    ).toEqual([y]);

    // B (workspace W2) cannot reach X at all → cannot observe the link.
    expect((await blockers(b, x)).status()).toBe(404);
  });

  test('link cycle prevention: reverse is_blocked_by is 409 with WI_LINK_CYCLE', async () => {
    const a = await newUser('wi-cyc-a@example.com');
    const p1 = await createProject(a, 'Cycle', 'CYCLE');

    const x = await createId(a, { projectId: p1.id, kind: 'task', title: 'X' });
    const y = await createId(a, { projectId: p1.id, kind: 'task', title: 'Y' });

    expect((await linkWorkItems(a, { fromId: x, toId: y, kind: 'is_blocked_by' })).status()).toBe(
      201,
    );
    const res = await linkWorkItems(a, { fromId: y, toId: x, kind: 'is_blocked_by' });
    expect(res.status(), 'a 2-cycle must be rejected').toBe(409);
    const text = await res.text();
    expect(text, 'cycle response carries the WI_LINK_CYCLE marker').toContain('WI_LINK_CYCLE');
  });

  test('symmetric relates_to: writes both directions; never appears in blockers', async () => {
    const a = await newUser('wi-rel-a@example.com');
    const p1 = await createProject(a, 'Rel', 'RELAT');

    const x = await createId(a, { projectId: p1.id, kind: 'task', title: 'X' });
    const y = await createId(a, { projectId: p1.id, kind: 'task', title: 'Y' });

    expect((await linkWorkItems(a, { fromId: x, toId: y, kind: 'relates_to' })).status()).toBe(201);

    // relates_to is a non-blocking edge: it never surfaces in the blocker queries.
    expect(((await (await blockers(a, x)).json()) as unknown[]).length).toBe(0);
    expect(((await (await blockers(a, y)).json()) as unknown[]).length).toBe(0);
    expect(((await (await blocking(a, x)).json()) as unknown[]).length).toBe(0);

    // One logical link, two row writes (the service persists the reciprocal):
    // the relation surfaces symmetrically from both endpoints. The DTO doesn't
    // carry related-issue links (Epic 2's detail view will), so the data-layer
    // truth is the two reciprocal rows — assert them directly.
    const forward = await db.workItemLink.findFirst({
      where: { fromId: x, toId: y, kind: 'relates_to' },
    });
    const reverse = await db.workItemLink.findFirst({
      where: { fromId: y, toId: x, kind: 'relates_to' },
    });
    expect(forward, 'X → Y relates_to row').not.toBeNull();
    expect(reverse, 'reciprocal Y → X relates_to row').not.toBeNull();
  });
});

// ── explanationSource state machine over HTTP ────────────────────────────────

test.describe('@smoke work-items: explanationSource state machine', () => {
  test('user_authored → ai_draft (explicit) → user_edited (auto), with a 3-row revision feed', async () => {
    const a = await newUser('wi-exp-a@example.com');
    const p1 = await createProject(a, 'Explain', 'EXPLN');

    const id = await createId(a, { projectId: p1.id, kind: 'epic', title: 'Q3 launch' });

    // Fresh create: no explanation, source defaults to user_authored.
    let dto = (await (await getWorkItem(a, id)).json()) as {
      explanationMd: string | null;
      explanationSource: string;
    };
    expect(dto.explanationMd).toBeNull();
    expect(dto.explanationSource).toBe('user_authored');

    // Simulate Epic 7's AI-drafting endpoint: explicit ai_draft.
    expect(
      (
        await patchWorkItem(a, id, {
          explanationMd: '## Why this matters\n\nThis launch…',
          explanationSource: 'ai_draft',
        })
      ).status(),
    ).toBe(200);
    dto = (await (await getWorkItem(a, id)).json()) as typeof dto;
    expect(dto.explanationMd).toContain('Why this matters');
    expect(dto.explanationSource).toBe('ai_draft');

    // Edit the explanation WITHOUT an explicit source → auto-transition to
    // user_edited (the state machine fires through the HTTP boundary).
    expect(
      (await patchWorkItem(a, id, { explanationMd: '## Updated\n\nEdited by the user.' })).status(),
    ).toBe(200);
    dto = (await (await getWorkItem(a, id)).json()) as typeof dto;
    expect(dto.explanationSource, 'editing an ai_draft auto-promotes to user_edited').toBe(
      'user_edited',
    );

    // Revision feed: created, then two updates (newest-first).
    const feed = (await (await getWorkItem(a, id, '&revisions=1')).json()) as Array<{
      changeKind: string;
      diff: Record<string, { from: unknown; to: unknown }>;
    }>;
    expect(feed.length, 'created + 2 updates').toBe(3);
    expect(feed[2]!.changeKind, 'oldest is the create').toBe('created');
    expect(
      feed[0]!.diff.explanationSource,
      'newest update records the ai_draft → user_edited transition',
    ).toMatchObject({ from: 'ai_draft', to: 'user_edited' });
  });
});

// ── Markdown render stack ────────────────────────────────────────────────────

test.describe('@smoke work-items: Markdown render smoke', () => {
  test('render strips <script>, renders the GFM table, and highlights the code block', async () => {
    const a = await newUser('wi-md-a@example.com');
    const p1 = await createProject(a, 'Markdown', 'MDREN');

    const descriptionMd = [
      '# Heading',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      "<script>alert('xss')</script>",
      '',
      '```js',
      'const x = 42;',
      '```',
      '',
    ].join('\n');

    const id = await createId(a, {
      projectId: p1.id,
      kind: 'task',
      title: 'Rich text',
      descriptionMd,
    });

    const res = await getWorkItem(a, id, '&render=1');
    expect(res.status()).toBe(200);
    const html = ((await res.json()) as { descriptionHtml: string }).descriptionHtml;

    expect(html, 'GFM table rendered').toContain('<table>');
    expect(html, 'code block syntax-highlighted (hljs markup)').toContain('hljs');
    expect(html.toLowerCase(), 'rehype-sanitize stripped the <script> tag').not.toContain(
      '<script',
    );
    expect(html, 'the inline script payload is gone').not.toContain('alert');
  });
});
