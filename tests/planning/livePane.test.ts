import { describe, expect, it } from 'vitest';
import {
  addedProposalIds,
  arrivalsSummary,
  EMPTY_ARRIVALS,
  foldArrivals,
  liveArrivals,
  newlyAddedCount,
  proposalChangeKey,
  visitLevel,
  type LiveArrival,
} from '@/lib/planning/livePane';
import { levelTrail } from '@/lib/planning/planArrival';
import { planReviewItem } from '../helpers/planReview';

// The PURE half of the planning surface's live pane (MOTIR-6300; design Part XXIII
// §23.4, §23.7, §23.15). Every rule is a diff of two snapshots by id.

const a = (id: string, levelId: string | null, first = true): LiveArrival => ({
  id,
  levelId,
  trail: levelId ? [{ id: levelId, label: levelId }] : [],
  arrivesOnFirstSight: first,
});

describe('proposalChangeKey — the DEEPEN signature', () => {
  const base = planReviewItem({ title: 'T', descriptionMd: 'body' });
  it('is stable for the same content, and changes with the title, body or sizing', () => {
    expect(proposalChangeKey({ ...base })).toBe(proposalChangeKey(base));
    expect(proposalChangeKey({ ...base, title: 'T2' })).not.toBe(proposalChangeKey(base));
    expect(proposalChangeKey({ ...base, descriptionMd: 'more' })).not.toBe(proposalChangeKey(base));
    expect(proposalChangeKey({ ...base, storyPoints: 3 })).not.toBe(proposalChangeKey(base));
    expect(proposalChangeKey({ ...base, type: 'code' })).not.toBe(proposalChangeKey(base));
  });
  it('does not change with where the card sits', () => {
    expect(proposalChangeKey({ ...base, parentNodeId: 'x' })).toBe(proposalChangeKey(base));
  });
});

describe('the batch announcement', () => {
  it('counts only the adds new in the snapshot', () => {
    const before = addedProposalIds([planReviewItem({ planItemId: 'p1' })]);
    const after = addedProposalIds([
      planReviewItem({ planItemId: 'p1' }),
      planReviewItem({ planItemId: 'p2' }),
      planReviewItem({ planItemId: 'm1', op: 'modify' }),
    ]);
    expect([...after]).toEqual(['p1', 'p2']);
    expect(newlyAddedCount(before, after)).toBe(1);
    expect(newlyAddedCount(after, after)).toBe(0);
  });
});

describe('foldArrivals — counted, never jumped to (§23.7)', () => {
  it('the FIRST snapshot is the baseline and counts nothing', () => {
    const log = foldArrivals(EMPTY_ARRIVALS, [a('p1', 'L1'), a('p2', 'L2')], 'L1');
    expect(log.pending).toEqual([]);
    expect(arrivalsSummary(log.pending)).toBeNull();
  });

  it('an add on ANOTHER level is pending; one on the viewed level is not', () => {
    let log = foldArrivals(EMPTY_ARRIVALS, [], 'L1');
    log = foldArrivals(log, [a('p1', 'L1'), a('p2', 'L2')], 'L1');
    expect(log.pending.map((p) => p.id)).toEqual(['p2']);
    expect(arrivalsSummary(log.pending)).toMatchObject({ count: 1, levels: 1 });
  });

  it('a committed card never arrives on first sight, but a MOVE counts', () => {
    let log = foldArrivals(EMPTY_ARRIVALS, [], null);
    log = foldArrivals(log, [a('m1', 'L2', false)], null);
    expect(log.pending).toEqual([]);
    log = foldArrivals(log, [a('m1', 'L3', false)], null);
    expect(log.pending.map((p) => [p.id, p.levelId])).toEqual([['m1', 'L3']]);
    // …and moving it again onto the level being viewed clears it.
    log = foldArrivals(log, [a('m1', null, false)], null);
    expect(log.pending).toEqual([]);
  });

  it('the LATEST arrival is what Go there goes to; a withdrawn one stops counting', () => {
    let log = foldArrivals(EMPTY_ARRIVALS, [], null);
    log = foldArrivals(log, [a('p1', 'L1')], null);
    log = foldArrivals(log, [a('p1', 'L1'), a('p2', 'L2')], null);
    const summary = arrivalsSummary(log.pending)!;
    expect(summary).toMatchObject({ count: 2, levels: 2 });
    expect(summary.latest.id).toBe('p2');
    log = foldArrivals(log, [a('p1', 'L1')], null);
    expect(log.pending.map((p) => p.id)).toEqual(['p1']);
  });

  it('visiting a level clears its count, and only its count', () => {
    let log = foldArrivals(EMPTY_ARRIVALS, [], null);
    log = foldArrivals(log, [a('p1', 'L1'), a('p2', 'L2')], null);
    log = visitLevel(log, 'L1');
    expect(log.viewing).toBe('L1');
    expect(log.pending.map((p) => p.id)).toEqual(['p2']);
  });
});

describe('liveArrivals + levelTrail — where Go there drills, named by its key', () => {
  const committed = planReviewItem({
    planItemId: 'p1',
    nodeId: 'p1',
    parentNodeId: 'wi_story',
    parentIdentifier: 'MOTIR-7',
    parentTitle: 'Story',
    parentTrail: [
      { id: 'wi_epic', identifier: 'MOTIR-1', title: 'Epic' },
      { id: 'wi_story', identifier: 'MOTIR-7', title: 'Story' },
    ],
  });
  const container = planReviewItem({ planItemId: 'pc', nodeId: 'pc', title: 'New story' });
  const child = planReviewItem({ planItemId: 'pk', nodeId: 'pk', parentNodeId: 'pc' });
  const filed = planReviewItem({
    planItemId: 'pf',
    nodeId: 'pf',
    folderId: 'f1',
    folderTrail: [{ id: 'f1', name: 'Billing' }],
  });

  it('a committed level: the whole chain, its last crumb keyed MOTIR-<n>', () => {
    const trail = levelTrail([committed], 'wi_story', 'New');
    expect(trail.map((c) => c.id)).toEqual(['wi_epic', 'wi_story']);
    expect(trail[1]).toMatchObject({ crumbKey: 'MOTIR-7' });
  });

  it('a proposed container: its crumb says New, with no key to name it by', () => {
    const trail = levelTrail([container, child], 'pc', 'New');
    expect(trail).toEqual([{ id: 'pc', label: 'New · New story' }]);
  });

  it('a folder level: its folder chain, named by the folder', () => {
    const trail = levelTrail([filed], 'folder:f1', 'New');
    expect(trail).toEqual([{ id: 'folder:f1', label: 'Billing' }]);
  });

  it('the top level has no trail', () => {
    expect(levelTrail([container], null, 'New')).toEqual([]);
  });

  it('each card rides its level, and only an add arrives on first sight', () => {
    const modify = planReviewItem({ planItemId: 'm1', nodeId: 'wi_x', op: 'modify' });
    const out = liveArrivals([committed, filed, modify], 'New');
    expect(out.map((x) => [x.id, x.levelId, x.arrivesOnFirstSight])).toEqual([
      ['p1', 'wi_story', true],
      ['pf', 'folder:f1', true],
      ['m1', null, false],
    ]);
  });
});
