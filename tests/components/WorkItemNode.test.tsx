// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  GhostAnchor,
  WorkItemNode,
  type WorkItemNodeData,
} from '@/components/planning/WorkItemNode';

afterEach(() => cleanup());

const item: WorkItemNodeData = {
  id: 'T1',
  identifier: 'MOTIR-1194',
  title: 'Standalone work-item canvas component',
  kind: 'subtask',
  status: 'in_progress',
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

  it('has a fixed height so a long title cannot overlap the row below it', () => {
    const { container } = render(
      <WorkItemNode
        item={{ ...item, title: 'A very long title that would wrap to many lines '.repeat(4) }}
      />,
    );
    expect((container.firstChild as HTMLElement).style.height).toBe('124px');
  });

  it('shows the drill affordance only when drillable', () => {
    const { rerender } = render(<WorkItemNode item={item} drillable />);
    expect(screen.queryByTestId('drill-affordance')).toBeTruthy();
    rerender(<WorkItemNode item={item} drillable={false} />);
    expect(screen.queryByTestId('drill-affordance')).toBeNull();
  });

  it('flags a cross-story (off-level blocked) node', () => {
    render(<WorkItemNode item={item} crossBlocked />);
    const flag = screen.getByTestId('cross-blocked-flag');
    expect(flag.textContent).toContain('cross-story');
  });

  // MOTIR-1362 — the card sits on the canvas's near-identical `--el-surface-soft`
  // background, so it MUST carry the crisp `--el-border` + a `--shadow-card` lift to
  // stay legible (the weak `border-soft` + `shadow-subtle` made cards vanish, esp. in
  // dark mode). Lock that so a future tweak can't quietly drop the contrast.
  it('renders the card with a crisp border + card shadow for canvas contrast', () => {
    const { container } = render(<WorkItemNode item={item} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-(--el-border)');
    expect(card.className).not.toContain('border-(--el-border-soft)');
    expect(card.className).toContain('shadow-(--shadow-card)');
    expect(card.className).not.toContain('shadow-(--shadow-subtle)');
  });

  // Subtask 7.20.6 / MOTIR-1013 — the per-container PROGRESS meter.
  it('renders a progress meter on a container, with the done/total count + a11y', () => {
    render(
      <WorkItemNode item={{ ...item, assigneeName: null }} progress={{ done: 2, total: 6 }} />,
    );
    expect(screen.getByTestId('progress-meter')).toBeTruthy();
    expect(screen.getByText('2 / 6')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe('6');
    expect((bar.firstChild as HTMLElement).style.width).toBe('33%'); // 2/6 ≈ 33%
  });

  it('omits the meter for a leaf (no progress) or a zero-total container', () => {
    const { rerender } = render(<WorkItemNode item={{ ...item, assigneeName: null }} />);
    expect(screen.queryByTestId('progress-meter')).toBeNull();
    rerender(
      <WorkItemNode item={{ ...item, assigneeName: null }} progress={{ done: 0, total: 0 }} />,
    );
    expect(screen.queryByTestId('progress-meter')).toBeNull();
  });

  // Subtask 7.20.6 / MOTIR-1013 — the "you are here" current-position marker.
  it('marks the active node "you are here": accent pill replaces status, aria-current=step', () => {
    const { container } = render(<WorkItemNode item={item} here />);
    expect(screen.getByText('You are here')).toBeTruthy();
    // The status pill is REPLACED (not shown alongside) on the active node.
    expect(screen.queryByText('In progress')).toBeNull();
    const card = container.firstChild as HTMLElement;
    expect(card.getAttribute('aria-current')).toBe('step');
    expect(card.className).toContain('border-(--el-accent)');
  });

  it('shows the status pill (no marker, no aria-current) when not active', () => {
    const { container } = render(<WorkItemNode item={item} />);
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.queryByText('You are here')).toBeNull();
    expect((container.firstChild as HTMLElement).getAttribute('aria-current')).toBeNull();
  });
});

describe('GhostAnchor', () => {
  it('names the off-level blocker and where it lives', () => {
    render(
      <GhostAnchor identifier="PROD-42" title="Migrate tokens" parentTitle="Auth hardening" />,
    );
    expect(screen.getByText('PROD-42')).toBeTruthy();
    expect(screen.getByText('Migrate tokens')).toBeTruthy();
    expect(screen.getByText('in Auth hardening ↗')).toBeTruthy();
  });
});
