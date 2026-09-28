import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { activityService } from '@/lib/services/activityService';
import { commentsService } from '@/lib/services/commentsService';
import { estimationService } from '@/lib/services/estimationService';
import { workItemsService } from '@/lib/services/workItemsService';
import { parseWorkItemRefs } from '@/lib/mentions/workItemRefs';
import { WITHHELD_WORK_ITEM_LABEL } from '@/lib/visitor/readScope';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { consentedVisitor } from './_consentedVisitor';
import { truncateAuthTables } from '../helpers/db';

// The single WORK-ITEM PAGE as a Visitor reads it (Story MOTIR-6170 ·
// MOTIR-6652; `epic-privacy.md` §3–§5), through the real resolver and datastore.
// A public project holds a private epic E (children C1, C2; C1 has a child G)
// and a visible task V that blocks C1, relates to C2, and names C1 by chip in
// its description and in a comment. Every channel of V's page — the item, its
// edges, children, rollup, chips, comments and history — must name no hidden
// item to a Visitor, and read exactly as before for a member.

// Each case builds a whole public project with a private subtree and then drives
// several multi-read services; under a parallel run the first case of the file
// also pays module warm-up, and it measured 12s against the 15s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function fixture() {
  const identifier = `VP${seq++}`;
  const fx = await makeWorkItemFixture({ name: `VP ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { accessMode: 'public', accessLevel: 'public' },
  });
  const E = await createTestWorkItem(fx, { kind: 'epic', title: 'Secret launch epic' });
  const C1 = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Secret story one',
    parentId: E.id,
  });
  const C2 = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Secret story two',
    parentId: E.id,
  });
  const G = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Secret grandchild',
    parentId: C1.id,
  });
  for (const w of [C1, C2, G]) {
    await adminDb.workItem.update({ where: { id: w.id }, data: { storyPoints: 5 } });
  }
  const V = await createTestWorkItem(fx, { kind: 'task', title: 'Visible task' });
  const O = await createTestWorkItem(fx, { kind: 'task', title: 'Open neighbour' });
  const chip = `[${C1.identifier}](motir:${C1.id})`;
  const openChip = `[${O.identifier}](motir:${O.id})`;
  await adminDb.workItem.update({
    where: { id: V.id },
    data: { descriptionMd: `Waits on ${chip} and ${openChip}.` },
  });
  // V blocks C1 (C1 is_blocked_by V), V relates to C2, V is blocked by O.
  await workItemsService.linkWorkItems(
    { fromId: C1.id, toId: V.id, kind: 'is_blocked_by' },
    fx.ctx,
  );
  await workItemsService.linkWorkItems({ fromId: V.id, toId: C2.id, kind: 'relates_to' }, fx.ctx);
  await workItemsService.linkWorkItems({ fromId: V.id, toId: O.id, kind: 'is_blocked_by' }, fx.ctx);
  await commentsService.addComment(V.id, { bodyMd: `See ${chip} for context.` }, fx.ctx);
  await adminDb.workItem.update({ where: { id: E.id }, data: { publicChildrenHidden: true } });

  const visitorCtx = await consentedVisitor(identifier);
  const hiddenItems = [C1, C2, G];
  return { fx, visitor: visitorCtx, E, C1, C2, G, V, O, hiddenItems };
}

/** Every string a hidden item could be named by — id, key and title. */
function hiddenNeedles(items: Array<{ id: string; identifier: string; title: string }>) {
  return items.flatMap((w) => [w.id, w.identifier, w.title]);
}

function expectNoneOf(payload: unknown, needles: string[]) {
  const text = JSON.stringify(payload);
  for (const n of needles) expect(text, `payload names ${n}`).not.toContain(n);
}

describe('the item itself', () => {
  it('a hidden key answers exactly as an unknown key does', async () => {
    const t = await fixture();
    const hidden = await workItemsService
      .getIssueDetail(t.fx.projectId, t.C1.identifier, t.visitor)
      .catch((e: unknown) => e);
    const unknown = await workItemsService
      .getIssueDetail(t.fx.projectId, `${t.fx.projectIdentifier}-99999`, t.visitor)
      .catch((e: unknown) => e);
    expect(hidden).toBeInstanceOf(WorkItemNotFoundError);
    expect(unknown).toBeInstanceOf(WorkItemNotFoundError);
    expect((hidden as Error).constructor).toBe((unknown as Error).constructor);
    // ...and the grandchild, which sits two levels under the private epic.
    await expect(
      workItemsService.getIssueDetail(t.fx.projectId, t.G.identifier, t.visitor),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('another project id is the same not-found', async () => {
    const t = await fixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: `OX${seq++}` });
    await expect(
      workItemsService.getIssueDetail(other.projectId, t.V.identifier, t.visitor),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('V — a visible item joined to hidden ones', () => {
  it('its detail names no hidden item: edges, chips in the description', async () => {
    const t = await fixture();
    const detail = await workItemsService.getIssueDetail(t.fx.projectId, t.V.identifier, t.visitor);
    expectNoneOf(detail, hiddenNeedles(t.hiddenItems));
    expect(detail.blocks).toEqual([]);
    expect(detail.relatesTo).toEqual([]);
    // The visible edge and chip survive.
    expect(detail.blockedBy.map((l) => l.item.id)).toEqual([t.O.id]);
    expect(detail.item.descriptionMd).toContain(WITHHELD_WORK_ITEM_LABEL);
    expect(detail.item.descriptionMd).toContain(`motir:${t.O.id}`);
  });

  it('its chips resolve the visible target and never the hidden one', async () => {
    const t = await fixture();
    const refs = parseWorkItemRefs(
      `${t.V.title}\n[x](motir:${t.C1.id}) [y](motir:${t.O.id}) ${t.C2.identifier}`,
      t.fx.projectIdentifier,
    );
    const map = await workItemsService.resolveReferenceSummaries(refs, t.fx.projectId, t.visitor);
    expectNoneOf(map, hiddenNeedles(t.hiddenItems));
    expect(map[t.O.id]).toBeDefined();
  });

  it('its comments show the hidden chip as unavailable', async () => {
    const t = await fixture();
    const page = await commentsService.listComments(t.V.id, {}, t.visitor);
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]!.bodyMd).toBe(`See ${WITHHELD_WORK_ITEM_LABEL} for context.`);
    expectNoneOf(page, hiddenNeedles(t.hiddenItems));
  });

  it('its history and All stream name no hidden item', async () => {
    const t = await fixture();
    const history = await activityService.listHistory(t.V.id, {}, t.visitor);
    expect(history.entries.length).toBeGreaterThan(0);
    expectNoneOf(history, hiddenNeedles(t.hiddenItems));
    const all = await activityService.listAll(t.V.id, {}, t.visitor);
    expectNoneOf(all, hiddenNeedles(t.hiddenItems));
    // A member's history still names the relates_to target C2.
    const memberHistory = await activityService.listHistory(t.V.id, {}, t.fx.ctx);
    expect(JSON.stringify(memberHistory)).toContain(t.C2.id);
  });

  it('a member reads V exactly as before — hidden edges and chips included', async () => {
    const t = await fixture();
    const detail = await workItemsService.getIssueDetail(t.fx.projectId, t.V.identifier, t.fx.ctx);
    expect(detail.blocks.map((l) => l.item.id)).toEqual([t.C1.id]);
    expect(detail.relatesTo.map((l) => l.item.id)).toEqual([t.C2.id]);
    expect(detail.item.descriptionMd).toContain(`motir:${t.C1.id}`);
    expect('childrenHidden' in detail).toBe(false);
    const page = await commentsService.listComments(t.V.id, {}, t.fx.ctx);
    expect(page.threads[0]!.bodyMd).toContain(`motir:${t.C1.id}`);
  });
});

describe('E — the private epic', () => {
  it('shows childrenHidden with no children and no sizing', async () => {
    const t = await fixture();
    const detail = await workItemsService.getIssueDetail(t.fx.projectId, t.E.identifier, t.visitor);
    expect(detail.childrenHidden).toBe(true);
    expect(detail.children).toEqual([]);
    expect(detail.item.storyPoints).toBeNull();
    expect(detail.item.estimateMinutes).toBeNull();
    expectNoneOf(detail, hiddenNeedles(t.hiddenItems));
  });

  it('its rollup counts no hidden descendant; a member counts all of them', async () => {
    const t = await fixture();
    const visitorRollup = await estimationService.rollupForParent(t.E.id, t.visitor);
    expect(visitorRollup.total).toBe(0);
    const memberRollup = await estimationService.rollupForParent(t.E.id, t.fx.ctx);
    expect(memberRollup.total).toBe(15);
    await expect(estimationService.rollupForParent(t.C1.id, t.visitor)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });

  it('a member sees E with its children', async () => {
    const t = await fixture();
    const detail = await workItemsService.getIssueDetail(t.fx.projectId, t.E.identifier, t.fx.ctx);
    expect(detail.children.map((c) => c.id).sort()).toEqual([t.C1.id, t.C2.id].sort());
  });
});
