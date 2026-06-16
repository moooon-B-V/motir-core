// E2E: Story 6.14 — EPIC-LEVEL PRIVACY on a public project (Subtask 6.14.9).
// The full privacy loop in a real browser, across two sessions, proving the
// 6.14.4 server-side hiding + the 6.14.5 tree placeholder + the 6.14.6 detail
// child-panel placeholder + the member-bypass + the 6.14.7 admin toggle, end to
// end, with a SECOND Motir account in a DIFFERENT org (the 6.12 cross-org public
// viewer):
//
//   1. the project admin flips the project PUBLIC (6.12.8), then marks an epic
//      that HAS children PRIVATE via the 6.14.7 control on the issue detail page;
//   2. a SECOND account in a DIFFERENT org (no membership) browses the public
//      surface: the private epic ROW shows with a "Not public" badge and NO
//      child count; expanding it in the TREE renders the "this epic is not
//      public" placeholder instead of children; its DETAIL page shows the same
//      statement in the CHILD PANEL (and "Hidden" rollups); the children are
//      absent from the BOARD and from the public items LIST *payload* (not just
//      the DOM);
//   3. the admin (a project MEMBER) sees the SAME epic's children normally —
//      the tree-expand lists them, the detail child-panel lists them, and the
//      member items-LIST payload contains them;
//   4. the admin UNSETS privacy → the public viewer (re-loaded) now sees the
//      children too, proving the toggle drives enforcement LIVE.
//
// Division of labour (mirrors public-project-flow.spec.ts): the integration /
// vitest suite (6.14.8) pins the access + projection matrix and the
// admin-ONLY permission gate at the service layer; this file owns the thing only
// a browser proves — the real toggle, the rendered placeholders, the member
// bypass, and the cross-surface exclusion, with a second browser context for the
// second account, asserting on the network PAYLOAD (not just the DOM).
//
// "Search for a child's title" (the card's step 3) maps, against shipped
// reality, to the public items-LIST endpoint: there is no per-project public
// free-text work-item search surface (the only public search is the cross-org
// /explore project directory). The items list is the flat, server-projected
// listing of every public-safe work item, so asserting a child is absent from
// its payload IS the "a search never surfaces it" guarantee.
//
// Per the E2E discipline (CLAUDE.md): every mutation (set-access / set-private)
// is awaited on its endpoint's response BEFORE asserting the persisted effect,
// and each surface is re-navigated fresh (a full server read) rather than
// leaning on an optimistic island's state.

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const ADMIN_EMAIL = 'e2e-epic-privacy-admin@example.com';
const CROSS_EMAIL = 'e2e-epic-privacy-crossorg@example.com';
const PUBLIC_KEY = 'EPV';

const EPIC_TITLE = 'Billing & invoicing';
const CHILD_A = 'Stripe webhook ingestion';
const CHILD_B = 'Invoice PDF export';
// A top-level, NON-epic-child control item — always public, proving the
// exclusion is targeted at the private epic's subtree and the surfaces still
// render their other content.
const PUBLIC_CONTROL = 'Public marketing site';

// The public copy (messages/en.json › publicProjects / issueViews).
const NOT_PUBLIC_TITLE = 'This epic is not public';
const NOT_PUBLIC_BADGE = 'Not public';
const PRIVACY_LABEL = 'Make this epic private';
const PRIVACY_ON_HELPER = 'Non-members now see only this epic’s row — its contents are hidden.';

interface AdminSeed {
  ctx: ServiceContext;
  publicProjectId: string;
  epic: { id: string; identifier: string };
  childA: { id: string; identifier: string };
  childB: { id: string; identifier: string };
  control: { id: string; identifier: string };
}

/** Sign the admin up through the real UI (auto-workspace), then create — server
 *  side — a public project (left at the default `open`; flipped public via the
 *  UI in the test) holding an EPIC with two children + a standalone control
 *  item. Pins the public project active so the project-scoped routes
 *  (/settings/project, /issues/[key]) resolve it. */
async function seedAdmin(page: Page): Promise<AdminSeed> {
  await signUp(page, ADMIN_EMAIL);
  const local = ADMIN_EMAIL.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email: ADMIN_EMAIL } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'admin exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const ctx: ServiceContext = { userId: user!.id, workspaceId: ws!.id };

  const publicProject = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Public Portal',
    identifier: PUBLIC_KEY,
  });

  // An EPIC with two task children (epic → task is a legal kind-parent edge),
  // plus a standalone public control item.
  const epic = await workItemsService.createWorkItem(
    { projectId: publicProject.id, kind: 'epic', title: EPIC_TITLE, parentId: null },
    ctx,
  );
  const childA = await workItemsService.createWorkItem(
    { projectId: publicProject.id, kind: 'task', title: CHILD_A, parentId: epic.id },
    ctx,
  );
  const childB = await workItemsService.createWorkItem(
    { projectId: publicProject.id, kind: 'task', title: CHILD_B, parentId: epic.id },
    ctx,
  );
  const control = await workItemsService.createWorkItem(
    { projectId: publicProject.id, kind: 'task', title: PUBLIC_CONTROL, parentId: null },
    ctx,
  );

  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: publicProject.id },
  });

  return {
    ctx,
    publicProjectId: publicProject.id,
    epic: { id: epic.id, identifier: epic.identifier },
    childA: { id: childA.id, identifier: childA.identifier },
    childB: { id: childB.id, identifier: childB.identifier },
    control: { id: control.id, identifier: control.identifier },
  };
}

/** The identifiers present in the public items-LIST payload (paged through to
 *  the end), read through a given context's cookie jar (anon/cross → no session;
 *  the admin page → its member session). The flat list is the closest public
 *  surface to a "search across all items". */
async function listItemIdentifiers(request: APIRequestContext): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const url = `/api/public/p/${PUBLIC_KEY}/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await request.get(url);
    expect(res.status(), 'public items list is 200').toBe(200);
    const body = (await res.json()) as {
      items: { identifier: string }[];
      nextCursor: string | null;
    };
    for (const it of body.items) ids.add(it.identifier);
    cursor = body.nextCursor;
  } while (cursor);
  return ids;
}

test('@smoke epic privacy: admin makes a project public + an epic private, a cross-org viewer sees the "not public" placeholder (tree + detail) and the children are gone from board/list payload, a member still sees them, and unsetting reveals them live', async ({
  page,
  browser,
}) => {
  const seed = await seedAdmin(page);

  // ── 1a. admin flips the project PUBLIC (6.12.8) ─────────────────────────────
  await page.goto('/settings/project/members');
  const accessGroup = page.getByRole('radiogroup', { name: 'Project access level' });
  await expect(accessGroup).toBeVisible({ timeout: 30_000 });
  const accessSaved = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/projects/${PUBLIC_KEY}/access` &&
      r.request().method() === 'PATCH',
  );
  await accessGroup.getByRole('radio', { name: /^Public/ }).click();
  expect((await accessSaved).status(), 'set-access → public returns 200').toBe(200);

  // ── 1b. admin marks the epic PRIVATE via the 6.14.7 control ─────────────────
  await page.goto(`/issues/${seed.epic.identifier}`);
  // The privacy control renders its label as adjacent text + the shared Switch
  // primitive; that primitive drops `aria-labelledby`, so the switch has no
  // accessible NAME (a shipped a11y defect, logged as a bug — not in scope here).
  // The issue-detail page has exactly one switch, so select by role alone, and
  // anchor on the control's visible label so a future second switch fails loudly.
  await expect(page.getByText(PRIVACY_LABEL, { exact: true })).toBeVisible({ timeout: 30_000 });
  const privacySwitch = page.getByRole('switch');
  await expect(privacySwitch).toBeVisible({ timeout: 30_000 });
  // The control is project-admin-gated; the admin is an admin → it's enabled.
  // (The non-admin 403 gate is pinned by the 6.14.8 service-layer matrix.)
  await expect(privacySwitch).toBeEnabled();
  await expect(privacySwitch).toHaveAttribute('aria-checked', 'false');
  const madePrivate = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/epic-privacy$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'PATCH',
  );
  await privacySwitch.click();
  expect((await madePrivate).status(), 'set-private returns 200').toBe(200);
  await expect(privacySwitch).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(PRIVACY_ON_HELPER)).toBeVisible();

  // ── 2. a SECOND account in a DIFFERENT org browses the public surface ───────
  const crossCtx = await browser.newContext();
  const cross = await crossCtx.newPage();
  await signUp(cross, CROSS_EMAIL); // fresh user → its OWN org/workspace, no membership

  // 2a. TREE — the private epic row shows with the "Not public" badge and no
  //     children; expanding it renders the placeholder, NOT a child list.
  await cross.goto(`/p/${PUBLIC_KEY}/tree`);
  const epicRow = cross.getByTestId(`public-tree-row-${seed.epic.identifier}`);
  await expect(epicRow).toBeVisible({ timeout: 30_000 });
  await expect(epicRow.getByText(NOT_PUBLIC_BADGE, { exact: true })).toBeVisible();
  // The child rows are not in the tree at all for the non-member.
  await expect(cross.getByTestId(`public-tree-row-${seed.childA.identifier}`)).toHaveCount(0);
  await expect(cross.getByTestId(`public-tree-row-${seed.childB.identifier}`)).toHaveCount(0);
  // Expand the epic → the synthetic "not public" placeholder (no fetch).
  await epicRow.getByRole('button', { name: 'Expand row' }).click();
  await expect(cross.getByText(NOT_PUBLIC_TITLE, { exact: true })).toBeVisible();
  await expect(cross.getByTestId(`public-tree-row-${seed.childA.identifier}`)).toHaveCount(0);

  // 2b. DETAIL child-panel — the same "not public" statement instead of the
  //     child list; the sidebar rollups read "Hidden"; no child link renders.
  await cross.goto(`/p/${PUBLIC_KEY}/items/${seed.epic.identifier}`);
  await expect(cross.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible({
    timeout: 30_000,
  });
  await expect(cross.getByText(NOT_PUBLIC_BADGE, { exact: true })).toBeVisible(); // header badge
  await expect(cross.getByText(NOT_PUBLIC_TITLE, { exact: true })).toBeVisible(); // child-panel placeholder
  await expect(cross.getByText('Hidden', { exact: true }).first()).toBeVisible(); // sidebar rollup
  await expect(cross.getByRole('link', { name: new RegExp(CHILD_A) })).toHaveCount(0);

  // 2c. BOARD — the child cards are absent; the standalone control item renders
  //     (so the board itself works; only the private subtree is excluded).
  await cross.goto(`/p/${PUBLIC_KEY}/board`);
  await expect(cross.getByText(PUBLIC_CONTROL).first()).toBeVisible({ timeout: 30_000 });
  await expect(cross.getByText(CHILD_A)).toHaveCount(0);
  await expect(cross.getByText(CHILD_B)).toHaveCount(0);

  // 2d. PAYLOAD ("search"/list) — the children are absent from the response
  //     BODY for the cross-org viewer, not merely the rendered DOM.
  const crossIds = await listItemIdentifiers(cross.request);
  expect(crossIds.has(seed.epic.identifier), 'private epic row is still public').toBe(true);
  expect(crossIds.has(seed.control.identifier), 'control item is public').toBe(true);
  expect(crossIds.has(seed.childA.identifier), 'child A absent from public payload').toBe(false);
  expect(crossIds.has(seed.childB.identifier), 'child B absent from public payload').toBe(false);

  // ── 3. a project MEMBER (the admin) sees the SAME epic's children normally ──
  // 3a. DETAIL child-panel lists the children (SSR'd initialChildren), no
  //     placeholder.
  await page.goto(`/p/${PUBLIC_KEY}/items/${seed.epic.identifier}`);
  await expect(page.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(NOT_PUBLIC_TITLE, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: new RegExp(CHILD_A) })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(CHILD_B) })).toBeVisible();

  // 3b. TREE-expand lists the real children for the member.
  await page.goto(`/p/${PUBLIC_KEY}/tree`);
  const memberEpicRow = page.getByTestId(`public-tree-row-${seed.epic.identifier}`);
  await expect(memberEpicRow).toBeVisible({ timeout: 30_000 });
  // The member's expand triggers a real child-level fetch — wait on it.
  const childLevel = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/public/p/${PUBLIC_KEY}/tree`) &&
      r.url().includes(`parentId=${seed.epic.id}`) &&
      r.request().method() === 'GET',
  );
  await memberEpicRow.getByRole('button', { name: 'Expand row' }).click();
  await childLevel;
  await expect(page.getByTestId(`public-tree-row-${seed.childA.identifier}`)).toBeVisible();

  // 3c. The member items-LIST payload CONTAINS the children.
  const memberIds = await listItemIdentifiers(page.request);
  expect(memberIds.has(seed.childA.identifier), 'member payload includes child A').toBe(true);
  expect(memberIds.has(seed.childB.identifier), 'member payload includes child B').toBe(true);

  // ── 4. admin UNSETS privacy → the public viewer now sees the children LIVE ──
  await page.goto(`/issues/${seed.epic.identifier}`);
  const switchAgain = page.getByRole('switch');
  await expect(switchAgain).toHaveAttribute('aria-checked', 'true');
  const madePublic = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/epic-privacy$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'PATCH',
  );
  await switchAgain.click();
  expect((await madePublic).status(), 'unset-private returns 200').toBe(200);
  await expect(switchAgain).toHaveAttribute('aria-checked', 'false');

  // The cross-org viewer reloads the detail page → the children are now visible
  // and the placeholder is gone (the toggle drove enforcement live).
  await cross.goto(`/p/${PUBLIC_KEY}/items/${seed.epic.identifier}`);
  await expect(cross.getByRole('heading', { level: 1, name: EPIC_TITLE })).toBeVisible({
    timeout: 30_000,
  });
  await expect(cross.getByText(NOT_PUBLIC_TITLE, { exact: true })).toHaveCount(0);
  await expect(cross.getByRole('link', { name: new RegExp(CHILD_A) })).toBeVisible();

  // …and the public items-LIST payload now carries the children too.
  const revealedIds = await listItemIdentifiers(cross.request);
  expect(revealedIds.has(seed.childA.identifier), 'child A revealed in public payload').toBe(true);
  expect(revealedIds.has(seed.childB.identifier), 'child B revealed in public payload').toBe(true);

  await crossCtx.close();
});
