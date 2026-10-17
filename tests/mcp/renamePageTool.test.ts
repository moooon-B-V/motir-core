import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import type { PageMarkdownDto, PageSummaryDto } from '@/lib/dto/pages';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { pagesService } from '@/lib/services/pagesService';
import type { TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `rename_page` (MOTIR-8841) over real Postgres, driven through `buildMcpServer`
// + an in-memory client. The tool is a thin adapter over
// `pagesService.renamePage`: this asserts the title changes with no body write
// and no new version (so no `revision` is needed), that the body is untouched,
// an over-long title is refused by the page package's own code, and the
// `page:edit` gate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const EDIT: TokenGrant = ['project:browse', 'page:view', 'page:edit'];

async function connectClient(ctx: ServiceContext, grant: TokenGrant): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    () => [...grant],
  );
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

function structured<T>(res: unknown): T {
  return (res as CallToolResult).structuredContent as unknown as T;
}

describe('rename_page', () => {
  it('sets the title without a revision, leaving the body and its newest version alone', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await pagesService.createPageFromMarkdown(fx.ctx, {
      projectId: fx.projectId,
      title: 'Wrong title',
      markdown: 'The body.',
    });
    const client = await connectClient(fx.ctx, EDIT);
    const before = structured<PageMarkdownDto>(
      await client.callTool({
        name: 'get_page',
        arguments: { projectKey: 'PROD', pageId: seeded.id },
      }),
    );

    const res = await client.callTool({
      name: 'rename_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id, title: 'Right title' },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(structured<PageSummaryDto>(res)).toMatchObject({
      id: seeded.id,
      title: 'Right title',
    });
    expect(textOf(res)).toContain(`Renamed page ${seeded.id} to Right title.`);

    const after = structured<PageMarkdownDto>(
      await client.callTool({
        name: 'get_page',
        arguments: { projectKey: 'PROD', pageId: seeded.id },
      }),
    );
    expect(after.title).toBe('Right title');
    expect(after.markdown).toBe('The body.');
    expect(after.latestVersion?.number).toBe(before.latestVersion?.number);
    await client.close();
  });

  it('an empty title makes the page untitled', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await pagesService.createPageFromMarkdown(fx.ctx, {
      projectId: fx.projectId,
      title: 'Notes',
      markdown: 'x',
    });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'rename_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id, title: '   ' },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(structured<PageSummaryDto>(res).title).toBe('');
    expect(textOf(res)).toContain(`Renamed page ${seeded.id} to Untitled.`);
    await client.close();
  });

  it('a title over 255 characters is refused PAGE_TITLE_TOO_LONG and the title stands', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await pagesService.createPageFromMarkdown(fx.ctx, {
      projectId: fx.projectId,
      title: 'Keep me',
      markdown: 'x',
    });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'rename_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id, title: 'x'.repeat(256) },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_TITLE_TOO_LONG');
    const after = structured<PageMarkdownDto>(
      await client.callTool({
        name: 'get_page',
        arguments: { projectKey: 'PROD', pageId: seeded.id },
      }),
    );
    expect(after.title).toBe('Keep me');
    await client.close();
  });

  it('a page id that names nothing is PAGE_NOT_FOUND', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx, EDIT);
    const res = await client.callTool({
      name: 'rename_page',
      arguments: { projectKey: 'PROD', pageId: 'page_missing', title: 'x' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_NOT_FOUND');
    await client.close();
  });

  it('`page:view` without `page:edit` is refused the write, naming `page:edit`', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await pagesService.createPageFromMarkdown(fx.ctx, {
      projectId: fx.projectId,
      title: 'Notes',
      markdown: 'x',
    });
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view']);
    const res = await client.callTool({
      name: 'rename_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id, title: 'x' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:edit');
    await client.close();
  });

  it('asserts `page:edit` and is annotated an idempotent destructive write', () => {
    expect(TOOL_PERMISSIONS.rename_page).toBe('page:edit');
    expect(TOOL_ANNOTATIONS.rename_page).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });
});
