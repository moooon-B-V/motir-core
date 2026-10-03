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
import { pagesService } from '@/lib/services/pagesService';
import type { TokenGrant } from '@/lib/tokens/grant';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `update_page` (Story MOTIR-5760 · MOTIR-7411) over real Postgres, driven
// through `buildMcpServer` + an in-memory client. The tool is a thin adapter
// over `pagesService.savePageMarkdown`: this asserts that the revision
// `get_page` returns is the one a write needs, that a stale revision is refused
// as an INSTRUCTION (both revisions, call get_page) with nothing written, the
// size cap, and the `page:edit` gate.

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

async function seedPage(ctx: ServiceContext, projectId: string, markdown = 'First draft.') {
  return pagesService.createPageFromMarkdown(ctx, { projectId, title: 'Notes', markdown });
}

describe('update_page', () => {
  it('writes at the revision get_page returned and answers revision + 1', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await seedPage(fx.ctx, fx.projectId);
    const client = await connectClient(fx.ctx, EDIT);

    const read = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id },
    });
    const { revision } = pageOf(read);
    const res = await client.callTool({
      name: 'update_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id, markdown: 'Second draft.', revision },
    });

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(pageOf(res)).toMatchObject({ revision: revision + 1, markdown: 'Second draft.' });
    expect(textOf(res)).toContain(`revision ${revision + 1}`);
    await client.close();
  });

  it('a stale revision is refused PAGE_REVISION_CONFLICT, naming both revisions, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await seedPage(fx.ctx, fx.projectId);
    const stale = seeded.revision;
    // Someone saves after the agent read.
    const current = await pagesService.savePageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: seeded.id,
      markdown: 'A person’s edit.',
      expectedRevision: stale,
    });
    const client = await connectClient(fx.ctx, EDIT);

    const res = await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: 'PROD',
        pageId: seeded.id,
        markdown: 'The agent’s edit.',
        revision: stale,
      },
    });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('PAGE_REVISION_CONFLICT');
    expect(text).toContain(`revision ${current.revision}`);
    expect(text).toContain(`you sent ${stale}`);
    expect(text).toContain('call get_page');

    const after = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id },
    });
    expect(pageOf(after)).toMatchObject({
      revision: current.revision,
      markdown: 'A person’s edit.',
    });
    await client.close();
  });

  it('a body over the cap is refused PAGE_BODY_TOO_LARGE, naming its size and limit', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await seedPage(fx.ctx, fx.projectId);
    const client = await connectClient(fx.ctx, EDIT);
    const markdown = 'x'.repeat(1_048_577);
    const res = await client.callTool({
      name: 'update_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id, markdown, revision: seeded.revision },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAGE_BODY_TOO_LARGE');
    expect(textOf(res)).toContain('1048577 bytes');
    expect(textOf(res)).toContain('1048576 bytes');
    await client.close();
  });

  it('`page:view` without `page:edit` reads the page and is refused the write, naming `page:edit`', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await seedPage(fx.ctx, fx.projectId);
    const client = await connectClient(fx.ctx, ['project:browse', 'page:view']);

    const read = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id },
    });
    expect(read.isError, textOf(read)).toBeFalsy();
    const res = await client.callTool({
      name: 'update_page',
      arguments: { projectKey: 'PROD', pageId: seeded.id, markdown: 'x', revision: 1 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:edit');
    await client.close();
  });

  it('asserts `page:edit` and is annotated reversible, not destructive', () => {
    expect(TOOL_PERMISSIONS.update_page).toBe('page:edit');
    expect(TOOL_ANNOTATIONS.update_page).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});
