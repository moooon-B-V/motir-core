// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunSetListPane } from '@/app/(authed)/runs/_components/RunSetListPane';
import type { DispatchRunCardDto, DispatchRunDto } from '@/lib/dto/dispatchRuns';
import type { RoadmapLevelItem } from '@/lib/planning/roadmapClient';

// THE RUN'S SET AS A LIST (MOTIR-9074).

afterEach(cleanup);

function leg(over: Partial<DispatchRunCardDto> = {}): DispatchRunCardDto {
  return {
    id: 'leg_1',
    key: 'MOTIR-1791',
    workItemId: 'wi_a',
    position: 0,
    disposition: 'implemented',
    skipReason: null,
    sessionBranch: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    model: null,
    ...over,
  };
}

function run(cards: DispatchRunCardDto[]): DispatchRunDto {
  return { id: 'run_1', cards } as unknown as DispatchRunDto;
}

const byId = new Map([
  ['wi_a', { id: 'wi_a', title: 'The ingest route' } as RoadmapLevelItem],
  ['wi_b', { id: 'wi_b', title: 'The run modal' } as RoadmapLevelItem],
]);

describe('the rows', () => {
  it('one row per leg, in the run’s stored order, with key, title and the tone label', () => {
    render(
      <RunSetListPane
        run={run([
          leg({ id: 'l1', key: 'MOTIR-1793', workItemId: 'wi_b', disposition: 'running' }),
          leg({ id: 'l2', key: 'MOTIR-1791', workItemId: 'wi_a' }),
        ])}
        byId={byId}
        selectedWorkItemId={null}
        onSelectWorkItem={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('run-set-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('MOTIR-1793');
    expect(rows[0]!.textContent).toContain('The run modal');
    expect(rows[1]!.textContent).toContain('MOTIR-1791');
    expect(rows[1]!.textContent).toContain('The ingest route');
  });

  it('shows the key and label without a title before the read lands', () => {
    render(
      <RunSetListPane
        run={run([leg()])}
        byId={new Map()}
        selectedWorkItemId={null}
        onSelectWorkItem={() => {}}
      />,
    );
    expect(screen.getByTestId('run-set-row').textContent).toContain('MOTIR-1791');
  });

  it('a leg with no work item is plain text, not a button', () => {
    render(
      <RunSetListPane
        run={run([leg({ workItemId: null })])}
        byId={byId}
        selectedWorkItemId={null}
        onSelectWorkItem={() => {}}
      />,
    );
    expect(screen.getByTestId('run-set-row').tagName).toBe('DIV');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('selection', () => {
  it('a click selects, marks aria-pressed, and clicking the selected row clears it', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <RunSetListPane
        run={run([leg()])}
        byId={byId}
        selectedWorkItemId={null}
        onSelectWorkItem={onSelect}
      />,
    );
    const row = screen.getByTestId('run-set-row');
    expect(row.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenLastCalledWith('wi_a');

    rerender(
      <RunSetListPane
        run={run([leg()])}
        byId={byId}
        selectedWorkItemId="wi_a"
        onSelectWorkItem={onSelect}
      />,
    );
    expect(screen.getByTestId('run-set-row').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('run-set-row'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
