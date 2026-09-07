import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import * as route from '@/app/api/mcp/route';
import { mcpToolRows } from '@/lib/apiDocs/mcp';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The store, faked as a store — see `publishAcceptanceResultTool.test.ts` for
// why the mint has to be faked as a GRANT rather than as a string.
const store = new Map<string, { size: number; contentType: string }>();
const minted = new Map<string, string>();

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  mintPrivateUploadToken: vi.fn(async (pathname: string, opts: { contentType: string }) => {
    minted.set(pathname, opts.contentType);
    return `https://store.example/signed/${encodeURIComponent(pathname)}`;
  }),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/get/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

// Bug MOTIR-4704 — the assertion this card is really buying: **a CLI-minted
// token actually REACHES both acceptance publish tools, over the shipped
// transport.**
//
// It is a test rather than a line to remember because the failure ships GREEN,
// and this bug is the proof: for four days three documents told an agent to
// publish "over the Motir MCP surface" while that surface carried no acceptance
// publisher at all, and nothing anywhere went red. A tool that registers, passes
// every unit suite against a workspace PAT, and then refuses the dispatched
// runner it was built for would be the same outage one layer in — the shape
// MOTIR-3051 / MOTIR-3058 / MOTIR-3528 have each produced on this constant.
//
// Every case enters at `app/api/mcp/route.ts` with a bearer token, the way a
// runner does — never by calling the tool function, which skips exactly the
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
  const client = new Client({ name: 'publish-acceptance-transport', version: '0.0.0' });
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

async function makeStory(fx: WorkItemFixture, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title },
    fx.ctx,
  );
  return item.identifier;
}

/** The structured payload of a tool call result. */
function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

beforeEach(async () => {
  store.clear();
  minted.clear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('both tools are REGISTERED on the shipped server', () => {
  it('appear in tools/list with the fields their descriptions promise', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    const { tools } = await client.listTools();

    const mint = tools.find((t) => t.name === 'create_acceptance_upload');
    expect(mint, 'create_acceptance_upload is not registered on the shipped server').toBeDefined();
    const mintSchema = mint!.inputSchema as { properties: Record<string, unknown> };
    for (const field of ['key', 'hasTrace']) {
      expect(mintSchema.properties, `tools/list omits \`${field}\``).toHaveProperty(field);
    }

    const publish = tools.find((t) => t.name === 'publish_acceptance_result');
    expect(
      publish,
      'publish_acceptance_result is not registered on the shipped server',
    ).toBeDefined();
    const publishSchema = publish!.inputSchema as { properties: Record<string, unknown> };
    for (const field of [
      'key',
      'videoPathname',
      'tracePathname',
      'chapters',
      'commitSha',
      'producedByKey',
    ]) {
      expect(publishSchema.properties, `tools/list omits \`${field}\``).toHaveProperty(field);
    }
  });

  it('say the two things an agent has to know, and each half is pinned', () => {
    // ⚠️ ONE REGEX PER CLAIM, deliberately. A description states a RULE in
    // several halves, and a regex on one word lets the others rot silently
    // (MOTIR-3722's lesson). The two claims that must survive any rewording:
    // the publish is the AGENT's to make, and it is TWO calls because the bytes
    // do not travel as an argument. An agent that loses either goes looking for
    // a one-shot tool, or for a CI lane that no longer exists.
    const rows = mcpToolRows();
    const summaryOf = (name: string) => rows.find((r) => r.name === name)?.summary ?? '';

    expect(summaryOf('create_acceptance_upload')).toMatch(/step 1 of 2/i);
    expect(summaryOf('publish_acceptance_result')).toMatch(/nothing else publishes it/i);
    // The retired mechanism must NOT come back in the prose: CI does not upload
    // the recording, and a summary that says it does would re-create the belief
    // this bug is made of.
    expect(summaryOf('publish_acceptance_result')).not.toMatch(/\bCI\b/);
  });
});

describe('a CLI-minted token REACHES both tools', () => {
  it('mints, then registers, on the grant a dispatched run actually holds', async () => {
    const fx = await makeWorkItemFixture();
    // The grant is READ, never re-listed — a narrowing of it must fail here.
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli'));
    const key = await makeStory(fx, 'A story a runner just recorded');

    const grant = await client.callTool({
      name: 'create_acceptance_upload',
      arguments: { key },
    });
    expect(grant.isError, JSON.stringify(grant)).toBeFalsy();
    const video = payload(grant).video as Record<string, unknown>;
    const pathname = video.pathname as string;
    expect(minted.get(pathname)).toBe('video/webm');

    // The agent's own PUT, which goes nowhere near Motir.
    store.set(pathname, { contentType: 'video/webm', size: 4096 });

    const published = await client.callTool({
      name: 'publish_acceptance_result',
      arguments: {
        key,
        videoPathname: pathname,
        chapters: [{ label: 'Open the item', tSeconds: 0 }],
        commitSha: 'abc123',
        producedByKey: key,
      },
    });
    expect(published.isError, JSON.stringify(published)).toBeFalsy();
    expect(payload(published).status).toBe('pending');

    const evidence = await adminDb.acceptanceEvidence.findFirstOrThrow();
    expect(payload(published).id).toBe(evidence.id);
  });

  it('refuses a token that holds only `project:browse`', async () => {
    // The receipt READ is `project:browse` on purpose (MOTIR-4144's least
    // privilege); publishing is not. A credential minted to let the lane guard
    // LOOK at receipts must not be able to write one.
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, ['project:browse'], 'read-only'));
    const key = await makeStory(fx, 'A story a read-only token may not touch');

    const grant = await client.callTool({
      name: 'create_acceptance_upload',
      arguments: { key },
    });

    expect(grant.isError).toBe(true);
    // ⚠️ AND NOTHING WAS MINTED — the refusal lands before a presigned PUT into
    // the workspace's object store is handed to a caller that may not write one.
    expect(minted.size).toBe(0);
  });
});
