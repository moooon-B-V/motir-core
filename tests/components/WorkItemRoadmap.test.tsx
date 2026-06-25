// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The per-level roadmap endpoint, served from a tiny in-memory tree:
//   roots → [Epic one (drillable)];  E1's children → [Story one (leaf)].
const root = {
  nodes: [
    {
      id: 'E1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-1',
      title: 'Epic one',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
  ],
  edges: [],
};
const e1Children = {
  nodes: [
    {
      id: 'S1',
      parentId: 'E1',
      kind: 'story',
      identifier: 'MOTIR-2',
      title: 'Story one',
      status: 'done',
      isDone: true,
      hasChildren: false,
    },
  ],
  edges: [],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
      return { ok: true, json: async () => root };
    }),
  );
});

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

describe('WorkItemRoadmap', () => {
  it('renders the root level and drills into a node, fetching its children', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    expect(await screen.findByText('Epic one')).toBeTruthy();
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy(); // S1 status pill
  });

  it('selects a leaf instead of drilling', async () => {
    const onSelect = vi.fn();
    render(<WorkItemRoadmap projectKey="MOTIR" onSelect={onSelect} />);
    await screen.findByText('Epic one');
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    await screen.findByText('Story one');
    fireEvent.keyDown(el('S1')!, { key: 'Enter' }); // S1 is a leaf
    expect(onSelect).toHaveBeenCalledWith('S1');
  });

  it('offers the search overlay', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    expect(screen.getByPlaceholderText('Search the roadmap')).toBeTruthy();
  });

  it('renders the cross-story signal: a ghost anchor + a flagged node for an off-level blocker', async () => {
    // A level where T1 is blocked_by X, and X is NOT in the level → off-level.
    const crossLevel = {
      nodes: [
        {
          id: 'T1',
          parentId: null,
          kind: 'subtask',
          identifier: 'MOTIR-5',
          title: 'Wire it',
          status: 'todo',
          isDone: false,
          hasChildren: false,
        },
      ],
      edges: [{ blockedId: 'T1', blockerId: 'X9' }],
      offLevelBlockers: [
        {
          id: 'X9',
          identifier: 'MOTIR-42',
          title: 'Migrate tokens',
          parentTitle: 'Auth hardening',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => crossLevel })),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    // the blocked node carries the cross-story flag…
    expect(await screen.findByTestId('cross-blocked-flag')).toBeTruthy();
    // …and the off-level blocker is anchored by a named ghost node.
    expect(screen.getByText('MOTIR-42')).toBeTruthy();
    expect(screen.getByText('in Auth hardening ↗')).toBeTruthy();
    expect(document.querySelector('[data-node-id="X9"]')).not.toBeNull();
  });
});
