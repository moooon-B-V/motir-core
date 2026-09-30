// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { HostedRunProvider } from '@/app/(authed)/items/[key]/_components/HostedRunProvider';
import { RunHostedButton } from '@/app/(authed)/items/[key]/_components/RunHostedButton';
import { RunSection } from '@/app/(authed)/items/[key]/_components/RunSection';
import { RunModal } from '@/app/(authed)/runs/_components/RunModal';
import { RunLogPane } from '@/app/(authed)/runs/_components/RunLogPane';
import { agentEndKind } from '@/app/(authed)/runs/_components/AgentRunParts';
import { AGENT_RUN_END_DETAIL } from '@/lib/agentInstances/runEnd';
import type {
  DispatchRunDetailDto,
  DispatchRunDto,
  DispatchRunHostedEndDto,
  DispatchRunStatus,
} from '@/lib/dto/dispatchRuns';

// A RUN IN AN AGENT on the two run surfaces (Story MOTIR-6864 · MOTIR-7028;
// design MOTIR-7022 revision 2, `design/runs/run-section--agent.mock.html` panels
// 7–10 and 12) — the item page's Run section and the run modal on `/runs`: who
// worked it (`<agent> · <coding agent>`) with a working link to the agent, machine
// time as its ONLY cost, the face every DispatchRunStatus draws with the reason
// its end recorded, and Cancel run — the agent's owner only — which POSTs the
// cancel route and shows the run cancelled.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
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
const calls = (key: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => `${init?.method ?? 'GET'} ${String(input).split('?')[0]}` === key,
  );
const requested = () => fetchMock.mock.calls.map(([input]) => String(input).split('?')[0] ?? '');

beforeEach(() => {
  refresh.mockReset();
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
    id: 'run_a',
    projectId: 'prj_1',
    command: 'run',
    origin: 'instance',
    scopeWorkItemId: null,
    scopeLabel: null,
    status: 'succeeded',
    stopReason: 'completed',
    lastHeartbeatAt: null,
    agentInstance: {
      id: 'ai_1',
      name: 'yue-claude',
      profile: 'claude',
      profileLabel: 'Claude Code',
    },
    agent: 'claude',
    model: null,
    startedAt: '2026-09-26T14:00:00.000Z',
    endedAt: '2026-09-26T14:26:32.000Z',
    createdById: 'usr_me',
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

const live = (over: Partial<DispatchRunDto> = {}) =>
  run({ status: 'running', stopReason: null, endedAt: null, ...over });

function detail(
  base: DispatchRunDto,
  hostedEnd: DispatchRunHostedEndDto = { outcome: null, detail: null, exitCode: null },
  prs = 0,
): DispatchRunDetailDto {
  return {
    ...base,
    cost: null,
    hostedEnd,
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

function serve(d: DispatchRunDetailDto) {
  routes[`GET /api/dispatch-runs/${d.id}`] = () => ({ status: 200, body: d });
}

async function mountSection(r: DispatchRunDto, viewerId = 'usr_me') {
  render(
    <HostedRunProvider
      itemKey="PROD-42"
      ready
      openBlockers={0}
      viewerId={viewerId}
      agents={{ projectName: 'Motir' }}
    >
      <RunHostedButton />
      <RunSection initialRuns={[r]} initialCursor={null} itemKey="PROD-42" formattedTimes={{}} />
    </HostedRunProvider>,
  );
  await act(async () => {});
}

describe('the Run section — a run in an agent', () => {
  it('running: who works it, the link to the agent, the phases and machine time as the only cost', async () => {
    const r = live();
    serve(detail(r));
    await mountSection(r);
    const body = screen.getByTestId('agent-run');
    expect(body.getAttribute('data-status')).toBe('running');
    expect(screen.getByTestId('agent-lane').textContent).toBe('yue-claude · Claude Code');
    expect(body.textContent).toContain('Your agent is working on it');
    expect(screen.getByTestId('agent-link').textContent).toBe('Watch it in My agents');
    expect(screen.getByTestId('agent-link').getAttribute('href')).toBe('/my-agents?agent=ai_1');
    expect(body.textContent).toContain('Worked by');
    expect(body.textContent).toContain('Coding agent');
    expect(body.textContent).toContain('Elapsed');
    expect(screen.getByTestId('hosted-phases')).toBeTruthy();
    const cost = screen.getByTestId('agent-run-cost');
    expect(cost.textContent).toContain('Machine time');
    expect(cost.textContent).toContain('No tokens: Claude Code runs on your own sign-in.');
    expect(cost.textContent).not.toContain('Tokens');
    expect(cost.textContent).not.toContain('Credits');
    // No hosted cost read for a run in an agent, and no "hosted" anywhere.
    expect(requested()).not.toContain('/api/dispatch-runs/run_a/machine-time');
    expect(body.textContent?.toLowerCase()).not.toContain('hosted');
    // No end yet.
    expect(screen.queryByTestId('agent-end')).toBeNull();
    // A live run leaves no way to start another.
    expect(screen.queryByTestId('start-bar')).toBeNull();
  });

  it('succeeded: the pull request it opened, then the end line, and Took', async () => {
    const r = run();
    serve(detail(r, { outcome: null, detail: null, exitCode: 0 }, 1));
    await mountSection(r);
    await waitFor(() => expect(screen.getByTestId('agent-end')).toBeTruthy());
    const end = screen.getByTestId('agent-end');
    expect(end.getAttribute('data-end')).toBe('succeeded');
    expect(end.textContent).toContain('acme/repo0 #10');
    expect(end.textContent).toContain('The run delivered its work.');
    expect(end.textContent).not.toContain('stays where it was');
    expect(screen.getByTestId('agent-run').textContent).toContain('Your agent worked on it');
    expect(screen.getByTestId('agent-link').textContent).toBe('Open yue-claude');
    expect(screen.getByTestId('agent-run').textContent).toContain('Took');
    expect(screen.getByTestId('agent-machine-time').textContent).toBe('26 min 32 s');
  });

  const ends: Array<{
    name: string;
    status: DispatchRunStatus;
    end: DispatchRunHostedEndDto;
    kind: string;
    line: string;
  }> = [
    {
      name: 'failed — the CLI exited without a pull request',
      status: 'failed',
      end: { outcome: null, detail: null, exitCode: 1 },
      kind: 'failed',
      line: 'The agent exited without a pull request.',
    },
    {
      name: 'failed — the agent stopped under the run',
      status: 'failed',
      end: { outcome: 'failed', detail: AGENT_RUN_END_DETAIL.agentStopped, exitCode: null },
      kind: 'crashed',
      line: 'The run’s machine stopped before the run closed.',
    },
    {
      name: 'failed — before the run started in the agent',
      status: 'failed',
      end: { outcome: 'failed', detail: 'the agent could not be reached', exitCode: null },
      kind: 'notStarted',
      line: 'The run couldn’t start in the agent.',
    },
    {
      name: 'cancelled by its owner',
      status: 'cancelled',
      end: { outcome: 'cancelled', detail: AGENT_RUN_END_DETAIL.cancelled, exitCode: null },
      kind: 'cancelled',
      line: 'The run was cancelled.',
    },
    {
      name: 'timed out — stalled',
      status: 'timed_out',
      end: { outcome: 'stall', detail: AGENT_RUN_END_DETAIL.stall, exitCode: null },
      kind: 'stalled',
      line: 'The agent stopped producing output.',
    },
    {
      name: 'timed out — the backstop',
      status: 'timed_out',
      end: { outcome: 'backstop', detail: AGENT_RUN_END_DETAIL.backstop, exitCode: null },
      kind: 'timedOut',
      line: 'The run reached its time limit.',
    },
  ];

  for (const e of ends) {
    it(`${e.name}: its end line, the recorded reason verbatim, and the work item stays`, async () => {
      const r = run({ status: e.status, stopReason: 'interrupted' });
      serve(detail(r, e.end));
      await mountSection(r);
      await waitFor(() => expect(screen.getByTestId('agent-end')).toBeTruthy());
      const end = screen.getByTestId('agent-end');
      expect(end.getAttribute('data-end')).toBe(e.kind);
      expect(end.textContent).toContain(e.line);
      expect(end.textContent).toContain('This work item stays where it was');
      if (e.end.detail) {
        expect(screen.getByTestId('agent-reason').textContent).toBe(e.end.detail);
      } else {
        expect(screen.getByTestId('agent-reason').textContent).toContain('1');
      }
      expect(screen.getByTestId('agent-run-cost').textContent).toContain('Machine time');
    });
  }

  it('a run whose agent was deleted still says who worked it, with no link', async () => {
    const r = run({ agentInstance: null });
    serve(detail(r));
    await mountSection(r);
    expect(screen.getByTestId('agent-lane').textContent).toBe('A deleted agent');
    expect(screen.queryByTestId('agent-link')).toBeNull();
  });
});

describe('cancel — the agent’s owner only', () => {
  it('the owner’s Cancel run says what stops, POSTs the cancel route, and the section shows the run cancelled', async () => {
    const r = live();
    serve(detail(r));
    routes['POST /api/dispatch-runs/run_a/cancel'] = () => ({
      status: 200,
      body: { dispatchRunId: 'run_a' },
    });
    const ended = run({ status: 'cancelled', stopReason: 'interrupted' });
    routes['GET /api/work-items/PROD-42/dispatch-runs'] = () => ({
      status: 200,
      body: { runs: [ended], nextCursor: null },
    });
    await mountSection(r);
    fireEvent.click(screen.getByTestId('hosted-run-cancel'));
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this run?' });
    expect(dialog.textContent).toContain('The run’s session in yue-claude stops');
    serve(
      detail(ended, {
        outcome: 'cancelled',
        detail: AGENT_RUN_END_DETAIL.cancelled,
        exitCode: null,
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('hosted-run-cancel-confirm'));
    });
    expect(calls('POST /api/dispatch-runs/run_a/cancel')).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByTestId('agent-run').getAttribute('data-status')).toBe('cancelled'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('agent-end').getAttribute('data-end')).toBe('cancelled'),
    );
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
    expect(screen.getByTestId('run-hosted').textContent).toBe('Run again');
  });

  it('another member sees no Cancel run on a run in someone’s agent', async () => {
    const r = live();
    serve(detail(r));
    await mountSection(r, 'usr_other');
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
  });
});

describe('the run modal — a run in an agent', () => {
  async function mountModal(d: DispatchRunDetailDto, viewerId: string | null = 'usr_me') {
    serve(d);
    render(<RunModal runId={d.id} projectKey="PROD" onClose={vi.fn()} viewerId={viewerId} />);
    await act(async () => {});
    await waitFor(() => expect(screen.queryByTestId('run-modal-loading')).toBeNull());
  }

  it('live: Run + the key, the agent chip with Open, Cancel for the owner, machine time only and the phase chip', async () => {
    await mountModal(detail(live()));
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Run');
    const header = h1.closest('header')!;
    expect(within(header).getByText('PROD-42').getAttribute('href')).toBe('/items/PROD-42');
    expect(within(header).getByTestId('agent-lane').textContent).toBe('yue-claude · Claude Code');
    expect(within(header).getByTestId('agent-link').textContent).toBe('Open yue-claude');
    expect(within(header).getByTestId('agent-link').getAttribute('href')).toBe(
      '/my-agents?agent=ai_1',
    );
    expect(screen.getByTestId('hosted-run-cancel')).toBeTruthy();
    const cost = screen.getByTestId('agent-run-cost');
    expect(cost.textContent).toContain('Cost so far');
    expect(cost.textContent).toContain('yue-claude’s running time, charged with the agent');
    expect(cost.textContent).toContain('No tokens — Claude Code runs on your own sign-in');
    expect(screen.queryByTestId('hosted-run-cost')).toBeNull();
    expect(screen.getByTestId('hosted-phase-chip')).toBeTruthy();
    expect(screen.queryByTestId('agent-end-strip')).toBeNull();
    expect(header.textContent?.toLowerCase()).not.toContain('hosted');
  });

  it('live, for another member: no Cancel', async () => {
    await mountModal(detail(live()), 'usr_other');
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
  });

  it('live, for a Visitor: no Cancel', async () => {
    await mountModal(detail(live()), null);
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
  });

  it('the owner’s Cancel in the modal carries the agent’s words and posts the cancel route', async () => {
    routes['POST /api/dispatch-runs/run_a/cancel'] = () => ({
      status: 200,
      body: { dispatchRunId: 'run_a' },
    });
    await mountModal(detail(live()));
    fireEvent.click(screen.getByTestId('hosted-run-cancel'));
    expect(screen.getByRole('alertdialog').textContent).toContain('yue-claude keeps running');
    serve(
      detail(run({ status: 'cancelled', stopReason: 'interrupted' }), {
        outcome: 'cancelled',
        detail: AGENT_RUN_END_DETAIL.cancelled,
        exitCode: null,
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('hosted-run-cancel-confirm'));
    });
    expect(calls('POST /api/dispatch-runs/run_a/cancel')).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByTestId('agent-end-strip').getAttribute('data-end')).toBe('cancelled'),
    );
  });

  it('succeeded: the pull request and end in one strip, and Cost', async () => {
    await mountModal(detail(run(), { outcome: null, detail: null, exitCode: 0 }, 1));
    const strip = screen.getByTestId('agent-end-strip');
    expect(strip.getAttribute('data-end')).toBe('succeeded');
    expect(strip.textContent).toContain('acme/repo0 #10');
    const cost = screen.getByTestId('agent-run-cost');
    expect(cost.textContent).toContain('Cost');
    expect(cost.textContent).not.toContain('so far');
    expect(cost.textContent).toContain('26 min 32 s');
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
  });

  it('failed: the end line and the recorded reason in the strip', async () => {
    await mountModal(
      detail(run({ status: 'failed', stopReason: 'interrupted' }), {
        outcome: 'failed',
        detail: AGENT_RUN_END_DETAIL.machineLost,
        exitCode: null,
      }),
    );
    const strip = screen.getByTestId('agent-end-strip');
    expect(strip.textContent).toContain('The run’s machine stopped before the run closed.');
    expect(strip.textContent).toContain(AGENT_RUN_END_DETAIL.machineLost);
  });

  it('a run whose agent is gone names no agent to open', async () => {
    await mountModal(detail(run({ agentInstance: null })));
    expect(screen.getByTestId('agent-lane').textContent).toBe('A deleted agent');
    expect(screen.queryByTestId('agent-link')).toBeNull();
  });

  it('the log console’s footer says this run always reports its output', () => {
    render(
      <RunLogPane
        run={live()}
        events={[
          {
            id: 'ev_1',
            seq: 1,
            kind: 'log',
            cardId: null,
            body: 'claude: reading the card',
            data: null,
            createdAt: '2026-09-26T14:01:00.000Z',
          },
        ]}
        selectedWorkItemId={null}
      />,
    );
    expect(screen.getByTestId('run-log-hosted-footer').textContent).toBe(
      'This run always reports its output. · Deleted after 30 days.',
    );
  });
});

describe('the end kind', () => {
  it('a live run has none', () => {
    expect(agentEndKind('running', undefined)).toBeNull();
  });
  it('a failure with a machine-stopped detail is crashed; out of credits too', () => {
    expect(
      agentEndKind('failed', {
        outcome: 'failed',
        detail: AGENT_RUN_END_DETAIL.outOfCredits,
        exitCode: null,
      }),
    ).toBe('crashed');
    expect(agentEndKind('failed', { outcome: 'failed', detail: null, exitCode: null })).toBe(
      'notStarted',
    );
    expect(agentEndKind('timed_out', undefined)).toBe('timedOut');
  });
});
