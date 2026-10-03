import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { PageMarkdownDto } from '@/lib/dto/pages';
import { runUpdatePage } from '@/lib/mcp/tools/updatePage';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { markdownToUpdate, parseMarkdown, stateToJson } from '@/lib/pages';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';

// STORY MOTIR-5760's INTEGRATION GATE (MOTIR-7413) — agents read and write a
// page over the MCP, assembled, on real Postgres with RLS, through the real
// `/api/mcp` route and real PATs.
//
// Each card tested its own layer: the package's `savePageMarkdown` over an
// in-memory store, the service doors on Postgres, each tool through an
// in-memory MCP client, the device grant through the device flow. This file
// drives the SEAMS between them:
//
//   the editor's save (a Yjs update) → `get_page`'s markdown → `update_page` →
//   the editor's document again; `create_page`'s markdown → what the editor
//   opens; a markdown write and an editor save racing on one row lock; the
//   version a whole-body write lands in; and who can reach which page.
//
// Nothing is mocked. The coalescing window is the real clock: every case here
// runs well inside it, and the one that needs a NEW version gets it from a
// different author, which §6 starts a version for whatever the time.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ENDPOINT = 'http://localhost/api/mcp';

// The package's own round-trip fixture — one body holding every node and mark
// the page schema carries (MOTIR-7272). Loaded by path at run time: it lives in
// the package's test tree, which the app's type-check projects do not list.
const { FIXTURE_MARKDOWN } = (await import(
  join(process.cwd(), 'packages/pages/test/document/fixture.ts')
)) as { FIXTURE_MARKDOWN: string };
const EDIT: readonly PermissionKey[] = ['project:browse', 'page:view', 'page:edit'];

interface Fixture {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  owner: ServiceContext;
}

let userSeq = 0;
async function makeUser(tag: string) {
  userSeq += 1;
  return usersService.createUser({
    email: `pages-mcp-${tag}-${userSeq}@example.com`,
    password: 'hunter2hunter2',
    name: `Pages ${tag}`,
  });
}

async function makeFixture(tag = 'w1', identifier = 'PGS'): Promise<Fixture> {
  const owner = await makeUser(`${tag}-owner`);
  const ws = await workspacesService.createWorkspace({ name: tag, ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Pages',
    identifier,
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'OTH',
  });
  return {
    workspaceId,
    projectId: project.id,
    otherProjectId: other.id,
    owner: { userId: owner.id, workspaceId },
  };
}

async function memberAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<ServiceContext> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  // A PAT binds to a workspace its user can reach, and reach runs through the
  // organization — so a member is an org member too, as an invite makes them.
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: f.workspaceId },
    select: { organizationId: true },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId, userId: user.id, role: ORGANIZATION_ROLE.member },
  });
  return { userId: user.id, workspaceId: f.workspaceId };
}

async function pat(ctx: ServiceContext, grant: readonly PermissionKey[]): Promise<string> {
  const { token } = await apiTokensService.create(ctx.userId, ctx.workspaceId, {
    label: `gate-${Math.random().toString(36).slice(2, 8)}`,
    fixedGrant: [...grant],
  });
  return token;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'pages-mcp-gate', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function pageOf(res: unknown): PageMarkdownDto {
  return (res as CallToolResult).structuredContent as unknown as PageMarkdownDto;
}

/** The ProseMirror document the editor opens for a page, from `getPage`'s state. */
async function editorDoc(ctx: ServiceContext, projectId: string, pageId: string) {
  const page = await pagesService.getPage(ctx, { projectId, pageId });
  return stateToJson(new Uint8Array(Buffer.from(page.bodyState, 'base64')));
}

async function stateOf(pageId: string): Promise<Uint8Array> {
  return new Uint8Array(
    (await adminDb.page.findUniqueOrThrow({ where: { id: pageId } })).bodyState,
  );
}

/** Backends on this worker's database parked on a lock — the race's barrier. */
async function lockWaiters(): Promise<number> {
  const rows = await adminDb.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_stat_activity
     WHERE datname = current_database()
       AND wait_event_type = 'Lock'
  `;
  return Number(rows[0]!.n);
}

function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('case 2 — the editor → markdown seam', () => {
  it('an editor-written page reads back as its stored markdown, and writing that back keeps the document', async () => {
    const f = await makeFixture();
    const created = await pagesService.createPage(f.owner, {
      projectId: f.projectId,
      title: 'Fixture',
    });
    // The EDITOR path: a Yjs update through `savePageUpdate`.
    await pagesService.savePageUpdate(f.owner, {
      projectId: f.projectId,
      pageId: created.id,
      update: markdownToUpdate(await stateOf(created.id), FIXTURE_MARKDOWN),
    });
    const original = await editorDoc(f.owner, f.projectId, created.id);
    const client = await connect(await pat(f.owner, EDIT));

    const read = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PGS', pageId: created.id },
    });
    expect(read.isError, textOf(read)).toBeFalsy();
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });
    expect(pageOf(read).markdown).toBe(stored.bodyMarkdown);

    const rewritten = await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: 'PGS',
        pageId: created.id,
        markdown: pageOf(read).markdown,
        revision: pageOf(read).revision,
      },
    });
    expect(rewritten.isError, textOf(rewritten)).toBeFalsy();
    expect(await editorDoc(f.owner, f.projectId, created.id)).toEqual(original);
    await client.close();
  });
});

describe('case 3 — the markdown → editor seam', () => {
  it('create_page’s markdown is the document the editor opens', async () => {
    const f = await makeFixture();
    const client = await connect(await pat(f.owner, EDIT));
    const created = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PGS', title: 'Fixture', markdown: FIXTURE_MARKDOWN },
    });
    expect(created.isError, textOf(created)).toBeFalsy();
    expect(await editorDoc(f.owner, f.projectId, pageOf(created).id)).toEqual(
      parseMarkdown(FIXTURE_MARKDOWN).toJSON(),
    );
    await client.close();
  });
});

describe('case 4 — a markdown write racing an editor save, on one row lock', () => {
  it('the editor’s paragraph survives, or the markdown write is refused — never neither, both orders seen', async () => {
    const f = await makeFixture();
    const RUNS = 24;
    const outcomes = { editorFirst: 0, markdownFirst: 0 };

    for (let run = 0; run < RUNS; run += 1) {
      const page = await pagesService.createPageFromMarkdown(f.owner, {
        projectId: f.projectId,
        title: `Race ${run}`,
        markdown: 'Base paragraph.',
      });
      const base = await stateOf(page.id);
      const editorPara = `Editor paragraph ${run}.`;
      const editorSave = () =>
        pagesService.savePageUpdate(f.owner, {
          projectId: f.projectId,
          pageId: page.id,
          update: markdownToUpdate(base, `Base paragraph.\n\n${editorPara}`),
        });
      const markdownWrite = () =>
        runUpdatePage(
          {
            projectKey: 'PGS',
            pageId: page.id,
            markdown: `Agent rewrite ${run}.`,
            revision: page.revision,
          },
          f.owner,
        );
      // Both are in flight before either commits, and the ORDER is built, not
      // hoped for (MOTIR-7493). A holder takes the page's row lock first; one
      // side is started and the test waits until it is parked on that lock, then
      // the other is started and parked behind it; then the holder commits.
      // Postgres hands a row lock to its waiters in the order they queued, so
      // the side started first is the side that writes first — on any runner.
      // (A random head start used to stand in for this. `update_page` reads the
      // project key before it reaches the lock, so on a loaded runner it lost
      // every run and the "both orders seen" check failed on a correct tree.)
      const editorFirst = run % 2 === 0;
      const held = latch();
      const release = latch();
      const holder = withWorkspaceContext(
        { userId: f.owner.userId, workspaceId: f.workspaceId, projectId: f.projectId },
        async (tx) => {
          await pageRepository.lockById(page.id, tx);
          held.open();
          await release.opened;
        },
      );
      await held.opened;
      let saved: Promise<unknown> | undefined;
      let wrote: Promise<CallToolResult> | undefined;
      try {
        if (editorFirst) saved = editorSave();
        else wrote = markdownWrite();
        await expect.poll(() => lockWaiters()).toBe(1);
        if (editorFirst) wrote = markdownWrite();
        else saved = editorSave();
        await expect.poll(() => lockWaiters()).toBe(2);
      } finally {
        release.open();
        await holder;
        // Settle whatever was started, so a failed barrier leaves nothing running.
        await Promise.allSettled([saved, wrote]);
      }
      const [, written] = await Promise.all([saved!, wrote!]);

      const after = await pagesService.getPageMarkdown(f.owner, {
        projectId: f.projectId,
        pageId: page.id,
      });
      const refused = written.isError === true;
      expect(refused, `run ${run}: the side that queued first writes first`).toBe(editorFirst);
      if (refused) {
        expect(textOf(written)).toContain('PAGE_REVISION_CONFLICT');
        outcomes.editorFirst += 1;
      } else {
        outcomes.markdownFirst += 1;
        expect(after.markdown).toContain(`Agent rewrite ${run}.`);
      }
      // The invariant, under either order: the person's paragraph is not lost.
      expect(after.markdown, `run ${run}`).toContain(editorPara);
      expect(after.revision).toBe(page.revision + (refused ? 1 : 2));
    }

    // A race that never happens cannot pass silently. Each order is produced on
    // purpose on half the runs, so each is seen exactly that often.
    expect(outcomes).toEqual({ editorFirst: RUNS / 2, markdownFirst: RUNS / 2 });
  });
});

describe('case 5 — the versions a markdown write lands in', () => {
  it('coalesces the agent’s own edits, and starts a version by the token’s user after a person saves', async () => {
    const f = await makeFixture();
    const agent = await memberAs(f, 'agent', 'member');
    const client = await connect(await pat(agent, EDIT));

    const created = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PGS', title: 'Log', markdown: 'One.' },
    });
    const page = pageOf(created);
    const second = await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: 'PGS',
        pageId: page.id,
        markdown: 'One. Two.',
        revision: page.revision,
      },
    });
    expect(second.isError, textOf(second)).toBeFalsy();
    expect(pageOf(second).latestVersion).toMatchObject({ number: 1, authorId: agent.userId });
    expect(await adminDb.pageVersion.count({ where: { pageId: page.id } })).toBe(1);

    // A person saves in the editor.
    const person = await pagesService.savePageUpdate(f.owner, {
      projectId: f.projectId,
      pageId: page.id,
      update: markdownToUpdate(await stateOf(page.id), 'One. Two.\n\nA person’s line.'),
    });
    const third = await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: 'PGS',
        pageId: page.id,
        markdown: 'One. Two.\n\nA person’s line.\n\nThe agent again.',
        revision: person.revision,
      },
    });
    expect(third.isError, textOf(third)).toBeFalsy();
    const versions = await adminDb.pageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { number: 'asc' },
      select: { number: true, authorId: true },
    });
    expect(versions).toEqual([
      { number: 1, authorId: agent.userId },
      { number: 2, authorId: f.owner.userId },
      { number: 3, authorId: agent.userId },
    ]);
    expect(pageOf(third).latestVersion).toMatchObject({ number: 3, authorId: agent.userId });
    await client.close();
  });
});

describe('case 6 — isolation, through the MCP handler with real PATs', () => {
  it('another project’s page is not-found from this project’s key', async () => {
    const f = await makeFixture();
    const elsewhere = await pagesService.createPageFromMarkdown(f.owner, {
      projectId: f.otherProjectId,
      markdown: 'Other.',
    });
    const client = await connect(await pat(f.owner, EDIT));
    const res = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PGS', pageId: elsewhere.id },
    });
    const missing = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PGS', pageId: 'no-such-page' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_NOT_FOUND');
    expect(textOf(res)).toBe(textOf(missing));
    const write = await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: 'PGS',
        pageId: elsewhere.id,
        markdown: 'x',
        revision: elsewhere.revision,
      },
    });
    expect(textOf(write)).toBe(textOf(missing));
    await client.close();
  });

  it('a page in another workspace is not-found from this workspace’s token', async () => {
    const w1 = await makeFixture('w1', 'PGS');
    const w2 = await makeFixture('w2', 'TWO');
    const theirs = await pagesService.createPageFromMarkdown(w2.owner, {
      projectId: w2.projectId,
      markdown: 'Theirs.',
    });
    const client = await connect(await pat(w1.owner, EDIT));
    // By their project's key, and by ours: neither confirms the page exists.
    const byTheirKey = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'TWO', pageId: theirs.id },
    });
    const byOurKey = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PGS', pageId: theirs.id },
    });
    expect(byTheirKey.isError).toBe(true);
    expect(byOurKey.isError).toBe(true);
    expect(textOf(byOurKey)).toContain('PAGE_NOT_FOUND');
    expect(textOf(byTheirKey)).not.toContain('Theirs.');
    expect(await adminDb.page.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({
      revision: theirs.revision,
    });
    await client.close();
  });

  it('a viewer’s PAT reads a page and is refused both writes by name', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPageFromMarkdown(f.owner, {
      projectId: f.projectId,
      markdown: 'Read me.',
    });
    const viewer = await memberAs(f, 'viewer', 'viewer');
    const client = await connect(await pat(viewer, EDIT));

    const read = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PGS', pageId: page.id },
    });
    expect(read.isError, textOf(read)).toBeFalsy();
    expect(pageOf(read).markdown).toBe('Read me.');
    for (const [name, args] of [
      ['create_page', { projectKey: 'PGS', markdown: 'x' }],
      [
        'update_page',
        { projectKey: 'PGS', pageId: page.id, markdown: 'x', revision: page.revision },
      ],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
      expect(textOf(res), name).toContain('PROJECT_ACCESS_DENIED');
    }
    expect(await adminDb.page.count({ where: { projectId: f.projectId } })).toBe(1);
    await client.close();
  });

  it('a PAT without `page:view` is refused get_page, naming the key', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPageFromMarkdown(f.owner, {
      projectId: f.projectId,
      markdown: 'Hidden.',
    });
    const client = await connect(await pat(f.owner, ['project:browse']));
    const res = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PGS', pageId: page.id },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:view');
    expect(textOf(res)).not.toContain('Hidden.');
    await client.close();
  });
});

describe('case 7 — the device grant, against stored rows', () => {
  it('a token stored with CLI_TOKEN_GRANT reaches all three tools', async () => {
    const f = await makeFixture();
    const client = await connect(await pat(f.owner, CLI_TOKEN_GRANT));
    const created = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PGS', markdown: 'From the CLI.' },
    });
    expect(created.isError, textOf(created)).toBeFalsy();
    const read = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PGS', pageId: pageOf(created).id },
    });
    expect(read.isError, textOf(read)).toBeFalsy();
    const updated = await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: 'PGS',
        pageId: pageOf(created).id,
        markdown: 'Edited from the CLI.',
        revision: pageOf(read).revision,
      },
    });
    expect(updated.isError, textOf(updated)).toBeFalsy();
    await client.close();
  });

  it('a token stored with the pre-change grant is refused get_page — no read-forward', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPageFromMarkdown(f.owner, {
      projectId: f.projectId,
      markdown: 'x',
    });
    const before = CLI_TOKEN_GRANT.filter((k) => k !== 'page:view' && k !== 'page:edit');
    const token = await pat(f.owner, before);
    // The stored row, as the database holds it: no page key, so nothing but a
    // read-forward could put one in the grant the gate sees.
    const row = await adminDb.apiToken.findFirstOrThrow({ where: { userId: f.owner.userId } });
    expect(row.scopes.some((s) => s.startsWith('page:'))).toBe(false);
    const client = await connect(token);
    const res = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PGS', pageId: page.id },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:view');
    await client.close();
  });
});
