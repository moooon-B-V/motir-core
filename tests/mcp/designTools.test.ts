import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WorkItem } from '@/generated/prisma/client';

// The blob STORE is the one mocked external. The verdict ladder, the permission
// gate and the presign all run for real against real Postgres.
const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string, bytes: Buffer, contentType: string) => {
    store.set(pathname, { contentType, size: bytes.byteLength });
    return { pathname };
  }),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/${pathname}?sig=x`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { runGetDesign, GET_DESIGN_TOOL_NAME } = await import('@/lib/mcp/tools/getDesign');
const { runListDesigns, LIST_DESIGNS_TOOL_NAME } = await import('@/lib/mcp/tools/listDesigns');
const { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { MCP_TOOL_NAMES, buildMcpServer } = await import('@/lib/mcp/registry');
const { isExemptTool } = await import('@/lib/mcp/payloads/exemptions');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { makeWorkItemFixture } = await import('../fixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');
const { makeWorkWaitOn } = await import('../helpers/designWaits');
import { shaFor } from '../helpers/commitShaFixtures';

// `get_design` / `list_designs` (Story MOTIR-5553 · Subtask MOTIR-5561).
//
// The verdict RULES are `designAccessService`'s and are driven in its own suite.
// What this file asserts is what only the TOOL layer can be wrong about: the
// wiring, the permission, and — the part that matters most for a tool — that the
// PROSE an agent reads carries the same facts as the structured payload. A tool
// whose summary omits the reason, or the expiry warning, leaves the agent acting
// on a channel that does not say what happened.

type Fixture = Awaited<ReturnType<typeof makeWorkItemFixture>>;
let fx: Fixture;
let parentStoryId: string;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Holder' },
    fx.ctx,
  );
  parentStoryId = story.id;
});

async function designCard(title: string): Promise<WorkItem> {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: parentStoryId, title, type: 'design' },
    fx.ctx,
  );
  await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
}

async function publishAndApprove(card: WorkItem, label: string): Promise<string> {
  const prefix = designPrefix(fx.workspaceId, card.id);
  const assets = [
    {
      kind: 'mock' as const,
      sourcePath: `design/frame/${label}.mock.html`,
      pathname: `${prefix}${label}.mock.html`,
    },
    {
      kind: 'note_file' as const,
      sourcePath: 'design/frame/design-notes.md',
      pathname: `${prefix}${label}.md`,
    },
  ];
  for (const a of assets) store.set(a.pathname, { contentType: 'text/html', size: 64 });
  const evidence = await designEvidenceService.recordFromPathnames(
    { workItemId: card.id, assets, commitSha: shaFor(label) },
    fx.ctx,
  );
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidence.id, kind: 'design_result', state: 'awaiting' },
  });
  await approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
    fx.ctx,
  );
  return evidence.id;
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('\n');

describe('wiring', () => {
  it('both tools are registered, read-scoped on `project:browse`, and NOT exempt', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_DESIGN_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(LIST_DESIGNS_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_DESIGN_TOOL_NAME]).toBe('project:browse');
    expect(TOOL_PERMISSIONS[LIST_DESIGNS_TOOL_NAME]).toBe('project:browse');
    // They DERIVE from the v1 components; neither is excused from the seam.
    expect(isExemptTool(GET_DESIGN_TOOL_NAME)).toBe(false);
    expect(isExemptTool(LIST_DESIGNS_TOOL_NAME)).toBe(false);
  });

  it('the GRANT IS NOT WIDENED — both tools need a key `CLI_TOKEN_GRANT` already carried', () => {
    // The property the whole feature rests on: a sandboxed run reaches the
    // designs with the credential it already holds, so nothing here has to
    // widen what a dispatched agent can do.
    //
    // ⚠️ ASSERTED AS MEMBERSHIP, not as the grant's whole contents. The grant's
    // exact set is pinned in its own suite and legitimately grows; re-pinning it
    // here would make an unrelated key addition red this file, which is the
    // second-home drift a guard is supposed to prevent rather than create.
    for (const tool of [GET_DESIGN_TOOL_NAME, LIST_DESIGNS_TOOL_NAME] as const) {
      expect(CLI_TOKEN_GRANT).toContain(TOOL_PERMISSIONS[tool]);
    }
  });
});

describe('`get_design`', () => {
  it('reports the version, every file and a link, in BOTH channels', async () => {
    const card = await designCard('The surface');
    await makeWorkWaitOn(card.id, fx, { title: 'Build it' });
    const evidenceId = await publishAndApprove(card, 'v1');

    const result = await runGetDesign({ key: card.identifier }, fx.ctx);
    const text = textOf(result);
    const payload = result.structuredContent as {
      verdict: string;
      design: { evidenceId: string; assets: Array<{ url?: string; sourcePath: string }> };
    };

    expect(payload.verdict).toBe('approved');
    expect(payload.design.evidenceId).toBe(evidenceId);
    expect(payload.design.assets).toHaveLength(2);
    expect(payload.design.assets.every((a) => typeof a.url === 'string')).toBe(true);

    // The PROSE carries the same facts — the version, each path, each link.
    expect(text).toContain('APPROVED');
    expect(text).toContain(evidenceId);
    for (const asset of payload.design.assets) {
      expect(text).toContain(asset.sourcePath);
      expect(text).toContain(asset.url!);
    }
    // …and the expiry warning, which is the one instruction an agent must act on
    // before it does anything else.
    expect(text).toMatch(/EXPIRE within minutes/);
    expect(text).toMatch(/OUTSIDE the repository checkout/);
  });

  it('a NOT-approved card reports the reason and what to do, in both channels', async () => {
    const card = await designCard('Still in review');
    await makeWorkWaitOn(card.id, fx, { title: 'Build it' });

    const result = await runGetDesign({ key: card.identifier }, fx.ctx);
    const payload = result.structuredContent as { verdict: string; reason: string };
    expect(payload).toMatchObject({ verdict: 'not_approved', reason: 'not_done' });
    const text = textOf(result);
    expect(text).toContain('NO APPROVED DESIGN (not_done)');
    expect(text).toMatch(/Do NOT build the surface against an unapproved design/);
  });

  it('an UNAVAILABLE asset is named as such and gets no link', async () => {
    const card = await designCard('Reclaimed');
    await makeWorkWaitOn(card.id, fx, { title: 'Build it' });
    const evidenceId = await publishAndApprove(card, 'v1');
    await adminDb.designAsset.updateMany({
      where: { designEvidenceId: evidenceId },
      data: { attachmentId: null },
    });

    const result = await runGetDesign({ key: card.identifier }, fx.ctx);
    const payload = result.structuredContent as {
      design: { assets: Array<{ state: string; url?: string }> };
    };
    expect(payload.design.assets.every((a) => a.state === 'unavailable')).toBe(true);
    expect(payload.design.assets.every((a) => a.url === undefined)).toBe(true);
    expect(textOf(result)).toContain('UNAVAILABLE');
    // It is still the approved design — the prose must not read as an error.
    expect(textOf(result)).toContain('it is still the design that was approved');
  });
});

describe('`list_designs`', () => {
  it('`blockersOf` answers one verdict per design the card waits on', async () => {
    const approved = await designCard('Approved one');
    const pending = await designCard('Pending one');
    const dependent = await makeWorkWaitOn(approved.id, fx, { title: 'Build it' });
    await workItemsService.linkWorkItems(
      { fromId: dependent.id, toId: pending.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await publishAndApprove(approved, 'v1');

    const result = await runListDesigns(
      { projectKey: fx.projectIdentifier, blockersOf: dependent.key },
      fx.ctx,
    );
    const payload = result.structuredContent as { designs: Array<{ verdict: string }> };
    expect(payload.designs).toHaveLength(2);
    expect(payload.designs.filter((d) => d.verdict === 'approved')).toHaveLength(1);

    const text = textOf(result);
    expect(text).toContain(approved.identifier);
    expect(text).toContain(pending.identifier);
    // The instruction an agent needs when a design is missing.
    expect(text).toMatch(/must not improvise a surface for/i);
  });

  it('the project listing pages and filters, and carries NO links on either arm', async () => {
    const cards: WorkItem[] = [];
    for (let i = 0; i < 2; i += 1) {
      const card = await designCard(`Surface ${i}`);
      await makeWorkWaitOn(card.id, fx, { title: `Build ${i}` });
      await publishAndApprove(card, `s${i}`);
      cards.push(card);
    }

    const all = await runListDesigns({ projectKey: fx.projectIdentifier }, fx.ctx);
    const page = all.structuredContent as {
      items: Array<{ designCardKey: string; assets: Array<{ url?: string }> }>;
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.designCardKey).toBe(cards[1]!.identifier);
    for (const design of page.items) {
      for (const asset of design.assets) expect(asset.url).toBeUndefined();
    }
    expect(textOf(all)).toContain('Call `get_design`');

    const filtered = await runListDesigns(
      { projectKey: fx.projectIdentifier, pathPrefix: 'design/frame/s1' },
      fx.ctx,
    );
    const filteredPage = filtered.structuredContent as {
      items: Array<{ designCardKey: string }>;
    };
    expect(filteredPage.items.map((d) => d.designCardKey)).toEqual([cards[1]!.identifier]);

    const firstPage = (await runListDesigns({ projectKey: fx.projectIdentifier, limit: 1 }, fx.ctx))
      .structuredContent as { items: unknown[]; nextCursor: string | null };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
  });

  it('a card waiting on nothing says so rather than answering an empty list', async () => {
    const lonely = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        parentId: parentStoryId,
        title: 'Alone',
        type: 'code',
      },
      fx.ctx,
    );
    const result = await runListDesigns(
      { projectKey: fx.projectIdentifier, blockersOf: lonely.identifier },
      fx.ctx,
    );
    expect((result.structuredContent as { designs: unknown[] }).designs).toEqual([]);
    expect(textOf(result)).toMatch(/waits on no design cards/);
  });
});

describe('the REGISTERED tools — driven through a real MCP handshake', () => {
  // The suites above call `runGetDesign` / `runListDesigns` directly, which is
  // the right altitude for behaviour. This one goes through `registerTool` and
  // the client, because that path carries two arms nothing else reaches: the
  // registration itself, and the `toToolError` wrapper that turns a thrown
  // service error into a tool RESULT rather than a transport failure.
  async function connectClient(ctx: typeof fx.ctx): Promise<InstanceType<typeof Client>> {
    const server = buildMcpServer(() => ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'design-tools', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('both tools appear in `tools/list` with their titles and schemas', async () => {
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(GET_DESIGN_TOOL_NAME);
    expect(names).toContain(LIST_DESIGNS_TOOL_NAME);

    const get = tools.find((t) => t.name === GET_DESIGN_TOOL_NAME)!;
    expect(get.inputSchema.required).toEqual(['key']);
    const list = tools.find((t) => t.name === LIST_DESIGNS_TOOL_NAME)!;
    expect(list.inputSchema.required).toEqual(['projectKey']);
    // The optional filters are ADVERTISED — an agent picks `blockersOf` off this
    // surface, so a schema that omitted it would hide the common case.
    expect(Object.keys(list.inputSchema.properties ?? {}).sort()).toEqual(
      ['blockersOf', 'cursor', 'limit', 'pathPrefix', 'projectKey', 'query'].sort(),
    );
  });

  it('a real approved design comes back through the handshake, in both channels', async () => {
    const card = await designCard('Through the wire');
    await makeWorkWaitOn(card.id, fx, { title: 'Build it' });
    const evidenceId = await publishAndApprove(card, 'v1');

    const client = await connectClient(fx.ctx);
    const result = (await client.callTool({
      name: GET_DESIGN_TOOL_NAME,
      arguments: { key: card.identifier },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(evidenceId);
  });

  it('an UNKNOWN key becomes a tool ERROR RESULT, never a transport failure', async () => {
    const client = await connectClient(fx.ctx);
    // This is the `toToolError` arm: the service throws `WorkItemNotFoundError`
    // and the agent must get a readable result it can act on, not a broken call.
    const result = (await client.callTool({
      name: GET_DESIGN_TOOL_NAME,
      arguments: { key: `${fx.projectIdentifier}-9999` },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);

    const listed = (await client.callTool({
      name: LIST_DESIGNS_TOOL_NAME,
      arguments: { projectKey: 'NOSUCHPROJECT' },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(listed.isError).toBe(true);
  });

  it('`list_designs` reaches both arms through the wire', async () => {
    const card = await designCard('Listed through the wire');
    const dependent = await makeWorkWaitOn(card.id, fx, { title: 'Build it' });
    await publishAndApprove(card, 'v1');
    const client = await connectClient(fx.ctx);

    const blockers = (await client.callTool({
      name: LIST_DESIGNS_TOOL_NAME,
      arguments: { projectKey: fx.projectIdentifier, blockersOf: dependent.key },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(blockers.isError).toBeFalsy();
    expect(textOf(blockers)).toContain(card.identifier);

    const page = (await client.callTool({
      name: LIST_DESIGNS_TOOL_NAME,
      arguments: { projectKey: fx.projectIdentifier, query: 'through the wire', limit: 5 },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(page.isError).toBeFalsy();
    expect(textOf(page)).toContain(card.identifier);
  });
});

describe('the invariant behind the defensive arms', () => {
  it('an AVAILABLE asset always carries both a size and a link — the state and the attachment agree', async () => {
    // `getDesign.ts` carries two null-guards on an available asset's size and
    // link, ignored for coverage because the service cannot produce that state:
    // `toApprovedDesignAssetDto` derives `available` FROM the attachment the
    // size comes from, and `downloadLinks` mints one link per available asset.
    // This asserts the invariant rather than fabricating a state to exercise
    // the guard — the guard exists for a future door, not for today's.
    const card = await designCard('Invariant');
    await makeWorkWaitOn(card.id, fx, { title: 'Build it' });
    await publishAndApprove(card, 'v1');

    const result = await runGetDesign({ key: card.identifier }, fx.ctx);
    const payload = result.structuredContent as {
      design: { assets: Array<{ state: string; byteSize: number | null; url?: string }> };
    };
    for (const asset of payload.design.assets) {
      if (asset.state !== 'available') continue;
      expect(asset.byteSize).not.toBeNull();
      expect(typeof asset.url).toBe('string');
    }
    expect(payload.design.assets.some((a) => a.state === 'available')).toBe(true);
  });

  it('`list_designs` tells the agent there are MORE pages when there are', async () => {
    for (let i = 0; i < 2; i += 1) {
      const card = await designCard(`Paged ${i}`);
      await makeWorkWaitOn(card.id, fx, { title: `Build ${i}` });
      await publishAndApprove(card, `p${i}`);
    }
    const result = await runListDesigns({ projectKey: fx.projectIdentifier, limit: 1 }, fx.ctx);
    const page = result.structuredContent as { nextCursor: string | null };
    expect(page.nextCursor).not.toBeNull();
    // The PROSE has to say so too: an agent reading only the summary would
    // otherwise take the first page for the whole project.
    expect(textOf(result)).toContain('More: pass cursor');
  });
});

describe('the empty project page says WHY it is empty', () => {
  it('names the rule rather than answering a bare empty list', async () => {
    // A design still under review is deliberately not listed. An agent that got
    // an empty page with no explanation would reasonably conclude the project
    // has no designs — and go and improvise one.
    const card = await designCard('Under review, so unlisted');
    await makeWorkWaitOn(card.id, fx, { title: 'Build it' });
    // Published but NOT approved.
    const prefix = designPrefix(fx.workspaceId, card.id);
    for (const path of [`${prefix}u.mock.html`, `${prefix}u.md`]) {
      store.set(path, { contentType: 'text/html', size: 64 });
    }
    await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/frame/u.mock.html',
            pathname: `${prefix}u.mock.html`,
          },
          {
            kind: 'note_file',
            sourcePath: 'design/frame/design-notes.md',
            pathname: `${prefix}u.md`,
          },
        ],
        commitSha: shaFor('u'),
      },
      fx.ctx,
    );

    const result = await runListDesigns({ projectKey: fx.projectIdentifier }, fx.ctx);
    expect((result.structuredContent as { items: unknown[] }).items).toEqual([]);
    expect(textOf(result)).toContain('No approved designs matched');
    expect(textOf(result)).toContain('not something to build against');
  });
});
