// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunModal } from '@/app/(authed)/runs/_components/RunModal';
import type { DispatchRunCardDto, DispatchRunDto } from '@/lib/dto/dispatchRuns';

// THE RUN MODAL (Story MOTIR-1789 · MOTIR-3895).
//
// Four properties this file exists to hold, each of which fails silently:
// a run already FINISHED opens no stream; a run that is not there closes rather
// than sitting in an error; a run with no members says so instead of drawing an
// empty canvas; and the selection the LOG PANE will consume is actually exposed.
//
// ⚠️ THE CANVAS IS STUBBED. `ProjectRoadmapCanvas` measures its own container and
// fetches its own levels, and this file is about the MODAL — the canvas
// composition has its own assertions in `RunCanvasPane.test.tsx`, which drives
// `loadLevel` directly rather than through a layout happy-dom cannot do.
// The LOG PANE opens its own stream (MOTIR-3962) and is asserted in
// `RunLogPane.test.tsx`. Stubbed here so the modal's own stream discipline is
// what these tests measure.
vi.mock('@/app/(authed)/runs/_components/RunLogPane', () => ({
  RunLogPane: () => <div data-testid="stub-log-pane" />,
}));

// The FINDINGS strip is asserted in `RunFindings.test.tsx`. Stubbed here so what
// this file measures is the modal's own composition.
vi.mock('@/app/(authed)/runs/_components/RunFindings', () => ({
  RunFindings: () => <div data-testid="stub-findings" />,
}));

vi.mock('@/app/(authed)/runs/_components/RunCanvasPane', () => ({
  RunCanvasPane: ({ onSelectWorkItem }: { onSelectWorkItem: (id: string) => void }) => (
    <button type="button" data-testid="stub-node" onClick={() => onSelectWorkItem('wi_1')}>
      node
    </button>
  ),
}));

const fetchMock = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  onClose.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function leg(over: Partial<DispatchRunCardDto> = {}): DispatchRunCardDto {
  return {
    id: 'leg_1',
    key: 'MOTIR-1791',
    workItemId: 'wi_1',
    position: 0,
    disposition: 'implemented',
    skipReason: null,
    sessionBranch: null,
    startedAt: '2026-08-30T14:02:00.000Z',
    endedAt: '2026-08-30T14:20:00.000Z',
    exitCode: 0,
    ...over,
  };
}

function run(over: Partial<DispatchRunDto> = {}): DispatchRunDto {
  return {
    id: 'run_a91f',
    projectId: 'prj_1',
    command: 'run',
    origin: 'local',
    scopeWorkItemId: 'wi_scope',
    scopeLabel: 'MOTIR-1789',
    status: 'succeeded',
    stopReason: 'drained',
    agent: 'claude',
    model: 'claude-opus-5',
    startedAt: '2026-08-30T14:02:00.000Z',
    endedAt: '2026-08-30T14:20:04.000Z',
    createdById: null,
    cards: [leg()],
    seq: 12,
    ...over,
  };
}

/** Resolve the run read with a DTO, and let the load effect settle. */
async function mountWith(dto: DispatchRunDto): Promise<void> {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).includes('/stream')
      ? { ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } }
      : { ok: true, status: 200, json: async () => dto },
  );
  render(<RunModal runId="run_a91f" projectKey="MOTIR" onClose={onClose} />);
  await act(async () => {});
}

/** Refuse the run read with an HTTP status, and let the load effect settle. */
async function mountFailing(status: number): Promise<void> {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).includes('/stream')
      ? { ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } }
      : { ok: false, status, json: async () => ({}) },
  );
  render(<RunModal runId="run_a91f" projectKey="MOTIR" onClose={onClose} />);
  await act(async () => {});
}

describe('⚠️ ONE stream for the whole modal — two readers, not two connections', () => {
  // The log pane and the findings strip both read the run's events. Each owning
  // its own connection is a fan-out wearing a different name, which is the
  // defect the run surfaces' bounded-reads guard exists to catch — so the modal
  // holds ONE and hands the events down.
  it('opens exactly one stream, whatever the run’s status', async () => {
    await mountWith(run({ status: 'succeeded' }));

    const streams = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/stream'));
    expect(streams).toHaveLength(1);
  });

  it('resumes from seq 0, so the BACKFILL arrives and not just the tail', async () => {
    await mountWith(run({ status: 'running', seq: 12 }));

    const stream = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/stream'));
    // ⚠️ `since=0`, not the run's own `seq`. A finished run's lines are all
    // BEFORE its seq, so resuming at the cursor would render an empty console
    // for exactly the runs a person opens to read.
    expect(stream).toBe('/api/dispatch-runs/run_a91f/stream?since=0');
  });

  it('reads the run itself once on open', async () => {
    await mountWith(run());
    const reads = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => !u.includes('/stream'));
    expect(reads).toEqual(['/api/dispatch-runs/run_a91f']);
  });
});

describe('⚠️ a run that is NOT THERE closes — there is no route to 404', () => {
  it('closes on a 404 rather than rendering an error to sit in', async () => {
    await mountFailing(404);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a 403 too — the same answer, no existence leak', async () => {
    await mountFailing(403);
    expect(onClose).toHaveBeenCalled();
  });

  it('a FAILED read is a different fact and does NOT close', async () => {
    await mountFailing(500);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('run-modal-failed')).toBeTruthy();
  });
});

describe('the header says what the run WAS', () => {
  it('carries the command, the scope as a link, the agent and the stop reason', async () => {
    await mountWith(run());

    // ⚠️ THE ANGLE BRACKETS ARE ICU-ESCAPED IN THE CATALOG (`'<'scope>`), because
    // MessageFormat reads a bare `<scope>` as a TAG and throws UNCLOSED_TAG. The
    // key had shipped unrendered since MOTIR-3923 — the index prints the raw
    // command — so this is the first surface to have caught it.
    expect(screen.getByText('motir run <scope>')).toBeTruthy();
    const scope = screen.getByRole('link', { name: 'MOTIR-1789' });
    expect(scope.getAttribute('href')).toBe('/items/MOTIR-1789');
    expect(screen.getByText('claude · claude-opus-5')).toBeTruthy();
    // The stop reason in the terminal's OWN words, not a re-wording.
    expect(screen.getByText('the ready set is drained')).toBeTruthy();
  });

  it('⚠️ a deleted SCOPE still renders — the label is stored beside the id', async () => {
    await mountWith(run({ scopeWorkItemId: null, scopeLabel: 'MOTIR-1789' }));

    expect(screen.queryByRole('link', { name: 'MOTIR-1789' })).toBeNull();
    expect(screen.getByText('MOTIR-1789')).toBeTruthy();
  });

  it('shows a DURATION once the run has ended, and no ticking clock while it runs', async () => {
    await mountWith(run());
    expect(screen.getByText(/18m 04s/)).toBeTruthy();

    cleanup();
    await mountWith(run({ status: 'running', stopReason: null, endedAt: null }));
    expect(screen.queryByText(/18m 04s/)).toBeNull();
  });
});

describe('every state, not the happy path', () => {
  it('a run with NO work items says so — never an empty canvas', async () => {
    await mountWith(run({ cards: [] }));

    expect(screen.getByTestId('run-modal-no-members')).toBeTruthy();
    expect(screen.queryByTestId('stub-node')).toBeNull();
  });

  it('⚠️ REPORTING-OFFLINE says the RECORD is incomplete, not that the run failed', async () => {
    await mountWith(run({ status: 'timed_out', stopReason: 'abandoned' }));

    const notice = screen.getByTestId('run-modal-offline');
    expect(notice.textContent).toContain('The record is incomplete, not the run');
  });

  it('renders a member whose work item was DELETED — the leg outlives it', async () => {
    // `key` survives, `workItemId` goes null. The modal must not throw, and the
    // canvas must still be offered the level.
    await mountWith(run({ cards: [leg({ workItemId: null })] }));
    expect(screen.getByTestId('stub-node')).toBeTruthy();
  });
});

describe('the SELECTION is exposed, so the log pane can consume it', () => {
  it('selecting a node hands the work item to the right-hand region', async () => {
    await mountWith(run());

    const region = screen.getByTestId('run-modal-log-region');
    expect(region.getAttribute('data-selected-work-item')).toBe('');

    fireEvent.click(screen.getByTestId('stub-node'));
    expect(region.getAttribute('data-selected-work-item')).toBe('wi_1');
  });
});
