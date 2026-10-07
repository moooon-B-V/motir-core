import { describe, expect, it } from 'vitest';
import {
  fieldMessage,
  moveRow,
  toDraft,
  toPatch,
  withKind,
} from '@/app/(admin)/admin/ideas/[slug]/_components/ideaDraft';
import type { StaffIdeaDto } from '@/lib/dto/ideas';

// The edit form's draft model (MOTIR-7681, design `platform-admin` § Ideas,
// Panels 6–7 and "Field messages"): what a save sends, and which sentence each
// refused field path shows.

const IDEA: StaffIdeaDto = {
  id: 'idea_1',
  slug: 'stop-returns',
  title: 'Stop returns',
  pitch: 'Predict the return.',
  kind: 'motir_buys',
  category: { slug: 'ecommerce', label: 'E-commerce' },
  tags: [{ slug: 'smb', label: 'SMB' }],
  capabilities: ['One', 'Two'],
  evidence: [{ claim: 'C', sourceName: 'S', url: 'https://e.example/a', sourceDate: null }],
  gap: null,
  whyNow: 'Now.',
  whyMotir: 'Motir needs it.',
  whoElse: null,
  status: 'active',
  retiredReason: null,
  retiredAt: null,
  addedAt: '2026-10-01T00:00:00.000Z',
  lastReviewedAt: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('toPatch', () => {
  it('is empty for an untouched draft', () => {
    expect(toPatch(IDEA, toDraft(IDEA))).toEqual({});
  });

  it('sends each changed field once, trims text, and nulls an emptied optional', () => {
    const draft = toDraft(IDEA);
    draft.title = '  Stop returns early ';
    draft.category = 'pets';
    draft.tags = ['smb', 'consumer'];
    draft.capabilities = [...draft.capabilities.slice(0, 1)];
    draft.whyNow = '   ';
    draft.gap = 'A gap.';
    draft.evidence[0]!.sourceDate = ' 2026-01-02 ';
    draft.reviewed = true;
    expect(toPatch(IDEA, draft)).toEqual({
      title: 'Stop returns early',
      category: 'pets',
      tags: ['smb', 'consumer'],
      capabilities: ['One'],
      evidence: [
        { claim: 'C', sourceName: 'S', url: 'https://e.example/a', sourceDate: '2026-01-02' },
      ],
      gap: 'A gap.',
      whyNow: null,
      reviewed: true,
    });
  });

  it('switching to Direction clears the two Motir-would-buy fields', () => {
    const draft = withKind(toDraft(IDEA), 'direction');
    expect(toPatch(IDEA, draft)).toEqual({ kind: 'direction', whyMotir: null });
    expect(withKind(draft, 'motir_buys').kind).toBe('motir_buys');
  });
});

describe('moveRow', () => {
  it('swaps a row with its neighbour and ignores a move off either end', () => {
    expect(moveRow(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveRow(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    const rows = ['a', 'b'];
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(moveRow(rows, 1, 1)).toBe(rows);
  });
});

describe('fieldMessage', () => {
  const direction = withKind(toDraft(IDEA), 'direction');
  const buys = toDraft(IDEA);
  it.each([
    [{ field: 'title' }, buys, { key: 'title' }],
    [{ field: 'pitch' }, buys, { key: 'pitch' }],
    [{ field: 'gap' }, buys, { key: 'long' }],
    [{ field: 'whyNow' }, buys, { key: 'long' }],
    [{ field: 'whyMotir' }, buys, { key: 'long' }],
    [{ field: 'whoElse' }, direction, { key: 'motirOnly' }],
    [{ field: 'evidence' }, { ...direction, evidence: [] }, { key: 'evidenceRequired' }],
    [{ field: 'evidence' }, buys, { key: 'evidenceMax' }],
    [{ field: 'capabilities' }, buys, { key: 'capabilities' }],
    [{ field: 'capabilities[3]' }, buys, { key: 'capability' }],
    [{ field: 'evidence[2].claim' }, buys, { key: 'claim' }],
    [{ field: 'evidence[0].sourceName' }, buys, { key: 'sourceName' }],
    [{ field: 'evidence[0].url' }, buys, { key: 'url' }],
    [{ field: 'evidence[0].sourceDate' }, buys, { key: 'sourceDate' }],
    [{ field: 'tags' }, buys, { key: 'tags' }],
    [{ field: 'tags', tag: 'gone' }, buys, { key: 'unknownTag', values: { tag: 'gone' } }],
    [{ field: 'reason' }, buys, { key: 'reason' }],
    [{ field: 'category' }, buys, { key: 'generic' }],
  ])('%j → %j', (issue, draft, expected) => {
    expect(fieldMessage(issue, draft)).toEqual(expected);
  });
});
