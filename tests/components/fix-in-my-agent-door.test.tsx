// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  FixInMyAgentControl,
  inMyAgentRefusalOf,
} from '@/components/agentRuns/FixInMyAgentControl';
import type { FixInMyAgentDoorDto } from '@/lib/dto/agentInstanceRuns';

// FIX IN MY AGENT (Story MOTIR-8981 · MOTIR-9053) — the door's states and refusals over
// the `en` messages the copy card ships. Driven under happy-dom, DB-free: global fetch is
// stubbed, so what is asserted is the REQUEST the press makes and what each answer draws.

const OFFERED: FixInMyAgentDoorDto = {
  offered: true,
  agent: {
    id: 'ag1',
    name: 'yue-claude',
    profileId: 'claude',
    profileName: 'Claude Code',
    state: 'running',
  },
};
const NOT_OFFERED = (reason: 'green' | 'repair_open', run = null): FixInMyAgentDoorDto => ({
  offered: false,
  reason,
  run,
  refusal: null,
});

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(door: FixInMyAgentDoorDto | Response, props = {}) {
  fetchMock.mockResolvedValueOnce(door instanceof Object && 'ok' in door ? door : json(door));
  renderWithIntl(<FixInMyAgentControl itemKey="PROD-7" viewerId="u1" {...props} />);
  await act(async () => {});
}
const press = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('fix-my-agent'));
  });
};

describe('the door’s read', () => {
  it('renders nothing until the read answers, and nothing when the card is not offered', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    renderWithIntl(<FixInMyAgentControl itemKey="PROD-7" />);
    expect(screen.queryByTestId('fix-my-agent-control')).toBeNull();
    cleanup();
    await mount(NOT_OFFERED('green'));
    expect(screen.queryByTestId('fix-my-agent-control')).toBeNull();
  });

  it('offered: the lead names the agent and the button is Fix in my agent', async () => {
    await mount(OFFERED);
    expect(screen.getByTestId('fix-my-agent-control').textContent).toContain('yue-claude');
    expect(screen.getByTestId('fix-my-agent').textContent).toBe('Fix in my agent');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/work-items/PROD-7/fix-in-my-agent');
  });

  it('modal variant uses the ended run’s own lead', async () => {
    await mount(OFFERED, { variant: 'modal' });
    expect(screen.getByTestId('fix-my-agent-control').textContent).toContain(
      'This run ended with a red pull request',
    );
  });

  it('a failed read draws the notice with a retry that re-reads', async () => {
    await mount(json({}, 500));
    expect(screen.getByTestId('fix-my-agent-read-failed')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(OFFERED));
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByTestId('fix-my-agent')).toBeTruthy();
  });

  it('modal variant reads a running fix back with a link to its run', async () => {
    await mount(
      NOT_OFFERED('repair_open', {
        id: 'run1',
        label: 'Fix PROD-7',
        startedAt: '2026-10-19T10:00:00.000Z',
        holder: { id: 'u2', name: 'Ada' },
        byViewer: false,
        agentName: 'ada-claude',
      } as never),
      { variant: 'modal' },
    );
    const fixing = screen.getByTestId('fix-my-agent-fixing');
    expect(fixing.textContent).toContain('Ada');
    expect(fixing.textContent).toContain('ada-claude');
    expect(screen.getByTestId('repair-hosted-run-link').getAttribute('href')).toContain('run1');
  });
});

describe('the press', () => {
  it('POSTs the agent id, command fix and an idempotency key — and nothing else', async () => {
    const onStarted = vi.fn();
    await mount(OFFERED, { onStarted });
    fetchMock.mockResolvedValueOnce(json({ dispatchRunId: 'r1' }, 200));
    fetchMock.mockResolvedValueOnce(json(NOT_OFFERED('green')));
    await press();
    const [url, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe('/api/work-items/PROD-7/agent-runs');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['agentInstanceId', 'command', 'idempotencyKey']);
    expect(body).toMatchObject({ agentInstanceId: 'ag1', command: 'fix' });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('a second press while one is in flight sends nothing, and the button reads its starting state', async () => {
    await mount(OFFERED);
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    await press();
    expect(screen.getByTestId('fix-my-agent').textContent).toContain('Starting the fix');
    await press();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a taken answer names the holder and does not start a second run', async () => {
    const onStateMoved = vi.fn();
    await mount(OFFERED, { onStateMoved });
    fetchMock.mockResolvedValueOnce(
      json(
        {
          code: 'agent_run_repair_refused',
          claim: {
            outcome: 'taken',
            holder: { id: 'u2', name: 'Ada' },
            startedAt: '2026-10-19T10:00:00.000Z',
            runId: 'run9',
          },
        },
        409,
      ),
    );
    fetchMock.mockResolvedValueOnce(json(NOT_OFFERED('green')));
    await press();
    const notice = screen.getByTestId('fix-my-agent-refused-busy');
    expect(notice.textContent).toContain('Ada');
    expect(onStateMoved).toHaveBeenCalledTimes(1);
  });

  it('a stale answer says the pull requests are green and asks the host to re-read', async () => {
    const onStateMoved = vi.fn();
    await mount(OFFERED, { onStateMoved });
    fetchMock.mockResolvedValueOnce(
      json(
        {
          code: 'agent_run_repair_refused',
          claim: { outcome: 'not_repairable', reason: 'not_failing' },
        },
        409,
      ),
    );
    fetchMock.mockResolvedValueOnce(json(NOT_OFFERED('green')));
    await press();
    expect(screen.getByTestId('fix-my-agent-refused-settled').textContent).toContain('green now');
    expect(onStateMoved).toHaveBeenCalledTimes(1);
  });
});

describe('inMyAgentRefusalOf', () => {
  it.each([
    [
      409,
      {
        code: 'agent_run_repair_refused',
        claim: { outcome: 'taken', holder: { id: 'u1', name: 'Me' } },
      },
      'busy',
    ],
    [409, { code: 'agent_run_repair_refused', claim: { outcome: 'not_repairable' } }, 'settled'],
    [409, { code: 'agent_not_signed_in' }, 'signedOut'],
    [403, {}, 'permission'],
    [402, {}, 'outOfCredits'],
    [500, {}, 'failed'],
  ])('%s %j → %s', (status, body, kind) => {
    expect(inMyAgentRefusalOf(status, body as Record<string, unknown>, 'u1').kind).toBe(kind);
  });
  it('a taken repair held by the viewer reads byViewer', () => {
    const r = inMyAgentRefusalOf(
      409,
      {
        code: 'agent_run_repair_refused',
        claim: { outcome: 'taken', holder: { id: 'u1', name: 'Me' } },
      },
      'u1',
    );
    expect(r).toMatchObject({ kind: 'busy', byViewer: true });
  });
});
