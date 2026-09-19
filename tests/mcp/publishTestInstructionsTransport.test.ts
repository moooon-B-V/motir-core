import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { CLI_TOKEN_GRANT, toolPermission } from '@/lib/mcp/toolPermissions';
import * as route from '@/app/api/mcp/route';
import type { PermissionKey } from '@/lib/permissions/catalog';
import {
  TEST_INSTRUCTIONS_MAX_BODY_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
} from '@/lib/testInstructions/caps';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { organizationIdOf } from '../helpers/organizationOf';

// `publish_test_instructions` OVER THE SHIPPED TRANSPORT (Story MOTIR-4906 ·
// MOTIR-5331). The assertion this card is really buying: **a CLI-minted token
// REACHES the door**, through the auth gate, the permission gate and the
// registry — the layers a direct function call skips. The door exists for the
// dispatched agent; a tool that passes every unit suite against a workspace PAT
// and refuses the runner is the outage MOTIR-3051 / MOTIR-4704 recorded.
//
// ⚠️ THE GRANT IS READ FROM THE EXPORTED CONSTANT, never re-listed, so a later
// narrowing of `CLI_TOKEN_GRANT` fails HERE.

const ENDPOINT = 'http://localhost/api/mcp';
const SHA = 'a1b2c3d'.padEnd(40, '0');

function routeFetch(token: string): typeof fetch {
  return (async (input: unknown, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', `Bearer ${token}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const handler = method === 'GET' ? route.GET : method === 'DELETE' ? route.DELETE : route.POST;
    return handler(new Request(url, { ...init, headers }) as never);
  }) as unknown as typeof fetch;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: routeFetch(token),
  });
  const client = new Client({ name: 'publish-test-instructions-transport', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function tokenWith(
  fx: WorkItemFixture,
  permissions: readonly PermissionKey[],
  label: string,
) {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    fixedGrant: [...permissions],
  });
  return token;
}

async function scenario() {
  const fx = await makeWorkItemFixture();
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Story' },
    fx.ctx,
  );
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: 'repo-web',
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name: 'web',
  });
  return { fx, card, repo };
}

const BODY =
  '## Precondition\n\nSign in as a member.\n\n## Locally\n\n```sh\npnpm install --frozen-lockfile\n```\n\n```sh\npnpm dev\n```\n\n## Click-path\n\n1. Open the item\n2. Scroll to How to test';

const CALL = (key: string) => ({
  name: 'publish_test_instructions',
  arguments: {
    key,
    bodyMd: BODY,
    repos: [{ repo: 'acme/web', commitSha: SHA }],
    previewPath: '/items/ACME-1',
  },
});

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('publish_test_instructions over /api/mcp', () => {
  it('is listed with every field and states the caps in its schema', async () => {
    const { fx } = await scenario();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'publish_test_instructions');
    expect(tool, 'publish_test_instructions is not registered').toBeDefined();

    const schema = tool!.inputSchema as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    for (const field of ['key', 'bodyMd', 'repos', 'previewPath']) {
      expect(schema.properties, `tools/list omits \`${field}\``).toHaveProperty(field);
    }
    // ⚠️ `repos` is NOT required (MOTIR-5689) — a person's form names no
    // repository — and the schema must say so, or an agent's SDK refuses the
    // body-only call before it reaches the door. Asserted in BOTH directions so
    // a required list cannot creep back in and a required BODY cannot fall out.
    expect(schema.required).toEqual(expect.arrayContaining(['key', 'bodyMd']));
    expect(schema.required).not.toContain('repos');
    const body = schema.properties.bodyMd!.description ?? '';
    expect(body).toContain('SECTIONS');
    expect(body).toContain('fenced code block');
    expect(body).toContain('click-to-copy');
    expect(body).toContain(String(TEST_INSTRUCTIONS_MAX_BODY_BYTES / 1024));
    const repos = schema.properties.repos!.description ?? '';
    expect(repos).toContain(String(TEST_INSTRUCTIONS_MAX_REPOS));
    // Optional to the SCHEMA, mandatory to an AGENT — the description is the
    // only place that distinction can be made, so it is asserted.
    expect(repos).toContain('SEND ONE PER REPOSITORY YOU PUSHED TO');
    await client.close();
  });

  it('asserts work_item:edit, which CLI_TOKEN_GRANT already carries', () => {
    expect(toolPermission('publish_test_instructions')).toBe('work_item:edit');
    expect(CLI_TOKEN_GRANT).toContain('work_item:edit');
  });

  it('a token with EXACTLY CLI_TOKEN_GRANT publishes on a STORY, and the record and its section read back', async () => {
    const { fx, card, repo } = await scenario();
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli'));

    const result = await client.callTool(CALL(card.identifier));
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workItemKey: card.identifier,
      repos: [{ repoId: repo.id, commitSha: SHA }],
      created: true,
    });

    const rows = await adminDb.testInstructions.findMany({
      where: { workItemId: card.id },
      include: { repos: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bodyMd: BODY,
      previewPath: '/items/ACME-1',
      publishedById: fx.ownerId,
      isCurrent: true,
    });
    expect(rows[0]!.repos).toHaveLength(1);
    expect(rows[0]!.repos[0]).toMatchObject({ repoId: repo.id, commitSha: SHA });
    await client.close();
  });

  it('the same call twice stores ONE row — a retry is safe through the transport', async () => {
    const { fx, card } = await scenario();
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli-retry'));

    await client.callTool(CALL(card.identifier));
    const second = await client.callTool(CALL(card.identifier));
    expect(second.structuredContent).toMatchObject({ created: false });
    expect(await adminDb.testInstructions.count({ where: { workItemId: card.id } })).toBe(1);
    await client.close();
  });

  it('a token WITHOUT work_item:edit is refused at the gate and writes nothing', async () => {
    const { fx, card } = await scenario();
    const client = await connect(
      await tokenWith(
        fx,
        GRANTABLE_PERMISSIONS.filter((k) => k !== 'work_item:edit'),
        'no-edit',
      ),
    );
    const result = await client.callTool(CALL(card.identifier));
    expect(result.isError).toBe(true);
    const first = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(first?.text).toMatch(/PERMISSION_NOT_GRANTED/);
    expect(first?.text).toContain('work_item:edit');
    expect(await adminDb.testInstructions.count()).toBe(0);
    await client.close();
  });
});
