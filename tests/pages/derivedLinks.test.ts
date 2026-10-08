import { describe, expect, it } from 'vitest';
import { diffItemDerivedLinks } from '@/lib/pages/derivedLinks';
import type { ItemDerivedPageLinkRecord } from '@/lib/repositories/pageWorkItemLinkRepository';

// The work item's side of the derived-link diff (Story MOTIR-7694 · MOTIR-7696):
// the bodies name pages, the stored item-derived rows are diffed against them,
// and only the sources the save supplied are in scope.

const at = new Date('2026-10-08T00:00:00Z');
const row = (
  id: string,
  pageId: string,
  source: 'description' | 'explanation',
): ItemDerivedPageLinkRecord => ({ id, pageId, source, createdById: 'u1', createdAt: at });

const BOTH = new Set(['description', 'explanation'] as const);

describe('diffItemDerivedLinks', () => {
  it('inserts what is new once, keeps what is still named, deletes what is not', () => {
    const stored = [row('r1', 'P', 'description'), row('r2', 'Q', 'description')];
    const diff = diffItemDerivedLinks(
      stored,
      [
        { pageId: 'P', source: 'description' },
        { pageId: 'R', source: 'description' },
        { pageId: 'R', source: 'description' },
      ],
      BOTH,
    );
    expect(diff).toEqual({ deleteIds: ['r2'], insert: [{ pageId: 'R', source: 'description' }] });
  });

  it('treats the same page in the two fields as two rows', () => {
    const diff = diffItemDerivedLinks(
      [row('r1', 'P', 'description')],
      [
        { pageId: 'P', source: 'description' },
        { pageId: 'P', source: 'explanation' },
      ],
      BOTH,
    );
    expect(diff).toEqual({ deleteIds: [], insert: [{ pageId: 'P', source: 'explanation' }] });
  });

  it('leaves the rows of a field the save did not supply untouched', () => {
    const stored = [row('r1', 'P', 'description'), row('r2', 'Q', 'explanation')];
    const diff = diffItemDerivedLinks(stored, [], new Set(['explanation'] as const));
    expect(diff).toEqual({ deleteIds: ['r2'], insert: [] });
  });

  it('ignores a named link outside the supplied sources', () => {
    const diff = diffItemDerivedLinks(
      [],
      [{ pageId: 'P', source: 'description' }],
      new Set(['explanation'] as const),
    );
    expect(diff).toEqual({ deleteIds: [], insert: [] });
  });
});
