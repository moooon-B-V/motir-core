import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import * as route from '@/app/api/mcp/route';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-3525 · Subtask MOTIR-3528, BLOCK 6 — the assertion this story is
// really buying: **a CLI-minted token actually REACHES `link_pull_request`.**
//
// It is a criterion with a test rather than a line to remember because the
// failure ships GREEN. A tool that registers, whose every other suite passes
// against a workspace PAT, and which then refuses the sandboxed agent it was
// built for is an outage that looks like a delivery. That has happened twice on
// this exact constant — MOTIR-3058 (the attach tool) and MOTIR-3051 (a CLI token
// that could open a plan and never fill it, because `CLI_TOKEN_GRANT` held one
// key of the pair).
//
// Every case enters at `app/api/mcp/route.ts` with a bearer token, the way an
// agent does — never by calling the tool function, which skips exactly the
// layers that could be wrong: the auth gate, the permission gate, the
// registration-time schema rewrite, and the registry itself.
//
// ⚠️ THE GRANT IS TAKEN FROM THE EXPORTED CONSTANT, never re-listed here. A
// re-listed copy passes forever; reading `CLI_TOKEN_GRANT` is what makes a later
// NARROWING of it fail HERE instead of silently un-shipping the feature.

const ENDPOINT = 'http://localhost/api/mcp';

function routeFetch(token?: string): typeof fetch {
  return (async (input: unknown, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(init.headers ?? {});
    if (token) headers.set('authorization', `Bearer ${token}`);
    const method = (init.method ?? 'GET').toUpperCase();
    const handler = method === 'GET' ? route.GET : method === 'DELETE' ? route.DELETE : route.POST;
    return handler(new Request(url, { ...init, headers }) as never);
  }) as unknown as typeof fetch;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: routeFetch(token),
  });
  const client = new Client({ name: 'link-pull-request-transport', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function tokenWith(
  fx: WorkItemFixture,
  permissions: readonly PermissionKey[],
  label: string,
): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    fixedGrant: [...permissions],
  });
  return token;
}

const OWNER = 'moooon';
const REPO_NAME = 'transport-alpha';
const INSTALLATION_ID = 'inst-link-pr-transport';

/** A repo connected in the fixture's workspace, behind an installation bound to
 *  NO workspace — Motir's shared provisioning shape (MOTIR-1931). */
async function connectRepo(fx: WorkItemFixture): Promise<string> {
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION_ID },
    create: {
      installationId: INSTALLATION_ID,
      workspaceId: null,
      accountLogin: OWNER,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      repoId: '970001',
      owner: OWNER,
      name: REPO_NAME,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  return repo.id;
}

async function makeItem(fx: WorkItemFixture, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

function callLink(
  client: Client,
  key: string,
  over: Record<string, unknown> = {},
): ReturnType<Client['callTool']> {
  return client.callTool({
    name: 'link_pull_request',
    arguments: {
      key,
      repository: `${OWNER}/${REPO_NAME}`,
      number: 2291,
      headRef: 'subtask/MOTIR-3526-link',
      baseRef: 'main',
      title: 'feat(mcp): link_pull_request',
      ...over,
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('block 6 — the tool is REGISTERED on the shipped server', () => {
  it('appears in tools/list with both address forms and the row-seeding fields', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'link_pull_request');
    expect(tool, 'link_pull_request is not registered on the shipped server').toBeDefined();

    const schema = tool!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    // A caller reading the surface must find everything the description promises.
    for (const field of ['key', 'repository', 'number', 'url', 'headRef', 'baseRef', 'title']) {
      expect(schema.properties, `tools/list omits \`${field}\``).toHaveProperty(field);
    }
    // Neither address form is required on its own — the tool decides, and says
    // which is missing — but the item and the row-seeding refs are.
    const required = schema.required ?? [];
    expect(required).toEqual(expect.arrayContaining(['key', 'headRef', 'baseRef']));
    expect(required).not.toContain('url');
    expect(required).not.toContain('repository');

    // The description is the only briefing an agent gets, and the cardinality is
    // the half it must not misread. Pinning only part of it is what let the text
    // go stale twice: for a day it said one pull request "cannot point at two"
    // work items, an agent delivering a parent and its children by one pull
    // request read that as "link the children", and each call walked the singular
    // link off the last (MOTIR-3722, motir-core#2353).
    //
    // ⚠️ THE PINS ARE INVERTED BY MOTIR-3757, and that is this card's deliverable
    // rather than a fixture repair. The `MOVES` pin was correct while
    // `github_pull_request.work_item_id` existed; with that column dropped a
    // second link ADDS, so the text must say so and must NOT say the old thing.
    expect(tool!.description, 'the cardinality — a re-link ADDS').toMatch(/ADDS/);
    expect(tool!.description, 'the correction door — only unlink removes a link').toMatch(
      /unlink_pull_request/,
    );
    expect(
      tool!.description,
      'the parent/children case is still ANSWERED, whichever way it is declared',
    ).toMatch(/PARENT/);
    // ⚠️ And neither retired claim may come back: the dual write falsified the
    // first, and the column drop the second.
    expect(tool!.description).not.toMatch(/cannot point at two/);
    expect(tool!.description).not.toMatch(/MOVES/);
    await client.close();
  });
});

describe('block 6 — GRANTED: the sandboxed-run grant CAN call it', () => {
  it('a token minted on CLI_TOKEN_GRANT links a pull request end to end', async () => {
    const fx = await makeWorkItemFixture();
    const repoRowId = await connectRepo(fx);
    const key = await makeItem(fx, 'Linked by a dispatched agent');

    // ⚠️ The grant comes from the EXPORTED CONSTANT. Dropping `work_item:edit`
    // from it fails HERE rather than in production.
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli-grant'));
    const result = await callLink(client, key);

    expect(result.isError, 'CLI_TOKEN_GRANT cannot call link_pull_request').toBeFalsy();
    expect(result.structuredContent).toMatchObject({ key, created: true });
    // `movedFrom` retired with the column it reported on (MOTIR-3757).
    expect(result.structuredContent).not.toHaveProperty('movedFrom');

    // Reached the database, not merely the registry.
    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: repoRowId, number: 2291 },
    });
    expect(row.linkedManually).toBe(true);
    expect(await adminDb.workItemDelivery.count({ where: { githubPullRequestId: row.id } })).toBe(
      1,
    );
    await client.close();
  });

  it('the grant carries the key this tool actually asserts', () => {
    // Stated as the RELATIONSHIP, so renaming the permission cannot leave a
    // passing test beside a broken grant — and so this card's claim that
    // CLI_TOKEN_GRANT needs no widening is asserted rather than assumed.
    expect(CLI_TOKEN_GRANT).toContain(TOOL_PERMISSIONS.link_pull_request);
  });
});

describe('block 6 — GATED: a token without the edit key never reaches the row', () => {
  it('is refused, and no change-request row is written', async () => {
    const fx = await makeWorkItemFixture();
    const repoRowId = await connectRepo(fx);
    const key = await makeItem(fx, 'Not linkable by a read-only token');

    const withheld = GRANTABLE_PERMISSIONS.filter((k) => k !== TOOL_PERMISSIONS.link_pull_request);
    const client = await connect(await tokenWith(fx, withheld, 'no-edit'));
    const result = await callLink(client, key);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(TOOL_PERMISSIONS.link_pull_request);
    // THE assertion — not "it returned an error", but that nothing was written.
    expect(await adminDb.githubPullRequest.count({ where: { repoId: repoRowId } })).toBe(0);
    await client.close();
  });
});

describe('block 6 — an unknown argument is REFUSED over the wire, never dropped', () => {
  it('the strict-input gate names the offending key', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx);
    const key = await makeItem(fx, 'Strict input');
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    // `pullRequest` is the plausible-but-wrong name for `url` — exactly the kind
    // of slip that must come back readable rather than silently vanish.
    const result = await callLink(client, key, { pullRequest: 'https://github.com/a/b/pull/1' });
    expect(JSON.stringify(result)).toContain('pullRequest');
    await client.close();
  });
});
