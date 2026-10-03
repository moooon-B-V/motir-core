import type { Page, Response } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import type { PageMarkdownDto } from '@/lib/dto/pages';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';

// AN AGENT AND A PERSON WRITE THE SAME PAGE — Story MOTIR-5760's journey
// (Subtask MOTIR-7414), as a regression spec in the main lane.
//
// An agent holding the token `motir login` mints writes a page over `/api/mcp`;
// a person opens it in the shipped editor at `/pages/<id>` and sees what the
// agent wrote; the person types; the agent's write from its stale read is refused
// by name and changes nothing; its write from a fresh read lands beside the
// person's paragraph.
//
// ── NO ACCEPTANCE VIDEO, and this is not the acceptance lane ────────────────
// The story adds no surface of its own: the editor and `/pages/<id>` are Story
// MOTIR-5752's, already accepted with a receipt. What this story adds is a door
// for agents, which is not something a person watches, so it records no paced
// video (the non-UI exemption) and declares no `acceptanceStory()`.
//
// ── THE AGENT ───────────────────────────────────────────────────────────────
// No `motir` binary: the agent is the real MCP SDK transport against the real
// route, carrying a token stored with `CLI_TOKEN_GRANT` IMPORTED from the app —
// the same `fixedGrant` the device flow mints with — so narrowing that constant
// fails this spec rather than a hand-built grant hiding it.
//
// ── THE WAITS (CLAUDE.md § E2E tests wait on the AUTHORITATIVE signal) ──────
// Every agent step waits on its own tool result. The person's typing waits on
// its `POST /api/pages/<id>/updates` response, armed before the keys, and then
// on the save indicator reading Saved. Every page load waits on the editor's
// body textbox before reading it. There is no fixed sleep.

const PASSWORD = 'pages-agent-mcp-e2e-pass-123';
const EMAIL = 'pages-agent-mcp@example.com';
const FOLDER = 'Runbooks';

const AGENT_MARKDOWN = [
  '# Deploy runbook',
  '',
  '- Build the image',
  '  - Tag it with the commit',
  '- Roll it out',
  '',
  '```bash',
  'pnpm deploy --env prod',
  '```',
  '',
  '| Step | Owner |',
  '| --- | --- |',
  '| Rollout | Ana |',
  '',
  '- [x] Dry run done',
  '- [ ] Announce it',
  '',
  'See [the release notes](https://example.com/notes).',
].join('\n');

const PERSON_LINE = 'Ben checked the dashboards after the rollout.';
const AGENT_LINE = 'The agent confirmed the rollback plan.';

interface Seed {
  projectKey: string;
  folderId: string;
  token: string;
  staleGrantToken: string;
}

async function seed(): Promise<Seed> {
  const member = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Ben Member',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Ops Workspace',
    ownerUserId: member.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: member.id,
    name: 'Ops',
    identifier: 'OPS',
  });
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const ctx = { userId: member.id, workspaceId: workspace.id };
  const folder = await foldersService.createFolder(
    { projectId: project.id, parentFolderId: null, name: FOLDER },
    ctx,
  );
  // Exactly what `motir login` stores (`cliDeviceService`'s `fixedGrant`).
  const cli = await apiTokensService.create(member.id, workspace.id, {
    label: 'CLI · agentbox',
    fixedGrant: CLI_TOKEN_GRANT,
  });
  // The device grant as it stood before the page keys joined it.
  const stale = await apiTokensService.create(member.id, workspace.id, {
    label: 'CLI · oldbox',
    fixedGrant: CLI_TOKEN_GRANT.filter((key) => key !== 'page:view' && key !== 'page:edit'),
  });
  return {
    projectKey: project.identifier,
    folderId: folder.id,
    token: cli.token,
    staleGrantToken: stale.token,
  };
}

async function agent(token: string, baseURL: string | undefined): Promise<Client> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  const client = new Client({ name: 'pages-agent-mcp', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (result: CallToolResult) =>
  (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/** A tool call that must succeed — a refusal fails the step with its own message. */
async function ok(client: Client, name: string, args: Record<string, unknown>) {
  const result = await tool(client, name, args);
  expect(result.isError ?? false, textOf(result).slice(0, 400)).toBe(false);
  return result.structuredContent as unknown as PageMarkdownDto;
}

const bodyOf = (page: Page) => page.getByRole('textbox', { name: 'Page body', exact: true });
const indicatorOf = (page: Page) =>
  page.getByRole('toolbar', { name: 'Formatting', exact: true }).getByRole('status');

/** Open the page and wait on the editor's body before anything reads it. */
async function openPage(page: Page, pageId: string): Promise<void> {
  await page.goto(`/pages/${pageId}`);
  await expect(bodyOf(page)).toBeVisible();
}

function bodySave(page: Page, pageId: string): Promise<Response> {
  return page.waitForResponse(
    (r) => r.url().endsWith(`/api/pages/${pageId}/updates`) && r.request().method() === 'POST',
  );
}

test('an agent writes a page over the MCP, a person edits it, and the agent rewrites it only from a fresh read', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await resetDatabase();
  const s = await seed();
  const client = await agent(s.token, baseURL);
  let pageId = '';
  let firstRevision = 0;

  await test.step('the agent creates a page from markdown in a folder', async () => {
    const created = await ok(client, 'create_page', {
      projectKey: s.projectKey,
      title: 'Deploy runbook',
      markdown: AGENT_MARKDOWN,
      parent: { kind: 'folder', id: s.folderId },
    });
    expect(created.placement.folderId).toBe(s.folderId);
    pageId = created.id;
    firstRevision = created.revision;
  });

  await test.step('the person opens it and sees what the agent wrote', async () => {
    await signIn(page, EMAIL, PASSWORD);
    await openPage(page, pageId);
    const body = bodyOf(page);
    await expect(body.getByRole('heading', { name: 'Deploy runbook' })).toBeVisible();
    await expect(body.getByText('Build the image')).toBeVisible();
    await expect(body.getByText('Tag it with the commit')).toBeVisible();
    await expect(body.getByText('pnpm deploy --env prod')).toBeVisible();
    await expect(body.getByRole('columnheader', { name: 'Owner' })).toBeVisible();
    await expect(body.getByRole('cell', { name: 'Ana' })).toBeVisible();
    await expect(body.getByText('Dry run done')).toBeVisible();
    await expect(body.getByRole('checkbox').first()).toBeChecked();
    await expect(body.getByRole('link', { name: 'the release notes' })).toBeVisible();
  });

  await test.step('the person types a paragraph and it saves', async () => {
    const saved = bodySave(page, pageId);
    await bodyOf(page).getByText('See the release notes').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(PERSON_LINE);
    expect((await saved).status()).toBe(200);
    await expect(indicatorOf(page)).toHaveText('Saved');
  });

  await test.step('the agent’s write from its stale read is refused by name', async () => {
    const stale = await tool(client, 'update_page', {
      projectKey: s.projectKey,
      pageId,
      markdown: `${AGENT_MARKDOWN}\n\n${AGENT_LINE}`,
      revision: firstRevision,
    });
    expect(stale.isError).toBe(true);
    const message = textOf(stale);
    expect(message).toContain('PAGE_REVISION_CONFLICT');
    expect(message).toContain(`you sent ${firstRevision}`);
    expect(message).toContain('call get_page');
    await openPage(page, pageId);
    await expect(bodyOf(page).getByText(PERSON_LINE)).toBeVisible();
    await expect(bodyOf(page).getByText(AGENT_LINE)).toHaveCount(0);
  });

  await test.step('the agent re-reads, writes from the fresh revision, and both lines show', async () => {
    const fresh = await ok(client, 'get_page', { projectKey: s.projectKey, pageId });
    expect(fresh.markdown).toContain(PERSON_LINE);
    expect(fresh.revision).toBeGreaterThan(firstRevision);
    const written = await ok(client, 'update_page', {
      projectKey: s.projectKey,
      pageId,
      markdown: `${fresh.markdown}\n\n${AGENT_LINE}`,
      revision: fresh.revision,
    });
    expect(written.revision).toBe(fresh.revision + 1);
    await openPage(page, pageId);
    await expect(bodyOf(page).getByText(PERSON_LINE)).toBeVisible();
    await expect(bodyOf(page).getByText(AGENT_LINE)).toBeVisible();
  });

  await test.step('a token from the pre-change device grant is refused, naming page:view', async () => {
    const old = await agent(s.staleGrantToken, baseURL);
    const refused = await tool(old, 'get_page', { projectKey: s.projectKey, pageId });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('page:view');
    await old.close();
  });

  await client.close();
});
