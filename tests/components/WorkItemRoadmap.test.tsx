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
});
