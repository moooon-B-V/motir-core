import { describe, expect, it } from 'vitest';
import { flattenRoadmap } from '@/lib/hooks/useProjectRoadmap';

// The pure flatten behind `useProjectRoadmap`: nest → flat parent→child list, with
// roadmap ROOTS (epics) re-parented under the plan station node.
describe('flattenRoadmap', () => {
  const forest = [
    {
      id: 'e1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-1',
      title: 'Billing',
      status: 'in_progress',
      isDone: false,
      children: [
        {
          id: 's1',
          parentId: 'e1',
          kind: 'story',
          identifier: 'MOTIR-2',
          title: 'Invoices',
          status: 'todo',
          isDone: false,
          children: [
            {
              id: 't1',
              parentId: 's1',
              kind: 'subtask',
              identifier: 'MOTIR-3',
              title: 'Create invoice',
              status: 'done',
              isDone: true,
            },
          ],
        },
      ],
    },
  ];

  it('flattens the nested forest and hangs roots under the plan node', () => {
    const flat = flattenRoadmap(forest, 'plan');
    expect(flat.map((i) => [i.id, i.parentId])).toEqual([
      ['e1', 'plan'], // epic re-parented under the plan station
      ['s1', 'e1'], // story keeps its epic parent
      ['t1', 's1'], // subtask keeps its story parent
    ]);
    expect(flat.map((i) => i.kind)).toEqual(['epic', 'story', 'subtask']);
    expect(flat.find((i) => i.id === 't1')!.status).toBe('done');
    expect(flat.find((i) => i.id === 'e1')!.status).toBe('in_progress');
  });

  it('falls back via isDone for an unrecognized status, and to subtask for an unknown kind', () => {
    const flat = flattenRoadmap(
      [
        {
          id: 'a',
          parentId: null,
          kind: 'weird',
          identifier: 'X-1',
          title: 'A',
          status: 'mystery',
          isDone: true,
        },
        {
          id: 'b',
          parentId: null,
          kind: 'epic',
          identifier: 'X-2',
          title: 'B',
          status: 'mystery',
          isDone: false,
        },
      ],
      'plan',
    );
    expect(flat.find((i) => i.id === 'a')!.status).toBe('done'); // isDone → done
    expect(flat.find((i) => i.id === 'a')!.kind).toBe('subtask'); // unknown kind → subtask
    expect(flat.find((i) => i.id === 'b')!.status).toBe('todo'); // not done → todo
  });

  it('returns an empty list for an empty forest', () => {
    expect(flattenRoadmap([], 'plan')).toEqual([]);
  });
});
