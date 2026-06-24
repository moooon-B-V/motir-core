// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { WorkItemCanvas } from '@/components/planning/WorkItemCanvas';
import type { WorkItemCanvasDep, WorkItemCanvasItem } from '@/lib/planning/workItemCanvasModel';

afterEach(() => cleanup());

const items: WorkItemCanvasItem[] = [
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
    id: 'S2',
    identifier: 'MOTIR-3',
    title: 'Story two',
    kind: 'story',
    status: 'done',
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
  {
    id: 'T1b',
    identifier: 'MOTIR-5',
    title: 'Wire the engine',
    kind: 'subtask',
    status: 'todo',
    parentId: 'S1',
  },
];
const deps: WorkItemCanvasDep[] = [{ blockedId: 'T1b', blockerId: 'T1a' }];

function node(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

describe('WorkItemCanvas', () => {
  it('renders the forest roots at the top level (no breadcrumb back yet)', () => {
    render(<WorkItemCanvas items={items} dependencies={deps} />);
    expect(node('E1')).toBeTruthy();
    expect(node('S1')).toBeNull(); // not at this level
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('drills into a node, shows the breadcrumb, and Back returns', () => {
    render(<WorkItemCanvas items={items} dependencies={deps} />);
    fireEvent.keyDown(node('E1')!, { key: 'Enter' }); // E1 is drillable
    expect(node('S1')).toBeTruthy();
    expect(node('S2')).toBeTruthy();
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('MOTIR-1')).toBeTruthy(); // E1 crumb
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(node('E1')).toBeTruthy();
    expect(node('S1')).toBeNull();
  });

  it('calls onSelect for a LEAF node (no children) instead of drilling', () => {
    const onSelect = vi.fn();
    render(<WorkItemCanvas items={items} dependencies={deps} onSelect={onSelect} />);
    fireEvent.keyDown(node('E1')!, { key: 'Enter' }); // → stories
    fireEvent.keyDown(node('S1')!, { key: 'Enter' }); // → subtasks
    fireEvent.keyDown(node('T1a')!, { key: 'Enter' }); // leaf → onSelect
    expect(onSelect).toHaveBeenCalledWith('T1a');
  });

  it('search-to-focus highlights the matching node at the current level', () => {
    render(<WorkItemCanvas items={items} dependencies={deps} />);
    fireEvent.keyDown(node('E1')!, { key: 'Enter' }); // show S1, S2
    fireEvent.change(screen.getByPlaceholderText('Search work items'), {
      target: { value: 'Story two' },
    });
    const s2 = node('S2')!;
    expect(s2.querySelector('[data-highlighted]')).toBeTruthy();
    expect(node('S1')!.querySelector('[data-highlighted]')).toBeNull();
  });

  it('shows the empty state when there is nothing to render', () => {
    render(<WorkItemCanvas items={[]} dependencies={[]} />);
    expect(screen.getByText('Nothing planned yet')).toBeTruthy();
  });

  it('shows a loading state', () => {
    render(<WorkItemCanvas items={items} dependencies={deps} loading />);
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('opens status filter chips for the statuses present at the level', () => {
    render(<WorkItemCanvas items={items} dependencies={deps} />);
    fireEvent.keyDown(node('E1')!, { key: 'Enter' }); // S1 (todo), S2 (done)
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(screen.getByRole('button', { name: 'To do', pressed: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done', pressed: false })).toBeTruthy();
  });
});
