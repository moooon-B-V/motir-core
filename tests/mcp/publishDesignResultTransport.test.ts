import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { mcpCatalogue } from '@/lib/apiDocs/mcp';
import * as route from '@/app/api/mcp/route';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const store = new Map<string, { size: number; contentType: string }>();
// The MINT half of the same store (bug MOTIR-4750) — faked as a GRANT rather
// than as a string, so `putUploaded` can refuse a pathname nobody granted.
const minted = new Map<string, { contentType: string; maxBytes: number }>();
// ⚠️ THE FAKE APPLIES THE SAME RANDOM SUFFIX THE REAL HELPER DOES, and that is
// not a detail. `putObject` calls `withRandomSuffix(pathname)` and
// `putPrivateAttachment` RETURNS the key it actually wrote, so a caller that
// registers the pathname it ASKED for names an object that does not exist. A
// fake returning `{ pathname }` unchanged reproduces the helper's contract
// WRONGLY and therefore agrees with that bug — which is exactly what happened
// here: these suites were green while the E2E failed on
// `DESIGN_EVIDENCE_BLOB_MISSING`. A fake that lies about a contract is worse
// than no fake.
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string, body: Buffer, contentType: string) => {
    const dot = pathname.lastIndexOf('.');
    const suffix = randomBytes(5).toString('hex');
    const written =
      dot <= pathname.lastIndexOf('/')
        ? `${pathname}-${suffix}`
        : `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
    store.set(written, { contentType, size: body.byteLength });
    return { pathname: written };
  }),
  mintPrivateUploadToken: vi.fn(
    async (pathname: string, opts: { contentType: string; maxBytes: number }) => {
      minted.set(pathname, { contentType: opts.contentType, maxBytes: opts.maxBytes });
      return `https://store.example/signed/${encodeURIComponent(pathname)}`;
    },
  ),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

// Story MOTIR-3780 · Subtask MOTIR-3782 — the assertion this card is really
// buying: **a CLI-minted token actually REACHES `publish_design_result`.**
//
// It is a test rather than a line to remember because the failure ships GREEN. A
// tool that registers, whose every other suite passes against a workspace PAT,
// and which then refuses the sandboxed agent it was built for is an outage that
// looks like a delivery. That has now happened three times on this exact
// constant — MOTIR-3051, MOTIR-3058, MOTIR-3528 — and the cost here is the
// highest of the four: this tool IS the last step of a design card, so a refusal
// leaves the card empty in precisely the way the CI publisher used to.
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
  const client = new Client({ name: 'publish-design-result-transport', version: '0.0.0' });
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

async function makeItem(fx: WorkItemFixture, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

function callPublish(
  client: Client,
  key: string,
  over: Record<string, unknown> = {},
): ReturnType<Client['callTool']> {
  return client.callTool({
    name: 'publish_design_result',
    arguments: {
      key,
      assets: [
        {
          kind: 'mock',
          sourcePath: 'design/work-items/detail.mock.html',
          contentType: 'text/html',
          contentBase64: b64('<p>detail</p>'),
        },
        {
          kind: 'image',
          sourcePath: 'design/work-items/detail.png',
          contentType: 'image/png',
          contentBase64: b64('PNG\r\n'),
        },
      ],
      noteMd: '## Detail\n\nWhat changed.\n',
      ...over,
    },
  });
}

/** Simulate the agent's own PUT — only to a pathname that was actually granted. */
function putUploaded(pathname: string, size: number): void {
  const grant = minted.get(pathname);
  if (!grant) throw new Error(`no grant was minted for ${pathname}`);
  store.set(pathname, { contentType: grant.contentType, size });
}

beforeEach(async () => {
  store.clear();
  minted.clear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the tool is REGISTERED on the shipped server', () => {
  it('appears in tools/list with the fields its description promises', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'publish_design_result');
    expect(tool, 'publish_design_result is not registered on the shipped server').toBeDefined();

    const schema = tool!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    for (const field of [
      'key',
      'assets',
      'noteMd',
      'commitSha',
      'producedByKey',
      'withinParentKey',
    ]) {
      expect(schema.properties, `tools/list omits \`${field}\``).toHaveProperty(field);
    }
    // The target and the files are required; every provenance field is optional,
    // because a publish that has none of them is still a publish.
    const required = schema.required ?? [];
    expect(required).toEqual(expect.arrayContaining(['key', 'assets']));
    expect(required).not.toContain('noteMd');
    expect(required).not.toContain('commitSha');

    await client.close();
  });
});

describe('the MINT half is registered too (bug MOTIR-4750)', () => {
  // A tool that exists in the source and not on the shipped server is exactly
  // the failure this bug is: `docs/mcp.md` described a door, and the population
  // that needed it could not open one.
  it('appears in tools/list with the fields its description promises', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'create_design_upload');
    expect(tool, 'create_design_upload is not registered on the shipped server').toBeDefined();

    const schema = tool!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    for (const field of ['key', 'files', 'withinParentKey']) {
      expect(schema.properties, `tools/list omits \`${field}\``).toHaveProperty(field);
    }
    const required = schema.required ?? [];
    expect(required).toEqual(expect.arrayContaining(['key', 'files']));
    expect(required).not.toContain('withinParentKey');

    // It says WHY it exists, not merely what it does: an agent that reads only
    // "mints an upload URL" will keep sending base64 until something refuses it.
    expect(tool!.description, 'the two-step instruction').toMatch(/STEP 1 OF 2/);
    expect(tool!.description, 'the reason the inline form is not merely slower').toMatch(
      /never pass through a tool argument/i,
    );
    expect(tool!.description, 'the target rule it shares with the publish').toMatch(/LEAF/);

    // And the published catalogue carries it — home #6, which no `tsc` error
    // reaches.
    const row = mcpCatalogue()
      .flatMap((group) => group.tools)
      .find((t) => t.name === 'create_design_upload');
    expect(row, 'the tool is missing from the published catalogue').toBeDefined();

    await client.close();
  });
});

describe('the DESCRIPTION states each rule this tool depends on', () => {
  // The description is the only briefing an agent gets, and this tool's whole
  // premise is that a DECLARATION replaced an inference. Three of its claims are
  // load-bearing and each is pinned SEPARATELY, because pinning one and letting
  // the others drift is what let `link_pull_request`'s text go stale for a day
  // and strand nine cards (MOTIR-3722).
  //
  // ⚠️ These are not stylistic. Each names a failure the previous mechanism
  // actually produced.
  let tool: { description?: string } | undefined;

  beforeEach(async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await tokenWith(fx, GRANTABLE_PERMISSIONS, 'full'));
    const { tools } = await client.listTools();
    tool = tools.find((t) => t.name === 'publish_design_result');
    await client.close();
  });

  it('says the AGENT must call it — the half that replaced a diff-driven trigger', () => {
    // AMENDMENT 2 Q2 gives up the one property the CI heuristic had: it could
    // not be forgotten. The description is mitigation #1 of the three that
    // replace it, so it must actually carry the instruction.
    expect(tool!.description, 'the operative instruction').toMatch(/Call it yourself/);
  });

  it('says a missing publish is INVISIBLE — the failure mode, not just the task', () => {
    // The retargeted warning from `CLAUDE.md`: files written, commit landed,
    // checks green, card empty. An agent that knows only "call this" will skip
    // it under time pressure; one that knows nothing else will notice is the
    // one that does not.
    expect(tool!.description, 'the silent-failure warning').toMatch(
      /looks exactly like a successful run/,
    );
  });

  it('says SECTIONS, not the whole note — the 396 KB trap', () => {
    expect(tool!.description, 'the note-scoping half').toMatch(/never a whole area note/);
  });

  it('says it targets a LEAF, so a container publish is not attempted', () => {
    expect(tool!.description, 'the target half — §3 of the ADR').toMatch(/LEAF/);
  });

  it('claims `text/html` for THIS path and disclaims it for `attach_file`', () => {
    // §5's one-entrance guarantee, stated on the surface an agent reads. Both
    // halves, because "html is allowed here" without "and refused there" is the
    // sentence that invites someone to widen the generic allowlist.
    expect(tool!.description).toMatch(/text\/html/);
    expect(tool!.description).toMatch(/attach_file.*refuses it/);
  });

  it('states the TWO asset forms, so the big-asset path is discoverable', () => {
    // The bug this closes was not that the mint did not exist — it was that the
    // one door an agent reads about could not carry a real design board. An
    // agent meeting only `contentBase64` will try it and produce nothing.
    expect(tool!.description, 'the two forms').toMatch(/contentBase64/);
    expect(tool!.description).toMatch(/create_design_upload/);
    expect(tool!.description, 'one publish uses one form').toMatch(/one form/);
  });

  it('does NOT claim CI publishes it — the retired mechanism must not come back', () => {
    // The `not.toMatch` half. This tool exists because a CI job used to do
    // this; a description that still mentions one would send an agent to read a
    // job log that will not exist.
    expect(tool!.description).not.toMatch(/CI|job log|design-guards/);
  });

  it('the published CATALOGUE summary agrees with it', () => {
    // Home #3. `mcp-truth.test.ts` pins the summary to the description via a
    // fingerprint; this asserts the summary says the same THING, which a
    // fingerprint cannot.
    const row = mcpCatalogue()
      .flatMap((group) => group.tools)
      .find((t) => t.name === 'publish_design_result');
    expect(row, 'the tool is missing from the published catalogue').toBeDefined();
    const summary = row!.summary;
    expect(summary).toMatch(/design RESULT/);
    expect(summary).not.toMatch(/CI|job log/);
  });
});

describe('GRANTED: the sandboxed-run grant CAN call it', () => {
  it('a token minted on CLI_TOKEN_GRANT publishes a design result end to end', async () => {
    const fx = await makeWorkItemFixture();
    const key = await makeItem(fx, 'Design, published by a dispatched agent');

    // ⚠️ The grant comes from the EXPORTED CONSTANT. Dropping `work_item:edit`
    // from it fails HERE rather than in production, on a design card, silently.
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli-grant'));
    const result = await callPublish(client, key);

    expect(
      result.isError,
      `CLI_TOKEN_GRANT cannot call publish_design_result: ${JSON.stringify(result)}`,
    ).toBeFalsy();

    // Reached the database, not merely the registry.
    const evidence = await adminDb.designEvidence.findFirstOrThrow({ include: { assets: true } });
    expect(evidence.isCurrent).toBe(true);
    expect(evidence.assets).toHaveLength(2);
    expect(evidence.noteMd).toContain('What changed.');

    // …and `text/html` genuinely travelled this path, which is the whole
    // reason the tool exists rather than reusing `attach_file`.
    expect(
      [...store.values()].map((v) => v.contentType).sort(),
      'the mock must have reached the store as text/html',
    ).toEqual(['image/png', 'text/html']);

    await client.close();
  });

  it('mints, uploads and publishes an asset too large to send inline', async () => {
    // The end-to-end shape MOTIR-4750 exists for, over the real transport with
    // the grant a dispatched run actually holds. A mint the sandboxed agent
    // cannot reach would leave this bug exactly where it was found.
    const fx = await makeWorkItemFixture();
    const key = await makeItem(fx, 'Design a multi-sheet board');
    const client = await connect(await tokenWith(fx, CLI_TOKEN_GRANT, 'cli-grant'));

    const grant = await client.callTool({
      name: 'create_design_upload',
      arguments: {
        key,
        files: [
          {
            kind: 'image',
            sourcePath: 'design/ai-chat/planning-workspace.png',
            contentType: 'image/png',
          },
        ],
      },
    });
    expect(
      grant.isError,
      `CLI_TOKEN_GRANT cannot call create_design_upload: ${JSON.stringify(grant)}`,
    ).toBeFalsy();
    const [target] = (grant.structuredContent as { targets: Array<Record<string, unknown>> })
      .targets;
    expect(target!.uploadUrl).toContain('https://store.example/signed/');

    // 3,929,899 bytes — the board measured on MOTIR-4742, which is 5.24 MB of
    // base64 and cannot travel as a tool argument at all.
    putUploaded(target!.pathname as string, 3_929_899);

    const published = await client.callTool({
      name: 'publish_design_result',
      arguments: {
        key,
        assets: [
          {
            kind: 'image',
            sourcePath: 'design/ai-chat/planning-workspace.png',
            pathname: target!.pathname as string,
          },
        ],
        noteMd: '## The planning workspace\n\nWhat changed.\n',
      },
    });
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    const evidence = await adminDb.designEvidence.findFirstOrThrow({ include: { assets: true } });
    expect(evidence.isCurrent).toBe(true);
    expect(evidence.assets).toHaveLength(1);

    await client.close();
  });
});
