// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunSection } from '@/app/(authed)/items/[key]/_components/RunSection';
import { RunModal } from '@/app/(authed)/runs/_components/RunModal';
import { RunLogPane } from '@/app/(authed)/runs/_components/RunLogPane';
import type {
  DispatchRunCostDto,
  DispatchRunDetailDto,
  DispatchRunDto,
  DispatchRunEventDto,
  DispatchRunHostedEndDto,
} from '@/lib/dto/dispatchRuns';

// A HOSTED run on the two SHIPPED run surfaces (Story MOTIR-683 · MOTIR-691;
// design MOTIR-684) — the Run section on the work item and the run modal on
// `/runs`: the meta row and phases, each END with the reason its run recorded,
// the cost block (tokens · credits · machine time), and Cancel run — and a LOCAL
// run's surfaces unchanged: no cost, no cancel, no cost read.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(authed)/runs/_components/RunCanvasPane', () => ({
  RunCanvasPane: () => <div data-testid="stub-canvas" />,
}));
vi.mock('@/app/(authed)/runs/_components/RunFindings', () => ({
  RunFindings: () => null,
}));

let routes: Record<string, () => { status: number; body: unknown }> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
  const handler = routes[key];
  if (!handler) return new Response(null, { status: 500 });
  const { status, body } = handler();
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
});
const requested = () => fetchMock.mock.calls.map(([input]) => String(input).split('?')[0] ?? '');

beforeEach(() => {
  fetchMock.mockClear();
  routes = {};
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function run(over: Partial<DispatchRunDto> = {}): DispatchRunDto {
  return {
    id: 'run_h',
    projectId: 'prj_1',
    command: 'run',
    origin: 'hosted',
    scopeWorkItemId: null,
    scopeLabel: null,
    status: 'succeeded',
    stopReason: 'completed',
    agent: 'opencode',
    model: 'claude-sonnet-5',
    startedAt: '2026-09-26T14:00:00.000Z',
    endedAt: '2026-09-26T14:26:32.000Z',
    createdById: 'usr_1',
    seq: 9,
    cards: [
      {
        id: 'leg_1',
        key: 'PROD-42',
        workItemId: 'itm_1',
        position: 0,
        disposition: 'implemented',
        skipReason: null,
        sessionBranch: null,
        startedAt: '2026-09-26T14:00:00.000Z',
        endedAt: '2026-09-26T14:26:32.000Z',
        exitCode: 0,
      },
    ],
    ...over,
  };
}

const COST: DispatchRunCostDto = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 50,
  cacheWriteTokens: 7,
  credits: 34,
  machineCredits: 27,
  totalCredits: 61,
};

function detail(
  base: DispatchRunDto,
  over: {
    cost?: DispatchRunCostDto | null;
    hostedEnd?: DispatchRunHostedEndDto;
    prs?: number;
  } = {},
): DispatchRunDetailDto {
  const prs = over.prs ?? 0;
  return {
    ...base,
    cost: over.cost === undefined ? COST : over.cost,
    hostedEnd: over.hostedEnd ?? { outcome: null, detail: null, exitCode: 0 },
    cards: base.cards.map((c) => ({
      ...c,
      deliveries: Array.from({ length: prs }, (_, i) => ({
        pullRequest: {
          url: `https://github.com/acme/repo${i}/pull/${10 + i}`,
          repo: `acme/repo${i}`,
          number: 10 + i,
          title: 'PROD-42 change',
        },
        defaultBranch: 'main',
        baseRef: 'main',
        queueExit: null,
      })),
    })) as DispatchRunDetailDto['cards'],
  };
}

function serve(d: DispatchRunDetailDto, machine = { billableSeconds: 1592, settled: true }) {
  routes[`GET /api/dispatch-runs/${d.id}`] = () => ({ status: 200, body: d });
  routes[`GET /api/dispatch-runs/${d.id}/machine-time`] = () => ({ status: 200, body: machine });
}

async function mountSection(r: DispatchRunDto) {
  render(
    <RunSection initialRuns={[r]} initialCursor={null} itemKey="PROD-42" formattedTimes={{}} />,
  );
  await act(async () => {});
}

describe('the Run section — a HOSTED run', () => {
  it('succeeded: meta row, all six phases, one pull request per repository, and the cost', async () => {
    const r = run();
    serve(detail(r, { prs: 2 }));
    await mountSection(r);
    await waitFor(() => expect(screen.getByTestId('hosted-end')).toBeTruthy());

    const body = screen.getByTestId('hosted-run');
    expect(body.textContent).toContain('Lane');
    expect(body.textContent).toContain('Hosted');
    expect(body.textContent).toContain('claude-sonnet-5');
    expect(body.textContent).toContain('Took');

    const phases = screen.getByTestId('hosted-phases').querySelectorAll('li');
    expect([...phases].map((li) => li.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);

    const end = screen.getByTestId('hosted-end');
    expect(end.getAttribute('data-end')).toBe('succeeded');
    const links = [...end.querySelectorAll('a')].map((a) => a.textContent);
    expect(links).toEqual(['acme/repo0 #10', 'acme/repo1 #11']);

    expect(screen.getByTestId('hosted-cost-tokens').textContent).toContain('1,200 in · 300 out');
    expect(screen.getByTestId('hosted-cost-credits').textContent).toContain('61 credits');
    expect(screen.getByTestId('hosted-cost-credits').textContent).toContain(
      '34 model calls · 27 machine time',
    );
    await waitFor(() =>
      expect(screen.getByTestId('hosted-cost-machine').textContent).toContain('26 min 32 s'),
    );
  });

  it('stalled: the recorded reason, verbatim, and the work item stays — no "reporting offline"', async () => {
    const r = run({ status: 'timed_out', stopReason: 'abandoned' });
    serve(
      detail(r, {
        hostedEnd: {
          outcome: 'stall',
          detail: 'stalled: no agent output for 15 minutes',
          exitCode: null,
        },
      }),
    );
    await mountSection(r);
    await waitFor(() => expect(screen.getByTestId('hosted-end')).toBeTruthy());
    const end = screen.getByTestId('hosted-end');
    expect(end.getAttribute('data-end')).toBe('stalled');
    expect(end.textContent).toContain('The agent stopped producing output.');
    expect(screen.getByTestId('hosted-reason').textContent).toBe(
      'stalled: no agent output for 15 minutes',
    );
    expect(end.textContent).toContain('This work item stays where it was');
    expect(screen.queryByText(/stopped reporting/i)).toBeNull();
  });

  it('failed, closed by the CLI itself: the reason is the agent’s exit code', async () => {
    const r = run({ status: 'failed', stopReason: 'halted' });
    serve(detail(r, { hostedEnd: { outcome: null, detail: null, exitCode: 1 } }));
    await mountSection(r);
    await waitFor(() => expect(screen.getByTestId('hosted-reason')).toBeTruthy());
    expect(screen.getByTestId('hosted-reason').textContent).toBe('agent exited with code 1');
  });

  it('cancelled still shows what it cost', async () => {
    const r = run({ status: 'cancelled', stopReason: 'interrupted' });
    serve(
      detail(r, {
        hostedEnd: { outcome: 'cancelled', detail: 'cancelled by a person', exitCode: null },
      }),
    );
    await mountSection(r);
    await waitFor(() => expect(screen.getByTestId('hosted-end')).toBeTruthy());
    expect(screen.getByTestId('hosted-end').getAttribute('data-end')).toBe('cancelled');
    expect(screen.getByTestId('hosted-run-cost')).toBeTruthy();
  });

  it('a live run: the cost is marked live, and the machine charge is not printed as zero', async () => {
    const r = run({ status: 'running', endedAt: null, stopReason: null });
    serve(detail(r, { cost: { ...COST, machineCredits: 0, totalCredits: 34 } }), {
      billableSeconds: 300,
      settled: false,
    });
    await mountSection(r);
    await waitFor(() =>
      expect(screen.getByTestId('hosted-cost-credits').textContent).toContain('34'),
    );
    expect(screen.getByTestId('hosted-run-cost').textContent).toContain(
      'So far — updating while the run is live',
    );
    expect(screen.getByTestId('hosted-cost-credits').textContent).toContain(
      'machine time is charged when the run ends',
    );
    expect(screen.queryByTestId('hosted-end')).toBeNull();
  });

  it('motir-ai could not be asked: the cost says so, never "0 credits"', async () => {
    const r = run();
    serve(detail(r, { cost: null }));
    await mountSection(r);
    await waitFor(() => expect(screen.getByTestId('hosted-cost-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('hosted-cost-credits')).toBeNull();
  });
});

describe('the Run section — a LOCAL run is unchanged', () => {
  it('no cost block, no cancel, no picker, and no cost or machine-time read', async () => {
    await mountSection(run({ origin: 'local', agent: 'claude' }));
    expect(screen.queryByTestId('hosted-run')).toBeNull();
    expect(screen.queryByTestId('hosted-run-cost')).toBeNull();
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
    expect(screen.queryByTestId('hosted-model-picker')).toBeNull();
    expect(requested()).toEqual([]);
  });
});

describe('the run modal — a HOSTED run', () => {
  async function mountModal(
    d: DispatchRunDetailDto,
    machine?: { billableSeconds: number; settled: boolean },
  ) {
    serve(d, machine);
    render(<RunModal runId={d.id} projectKey="PROD" onClose={vi.fn()} />);
    await act(async () => {});
    await waitFor(() => expect(screen.queryByTestId('run-modal-loading')).toBeNull());
  }

  it('live: the Hosted title and lane chip, Cancel run beside the pill, the cost strip and the phase chip', async () => {
    await mountModal(detail(run({ status: 'running', endedAt: null, stopReason: null })), {
      billableSeconds: 60,
      settled: false,
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hosted run');
    expect(screen.getByTestId('hosted-run-cancel')).toBeTruthy();
    expect(screen.getByTestId('hosted-run-cost').textContent).toContain('Cost so far');
    expect(screen.getByTestId('hosted-phase-chip').textContent).toBe('Starting · 1 of 6');
  });

  it('the log console’s footer says a hosted run always reports its output', () => {
    render(
      <RunLogPane
        run={run({ status: 'running', endedAt: null, stopReason: null })}
        events={[
          {
            id: 'ev_1',
            seq: 1,
            kind: 'log',
            cardId: null,
            body: 'opencode: reading the card',
            data: null,
            createdAt: '2026-09-26T14:01:00.000Z',
          } satisfies DispatchRunEventDto,
        ]}
        selectedWorkItemId={null}
      />,
    );
    expect(screen.getByTestId('run-log-hosted-footer').textContent).toBe(
      'A hosted run always reports its output. · Deleted after 30 days.',
    );
  });

  it('ended: the stop line is the reason its end recorded, and there is no cancel', async () => {
    await mountModal(
      detail(run({ status: 'timed_out', stopReason: 'abandoned' }), {
        hostedEnd: { outcome: 'backstop', detail: 'timed out after 12 hours', exitCode: null },
      }),
    );
    expect(screen.getByTestId('hosted-stop-line').textContent).toBe('timed out after 12 hours');
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
    expect(screen.queryByTestId('run-modal-offline')).toBeNull();
  });

  it('a LOCAL run: no cost strip, no cancel, no phase chip', async () => {
    const local = run({ origin: 'local', agent: 'claude' });
    routes[`GET /api/dispatch-runs/${local.id}`] = () => ({ status: 200, body: { ...local } });
    render(<RunModal runId={local.id} projectKey="PROD" onClose={vi.fn()} />);
    await act(async () => {});
    await waitFor(() => expect(screen.queryByTestId('run-modal-loading')).toBeNull());
    expect(screen.queryByTestId('hosted-run-cost')).toBeNull();
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
    expect(screen.queryByTestId('hosted-phase-chip')).toBeNull();
    expect(requested().some((u) => u.endsWith('/machine-time'))).toBe(false);
  });
});
