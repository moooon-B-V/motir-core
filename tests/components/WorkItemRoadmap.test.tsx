// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { WorkItemRoadmap, type WorkItemForestItem } from '@/components/planning/WorkItemRoadmap';

afterEach(() => cleanup());

const items: WorkItemForestItem[] = [
  {
    id: 'E1',
    identifier: 'MOTIR-1',
    title: 'Epic one',
    kind: 'epic',
    status: 'in_progress',
    parentId: null,
  },
  {
    id: 'S1',
    identifier: 'MOTIR-2',
    title: 'Story one',
    kind: 'story',
    status: 'todo',
    parentId: 'E1',
  },
  {
    id: 'T1a',
    identifier: 'MOTIR-4',
    title: 'Build the engine',
    kind: 'subtask',
    status: 'done',
    parentId: 'S1',
  },
];

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

describe('WorkItemRoadmap', () => {
  it('renders the epic at the top level and drills into its stories', () => {
    render(<WorkItemRoadmap items={items} />);
    expect(el('E1')).toBeTruthy();
    expect(screen.getByText('Epic one')).toBeTruthy();
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    expect(el('S1')).toBeTruthy();
    expect(screen.getByText('Story one')).toBeTruthy();
  });

  it('selects a leaf subtask instead of drilling, and shows its status', () => {
    const onSelect = vi.fn();
    render(<WorkItemRoadmap items={items} onSelect={onSelect} />);
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    fireEvent.keyDown(el('S1')!, { key: 'Enter' });
    expect(screen.getByText('Done')).toBeTruthy(); // T1a status pill
    fireEvent.keyDown(el('T1a')!, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('T1a');
  });

  it('offers the search overlay (the roadmap is searchable)', () => {
    render(<WorkItemRoadmap items={items} />);
    expect(screen.getByPlaceholderText('Search the roadmap')).toBeTruthy();
  });
});
