import type { APIRequestContext, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from './_helpers/acceptance-video';
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

// AGENTS AND INTEGRATIONS FILE INTO FOLDERS — THE ACCEPTANCE RECEIPT
// (Story MOTIR-5310 · Subtask MOTIR-5421). The story's verification recipe as one
// journey, against a production build and a real database.
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
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Three moments, each held with a `beat()` named at the line that holds it:
// the folder path on a proposal, the move into the folder under Show changes,
// and the three items inside the folder once the plan is approved.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
//
// Every write waits on its own answer: an `/api/v1` status, an MCP tool result,
// the approve POST, and the folder level's lazy Server Action read in `/items`.
// The review surface's landmark is asserted before any folder crumb, so a spec
// run against a surface that never mounted cannot pass on a stray string.
//
// The rules behind each step are proven below the browser, in the story's vitest
// gate (MOTIR-5420). This spec proves the journey.
//
// ⚠️ THE CARD NAMED THIS FILE `acceptance-folder-placement.spec.ts`. That name was
// taken by MOTIR-5309's receipt, which merged after the card was written, so this
// receipt carries the agent in its name. Recorded on MOTIR-5421.

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

test('an integration files work, an agent proposes into the folder, and a reviewer approves it into place', async ({
  page,
  request,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5310');

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
  await chapter('An agent’s plan says which folder each card will be filed into', async () => {
    await page.goto(`/plans/${planId}?view=canvas`);
    await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');
    // The landmark FIRST: nothing below may pass against a page that never mounted.
    await expect(reviewCanvas(page)).toBeVisible();

    const mapFields = nodeTitled(page, 'Map legacy fields');
    await expect(mapFields).toHaveCount(1);
    await expect(mapFields.getByTestId('placement-line')).toContainText(FOLDER);
    // MOMENT 1 — the folder path on the proposal.
    await beat();
  });

  await chapter('Show changes: Old reports moves from the root into Backlog ideas', async () => {
    const toggle = page.getByTestId('show-changes-toggle');
    // Armed on arrival (MOTIR-4020), so the reader lands on the marked changes.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const move = node(page, oldReports.id).getByTestId('diff-line');
    await expect(move).toContainText('Placement');
    await expect(move).toContainText('Project root');
    await expect(move).toContainText(FOLDER);
    // MOMENT 2 — the move into the folder, under Show changes.
    await beat();
  });

  // ── Step 4 — approve, and all three sit inside the folder ────────────────
  await chapter('Approve — and the plan’s cards become filed work', async () => {
    const approve = page.getByRole('button', { name: /^Approve/ });
    await expect(approve).toBeEnabled();
    const approved = page.waitForResponse(
      (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
    );
    await approve.click();
    expect((await approved).status()).toBe(200);
    await expect(page.getByTestId('plan-status-pill')).toContainText('Approved');
  });

  await chapter('In the tree, all three items are inside Backlog ideas', async () => {
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
    // MOMENT 3 — the three items inside Backlog ideas after approve.
    await beat();
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
  const card = nodeTitled(page, 'Draft scratch notes');
  await expect(card.getByTestId('placement-line')).toContainText('Scratch');

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
  await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');

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
