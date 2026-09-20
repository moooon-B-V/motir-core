import type { APIRequestContext, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from '@playwright/test';
import { actionWrite } from './_helpers/authoritative-signal';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';

// AGENTS AND INTEGRATIONS FILE INTO FOLDERS
// (Story MOTIR-5310 · Subtask MOTIR-5421).
//
// ── PROMOTED FROM THE ACCEPTANCE LANE (Bug MOTIR-5782 · MOTIR-5796) ─────────
//
// This was `acceptance-agent-folder-placement.spec.ts`, the receipt for
// MOTIR-5310. That story is `done`, so the spec has discharged its purpose and,
// per docs/decisions/acceptance-receipt-lifecycle.md §3, leaves the lane rather
// than being edited in place. It went RED in the merge queue on bug MOTIR-5782,
// whose design (Part XVIII decision 2) retires the plan-review canvas's
// PLACEMENT LINE for a card filed into a folder that still exists — the folder
// is a level there now, so the breadcrumb says where the reviewer is standing
// and the line would repeat it. The receipt's `chapter()` / `beat()` pacing and
// its `acceptanceStory()` tag are gone (`test.step` keeps the structure), and
// the two moments that read the retired line are restated on top of this
// promotion, never inside it. Disposition recorded in
// docs/acceptance-lane-triage.md.
//
// ── WHERE THE JOURNEY STARTS ────────────────────────────────────────────────
//
// Outside the browser, on purpose. An integration is a bearer on `/api/v1`, and
// an agent authoring a plan is the same bearer on `/api/mcp` through the real MCP
// SDK transport. Neither is stubbed: the claim is that a token-holding caller can
// file work and propose filings a person then SEES and approves, and a stubbed
// transport would prove the harness instead (`agent-authored-plan-seed.ts` makes
// the same call). The only service-layer reach is the tenant itself — a person,
// a workspace, a project, one committed epic and the token.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
//
// Every write waits on its own answer: an `/api/v1` status, an MCP tool result,
// the approve POST, and the folder level's lazy Server Action read in `/items`.
// The review surface's landmark is asserted before any folder assertion, so a
// spec run against a surface that never mounted cannot pass on a stray string.
//
// The rules behind each step are proven below the browser, in the story's vitest
// gate (MOTIR-5420). This spec proves the journey.

const PASSWORD = 'acceptance-agent-folders-e2e-pass-123';
const V1 = '/api/v1';
const FOLDER = 'Backlog ideas';

interface Seed {
  email: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** One bearer for both doors: `CLI_TOKEN_GRANT` for `/api/v1` and the MCP's
   *  work-item tools, plus `ai:view_plan` for `add_plan_items`. */
  token: string;
}

async function seedProject(email: string, identifier: string): Promise<Seed> {
  const owner = await usersService.createUser({
    email,
    password: PASSWORD,
    name: 'Priya Reviewer',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Legacy Import Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Legacy import',
    identifier,
  });
  // `/plans` and `/items` are active-project scoped.
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'acceptance-agent-folders',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT, 'ai:view_plan'],
  });
  return {
    email,
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    token: minted.token,
  };
}

const bearer = (seed: Seed) => ({ Authorization: `Bearer ${seed.token}` });

async function createFolderOverApi(request: APIRequestContext, seed: Seed, name: string) {
  const res = await request.post(`${V1}/projects/${seed.projectKey}/folders`, {
    headers: bearer(seed),
    data: { name },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; name: string; path: string[] };
}

async function agentSession(seed: Seed, baseURL: string | undefined): Promise<Client> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  const client = new Client({ name: 'acceptance-agent-folders', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: bearer(seed) },
    }),
  );
  return client;
}

/** A tool call that must succeed — a refusal fails the step by its own message. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError ?? false, JSON.stringify(result.content).slice(0, 400)).toBe(false);
  return result;
}

/** `create_plan` then ONE closing `add_plan_items` batch, as an agent authors it. */
async function authorPlan(
  client: Client,
  seed: Seed,
  title: string,
  proposals: Record<string, unknown>[],
): Promise<string> {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: seed.projectKey,
    title,
    summary: title,
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  const planId = (created.structuredContent as { id: string }).id;
  await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, final: true, proposals });
  return planId;
}

const reviewCanvas = (page: Page) =>
  page.getByRole('application', { name: 'Proposed plan canvas' });
const node = (page: Page, nodeId: string) => page.locator(`[data-node-id="${nodeId}"]`);
const nodeTitled = (page: Page, title: string) =>
  page.locator('[data-node-id]').filter({ hasText: title });
const tree = (page: Page) => page.getByRole('treegrid', { name: 'Work Items', exact: true });
const crumbs = (page: Page) =>
  page
    .getByRole('main')
    .getByTestId('roadmap-canvas')
    .getByRole('navigation', { name: 'Breadcrumb' });

test('an integration files work, an agent proposes into the folder, and a reviewer approves it into place', async ({
  page,
  request,
  baseURL,
}) => {
  await resetDatabase();
  const seed = await seedProject('acceptance-agent-folders@example.com', 'LEGACY');
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  // The unfiled epic the agent will propose to file.
  const oldReports = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'epic', title: 'Old reports', parentId: null },
    ctx,
  );

  // ── Step 1 — an integration files work over /api/v1 ──────────────────────
  const folder = await createFolderOverApi(request, seed, FOLDER);
  expect(folder.path).toEqual([FOLDER]);

  const createdEpic = await request.post(`${V1}/projects/${seed.projectKey}/work-items`, {
    headers: bearer(seed),
    data: { kind: 'epic', title: 'Import legacy tickets', folderId: folder.id },
  });
  expect(createdEpic.status(), await createdEpic.text()).toBe(201);
  const importKey = ((await createdEpic.json()) as { key: string }).key;

  const readBack = await request.get(`${V1}/work-items/${importKey}`, { headers: bearer(seed) });
  expect(readBack.status()).toBe(200);
  const detail = (await readBack.json()) as {
    folderId: string | null;
    folderPath: string[] | null;
  };
  expect(detail.folderId).toBe(folder.id);
  expect(detail.folderPath).toEqual([FOLDER]);

  // ── Step 2 — an agent proposes into the folder over the MCP ──────────────
  const client = await agentSession(seed, baseURL);
  const planId = await authorPlan(client, seed, 'Tidy the legacy import', [
    {
      op: 'add',
      proposedFields: { title: 'Map legacy fields', kind: 'story' },
      parentRef: `folder:${folder.id}`,
    },
    { op: 'modify', workItemId: oldReports.id, patch: { parentRef: `folder:${folder.id}` } },
  ]);
  await client.close();

  await signIn(page, seed.email, PASSWORD);

  // ── Step 3 — the reviewer sees where each card lands ─────────────────────
  await test.step('An agent’s plan opens INSIDE the folder each card will be filed into', async () => {
    await page.goto(`/plans/${planId}?view=canvas`);
    await expect(page.getByRole('main').getByTestId('plan-status-pill')).toContainText(
      'Ready to review',
    );
    // The landmark FIRST: nothing below may pass against a page that never mounted.
    await expect(reviewCanvas(page)).toBeVisible();

    // ⚠️ RESTATED by bug MOTIR-5782 (design Part XVIII decision 2). A folder is a
    // LEVEL on this canvas now, so both proposals sit on Backlog ideas' level and
    // the plan ARRIVES there (§18.2). What tells the reviewer where the work lands
    // is therefore the BREADCRUMB — the placement line would repeat the level the
    // reader is already standing on, and is kept only for the stale case
    // (decision 6, asserted in the second test below). The list body keeps the
    // placement fact unchanged, which is where `folderPath` is still read.
    await expect(crumbs(page).getByRole('button', { name: `Folder: ${FOLDER}` })).toBeVisible();
    const mapFields = nodeTitled(page, 'Map legacy fields');
    await expect(mapFields).toHaveCount(1);
    await expect(mapFields.getByTestId('placement-line')).toHaveCount(0);
  });

  await test.step('Show changes: Old reports moves from the root into Backlog ideas', async () => {
    const toggle = page.getByRole('main').getByTestId('show-changes-toggle');
    // Armed on arrival (MOTIR-4020), so the reader lands on the marked changes.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const move = node(page, oldReports.id).getByTestId('diff-line');
    await expect(move).toContainText('Placement');
    await expect(move).toContainText('Project root');
    await expect(move).toContainText(FOLDER);
  });

  // ── Step 4 — approve, and all three sit inside the folder ────────────────
  await test.step('Approve — and the plan’s cards become filed work', async () => {
    const approve = page.getByRole('button', { name: /^Approve/ });
    await expect(approve).toBeEnabled();
    const approved = page.waitForResponse(
      (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
    );
    await approve.click();
    expect((await approved).status()).toBe(200);
    await expect(page.getByRole('main').getByTestId('plan-status-pill')).toContainText('Approved');
  });

  await test.step('In the tree, all three items are inside Backlog ideas', async () => {
    const mapFields = await db.workItem.findFirstOrThrow({
      where: { projectId: seed.projectId, title: 'Map legacy fields' },
    });
    await page.goto('/items');
    await expect(tree(page)).toBeVisible();
    const folderRow = tree(page).getByTestId(`folder-row-${folder.id}`);
    await expect(folderRow).toBeVisible();

    // A folder's first expand is a lazy level read: a Server Action carrying its id.
    const level = actionWrite(page, '/items', folder.id);
    await page.getByRole('button', { name: `Expand folder ${FOLDER}`, exact: true }).click();
    expect((await level).status(), 'the folder level read').toBe(200);
    await expect(folderRow).toHaveAttribute('aria-expanded', 'true');

    for (const key of [importKey, oldReports.identifier, mapFields.identifier]) {
      await expect(tree(page).getByTestId(`issue-row-${key}`)).toHaveAttribute('aria-level', '2');
    }
  });
});

test('a folder deleted after the plan was written refuses the approve and creates nothing', async ({
  page,
  request,
  baseURL,
}) => {
  await resetDatabase();
  const seed = await seedProject('acceptance-agent-folders-stale@example.com', 'STALE');
  const scratch = await createFolderOverApi(request, seed, 'Scratch');

  const client = await agentSession(seed, baseURL);
  const planId = await authorPlan(client, seed, 'Scratch notes', [
    {
      op: 'add',
      proposedFields: { title: 'Draft scratch notes', kind: 'story' },
      parentRef: `folder:${scratch.id}`,
    },
  ]);
  await client.close();

  await signIn(page, seed.email, PASSWORD);
  await page.goto(`/plans/${planId}?view=canvas`);
  await expect(reviewCanvas(page)).toBeVisible();
  // RESTATED with the moment above: the plan arrives inside Scratch, so the crumb
  // names the folder and the card spends no slot on saying so (decision 2).
  await expect(crumbs(page).getByRole('button', { name: 'Folder: Scratch' })).toBeVisible();
  const card = nodeTitled(page, 'Draft scratch notes');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('placement-line')).toHaveCount(0);

  // The folder goes while the reviewer has the plan open.
  const deleted = await request.delete(`${V1}/folders/${scratch.id}`, { headers: bearer(seed) });
  expect(deleted.status(), await deleted.text()).toBe(200);

  const approve = page.getByRole('button', { name: /^Approve/ });
  const refused = page.waitForResponse(
    (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
  );
  await approve.click();
  expect((await refused).status()).toBe(400);

  // The refusal names the PROPOSAL: the folder's name went with its row, so the
  // copy cannot name Scratch (design Part XVII §17.5, amended on MOTIR-5423).
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Nothing was created' })
      .filter({ hasText: 'Draft scratch notes' }),
  ).toContainText('is filed into a folder that was deleted after this plan was written.');
  await expect(page.getByRole('main').getByTestId('plan-status-pill')).toContainText(
    'Ready to review',
  );

  // Reloaded, the card carries the stale state and Approve is a dead control.
  await page.reload();
  await expect(reviewCanvas(page)).toBeVisible();
  const staleCard = nodeTitled(page, 'Draft scratch notes');
  await expect(staleCard.getByTestId('placement-line')).toHaveAttribute(
    'data-folder-missing',
    'true',
  );
  await expect(staleCard.getByTestId('placement-line')).toContainText('Folder deleted');
  await expect(staleCard).toContainText('Out of date');
  await expect(page.getByRole('button', { name: /^Approve/ })).toBeDisabled();

  expect(
    await db.workItem.count({ where: { projectId: seed.projectId, title: 'Draft scratch notes' } }),
  ).toBe(0);
});
