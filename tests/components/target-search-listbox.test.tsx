// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { TargetSearchListbox } from '@/components/planning/TargetSearchListbox';
import type { WorkItemMentionCandidate } from '@/components/ui/markdownEditorMentions';

// The target search popover's SHELL (MOTIR-1491, extended by MOTIR-6897 —
// design `target-picker--search-and-canvas.mock.html` panels 2 + 3), rendered
// directly: the row grammar's status tones, the hint line, and a row with no
// status. The composer spec drives it end to end; this pins the presentational
// branches a search against a two-row fixture never reaches.

afterEach(cleanup);

function row(id: string, status: WorkItemMentionCandidate['status']): WorkItemMentionCandidate {
  return { id, identifier: `MOTIR-${id}`, title: `Item ${id}`, kind: 'task', status };
}

function renderListbox(
  results: WorkItemMentionCandidate[],
  extra: { targetIds?: Set<string> } = {},
) {
  const onPick = vi.fn();
  renderWithIntl(
    <TargetSearchListbox
      listboxId="lb"
      optionIdPrefix="opt"
      query="item"
      results={results}
      loading={false}
      tooShort={false}
      activeIndex={0}
      onPick={onPick}
      onHover={() => {}}
      {...extra}
    />,
  );
  return onPick;
}

describe('TargetSearchListbox', () => {
  it('draws every status tone as its Pill, and a row with no status as none', () => {
    renderListbox([
      row('1', { label: 'To Do', tone: 'planned' }),
      row('2', { label: 'In Progress', tone: 'in-progress' }),
      row('3', { label: 'Done', tone: 'done' }),
      row('4', { label: 'Blocked', tone: 'warning' }),
      row('5', { label: 'Custom', tone: 'neutral' }),
      row('6', null),
    ]);

    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'MOTIR-1Item 1To Do',
      'MOTIR-2Item 2In Progress',
      'MOTIR-3Item 3Done',
      'MOTIR-4Item 4Blocked',
      'MOTIR-5Item 5Custom',
      'MOTIR-6Item 6',
    ]);
  });

  it('shows the key-hint line only while there are rows', () => {
    renderListbox([row('1', null)]);
    expect(screen.getByText('Enter add as target')).toBeTruthy();
  });

  it('picks a normal row on mousedown, and not a row that is already a target', () => {
    const onPick = renderListbox([row('1', null), row('2', null)], { targetIds: new Set(['1']) });
    const [first, second] = screen.getAllByRole('option');

    fireEvent.mouseDown(first!);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.mouseDown(second!);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
  });
});
