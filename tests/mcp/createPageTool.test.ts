import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import type { PageMarkdownDto } from '@/lib/dto/pages';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { parseMarkdown, serializeMarkdown } from '@/lib/pages';
import { foldersService } from '@/lib/services/foldersService';
import { GRANTABLE_PERMISSIONS, type TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `create_page` (Story MOTIR-5760 · MOTIR-7411) over real Postgres, driven
// through `buildMcpServer` + an in-memory client — the `getPageTool.test.ts`
// pattern. The tool is a thin adapter over `pagesService.createPageFromMarkdown`:
// this asserts the placements it files under, that a refused parent creates
// nothing, that the returned revision is one `update_page` accepts, and the
// `page:edit` gate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const EDIT: TokenGrant = ['project:browse', 'page:view', 'page:edit'];

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

function pageOf(res: unknown): PageMarkdownDto {
  return (res as CallToolResult).structuredContent as unknown as PageMarkdownDto;
}

const BODY = '# Decision\n\nWe ship *pages* to agents.\n\n- read\n- write';

describe('create_page', () => {
  it('files a page in a folder with its markdown, at a revision update_page accepts', async () => {
    const fx = await makeWorkItemFixture();
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Decisions' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'create_page',
      arguments: {
        projectKey: 'PROD',
        title: 'Pages for agents',
        markdown: BODY,
        parent: { kind: 'folder', id: folder.id },
      },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    const page = pageOf(res);
    expect(page.placement).toEqual({ parentPageId: null, folderId: folder.id });
    expect(page.title).toBe('Pages for agents');
    expect(page.markdown).toBe(serializeMarkdown(parseMarkdown(BODY)));
    expect(textOf(res)).toContain(`/pages/${page.id}`);
    expect(textOf(res)).toContain(`revision ${page.revision}`);

    const updated = await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: 'PROD',
        pageId: page.id,
        markdown: `${BODY}\n- review`,
        revision: page.revision,
      },
    });
    expect(updated.isError, textOf(updated)).toBeFalsy();
    expect(pageOf(updated).revision).toBe(page.revision + 1);
    await client.close();
  });

  it('files a sub-page under a page parent, and at the root with no parent', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx, EDIT);

    const root = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', title: 'Parent' },
    });
    expect(root.isError, textOf(root)).toBeFalsy();
    expect(pageOf(root).placement).toEqual({ parentPageId: null, folderId: null });
    expect(pageOf(root).markdown).toBe('');

    const child = await client.callTool({
      name: 'create_page',
      arguments: {
        projectKey: 'PROD',
        markdown: 'A child.',
        parent: { kind: 'page', id: pageOf(root).id },
      },
    });
    expect(child.isError, textOf(child)).toBeFalsy();
    expect(pageOf(child).placement).toEqual({ parentPageId: pageOf(root).id, folderId: null });
    await client.close();
  });

  it('refuses a work item as the parent by name, and creates no page', async () => {
    const fx = await makeWorkItemFixture();
    const task = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'create_page',
      arguments: {
        projectKey: 'PROD',
        markdown: BODY,
        parent: { kind: 'work_item', id: task.id },
      },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_PARENT_NOT_ALLOWED');
    expect(await adminDb.page.count({ where: { projectId: fx.projectId } })).toBe(0);
    await client.close();
  });

  it('a folder or page parent with no id is refused before anything is written', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx, EDIT);
    const res = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', parent: { kind: 'folder' } },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_PARENT_ID_REQUIRED');
    expect(await adminDb.page.count({ where: { projectId: fx.projectId } })).toBe(0);
    await client.close();
  });

  it('a body over the cap is refused PAGE_BODY_TOO_LARGE and creates no page', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx, EDIT);
    const res = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', markdown: 'x'.repeat(1_048_577) },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_BODY_TOO_LARGE');
    expect(await adminDb.page.count({ where: { projectId: fx.projectId } })).toBe(0);
    await client.close();
  });

  it('a grant with `page:view` but not `page:edit` is refused, naming `page:edit`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view']);
    const res = await client.callTool({
      name: 'create_page',
      arguments: { projectKey: 'PROD', markdown: BODY },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:edit');
    await client.close();
  });

  it('asserts `page:edit`, which makes the key grantable, and is not destructive', () => {
    expect(TOOL_PERMISSIONS.create_page).toBe('page:edit');
    expect(GRANTABLE_PERMISSIONS).toContain('page:edit');
    expect(TOOL_ANNOTATIONS.create_page).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});
