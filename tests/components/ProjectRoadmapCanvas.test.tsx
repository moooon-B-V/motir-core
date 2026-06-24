// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { ProjectRoadmapCanvas } from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

afterEach(() => cleanup());

function node(id: string, parentId: string | null, label: string): ProjectCanvasNode {
  return { id, parentId, searchText: label, crumbLabel: id, content: <div>{label}</div> };
}

// epic E1 → stories S1, S2 → subtasks; S1 has T1a (done) → T1b.
const nodes: ProjectCanvasNode[] = [
  node('E1', null, 'Epic one'),
  node('S1', 'E1', 'Story one'),
  node('S2', 'E1', 'Story two'),
  node('T1a', 'S1', 'Build engine'),
  node('T1b', 'S1', 'Wire engine'),
];
const deps: ProjectCanvasDep[] = [{ from: 'T1a', to: 'T1b', variant: 'firm' }];

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

describe('ProjectRoadmapCanvas', () => {
  it('renders the roadmap roots, bare (no breadcrumb / search) by default', () => {
    render(<ProjectRoadmapCanvas nodes={nodes} deps={deps} />);
    expect(el('E1')).toBeTruthy();
    expect(el('S1')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('drills into a node, shows the breadcrumb, and Back returns', () => {
    render(<ProjectRoadmapCanvas nodes={nodes} deps={deps} />);
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    expect(el('S1')).toBeTruthy();
    expect(el('S2')).toBeTruthy();
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('E1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(el('E1')).toBeTruthy();
    expect(el('S1')).toBeNull();
  });

  it('calls onSelect for a LEAF node instead of drilling', () => {
    const onSelect = vi.fn();
    render(<ProjectRoadmapCanvas nodes={nodes} deps={deps} onSelect={onSelect} />);
    fireEvent.keyDown(el('E1')!, { key: 'Enter' }); // → stories
    fireEvent.keyDown(el('S1')!, { key: 'Enter' }); // → subtasks
    fireEvent.keyDown(el('T1a')!, { key: 'Enter' }); // leaf → onSelect
    expect(onSelect).toHaveBeenCalledWith('T1a');
  });

  it('search-to-focus highlights the matching node at the current level', () => {
    render(<ProjectRoadmapCanvas nodes={nodes} deps={deps} searchable />);
    fireEvent.keyDown(el('E1')!, { key: 'Enter' }); // show S1, S2
    fireEvent.change(screen.getByPlaceholderText('Search the roadmap'), {
      target: { value: 'Story two' },
    });
    expect(el('S2')!.querySelector('[data-highlighted]')).toBeTruthy();
    expect(el('S1')!.querySelector('[data-highlighted]')).toBeNull();
  });

  it('flags a cross-parent dependency when both ends are visible', () => {
    // Two subtasks under different parents rendered as one level → cross edge.
    const cross = [node('A', 'P1', 'a'), node('B', 'P2', 'b')];
    render(<ProjectRoadmapCanvas nodes={cross} deps={[{ from: 'A', to: 'B', variant: 'firm' }]} />);
    expect(screen.getAllByTestId('cross-flag')).toHaveLength(1);
  });

  it('shows the empty state when there is nothing to render', () => {
    render(<ProjectRoadmapCanvas nodes={[]} />);
    expect(screen.getByText('Nothing on the roadmap yet')).toBeTruthy();
  });
});
