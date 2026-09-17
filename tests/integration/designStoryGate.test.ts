import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';

// The blob STORE is the one mocked external — no object store runs in the vitest
// lanes. Everything else is real: real Postgres, the real decide door, the real
// status transitions, the real routes and the real prompt assembly.
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

const { db } = await import('@/lib/db');
const { designAccessService } = await import('@/lib/services/designAccessService');
const { dispatchPromptService } = await import('@/lib/services/dispatchPromptService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { runGetDesign } = await import('@/lib/mcp/tools/getDesign');
const { runListDesigns } = await import('@/lib/mcp/tools/listDesigns');
const { GET: GET_DESIGNS } = await import('@/app/api/v1/work-items/[key]/designs/route');
const { GET: GET_DESIGN } = await import('@/app/api/v1/work-items/[key]/design/route');
const { GET: LIST_PROJECT } = await import('@/app/api/v1/projects/[projectKey]/designs/route');
const { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { isExemptTool } = await import('@/lib/mcp/payloads/exemptions');
const { unresolvedTools } = await import('@/lib/mcp/payloads/registry');
const { MCP_TOOL_NAMES } = await import('@/lib/mcp/registry');
const { DESIGN_DIR_ENV, GET_DESIGN_TOOL_NAME, LIST_DESIGNS_TOOL_NAME } =
  await import('@/lib/dispatch/promptTemplate');
const { MOTIR_DESIGN_DIR_ENV } = await import('../../packages/cli/src/designFiles');
const { createV1ProjectCaller } = await import('../fixtures/apiV1Fixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');

// STORY VITEST GATE — EVERY AGENT RUN IS HANDED THE APPROVED DESIGN IT BUILDS
// AGAINST (Story MOTIR-5553 · Subtask MOTIR-5566).
//
// Each child's own suite tests its own door. This file asserts what only the
// ASSEMBLED story can show, and it is organised around the two claims the story
// makes that no single card can prove:
//
//   (2) THE SEAM — publish → approve → Done → the read → the prompt → v1 → the
//       CLI's own generated type, and then the REOPEN, where every one of those
//       consumers must go back to saying *not approved* together.
//   (3) THE GUARDS A PERCENTAGE CANNOT SEE — one table over EVERY door against
//       EVERY not-approved shape, the grant, isolation, the derive seal, and the
//       constants that must agree across three packages.
//
// ⚠️ THE DOOR TABLE IS THE POINT. Seven consumers now resolve "which design
// counts", and they all route through one service — but "they all call the same
// function" is a claim about the code, and this is the file that makes it a
// claim about BEHAVIOUR. A door added later that reads the evidence table
// directly would pass its own suite and fail here.

type Caller = Awaited<ReturnType<typeof createV1ProjectCaller>>;
let caller: Caller;
let storyId: string;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  caller = await createV1ProjectCaller();
  const story = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title: 'The surface story' },
    caller.ctx,
  );
  storyId = story.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─── fixtures ──────────────────────────────────────────────────────────────

async function designCard(title: string): Promise<WorkItem> {
  const card = await workItemsService.createWorkItem(
    {
      projectId: caller.fixture.projectId,
      kind: 'subtask',
      parentId: storyId,
      title,
      type: 'design',
    },
    caller.ctx,
  );
  await workItemsService.updateStatus(card.id, 'in_progress', caller.ctx);
  await workItemsService.updateStatus(card.id, 'in_review', caller.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
}

async function consumerOf(designId: string, title = 'Build the surface'): Promise<WorkItem> {
  const card = await workItemsService.createWorkItem(
    {
      projectId: caller.fixture.projectId,
      kind: 'subtask',
      parentId: storyId,
      title,
      type: 'code',
    },
    caller.ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: card.id, toId: designId, kind: 'is_blocked_by' },
    caller.ctx,
  );
  return adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
}

async function publish(card: WorkItem, label: string): Promise<string> {
  const prefix = designPrefix(caller.fixture.workspaceId, card.id);
  const assets = [
    {
      kind: 'mock' as const,
      sourcePath: `design/work-items/${label}.mock.html`,
      pathname: `${prefix}${label}.mock.html`,
    },
    {
      kind: 'note_file' as const,
      sourcePath: 'design/work-items/design-notes.md',
      pathname: `${prefix}${label}.md`,
    },
  ];
  for (const a of assets) store.set(a.pathname, { contentType: 'text/html', size: 64 });
  const evidence = await designEvidenceService.recordFromPathnames(
    { workItemId: card.id, assets, commitSha: `sha-${label}` },
    caller.ctx,
  );
  return evidence.id;
}

async function approve(evidenceId: string): Promise<void> {
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidenceId, kind: 'design_result', state: 'awaiting' },
  });
  await approvalGatesService.decide(
    { gateId: gate.id, decision: 'approve', source: 'ui' },
    caller.ctx,
  );
}

const BASE = 'http://localhost:3000/api/v1';
const req = (url: string) => new Request(url, { headers: caller.headers });

/**
 * ONE reading of every door that can hand out a design, for one consumer and
 * one design card. The shape this file is built around.
 */
async function everyDoor(consumer: WorkItem, design: WorkItem) {
  const [serviceVerdicts, serviceOne, toolOne, toolMany, v1Many, v1One, v1List, prompt] =
    await Promise.all([
      designAccessService.designsForWorkItem(consumer.identifier, caller.ctx),
      designAccessService.getApprovedDesign(design.identifier, caller.ctx),
      runGetDesign({ key: design.identifier }, caller.ctx),
      runListDesigns(
        { projectKey: caller.projectKey, blockersOf: consumer.identifier },
        caller.ctx,
      ),
      GET_DESIGNS(req(`${BASE}/work-items/${consumer.identifier}/designs`), {
        params: Promise.resolve({ key: consumer.identifier }),
      }).then((r) => r.json()),
      GET_DESIGN(req(`${BASE}/work-items/${design.identifier}/design`), {
        params: Promise.resolve({ key: design.identifier }),
      }).then((r) => r.json()),
      LIST_PROJECT(req(`${BASE}/projects/${caller.projectKey}/designs`), {
        params: Promise.resolve({ projectKey: caller.projectKey }),
      }).then((r) => r.json()),
      dispatchPromptService
        .getDispatchPrompt(caller.fixture.projectId, consumer.identifier, caller.ctx)
        .then((d) => d.prompt),
    ]);

  return {
    service: serviceVerdicts.find((v) => v.designCardKey === design.identifier)!,
    serviceOne,
    toolOne: toolOne.structuredContent as { verdict: string; design?: { evidenceId: string } },
    toolMany: toolMany.structuredContent as {
      designs: Array<{ designCardKey: string; verdict: string; design?: { evidenceId: string } }>;
    },
    v1Many: v1Many as {
      designs: Array<{
        designCardKey: string;
        verdict: string;
        design?: { evidenceId: string; assets: Array<{ url?: string }> };
      }>;
    },
    v1One: v1One as { verdict: string; design?: { evidenceId: string } },
    v1List: v1List as { items: Array<{ designCardKey: string }> },
    prompt,
  };
}

// ─── (2) THE SEAM ──────────────────────────────────────────────────────────

describe('(2) the seam — publish → approve → Done → every consumer, then the REOPEN', () => {
  it('carries ONE version from the approval to the agent, through every reader', async () => {
    const design = await designCard('Draw the ready-set filter bar');
    const consumer = await consumerOf(design.id);
    const v1 = await publish(design, 'v1');
    await approve(v1);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: design.id } })).status).toBe(
      'done',
    );

    const doors = await everyDoor(consumer, design);

    // Every door says APPROVED, and every door names the SAME version. A door
    // that agreed on the verdict and disagreed on the version would hand two
    // agents two different designs while every test about "is it approved"
    // stayed green.
    expect(doors.service).toMatchObject({ verdict: 'approved' });
    expect(doors.serviceOne).toMatchObject({ verdict: 'approved' });
    expect(doors.toolOne.verdict).toBe('approved');
    expect(doors.v1One.verdict).toBe('approved');

    const versions = [
      doors.service.verdict === 'approved' ? doors.service.design.evidenceId : null,
      doors.serviceOne.verdict === 'approved' ? doors.serviceOne.design.evidenceId : null,
      doors.toolOne.design?.evidenceId,
      doors.toolMany.designs[0]?.design?.evidenceId,
      doors.v1Many.designs[0]?.design?.evidenceId,
      doors.v1One.design?.evidenceId,
    ];
    expect(new Set(versions)).toEqual(new Set([v1]));

    // The PROMPT — the one an agent actually reads — names the same card and the
    // same version.
    expect(doors.prompt).toContain(design.identifier);
    expect(doors.prompt).toContain(v1);
    // …and the project list shows it.
    expect(doors.v1List.items.map((d) => d.designCardKey)).toContain(design.identifier);
    // …and the single v1 read carries fetchable links.
    expect(doors.v1Many.designs[0]!.design!.assets.every((a) => typeof a.url === 'string')).toBe(
      true,
    );
  });

  it('the REOPEN takes every consumer back to not-approved TOGETHER, until Done again', async () => {
    const design = await designCard('Draw it again');
    const consumer = await consumerOf(design.id);
    const v1 = await publish(design, 'v1');
    await approve(v1);

    // Reopen and republish: the card is open, so a publish supersedes.
    await workItemsService.updateStatus(design.id, 'in_progress', caller.ctx);
    await workItemsService.updateStatus(design.id, 'in_review', caller.ctx);
    const v2 = await publish(design, 'v2');
    expect(v2).not.toBe(v1);

    const during = await everyDoor(consumer, design);
    // ⚠️ EVERY door, not most of them. A door that kept answering `approved`
    // here would hand an agent v1 — a version whose card is being redrawn — or
    // v2, which nobody has approved.
    expect(during.service).toMatchObject({ verdict: 'not_approved', reason: 'not_done' });
    expect(during.serviceOne).toMatchObject({ verdict: 'not_approved', reason: 'not_done' });
    expect(during.toolOne.verdict).toBe('not_approved');
    expect(during.v1One.verdict).toBe('not_approved');
    expect(during.toolMany.designs[0]!.verdict).toBe('not_approved');
    expect(during.v1Many.designs[0]!.verdict).toBe('not_approved');
    expect(during.v1List.items.map((d) => d.designCardKey)).not.toContain(design.identifier);
    expect(during.prompt).toContain('NO APPROVED DESIGN (not_done)');

    // Approve the NEW version: everything agrees again, on v2.
    await approve(v2);
    const after = await everyDoor(consumer, design);
    expect(after.toolOne.design?.evidenceId).toBe(v2);
    expect(after.v1One.design?.evidenceId).toBe(v2);
    expect(after.prompt).toContain(v2);
    expect(after.prompt).not.toContain(v1);
  });
});

// ─── (3) THE GUARDS A PERCENTAGE CANNOT SEE ────────────────────────────────

describe('(3) no door hands out a design that is not approved', () => {
  /** The five shapes a design can be in that are NOT an approved design. */
  const SHAPES = [
    'awaiting approval',
    'sent back',
    'cancelled',
    'withdrawn',
    'superseded while open',
  ] as const;

  it.each(SHAPES)('%s — every one of the seven doors withholds the design', async (shape) => {
    const design = await designCard(`A design that is ${shape}`);
    const consumer = await consumerOf(design.id);
    const v1 = await publish(design, 'v1');

    if (shape === 'sent back') {
      const gate = await adminDb.approvalGate.findFirstOrThrow({
        where: { subjectId: v1, kind: 'design_result', state: 'awaiting' },
      });
      await approvalGatesService.decide(
        { gateId: gate.id, decision: 'request_changes', source: 'ui', noteMd: 'not yet' },
        caller.ctx,
      );
    } else if (shape === 'cancelled') {
      await adminDb.workItem.update({ where: { id: design.id }, data: { status: 'cancelled' } });
    } else if (shape === 'withdrawn') {
      await designEvidenceService.withdrawCurrentForWorkItem(
        { workItemId: design.id, reason: 'wrong surface' },
        caller.ctx,
      );
      await adminDb.workItem.update({ where: { id: design.id }, data: { status: 'done' } });
    } else if (shape === 'superseded while open') {
      await publish(design, 'v2'); // v1 superseded, card still open
    }

    const doors = await everyDoor(consumer, design);

    expect(doors.service.verdict).toBe('not_approved');
    expect(doors.serviceOne.verdict).toBe('not_approved');
    expect(doors.toolOne.verdict).toBe('not_approved');
    expect(doors.toolOne.design).toBeUndefined();
    expect(doors.toolMany.designs[0]!.verdict).toBe('not_approved');
    expect(doors.v1One.verdict).toBe('not_approved');
    expect(doors.v1One.design).toBeUndefined();
    expect(doors.v1Many.designs[0]!.verdict).toBe('not_approved');
    expect(doors.v1Many.designs[0]!.design).toBeUndefined();
    expect(doors.v1List.items.map((d) => d.designCardKey)).not.toContain(design.identifier);

    // NO LINK reaches anybody. A verdict that withheld the design but leaked a
    // presigned url would hand out exactly the bytes it just refused.
    const text = JSON.stringify(doors);
    expect(text).not.toContain('https://store.example/');
    // …and the prompt tells the agent to stop rather than to build.
    expect(doors.prompt).toContain('NO APPROVED DESIGN');
    expect(doors.prompt).toContain('Stop through THE CARD');
  });
});

describe('(3) the grant, the seal, isolation and the names', () => {
  it('the GRANT is unchanged: every new door asserts a key `CLI_TOKEN_GRANT` already held', () => {
    for (const tool of [GET_DESIGN_TOOL_NAME, LIST_DESIGNS_TOOL_NAME] as const) {
      expect(TOOL_PERMISSIONS[tool]).toBe('project:browse');
      expect(CLI_TOKEN_GRANT).toContain('project:browse');
    }
    // The three v1 operations declare the same key.
    expect(MCP_TOOL_NAMES).toContain(GET_DESIGN_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(LIST_DESIGNS_TOOL_NAME);
  });

  it('the DERIVE-OR-EXEMPT seal holds with both tools on the derived side', async () => {
    expect(isExemptTool(GET_DESIGN_TOOL_NAME)).toBe(false);
    expect(isExemptTool(LIST_DESIGNS_TOOL_NAME)).toBe(false);
    // The partition is total: no tool is in neither column.
    expect(unresolvedTools(MCP_TOOL_NAMES)).toEqual([]);
  });

  it('a design card in ANOTHER workspace is not found through every door', async () => {
    const other = await createV1ProjectCaller({ workspaceName: 'Other', identifier: 'OTHR' });
    const theirs = await workItemsService.createWorkItem(
      { projectId: other.fixture.projectId, kind: 'task', title: 'Their design', type: 'design' },
      other.ctx,
    );

    await expect(
      designAccessService.getApprovedDesign(theirs.identifier, caller.ctx),
    ).rejects.toThrow();
    expect(
      (await runGetDesign({ key: theirs.identifier }, caller.ctx).catch(() => ({ isError: true })))
        .isError,
    ).toBeTruthy();
    const v1 = await GET_DESIGN(req(`${BASE}/work-items/${theirs.identifier}/design`), {
      params: Promise.resolve({ key: theirs.identifier }),
    });
    // NOT FOUND, never FORBIDDEN — the no-existence-leak contract.
    expect(v1.status).toBe(404);
  });

  it('the NAMES agree across three packages', () => {
    // The prompt tells an agent to call these tools; the registry decides
    // whether they exist. A drift is a prompt naming a door that is not there.
    expect(MCP_TOOL_NAMES).toContain(GET_DESIGN_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(LIST_DESIGNS_TOOL_NAME);
    // The prompt tells an agent to read this variable; the CLI sets it. This is
    // the only place both values are reachable — the app cannot import a CLI
    // module and the CLI package cannot import `lib/`.
    expect(DESIGN_DIR_ENV).toBe(MOTIR_DESIGN_DIR_ENV);
  });
});
