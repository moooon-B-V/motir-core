import { describe, expect, it } from 'vitest';
import type { RelationshipKind, WorkItemLinkKindDto } from '@/lib/dto/workItemLinks';
import { relationshipSchema } from '@/lib/api/v1/workItems/schema';
import {
  LINK_FORM_RELATIONSHIP_KINDS,
  RELATIONSHIP_KINDS,
  isRelationshipKind,
  relationshipLabel,
  relationshipStorage,
  relationshipToLink,
} from '@/lib/workItems/linkRelationships';

// The relationship model (Subtask 2.4.9, widened by MOTIR-6580) — the pure
// mapping every link door (the web actions, REST v1, MCP, the create modal)
// shares. The supersedes pair is the second DIRECTED pair beside blocked_by /
// blocks: `from` is the NEWER item, `to` the OLDER one.

const ALL: RelationshipKind[] = [
  'blocked_by',
  'blocks',
  'relates_to',
  'duplicates',
  'clones',
  'supersedes',
  'superseded_by',
];

describe('RELATIONSHIP_KINDS', () => {
  it('lists all seven relationships, in order, with their labels', () => {
    expect(RELATIONSHIP_KINDS).toEqual([
      { kind: 'blocked_by', label: 'Blocked by' },
      { kind: 'blocks', label: 'Blocks' },
      { kind: 'relates_to', label: 'Relates to' },
      { kind: 'duplicates', label: 'Duplicates' },
      { kind: 'clones', label: 'Clones' },
      { kind: 'supersedes', label: 'Supersedes' },
      { kind: 'superseded_by', label: 'Superseded by' },
    ]);
  });

  it('is the SAME vocabulary REST v1 publishes', () => {
    expect([...relationshipSchema.options]).toEqual(RELATIONSHIP_KINDS.map((r) => r.kind));
  });

  it('recognises every relationship and nothing else', () => {
    for (const kind of ALL) expect(isRelationshipKind(kind)).toBe(true);
    expect(isRelationshipKind('is_blocked_by')).toBe(false);
    expect(isRelationshipKind('supersedes_by')).toBe(false);
    expect(relationshipLabel('superseded_by')).toBe('Superseded by');
  });

  it('the web add-link form does not offer the supersedes pair until the panel renders it', () => {
    expect(LINK_FORM_RELATIONSHIP_KINDS.map((r) => r.kind)).toEqual([
      'blocked_by',
      'blocks',
      'relates_to',
      'duplicates',
      'clones',
    ]);
  });
});

describe('relationshipToLink', () => {
  const expected: Record<RelationshipKind, { from: 'cur' | 'tgt'; kind: WorkItemLinkKindDto }> = {
    blocked_by: { from: 'cur', kind: 'is_blocked_by' },
    blocks: { from: 'tgt', kind: 'is_blocked_by' },
    relates_to: { from: 'cur', kind: 'relates_to' },
    duplicates: { from: 'cur', kind: 'duplicates' },
    clones: { from: 'cur', kind: 'clones' },
    supersedes: { from: 'cur', kind: 'supersedes' },
    superseded_by: { from: 'tgt', kind: 'supersedes' },
  };

  it.each(ALL)('maps %s to its directed storage edge', (relationship) => {
    const want = expected[relationship];
    const link = relationshipToLink(relationship, 'cur', 'tgt');
    expect(link).toEqual({
      fromId: want.from === 'cur' ? 'cur' : 'tgt',
      toId: want.from === 'cur' ? 'tgt' : 'cur',
      kind: want.kind,
    });
    // The storage lookup the candidate read uses agrees with the mapping.
    expect(relationshipStorage(relationship)).toEqual({
      kind: want.kind,
      currentIs: want.from === 'cur' ? 'from' : 'to',
    });
  });

  it('"A supersedes B" and "B superseded_by A" name the SAME row — A (newer) → B (older)', () => {
    expect(relationshipToLink('supersedes', 'A', 'B')).toEqual(
      relationshipToLink('superseded_by', 'B', 'A'),
    );
    expect(relationshipToLink('supersedes', 'A', 'B')).toEqual({
      fromId: 'A',
      toId: 'B',
      kind: 'supersedes',
    });
  });
});
