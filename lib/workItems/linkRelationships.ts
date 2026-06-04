import type {
  LinkWorkItemsInput,
  RelationshipKind,
  WorkItemLinkKindDto,
} from '@/lib/dto/workItemLinks';

// The UI relationship model for link management (Subtask 2.4.9), pure + UI-free
// so the Server Actions, the service candidate read, and component tests all
// share ONE source of truth for the five kinds and their direction mapping.
//
// There are FIVE user-facing relationships but only FOUR storage kinds:
// `blocked_by` and `blocks` are the two directions of the single
// `is_blocked_by` edge. "A blocked_by B" stores `A is_blocked_by B`; "A blocks
// B" stores `B is_blocked_by A`. The other three map straight through.

export const RELATIONSHIP_KINDS: ReadonlyArray<{ kind: RelationshipKind; label: string }> = [
  { kind: 'blocked_by', label: 'Blocked by' },
  { kind: 'blocks', label: 'Blocks' },
  { kind: 'relates_to', label: 'Relates to' },
  { kind: 'duplicates', label: 'Duplicates' },
  { kind: 'clones', label: 'Clones' },
];

const RELATIONSHIP_LABELS = new Map(RELATIONSHIP_KINDS.map((r) => [r.kind, r.label]));

export function isRelationshipKind(value: string): value is RelationshipKind {
  return RELATIONSHIP_LABELS.has(value as RelationshipKind);
}

export function relationshipLabel(kind: RelationshipKind): string {
  return RELATIONSHIP_LABELS.get(kind) ?? kind;
}

/**
 * Map a UI relationship (the CURRENT item + a TARGET) to the directed storage
 * link `linkWorkItems` consumes. `blocks` flips from/to (it's the inverse of
 * `blocked_by`); everything else is `current → target`.
 */
export function relationshipToLink(
  relationship: RelationshipKind,
  currentItemId: string,
  targetId: string,
): LinkWorkItemsInput {
  if (relationship === 'blocks') {
    return { fromId: targetId, toId: currentItemId, kind: 'is_blocked_by' };
  }
  const kind: WorkItemLinkKindDto = relationship === 'blocked_by' ? 'is_blocked_by' : relationship;
  return { fromId: currentItemId, toId: targetId, kind };
}
