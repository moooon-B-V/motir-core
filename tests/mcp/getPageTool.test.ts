import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { markdownToUpdate } from '@/lib/pages';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { GRANTABLE_PERMISSIONS, type TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `get_page` (Story MOTIR-5760 · MOTIR-7410) over real Postgres, driven through
// `buildMcpServer` + an in-memory client — the `folder-tools.test.ts` pattern.
// The tool is a thin adapter over `pagesService.getPageMarkdown`, so this
// asserts the adapter half: the payload IS the service's DTO, the text carries
// the markdown and the revision, the not-found answer is one answer, and the
// `page:view` gate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext, grant?: TokenGrant): Promise<Client> {
  const server = grant
    ? buildMcpServer(
        () => ctx,
        () => [...grant],
      )
    : buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

const EDITOR_BODY = '# Runbook\n\n- [ ] check the logs\n\n```sh\npnpm test\n```';

/** A page written the way the editor writes it: a Yjs update through the save door. */
async function editorPage(ctx: ServiceContext, projectId: string, title = 'Runbook') {
  const created = await pagesService.createPage(ctx, { projectId, title });
  const row = await adminDb.page.findUniqueOrThrow({ where: { id: created.id } });
  await pagesService.savePageUpdate(ctx, {
    projectId,
    pageId: created.id,
    update: markdownToUpdate(new Uint8Array(row.bodyState), EDITOR_BODY),
  });
  return created;
}

describe('get_page', () => {
  it('returns the service DTO as structuredContent, and the markdown and revision as text', async () => {
    const fx = await makeWorkItemFixture();
    const page = await editorPage(fx.ctx, fx.projectId);
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view']);

    const res = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'prod', pageId: page.id },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    const dto = await pagesService.getPageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
    });
    expect((res as CallToolResult).structuredContent).toEqual(dto);
    expect(dto).toMatchObject({ title: 'Runbook', revision: 2 });
    const text = textOf(res);
    expect(text).toContain(dto.markdown);
    expect(text).toContain('revision 2');
    expect(text).toContain('at the project root');
    expect(text).toContain(`in version ${dto.latestVersion!.number}`);
    await client.close();
  });

  it('names where a sub-page is filed', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await editorPage(fx.ctx, fx.projectId, 'Parent');
    const child = await pagesService.createPage(fx.ctx, {
      projectId: fx.projectId,
      parent: { kind: 'page', id: parent.id },
    });
    const client = await connectClient(fx.ctx);
    const res = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PROD', pageId: child.id },
    });
    expect(textOf(res)).toContain(`under page ${parent.id}`);
    expect(textOf(res)).toContain('# Untitled');
    await client.close();
  });

  it('an unknown page and another project’s page are the SAME not-found answer', async () => {
    const fx = await makeWorkItemFixture();
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const elsewhere = await editorPage(fx.ctx, other.id);
    const client = await connectClient(fx.ctx);

    const answers = [];
    for (const pageId of [elsewhere.id, 'no-such-page']) {
      const res = await client.callTool({
        name: 'get_page',
        arguments: { projectKey: 'PROD', pageId },
      });
      expect(res.isError).toBe(true);
      answers.push(textOf(res));
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).toContain('PAGE_NOT_FOUND');
    await client.close();
  });

  it('a non-member reads the project as not-found, as every project-scoped tool does', async () => {
    const fx = await makeWorkItemFixture();
    const page = await editorPage(fx.ctx, fx.projectId);
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const client = await connectClient(outsider.ctx);

    const res = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PROD', pageId: page.id },
    });
    const folders = await client.callTool({
      name: 'list_folders',
      arguments: { projectKey: 'PROD' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(textOf(folders));
    await client.close();
  });

  it('a grant without `page:view` is refused by the gate, naming the key', async () => {
    const fx = await makeWorkItemFixture();
    const page = await editorPage(fx.ctx, fx.projectId);
    const client = await connectClient(fx.ctx, ['project:browse']);
    const res = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PROD', pageId: page.id },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:view');
    await client.close();
  });

  describe('one version (MOTIR-7429)', () => {
    /**
     * A page with FIVE versions. Each save is pushed back an hour first, so the
     * next save opens a new version rather than coalescing into it (§6).
     */
    async function fiveVersionPage(ctx: ServiceContext, projectId: string) {
      const page = await pagesService.createPage(ctx, { projectId, title: 'Decision' });
      for (let n = 1; n <= 5; n++) {
        const current = await pagesService.getPageMarkdown(ctx, { projectId, pageId: page.id });
        if (current.latestVersion) {
          const back = new Date(Date.now() - 3_600_000 * (6 - n));
          await adminDb.pageVersion.updateMany({
            where: { pageId: page.id },
            data: { startedAt: back, savedAt: back },
          });
        }
        await pagesService.savePageMarkdown(ctx, {
          projectId,
          pageId: page.id,
          markdown: `Body number ${n}`,
          expectedRevision: current.revision,
        });
      }
      const versions = await adminDb.pageVersion.findMany({
        where: { pageId: page.id },
        orderBy: { number: 'asc' },
      });
      return { page, versions };
    }

    it('returns an older version’s markdown after the page has moved on, with its marks', async () => {
      const fx = await makeWorkItemFixture();
      const { page, versions } = await fiveVersionPage(fx.ctx, fx.projectId);
      const second = versions.find((v) => v.bodyMarkdown.includes('Body number 2'))!;
      await adminDb.pageVersion.update({
        where: { id: second.id },
        data: { sealedAt: new Date() },
      });
      const client = await connectClient(fx.ctx, ['project:browse', 'page:view']);

      const res = await client.callTool({
        name: 'get_page',
        arguments: { projectKey: 'PROD', pageId: page.id, version: second.number },
      });

      expect(res.isError, textOf(res)).toBeFalsy();
      const dto = (res as CallToolResult).structuredContent as Record<string, unknown>;
      expect(dto['markdown']).toContain('Body number 2');
      expect(dto['markdown']).not.toContain('Body number 5');
      expect(dto['version']).toMatchObject({
        number: second.number,
        authorId: fx.ownerId,
        sealed: true,
        frozen: false,
      });
      expect((dto['latestVersion'] as { number: number }).number).toBe(
        versions[versions.length - 1]!.number,
      );
      const text = textOf(res);
      expect(text).toContain(`version ${second.number} by`);
      expect(text).toContain('sealed');
      expect(text).toContain('Body number 2');
      await client.close();
    });

    it('a number the page does not have is PAGE_VERSION_NOT_FOUND, never the current body', async () => {
      const fx = await makeWorkItemFixture();
      const { page } = await fiveVersionPage(fx.ctx, fx.projectId);
      const client = await connectClient(fx.ctx);

      const res = await client.callTool({
        name: 'get_page',
        arguments: { projectKey: 'PROD', pageId: page.id, version: 99 },
      });

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('PAGE_VERSION_NOT_FOUND');
      expect(textOf(res)).toContain('99');
      expect(textOf(res)).not.toContain('Body number 5');
      await client.close();
    });

    it('without `version` the payload carries no `version` field — the current-body read is unchanged', async () => {
      const fx = await makeWorkItemFixture();
      const { page } = await fiveVersionPage(fx.ctx, fx.projectId);
      const client = await connectClient(fx.ctx);
      const res = await client.callTool({
        name: 'get_page',
        arguments: { projectKey: 'PROD', pageId: page.id },
      });
      const dto = (res as CallToolResult).structuredContent as Record<string, unknown>;
      expect(dto).not.toHaveProperty('version');
      expect(dto['markdown']).toContain('Body number 5');
      await client.close();
    });
  });

  it('asserts `page:view`, which makes the key grantable', () => {
    expect(TOOL_PERMISSIONS.get_page).toBe('page:view');
    expect(GRANTABLE_PERMISSIONS).toContain('page:view');
  });
});
