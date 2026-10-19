// Shared fixtures for the MOTIR-9023 story gate (`tests/integration/work-items/
// sections*.test.ts`). The gate compares one door's output with another's and
// with three independent heading readers, so every fixture here is plain: no bare
// work-item key and no `motir-ref:` chip, because `createWorkItem` and approve
// normalise those and a plan `add` does not.

import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import type { IssueType } from '@/lib/issues/parentRules';
import {
  sectionSetFor,
  type SectionType,
  type WorkItemSections,
} from '@/lib/workItems/sections/registry';
import { fixture } from '../unit/workItems/sections/helpers/sectionFixture';

export const GATE_CRITERIA = ['First criterion.', 'Second criterion.', 'Third criterion.'];
export const GATE_REFS = [
  { ref: 'lib/a/b.ts', why: 'the plain path' },
  { ref: 'lib/c.ts', why: 'a second path' },
];
export const GATE_REF_PATHS = ['lib/a/b.ts', 'lib/c.ts'];
export const GATE_BOUNDARY = 'The boundary text.';

/** The registry fixture for a cell, with its criteria and refs made single-line
 *  and chip-free so every reader's output compares to the input directly. */
export function gateSections(kind: IssueType, type: SectionType): WorkItemSections {
  const base = fixture(kind, type);
  return {
    ...base,
    ...('acceptanceCriteria' in base ? { acceptanceCriteria: GATE_CRITERIA } : {}),
    ...('contextRefs' in base ? { contextRefs: GATE_REFS } : {}),
  };
}

export interface GateCell {
  kind: IssueType;
  type: SectionType;
}

/** The cells a DOOR can create without a parent (a subtask cannot be a root, and
 *  a container carries no type) that define `acceptanceCriteria`. */
export const DOOR_CELLS: GateCell[] = [
  ...(['task', 'bug'] as const).flatMap((kind) =>
    WORK_ITEM_TYPES.map((type) => ({ kind, type: type as SectionType })),
  ),
  { kind: 'story' as const, type: null },
].filter((cell) => sectionSetFor(cell.kind, cell.type).sections.includes('acceptanceCriteria'));

/** Every line a person would count as text: non-blank, bullet marker aside. */
export function textLines(md: string): string[] {
  return md
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((l) => l.length > 0);
}
