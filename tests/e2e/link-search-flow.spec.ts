// Story 6.9 — Quick issue search · the story-closing E2E + a11y sweep (Subtask 6.9.3).
//
// 6.9.1 built the reusable server-side quick-search read (key + title trgm,
// workspace + Story-6.4 permission scoped, bounded, relevance-ordered); 6.9.2
// retrofitted the link/blocker picker onto it (closes finding #98) and shipped
// the create-modal link control on the same shared `LinkAddForm`. The
// correctness / permission / exclusion / guard MATRIX is pinned by the
// integration suites (`tests/integration/work-items/quick-search.test.ts` +
// `link-candidate-search.test.ts`) — those exercise the service over real
// Postgres and need no replay here. What's left for the story to close is the
// thing only a browser proves:
//
//   1. the #98 LARGE-SEED regression as a real journey — an EARLY work item,
//      provably outside any newest-N window, is found from a LATE item's link
//      picker and links (the exact case the old newest-50 client filter broke);
//   2. the picker's empty / no-results states render in the UI;
//   3. the create-modal link control searches server-side identically and the
//      collected link persists when the item is created;
//   4. a strict axe (WCAG 2.1 AA) sweep over the link form across its states
//      (empty / typing / no-results / selected).
//
// Mirrors the `issue-detail-flow.spec.ts` harness (real sign-up, server-seeded
// project, `_test` transport for fast setup). Per the E2E discipline
// (CLAUDE.md): the link Add is an immediate server-action write that
// `router.refresh()`es the panel, so we assert the REFRESHED committed state
// (the link row + readiness banner) before any reload — never the optimistic
// frame alone.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { projectsService } from '@/lib/services/projectsService';

// WCAG 2.1 Level A + AA — the same ruleset the shell a11y sweep names, scoped
// explicitly so the bar can't drift when axe-core bumps. (Best-practice rules
// like `landmark-no-duplicate-main` are intentionally NOT in this set.)
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: unknown[] }[];
}

// Render axe violations as a readable block so a CI failure points straight at
// the rule + element (mirrors shell-a11y.spec.ts).
function formatViolations(label: string, violations: AxeViolation[]): string {
  const lines = violations.map((v) => {
    const selectors = v.nodes.map((n) => `      - ${JSON.stringify(n.target)}`).join('\n');
    return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${selectors}`;
  });
  return `axe found ${violations.length} violation(s) on "${label}":\n${lines.join('\n')}`;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Sign-up auto-creates the workspace; create a project server-side + pin it
 * active. Returns the project id (for `_test` calls). Mirrors the detail spec. */
async function seedActiveProject(email: string, identifier: string): Promise<string> {
  const local = email.split('@')[0]!;
  const user = await db.user.findFirst({ where: { email } });
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(user, 'user exists after sign-up').not.toBeNull();
  expect(ws, 'auto workspace exists').not.toBeNull();
  const project = await projectsService.createProject({
    workspaceId: ws!.id,
    actorUserId: user!.id,
    name: 'Link Search',
    identifier,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user!.id, workspaceId: ws!.id } },
    data: { activeProjectId: project.id },
  });
  return project.id;
}

interface Created {
  id: string;
  identifier: string;
}

/** Create a work item through the `_test` route. Returns id + identifier. */
async function mk(page: Page, projectId: string, title: string): Promise<Created> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title },
  });
  expect(res.status(), `create "${title}"`).toBe(201);
  const dto = (await res.json()) as Created;
  return { id: dto.id, identifier: dto.identifier };
}

interface SummaryRow {
  id: string;
  title: string;
}

/** The project's work items via the `_test` list route (service-layer read). */
async function listItems(page: Page, projectId: string): Promise<SummaryRow[]> {
  const res = await page.request.get(`/api/_test/work-items?projectId=${projectId}`);
  expect(res.status(), 'list work items').toBe(200);
  return (await res.json()) as SummaryRow[];
}

/** The item's `is_blocked_by` blockers, via `_test` — the authoritative read. */
async function blockersOf(page: Page, id: string): Promise<{ id: string }[]> {
  const res = await page.request.get(
    `/api/_test/work-item-links?workItemId=${id}&direction=blockers`,
  );
  expect(res.status(), 'list blockers').toBe(200);
  return (await res.json()) as { id: string }[];
}

/** Open the inline add-link form and type into its query-driven search box. The
 * picker is server-driven (6.9.2) — it loads nothing until a query is typed. */
async function openPickerAndType(page: Page, query: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill(query);
}

test('@smoke #98 regression — an EARLY work item, outside any newest-50 window, is found from a LATE item’s picker and links', async ({
  page,
}) => {
  // 50 fillers sit between the needle and the subject → 52 HTTP creates + a
  // browser journey. Give it room beyond the 30s default.
  test.setTimeout(120_000);

  const email = 'e2e-link-search-scale@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'LSC');

  // The EARLIEST-created item — the needle the old newest-50 client filter
  // buried (finding #98). Its distinctive title token is searched below.
  const early = await mk(page, projectId, 'ancient quokka beacon');
  // 50 newer fillers push `early` to the 52nd-newest position — provably
  // outside ANY newest-50 window, so the pre-6.9.2 read could not surface it.
  for (let i = 0; i < 50; i++) {
    await mk(page, projectId, `routine filler ${i}`);
  }
  // The picker is opened on the NEWEST item.
  const subject = await mk(page, projectId, 'the subject of the search');

  await page.goto(`/items/${subject.identifier}`);
  await expect(
    page.getByRole('heading', { name: 'the subject of the search', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Ready to start')).toBeVisible();

  // Open the picker; the default relationship is "Blocked by". Search the
  // early needle by a title token — it appears despite being far outside the
  // old recent window, and links.
  await page.getByRole('button', { name: 'Link work item' }).click();
  await openPickerAndType(page, 'quokka');
  const earlyOption = page.getByRole('option', { name: /ancient quokka beacon/ });
  await expect(earlyOption).toBeVisible();
  await earlyOption.click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // The blocker row appears (the panel re-rendered server-side after the write)
  // and readiness flips to Blocked — the authoritative committed state, asserted
  // before any reload.
  await expect(page.getByRole('link', { name: /ancient quokka beacon/ })).toBeVisible();
  await expect(page.getByText('Blocked', { exact: true })).toBeVisible();

  // Persisted across reload + at the data layer.
  await page.reload();
  await expect(page.getByRole('link', { name: /ancient quokka beacon/ })).toBeVisible();
  expect((await blockersOf(page, subject.id)).map((x) => x.id)).toContain(early.id);

  // And the early needle is reachable by KEY too (a different relationship, so
  // the already-linked exclusion doesn't hide it). Its identifier is well
  // outside any newest-N window.
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Relationship' }).click();
  await page.getByRole('option', { name: 'Relates to' }).click();
  await openPickerAndType(page, early.identifier);
  await expect(page.getByRole('option', { name: /ancient quokka beacon/ })).toBeVisible();
});

test('@smoke the link picker shows the type-to-search prompt then the no-results state', async ({
  page,
}) => {
  const email = 'e2e-link-search-empty@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'LNR');
  const host = await mk(page, projectId, 'the host work item');
  // A second item exists, but it won't match the non-matching query below.
  await mk(page, projectId, 'an unrelated candidate');

  await page.goto(`/items/${host.identifier}`);
  await page.getByRole('button', { name: 'Link work item' }).click();

  // Empty state: the open picker prompts to type before anything is fetched.
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await expect(page.getByText('Type to search work items…')).toBeVisible();

  // No-results state: a query that matches nothing renders the empty message
  // (a real server round-trip — the read returns zero rows, not a client miss).
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill('zzznomatch');
  await expect(page.getByText('No matching work items.')).toBeVisible();
});

test('@smoke the create-modal link control searches server-side and persists the collected link', async ({
  page,
}) => {
  const email = 'e2e-link-search-create@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'LCR');
  const target = await mk(page, projectId, 'the create-modal blocker');

  await page.goto('/items');
  await page.getByRole('button', { name: 'Create work item' }).click();
  await page.getByLabel('Title').fill('item created with a link');

  // The "Linked work items" section rides the same query-driven LinkAddForm —
  // search server-side, pick, Add a pending row (default relationship: Blocked
  // by). Inside the dialog the picker renders inline (not portaled).
  await openPickerAndType(page, 'blocker');
  await page.getByRole('option', { name: /the create-modal blocker/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // The pending row is collected (its remove affordance names the target).
  await expect(
    page.getByRole('button', { name: `Remove pending blocked by link to ${target.identifier}` }),
  ).toBeVisible();

  // Create the item — the link is written atomically with it.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/^\S+ created$/).first()).toBeVisible();

  // The created item is blocked_by the searched target — verified at the data layer.
  const created = (await listItems(page, projectId)).find(
    (i) => i.title === 'item created with a link',
  );
  expect(created, 'the created item is listed').toBeTruthy();
  expect((await blockersOf(page, created!.id)).map((x) => x.id)).toContain(target.id);
});

test('@a11y the link form passes a strict axe sweep across its states (empty / typing / no-results / selected)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const email = 'e2e-link-search-a11y@example.com';
  await signUp(page, email);
  const projectId = await seedActiveProject(email, 'LAX');
  const host = await mk(page, projectId, 'the a11y host work item');
  await mk(page, projectId, 'a linkable candidate alpha');

  await page.goto(`/items/${host.identifier}`);

  // Whole-page sweep: the Combobox PORTALS its open dropdown to document.body on
  // a non-dialog surface, so the open listbox lives outside the relationships
  // panel — a scoped include() would miss it. A full-page WCAG-tagged analyse
  // covers the page chrome AND the portaled menu. (The detail page's nested
  // <main> is a best-practice-only concern, excluded by the WCAG tag filter.)
  const sweep = async (label: string): Promise<void> => {
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(
      results.violations,
      formatViolations(label, results.violations as AxeViolation[]),
    ).toEqual([]);
  };

  // (1) empty — the form is open with the "type to search" prompt.
  await page.getByRole('button', { name: 'Link work item' }).click();
  await page.getByRole('combobox', { name: 'Work item to link' }).click();
  await expect(page.getByText('Type to search work items…')).toBeVisible();
  await sweep('link form — empty');

  // (2) typing — a query with candidates (the listbox is populated).
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill('candidate');
  await expect(page.getByRole('option', { name: /a linkable candidate alpha/ })).toBeVisible();
  await sweep('link form — typing (candidates)');

  // (3) no-results — a query that matches nothing (the empty message).
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill('zzznomatch');
  await expect(page.getByText('No matching work items.')).toBeVisible();
  await sweep('link form — no results');

  // (4) selected — a candidate is picked (the trigger shows the selection).
  await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill('candidate');
  await page.getByRole('option', { name: /a linkable candidate alpha/ }).click();
  await sweep('link form — selected');
});
