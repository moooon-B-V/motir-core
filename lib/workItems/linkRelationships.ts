import type {
  LinkWorkItemsInput,
  RelationshipKind,
  WorkItemLinkKindDto,
} from '@/lib/dto/workItemLinks';

// The UI relationship model for link management (Subtask 2.4.9), pure + UI-free
// so the Server Actions, the service candidate read, and component tests all
// share ONE source of truth for the relationships and their direction mapping.
//
// There are SEVEN user-facing relationships but only FIVE storage kinds, because
// two storage kinds are DIRECTED and read from either end:
//   - `blocked_by` / `blocks` are the two directions of the single
//     `is_blocked_by` edge. "A blocked_by B" stores `A is_blocked_by B`;
//     "A blocks B" stores `B is_blocked_by A`.
//   - `supersedes` / `superseded_by` are the two directions of the single
//     `supersedes` edge (MOTIR-6580), whose `from` is the NEWER item and `to`
//     the OLDER one. "A supersedes B" stores `A supersedes B`; "A superseded_by
//     B" stores `B supersedes A`.
// The other three map straight through.

export const RELATIONSHIP_KINDS: ReadonlyArray<{ kind: RelationshipKind; label: string }> = [
  { kind: 'blocked_by', label: 'Blocked by' },
  { kind: 'blocks', label: 'Blocks' },
  { kind: 'relates_to', label: 'Relates to' },
  { kind: 'duplicates', label: 'Duplicates' },
  { kind: 'clones', label: 'Clones' },
  { kind: 'supersedes', label: 'Supersedes' },
  { kind: 'superseded_by', label: 'Superseded by' },
];

/**
 * The relationships the web add-link control OFFERS today. The supersedes pair is
 * writable over REST v1 and MCP (MOTIR-6580), but the relationships panel does
 * not render those two groups yet — that is the person's story — so offering
 * them in the form would write a link the panel then drops from view. Widen this
 * to {@link RELATIONSHIP_KINDS} when the panel renders `supersedes` /
 * `supersededBy`.
 */
export const LINK_FORM_RELATIONSHIP_KINDS: ReadonlyArray<{
  kind: RelationshipKind;
  label: string;
}> = RELATIONSHIP_KINDS.filter((r) => r.kind !== 'supersedes' && r.kind !== 'superseded_by');

const RELATIONSHIP_LABELS = new Map(RELATIONSHIP_KINDS.map((r) => [r.kind, r.label]));

export function isRelationshipKind(value: string): value is RelationshipKind {
  return RELATIONSHIP_LABELS.has(value as RelationshipKind);
}

export function relationshipLabel(kind: RelationshipKind): string {
  return RELATIONSHIP_LABELS.get(kind) ?? kind;
}

/**
 * Which storage kind a relationship is, and which END of that directed edge the
 * CURRENT item sits on. Total over {@link RelationshipKind}: a new relationship
 * that is not added here fails the type check rather than falling through to a
 * wrong default.
 */
const RELATIONSHIP_STORAGE: Record<
  RelationshipKind,
  { kind: WorkItemLinkKindDto; currentIs: 'from' | 'to' }
> = {
  blocked_by: { kind: 'is_blocked_by', currentIs: 'from' },
  blocks: { kind: 'is_blocked_by', currentIs: 'to' },
  relates_to: { kind: 'relates_to', currentIs: 'from' },
  duplicates: { kind: 'duplicates', currentIs: 'from' },
  clones: { kind: 'clones', currentIs: 'from' },
  supersedes: { kind: 'supersedes', currentIs: 'from' },
  superseded_by: { kind: 'supersedes', currentIs: 'to' },
};

export function relationshipStorage(relationship: RelationshipKind): {
  kind: WorkItemLinkKindDto;
  currentIs: 'from' | 'to';
} {
  return RELATIONSHIP_STORAGE[relationship];
}

/**
 * Map a UI relationship (the CURRENT item + a TARGET) to the directed storage
 * link `linkWorkItems` consumes. `blocks` and `superseded_by` flip from/to (they
 * are the inverses of `blocked_by` and `supersedes`); everything else is
 * `current → target`.
 */
export function relationshipToLink(
  relationship: RelationshipKind,
  currentItemId: string,
  targetId: string,
): LinkWorkItemsInput {
  const { kind, currentIs } = RELATIONSHIP_STORAGE[relationship];
  return currentIs === 'from'
    ? { fromId: currentItemId, toId: targetId, kind }
    : { fromId: targetId, toId: currentItemId, kind };
}
