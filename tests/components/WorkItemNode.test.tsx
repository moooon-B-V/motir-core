// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkItemNode } from '@/components/planning/WorkItemNode';
import type { WorkItemCanvasItem } from '@/lib/planning/workItemCanvasModel';

afterEach(() => cleanup());

const item: WorkItemCanvasItem = {
  id: 'T1',
  identifier: 'MOTIR-1194',
  title: 'Standalone work-item canvas component',
  kind: 'subtask',
  status: 'in_progress',
  parentId: 'S1',
  assigneeName: 'Yue',
};

describe('WorkItemNode', () => {
  it('shows the identifier, title, status label, and assignee', () => {
    render(<WorkItemNode item={item} />);
    expect(screen.getByText('MOTIR-1194')).toBeTruthy();
    expect(screen.getByText('Standalone work-item canvas component')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Yue')).toBeTruthy();
  });

  it('shows the drill affordance only when drillable', () => {
    const { rerender } = render(<WorkItemNode item={item} drillable />);
    expect(screen.queryByTestId('drill-affordance')).toBeTruthy();
    rerender(<WorkItemNode item={item} drillable={false} />);
    expect(screen.queryByTestId('drill-affordance')).toBeNull();
  });

  it('marks the highlighted (search-match) node', () => {
    render(<WorkItemNode item={item} highlighted />);
    expect(document.querySelector('[data-highlighted]')).toBeTruthy();
  });
});
