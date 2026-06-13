import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXECUTOR_BY_TYPE,
  TYPEABLE_KINDS,
  WORK_ITEM_TYPES,
  defaultExecutorForType,
  isTypeableKind,
  isWorkItemType,
} from '@/lib/issues/executorDefaults';
import type { ExecutorDto, WorkItemKindDto, WorkItemTypeDto } from '@/lib/dto/workItems';

// Subtask 2.7.3 — the type→executor default map + the leaf-only guard, the pure
// SINGLE SOURCE the picker (2.7.4), the seed loader (2.7.5), and the service all
// call. No DB. The default map's totality is the load-bearing guarantee Story
// 7.6's per-type prompt generator relies on (a total function over the fixed
// enum). (Subtask 2.7.7 adds the broader DB-backed lock-down; this pins the
// pure helper at the source.)
//
// The expected values are written INDEPENDENTLY of the implementation (the
// parentValidation.test.ts convention) so these tests pin the 2.7.2 ADR's
// contract rather than mirror the code.

/** The ten members, in the canonical order the 2.7.2 ADR froze. */
const EXPECTED_TYPES: readonly WorkItemTypeDto[] = [
  'code',
  'design',
  'test',
  'content',
  'research',
  'review',
  'decision',
  'deploy',
  'manual',
  'chore',
];

/** The type→executor default map, transcribed independently from the ADR §3 table. */
const EXPECTED_DEFAULTS: Record<WorkItemTypeDto, ExecutorDto> = {
  code: 'coding_agent',
  test: 'coding_agent',
  deploy: 'coding_agent',
  manual: 'human',
  decision: 'human',
  review: 'human',
  design: 'coding_agent',
  content: 'coding_agent',
  research: 'coding_agent',
  chore: 'coding_agent',
};

const ALL_KINDS: readonly WorkItemKindDto[] = ['epic', 'story', 'task', 'bug', 'subtask'];
const EXPECTED_TYPEABLE: ReadonlySet<WorkItemKindDto> = new Set(['task', 'subtask', 'bug']);

describe('WORK_ITEM_TYPES — the fixed ten-member enum', () => {
  it('is exactly the ten members in the canonical ADR order', () => {
    expect([...WORK_ITEM_TYPES]).toEqual(EXPECTED_TYPES);
  });

  it('has no duplicate members', () => {
    expect(new Set(WORK_ITEM_TYPES).size).toBe(WORK_ITEM_TYPES.length);
  });
});

describe('defaultExecutorForType — a TOTAL function over the enum', () => {
  // Iterate the FULL enum: a new WorkItemType member with no mapping would fail
  // here (the total-function guarantee 7.6 relies on), not silently default.
  for (const type of EXPECTED_TYPES) {
    it(`maps ${type} → ${EXPECTED_DEFAULTS[type]}`, () => {
      expect(defaultExecutorForType(type)).toBe(EXPECTED_DEFAULTS[type]);
    });
  }

  it('the DEFAULT_EXECUTOR_BY_TYPE record has an entry for every type (no hole)', () => {
    for (const type of WORK_ITEM_TYPES) {
      expect(DEFAULT_EXECUTOR_BY_TYPE[type]).toBeDefined();
    }
    expect(Object.keys(DEFAULT_EXECUTOR_BY_TYPE).sort()).toEqual([...EXPECTED_TYPES].sort());
  });

  it('every default is a valid executor value', () => {
    for (const type of WORK_ITEM_TYPES) {
      expect(['coding_agent', 'human']).toContain(defaultExecutorForType(type));
    }
  });

  it('the three groups match the ADR (agent / human / either-default-agent)', () => {
    const agent: WorkItemTypeDto[] = ['code', 'test', 'deploy'];
    const human: WorkItemTypeDto[] = ['manual', 'decision', 'review'];
    const eitherDefaultAgent: WorkItemTypeDto[] = ['design', 'content', 'research', 'chore'];
    for (const t of agent) expect(defaultExecutorForType(t)).toBe('coding_agent');
    for (const t of human) expect(defaultExecutorForType(t)).toBe('human');
    for (const t of eitherDefaultAgent) expect(defaultExecutorForType(t)).toBe('coding_agent');
  });
});

describe('isTypeableKind / TYPEABLE_KINDS — leaf-only', () => {
  for (const kind of ALL_KINDS) {
    const expected = EXPECTED_TYPEABLE.has(kind);
    it(`${expected ? 'permits' : 'rejects'} a type on a ${kind}`, () => {
      expect(isTypeableKind(kind)).toBe(expected);
    });
  }

  it('TYPEABLE_KINDS is exactly {task, subtask, bug}', () => {
    expect([...TYPEABLE_KINDS].sort()).toEqual(['bug', 'subtask', 'task']);
  });
});

describe('isWorkItemType — narrowing guard', () => {
  it('accepts every enum member', () => {
    for (const type of WORK_ITEM_TYPES) expect(isWorkItemType(type)).toBe(true);
  });

  it('rejects non-members and non-strings', () => {
    expect(isWorkItemType('epic')).toBe(false); // a kind, not a type
    expect(isWorkItemType('Code')).toBe(false); // case-sensitive
    expect(isWorkItemType('')).toBe(false);
    expect(isWorkItemType(null)).toBe(false);
    expect(isWorkItemType(undefined)).toBe(false);
    expect(isWorkItemType(42)).toBe(false);
  });
});
