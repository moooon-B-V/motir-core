import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkWaitOn } from '../helpers/designWaits';

// THE APPROVED-DESIGN READ (Story MOTIR-5553 · Subtask MOTIR-5557) —
// `docs/decisions/design-result.md` AMENDMENT 5 Q2–Q6, on a real Postgres.
//
// The file that matters most here is Q2's LADDER, because the drafted answer
// (*the current result of a `done` design card*) is FALSE on one path and every
// door downstream reads this service rather than re-deriving it:
//
//   arm 1  the decided `approved` `design_result` gate's `subjectId`
//   arm 2  the newest pinned row        (AMENDMENT 4 Q8's no-gate path)
//   arm 3  the current row              (a `done` card no gate ever decided)
//
// The window that motivates arm 1 is driven end to end below: approve X, publish
// Y while the card is still open, close the card, and assert the service hands
// back X.
//
// The object store is the one mocked external (no store runs in the vitest
// lanes), mocked as a STORE so a publish's authoritative `head` reads what was
// put — the same shape `design-card-closed-seam.test.ts` uses.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(async (pathname: string, bytes: Buffer, contentType: string) => {
    store.set(pathname, { contentType, size: bytes.byteLength });
    return { pathname };
  }),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/${pathname}?sig=x`),
  deleteAttachmentBlob: vi.fn(async () => {}),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { designAccessService } = await import('@/lib/services/designAccessService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');

let fx: WorkItemFixture;
/** Subtasks need a parent; one story per test holds every card it creates. */
let parentStoryId: string;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The story these cards hang under' },
    fx.ctx,
  );
  parentStoryId = story.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─── fixtures ──────────────────────────────────────────────────────────────

/** A `type: design` subtask sitting IN REVIEW — where a published design waits. */
async function designCard(title = 'Draw the frame'): Promise<WorkItem> {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: parentStoryId, title, type: 'design' },
    fx.ctx,
  );
  await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
}

/** Publish one version onto a design card, by pathnames. Returns its id. */
async function publish(card: WorkItem, label: string, assetCount = 2): Promise<string> {
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
  if (assetCount > 2) {
    assets.splice(1, 0, {
      kind: 'mock' as const,
      sourcePath: `design/frame/${label}--delta.mock.html`,
      pathname: `${prefix}${label}-delta.mock.html`,
    });
  }
  for (const asset of assets) {
    store.set(asset.pathname, {
      contentType: asset.kind === 'mock' ? 'text/html' : 'text/markdown',
      size: 64,
    });
  }
  const result = await designEvidenceService.recordFromPathnames(
    { workItemId: card.id, assets, commitSha: `sha-${label}` },
    fx.ctx,
  );
  return result.id;
}

async function awaitingGate(evidenceId: string) {
  return adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidenceId, kind: 'design_result', state: 'awaiting' },
  });
}

/** Approve the design card's awaiting gate — terminal, so it writes `done`. */
async function approve(evidenceId: string): Promise<void> {
  const gate = await awaitingGate(evidenceId);
  await approvalGatesService.decide({ gateId: gate.id, decision: 'approve', source: 'ui' }, fx.ctx);
}

/** A card that waits on the given design cards, so a publish is never refused. */
async function dependentOn(...designIds: string[]): Promise<{ id: string; key: string }> {
  const first = await makeWorkWaitOn(designIds[0]!, fx, { title: 'Build to the design' });
  for (const id of designIds.slice(1)) {
    await workItemsService.linkWorkItems(
      { fromId: first.id, toId: id, kind: 'is_blocked_by' },
      fx.ctx,
    );
  }
  return first;
}

/** The one verdict for a design card, read through the public door. */
async function verdictFor(card: WorkItem) {
  return designAccessService.getApprovedDesign(card.identifier, fx.ctx);
}

// ─── Q2 — the five no-design reasons ───────────────────────────────────────

describe('Q2 — what "approved" means, and the five reasons there is no design', () => {
  it('returns the approved design of a done design card, with every asset', async () => {
    const card = await designCard();
    await dependentOn(card.id);
    const v1 = await publish(card, 'v1', 3);
    await approve(v1);

    const verdict = await verdictFor(card);
    expect(verdict.verdict).toBe('approved');
    if (verdict.verdict !== 'approved') throw new Error('unreachable');
    expect(verdict.design.evidenceId).toBe(v1);
    expect(verdict.design.commitSha).toBe('sha-v1');
    // The mock, its delta and the note file — the whole set, in render order.
    expect(verdict.design.assets.map((a) => a.kind)).toEqual(['mock', 'mock', 'note_file']);
    expect(verdict.design.assets.map((a) => a.fileName)).toEqual([
      'v1.mock.html',
      'v1--delta.mock.html',
      'design-notes.md',
    ]);
    expect(verdict.design.assets.every((a) => a.state === 'available')).toBe(true);
  });

  it('`not_done` — a design card in review, and one at `approved` with an open pull request', async () => {
    const inReview = await designCard('Still in review');
    await dependentOn(inReview.id);
    await publish(inReview, 'v1');
    const first = await verdictFor(inReview);
    expect(first).toMatchObject({ verdict: 'not_approved', reason: 'not_done' });

    // The `approved` status itself is NOT enough — it is precisely the state in
    // which §6c's second amendment leaves the publish window open.
    await adminDb.workItem.update({
      where: { id: inReview.id },
      data: { status: 'approved' },
    });
    const second = await verdictFor(inReview);
    expect(second).toMatchObject({ verdict: 'not_approved', reason: 'not_done' });
  });

  it('`cancelled` — a cancelled card is not approved, even though `cancelled` is in the done CATEGORY', async () => {
    const card = await designCard('Abandoned');
    await dependentOn(card.id);
    await publish(card, 'v1');
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'cancelled' } });

    expect(await verdictFor(card)).toMatchObject({
      verdict: 'not_approved',
      reason: 'cancelled',
    });
  });

  it('`no_result` — a done design card that never published one', async () => {
    const card = await designCard('Never drawn');
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    expect(await verdictFor(card)).toMatchObject({
      verdict: 'not_approved',
      reason: 'no_result',
    });
  });

  it('`withdrawn` — a card whose result was taken back, told apart from one that never had one', async () => {
    const card = await designCard('Taken back');
    await dependentOn(card.id);
    await publish(card, 'v1');
    await designEvidenceService.withdrawCurrentForWorkItem(
      { workItemId: card.id, reason: 'wrong surface' },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    expect(await verdictFor(card)).toMatchObject({
      verdict: 'not_approved',
      reason: 'withdrawn',
    });
  });

  it('`not_a_design_card` — a blocker whose type is not `design`', async () => {
    const code = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        parentId: parentStoryId,
        title: 'A code card',
        type: 'code',
      },
      fx.ctx,
    );
    expect(await verdictFor(code as WorkItem)).toMatchObject({
      verdict: 'not_approved',
      reason: 'not_a_design_card',
    });
  });
});

// ─── Q2 — the ladder, arm by arm ───────────────────────────────────────────

describe('Q2 — the ladder: the version the APPROVAL named, not the version that is current', () => {
  it('arm 1 OUTRANKS the current row — the `approved`-with-open-PR window', async () => {
    const card = await designCard('The window');
    await dependentOn(card.id);

    // X is published and APPROVED. With no open pull request the approval is
    // terminal, so it writes `done` — reopen the card to stand in for the
    // `approved`-with-open-pull-request window, where §6c's refusal does not
    // reach and a publish still supersedes.
    const x = await publish(card, 'x');
    await approve(x);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'done',
    );
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    // Y is published in that window and becomes current; nobody approved it.
    const y = await publish(card, 'y');
    expect(y).not.toBe(x);
    const current = await adminDb.designEvidence.findFirstOrThrow({
      where: { workItemId: card.id, isCurrent: true },
    });
    expect(current.id).toBe(y);

    // The merge closes the card. The CURRENT result is now Y.
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    // …and the approved design is still X. This is the whole of Q2.
    const verdict = await verdictFor(card);
    expect(verdict.verdict).toBe('approved');
    if (verdict.verdict !== 'approved') throw new Error('unreachable');
    expect(verdict.design.evidenceId).toBe(x);
    expect(verdict.design.commitSha).toBe('sha-x');
  });

  it('arm 2 — a card whose only approval left a PIN and no `design_result` gate', async () => {
    const card = await designCard('Pinned only');
    await dependentOn(card.id);
    const v1 = await publish(card, 'v1');

    // AMENDMENT 4 Q8's path, reproduced by its effects: the approve-to-merge
    // gate pinned the then-current row, and no `design_result` gate survives.
    await adminDb.designEvidence.update({
      where: { id: v1 },
      data: { pinnedAt: new Date() },
    });
    await adminDb.approvalGate.deleteMany({ where: { workItemId: card.id } });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    const verdict = await verdictFor(card);
    expect(verdict.verdict).toBe('approved');
    if (verdict.verdict !== 'approved') throw new Error('unreachable');
    expect(verdict.design.evidenceId).toBe(v1);
  });

  it('arm 2 takes the NEWEST pin — approvals accumulate across a reopen (§6d)', async () => {
    const card = await designCard('Approved twice');
    await dependentOn(card.id);
    const v1 = await publish(card, 'v1');
    await adminDb.designEvidence.update({
      where: { id: v1 },
      data: { pinnedAt: new Date(Date.now() - 60_000) },
    });
    const v2 = await publish(card, 'v2');
    await adminDb.designEvidence.update({ where: { id: v2 }, data: { pinnedAt: new Date() } });
    await adminDb.approvalGate.deleteMany({ where: { workItemId: card.id } });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    const verdict = await verdictFor(card);
    if (verdict.verdict !== 'approved') throw new Error('expected approved');
    expect(verdict.design.evidenceId).toBe(v2);
  });

  it('arm 3 — a done design card no gate ever decided falls to its current row', async () => {
    const card = await designCard('Closed by hand');
    await dependentOn(card.id);
    const v1 = await publish(card, 'v1');
    await adminDb.approvalGate.deleteMany({ where: { workItemId: card.id } });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    const verdict = await verdictFor(card);
    if (verdict.verdict !== 'approved') throw new Error('expected approved');
    expect(verdict.design.evidenceId).toBe(v1);
  });

  it('an approved version whose bytes were reclaimed is returned UNAVAILABLE, never replaced', async () => {
    const card = await designCard('Files gone');
    await dependentOn(card.id);
    const x = await publish(card, 'x');
    await approve(x);
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
    const y = await publish(card, 'y');
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    // The orphan-GC's effect on the approved-but-unpinned row: its assets lose
    // their attachments. `filesKept: false` is the state this models.
    await adminDb.designAsset.updateMany({
      where: { designEvidenceId: x },
      data: { attachmentId: null },
    });

    const verdict = await verdictFor(card);
    if (verdict.verdict !== 'approved') throw new Error('expected approved');
    // Still X — NOT the newer Y whose files are perfectly intact.
    expect(verdict.design.evidenceId).toBe(x);
    expect(verdict.design.evidenceId).not.toBe(y);
    expect(verdict.design.assets.every((a) => a.state === 'unavailable')).toBe(true);
    expect(verdict.design.assets.every((a) => a.byteSize === null)).toBe(true);
    expect(await designAccessService.downloadLinks(x, fx.ctx)).toEqual([]);
  });
});

// ─── Q4 — what a run is handed by default ──────────────────────────────────

describe('Q4 — the designs a work item waits on', () => {
  it('returns one verdict per blocker, in key order, including non-design blockers', async () => {
    const approvedCard = await designCard('Approved one');
    const pendingCard = await designCard('Pending one');
    const codeCard = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        parentId: parentStoryId,
        title: 'Not a design',
        type: 'code',
      },
      fx.ctx,
    );
    const dependent = await dependentOn(approvedCard.id, pendingCard.id, codeCard.id);

    const v1 = await publish(approvedCard, 'v1');
    await approve(v1);
    await publish(pendingCard, 'p1');

    const verdicts = await designAccessService.designsForWorkItem(dependent.key, fx.ctx);
    expect(verdicts).toHaveLength(3);
    // Key order, so the list is stable for a prompt that renders it.
    expect(verdicts.map((v) => v.designCardKey)).toEqual(
      [approvedCard.identifier, pendingCard.identifier, codeCard.identifier].sort(),
    );
    const byKey = new Map(verdicts.map((v) => [v.designCardKey, v]));
    expect(byKey.get(approvedCard.identifier)).toMatchObject({ verdict: 'approved' });
    expect(byKey.get(pendingCard.identifier)).toMatchObject({ reason: 'not_done' });
    expect(byKey.get(codeCard.identifier)).toMatchObject({ reason: 'not_a_design_card' });
  });

  it('a work item with no blockers gets an empty list, not an error', async () => {
    const lonely = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        parentId: parentStoryId,
        title: 'Waits on nothing',
        type: 'code',
      },
      fx.ctx,
    );
    expect(await designAccessService.designsForWorkItem(lonely.identifier, fx.ctx)).toEqual([]);
  });

  it('issues the SAME number of queries for five blockers × three assets as for one × one', async () => {
    const countQueries = async (fn: () => Promise<unknown>): Promise<number> => {
      let calls = 0;
      const listener = (e: { query: string }) => {
        // The transaction's own frames are not the N+1 this is measuring.
        if (!/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(e.query.trim())) calls += 1;
      };
      const client = db as unknown as {
        $on: (e: 'query', cb: (e: { query: string }) => void) => void;
      };
      client.$on('query', listener);
      await fn();
      // Prisma has no `$off`; the counter is read before the next arm arms its own.
      return calls;
    };

    const one = await designCard('Single');
    const oneDependent = await dependentOn(one.id);
    await approve(await publish(one, 'v1'));

    const many: WorkItem[] = [];
    for (let i = 0; i < 5; i += 1) many.push(await designCard(`Many ${i}`));
    const manyDependent = await dependentOn(...many.map((m) => m.id));
    for (const [i, card] of many.entries()) await approve(await publish(card, `m${i}`, 3));

    const small = await countQueries(() =>
      designAccessService.designsForWorkItem(oneDependent.key, fx.ctx),
    );
    const big = await countQueries(() =>
      designAccessService.designsForWorkItem(manyDependent.key, fx.ctx),
    );
    // `big` is the second measurement on a listener that also saw the first, so
    // compare the DELTA rather than the totals.
    expect(big - small).toBe(small);
  });
});

// ─── Q6 — browsing, links and visibility ───────────────────────────────────

describe('Q6 — listing, links, and what a caller may not see', () => {
  it('lists a project approved designs newest first, pages with a stable cursor, and filters', async () => {
    const cards: WorkItem[] = [];
    for (let i = 0; i < 3; i += 1) {
      const card = await designCard(`Surface ${i}`);
      await dependentOn(card.id);
      await approve(await publish(card, `s${i}`));
      cards.push(card);
    }

    const first = await designAccessService.listApprovedDesigns(
      fx.projectIdentifier,
      { limit: 2 },
      fx.ctx,
    );
    expect(first.designs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    // Newest key first.
    expect(first.designs[0]!.designCardKey).toBe(cards[2]!.identifier);

    const second = await designAccessService.listApprovedDesigns(
      fx.projectIdentifier,
      { limit: 2, cursor: first.nextCursor! },
      fx.ctx,
    );
    expect(second.designs.map((d) => d.designCardKey)).toEqual([cards[0]!.identifier]);
    expect(second.nextCursor).toBeNull();

    // `query` filters on the design card's title.
    const byTitle = await designAccessService.listApprovedDesigns(
      fx.projectIdentifier,
      { query: 'surface 1' },
      fx.ctx,
    );
    expect(byTitle.designs.map((d) => d.designCardKey)).toEqual([cards[1]!.identifier]);

    // `pathPrefix` filters on an asset's `sourcePath` — how a delta mock's
    // amended base is found.
    const byPath = await designAccessService.listApprovedDesigns(
      fx.projectIdentifier,
      { pathPrefix: 'design/frame/s2' },
      fx.ctx,
    );
    expect(byPath.designs.map((d) => d.designCardKey)).toEqual([cards[2]!.identifier]);
    expect(
      (
        await designAccessService.listApprovedDesigns(
          fx.projectIdentifier,
          { pathPrefix: 'design/nowhere/' },
          fx.ctx,
        )
      ).designs,
    ).toEqual([]);
  });

  it('a design card with no approved design is not listed', async () => {
    const card = await designCard('Pending');
    await dependentOn(card.id);
    await publish(card, 'v1');
    const page = await designAccessService.listApprovedDesigns(fx.projectIdentifier, {}, fx.ctx);
    expect(page.designs).toEqual([]);
  });

  it('mints a short-lived link per available asset, with its expiry', async () => {
    const card = await designCard('Linkable');
    await dependentOn(card.id);
    const v1 = await publish(card, 'v1', 3);
    await approve(v1);

    const links = await designAccessService.downloadLinks(v1, fx.ctx);
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.fileName)).toEqual([
      'v1.mock.html',
      'v1--delta.mock.html',
      'design-notes.md',
    ]);
    for (const link of links) {
      expect(link.url).toMatch(/^https:\/\/store\.example\//);
      expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
    }
  });

  it('a card in ANOTHER workspace reads as not found from every method', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const card = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'task', title: 'Their design', type: 'design' },
      other.ctx,
    );

    await expect(designAccessService.getApprovedDesign(card.identifier, fx.ctx)).rejects.toThrow();
    await expect(designAccessService.designsForWorkItem(card.identifier, fx.ctx)).rejects.toThrow();
    await expect(
      designAccessService.listApprovedDesigns(other.projectIdentifier, {}, fx.ctx),
    ).rejects.toThrow();
  });
});
