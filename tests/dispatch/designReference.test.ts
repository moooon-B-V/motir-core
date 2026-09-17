import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';

// The blob STORE is the one mocked external — the edges, the verdict ladder and
// the prompt assembly all run for real against real Postgres.
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
const { dispatchPromptService } = await import('@/lib/services/dispatchPromptService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

// THE DISPATCHED PROMPT CARRIES THE DESIGN (Story MOTIR-5553 · Subtask
// MOTIR-5563), end to end on real Postgres.
//
// The GRAMMAR is pinned in `promptTemplate.test.ts`, which is pure. What only
// this altitude can show is that the prompt service actually RESOLVES the
// designs from the card's `is_blocked_by` edges — the seam where a prompt that
// renders perfectly in a unit test still reaches an agent empty.

type Fixture = Awaited<ReturnType<typeof makeWorkItemFixture>>;
let fx: Fixture;
let storyId: string;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The surface story' },
    fx.ctx,
  );
  storyId = story.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function designCard(title: string): Promise<WorkItem> {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: storyId, title, type: 'design' },
    fx.ctx,
  );
  await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
}

/** A `code` card that waits on the given design card. */
async function codeCardWaitingOn(designId: string): Promise<WorkItem> {
  const card = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: storyId,
      title: 'Build the surface',
      type: 'code',
    },
    fx.ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: card.id, toId: designId, kind: 'is_blocked_by' },
    fx.ctx,
  );
  return adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
}

async function publish(card: WorkItem, label: string): Promise<string> {
  const prefix = designPrefix(fx.workspaceId, card.id);
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
    fx.ctx,
  );
  return evidence.id;
}

async function approve(evidenceId: string): Promise<void> {
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidenceId, kind: 'design_result', state: 'awaiting' },
  });
  await approvalGatesService.decide({ gateId: gate.id, decision: 'approve', source: 'ui' }, fx.ctx);
}

const promptFor = async (card: WorkItem): Promise<string> =>
  (await dispatchPromptService.getDispatchPrompt(fx.projectId, card.identifier, fx.ctx)).prompt;

describe('the dispatched prompt resolves the design from the card’s own edges', () => {
  it('a card blocked_by a DONE design card carries that card’s key and its version', async () => {
    const design = await designCard('Draw the surface');
    const consumer = await codeCardWaitingOn(design.id);
    const evidenceId = await publish(design, 'v1');
    await approve(evidenceId);

    const prompt = await promptFor(consumer);
    expect(prompt).toContain('DESIGN REFERENCE — what this card is built against');
    expect(prompt).toContain(design.identifier);
    expect(prompt).toContain('Draw the surface');
    // The VERSION — what makes the reference checkable months later.
    expect(prompt).toContain(evidenceId);
    expect(prompt).toContain('design/work-items/v1.mock.html');
    expect(prompt).toContain('design/work-items/design-notes.md');
    expect(prompt).toContain('MOTIR_DESIGN_DIR');
    expect(prompt).toContain('get_design');
  });

  it('a card blocked_by a design still AWAITING approval carries the `not_done` reason', async () => {
    const design = await designCard('Still under review');
    const consumer = await codeCardWaitingOn(design.id);
    await publish(design, 'v1'); // published, NOT approved

    const prompt = await promptFor(consumer);
    expect(prompt).toContain('NO APPROVED DESIGN (not_done)');
    expect(prompt).toContain(design.identifier);
    // …and the stop, with the shape of the correction.
    expect(prompt).toContain('Stop through THE CARD');
    expect(prompt).toContain('BESIDE this card');
  });

  it('a card that waits on NO design renders no block, and is told to look first', async () => {
    const lonely = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        parentId: storyId,
        title: 'No design',
        type: 'code',
      },
      fx.ctx,
    );
    const prompt = await promptFor(
      await adminDb.workItem.findUniqueOrThrow({ where: { id: lonely.id } }),
    );
    expect(prompt).not.toContain('DESIGN REFERENCE — what this card is built against');
    // The absence is handled where it bites.
    expect(prompt).toContain('look first with the list_designs tool');
  });

  it('a NON-design blocker does not become a design reference', async () => {
    const other = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        parentId: storyId,
        title: 'A code blocker',
        type: 'code',
      },
      fx.ctx,
    );
    const consumer = await codeCardWaitingOn(other.id);
    const prompt = await promptFor(consumer);
    // It is listed as a BLOCKER, and it is not claimed to be a design.
    expect(prompt).toContain(other.identifier);
    expect(prompt).not.toContain('DESIGN REFERENCE — what this card is built against');
  });
});
