// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { MyAgentsRoom } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import { AgentPanelHeader } from '@/app/(authed)/my-agents/_components/AgentPanelHeader';
import { AGENT_STATE_TONE, AGENT_STATES_IN_MOTION } from '@/lib/agentInstances/presentation';
import { AGENT_INSTANCE_STATES } from '@/lib/agentInstances/stateMachine';
import type { AgentInstanceListItemDto, AgentInstanceListPageDto } from '@/lib/dto/agentInstances';

// UPDATE ON MY AGENTS (Story MOTIR-6862 · MOTIR-6953), held to the approved
// `design/my-agents/my-agents--update.mock.html` (MOTIR-6951). The routes are
// stubbed at `fetch`; what is asserted is the page's own decisions — which marker
// a row wears for each catalog answer, when Update is offered or disabled, what
// Confirm sends (once) and Not now does not, and each refusal in its words.

const PROFILES = [{ id: 'claude', name: 'Claude Code' }];

function agent(over: Partial<AgentInstanceListItemDto> = {}): AgentInstanceListItemDto {
  return {
    id: 'a1',
    name: 'yue-claude',
    projectId: 'p1',
    profileId: 'claude',
    profileName: 'Claude Code',
    imageTag: 'ghcr.io/moooon-b-v/motir-sandbox:claude',
    imageDigest: 'sha256:abc',
    imageVersion: '0.4.0',
    update: null,
    pendingImageVersion: null,
    updateFailureReason: null,
    region: 'iad',
    state: 'running',
    failureReason: null,
    // `absent`: the panel opens with no terminal socket to stub (and draws panel 8).
    terminalServer: 'absent',
    stateChangedAt: '2026-09-29T10:00:00.000Z',
    lastActivityAt: '2026-09-29T10:00:00.000Z',
    createdAt: '2026-09-29T10:00:00.000Z',
    machineSecondsThisMonth: 60,
    creditsThisMonth: 1,
    stopReason: null,
    scheduledDeletionAt: null,
    activeRun: null,
    lastRun: null,
    ...over,
  };
}
const UPDATE = { version: '0.5.0', digest: 'sha256:def' };
const page = (instances: AgentInstanceListItemDto[]): AgentInstanceListPageDto => ({
  instances,
  total: instances.length,
  planLapse: null,
});
const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = (rows: AgentInstanceListItemDto[], openAgentId: string | null = null) =>
  render(
    <MyAgentsRoom
      projectKey="MOTIR"
      projectName="motir"
      initial={page(rows)}
      profiles={PROFILES}
      maxPerUser={10}
      openAgentId={openAgentId}
    />,
  );

const posts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url]) => String(url));

describe('the row (panels 1 and 2)', () => {
  it('shows the version, and one marker per catalog answer — never "up to date" on a failed read', () => {
    mount([
      agent({ id: 'a1', name: 'old', update: UPDATE }),
      agent({ id: 'a2', name: 'newest', imageVersion: '0.5.0', update: null }),
      agent({ id: 'a3', name: 'unchecked', update: 'unknown' }),
      agent({ id: 'a4', name: 'unnamed', imageVersion: null, update: null }),
    ]);
    const rows = screen.getAllByTestId('agent-row');
    expect(within(rows[0]!).getByTestId('agent-version').textContent).toBe('0.4.0');
    expect(within(rows[0]!).getByTestId('agent-update-available').textContent).toBe(
      'Update available → 0.5.0',
    );
    expect(within(rows[1]!).getByTestId('agent-version').textContent).toBe('0.5.0');
    expect(within(rows[1]!).queryByTestId('agent-update-available')).toBeNull();
    expect(within(rows[1]!).queryByTestId('agent-update-unknown')).toBeNull();
    expect(within(rows[2]!).getByTestId('agent-update-unknown').textContent).toBe(
      'Could not check for updates',
    );
    expect(within(rows[3]!).getByTestId('agent-version').textContent).toBe('an earlier build');
  });

  it('a hibernated agent that took the update shows "<version> on next wake"; an updating one says so', () => {
    mount([
      agent({
        id: 'a1',
        name: 'asleep',
        state: 'hibernated',
        update: UPDATE,
        pendingImageVersion: '0.5.0',
      }),
      agent({
        id: 'a2',
        name: 'moving',
        state: 'updating',
        update: UPDATE,
        pendingImageVersion: '0.5.0',
      }),
    ]);
    const rows = screen.getAllByTestId('agent-row');
    expect(within(rows[0]!).getByTestId('agent-update-pending').textContent).toBe(
      '0.5.0 on next wake',
    );
    expect(within(rows[0]!).queryByTestId('agent-update-available')).toBeNull();
    expect(within(rows[1]!).getByText('Updating to 0.5.0')).toBeTruthy();
    expect(within(rows[1]!).getByText('Updating')).toBeTruthy();
  });

  it('a rolled-back agent says why under its name, on its old version, the update still offered', () => {
    const reason =
      'The update to 0.5.0 didn’t work: claude --version exited 127. Your agent is back on 0.4.0.';
    mount([agent({ update: UPDATE, updateFailureReason: reason })]);
    const row = screen.getAllByTestId('agent-row')[0]!;
    expect(within(row).getByText(reason)).toBeTruthy();
    expect(within(row).getByTestId('agent-version').textContent).toBe('0.4.0');
    expect(within(row).getByTestId('agent-update-available')).toBeTruthy();
  });
});

describe('the panel header (panels 1 and 4)', () => {
  const header = (a: AgentInstanceListItemDto, onUpdate = vi.fn()) => {
    render(
      <AgentPanelHeader
        agent={a}
        projectName="motir"
        signIn={null}
        onClose={vi.fn()}
        onHibernate={vi.fn()}
        onDelete={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    return onUpdate;
  };

  it('offers Update FIRST, beside Hibernate and Delete, only while an update is available', () => {
    const onUpdate = header(agent({ update: UPDATE }));
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.indexOf('Update')).toBeLessThan(buttons.indexOf('Hibernate'));
    expect(buttons.indexOf('Hibernate')).toBeLessThan(buttons.indexOf('Delete…'));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('agent-update-available').textContent).toBe(
      'Update available → 0.5.0',
    );
  });

  it.each([
    ['on the newest', { update: null }],
    ['could not check', { update: 'unknown' as const }],
    [
      'already took it, asleep',
      { state: 'hibernated' as const, update: UPDATE, pendingImageVersion: '0.5.0' },
    ],
  ])('offers no Update when %s', (_label, over) => {
    header(agent(over));
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('while updating, Update, Hibernate and Delete are all disabled', () => {
    header(agent({ state: 'updating', update: UPDATE, pendingImageVersion: '0.5.0' }));
    for (const name of ['Update', 'Hibernate', 'Delete…']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('a rolled-back agent shows the reason in the header', () => {
    header(agent({ update: UPDATE, updateFailureReason: 'The update to 0.5.0 didn’t work: x.' }));
    expect(screen.getByTestId('agent-update-failed').textContent).toBe(
      'The update to 0.5.0 didn’t work: x.',
    );
  });
});

describe('the confirmation and the call (panel 3)', () => {
  async function openDialog(rows = [agent({ update: UPDATE })]) {
    mount(rows, 'a1');
    const panel = screen.getByTestId('agent-panel');
    fireEvent.click(within(panel).getAllByRole('button', { name: 'Update' })[0]!);
    return screen.findByRole('dialog');
  }

  it('names both versions and what is kept; Not now calls nothing', async () => {
    const dialog = await openDialog();
    expect(within(dialog).getByText('Update yue-claude to 0.5.0?')).toBeTruthy();
    expect(dialog.textContent).toContain('Claude Code 0.4.0 → 0.5.0');
    expect(dialog.textContent).toContain('The agent restarts on the new version');
    expect(dialog.textContent).toContain('its coding agent’s sign-in;');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toEqual([]);
  });

  it('Confirm posts to the update route ONCE, closes, and re-reads the list', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? json(200, { instance: agent({ state: 'updating', pendingImageVersion: '0.5.0' }) })
        : json(
            200,
            page([agent({ state: 'updating', update: UPDATE, pendingImageVersion: '0.5.0' })]),
          ),
    );
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toEqual(['/api/projects/MOTIR/instances/a1/update']);
    await waitFor(() => expect(screen.getAllByText('Updating').length).toBeGreaterThan(0));
  });

  it('a hibernated agent is told it takes the version at its next wake', async () => {
    const dialog = await openDialog([agent({ state: 'hibernated', update: UPDATE })]);
    expect(dialog.textContent).toContain('It stays asleep and takes the new version');
    expect(within(dialog).getByRole('button', { name: 'Update on next wake' })).toBeTruthy();
  });

  it.each([
    [
      'the active run, named and linked',
      json(409, { code: 'agent_instance_run_active', runId: 'r1', workItemKey: 'MOTIR-123' }),
      'yue-claude is running MOTIR-123. Cancel that run on the work item first, then update it.',
    ],
    [
      'already on the newest',
      json(409, { code: 'agent_instance_up_to_date', version: '0.5.0' }),
      'This agent already runs the newest version (0.5.0).',
    ],
    [
      'a transitional state',
      json(409, { code: 'agent_instance_state_conflict' }),
      'This agent is running, so it can’t be updated right now.',
    ],
    [
      'the registry could not be asked',
      json(503, { code: 'agent_image_catalog_unavailable' }),
      'Motir couldn’t check for a newer version just now. Try again in a few minutes.',
    ],
  ])('shows %s in its words, keeping the dialog open', async (_label, answer, words) => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? answer : json(200, page([agent({ update: UPDATE })])),
    );
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(words);
    if (words.includes('MOTIR-123')) {
      expect(within(alert).getByRole('link', { name: 'MOTIR-123' })).toBeTruthy();
    }
  });
});

describe('image too old (panel 8)', () => {
  it('offers Update to <version> as the way out where an update is available', async () => {
    mount([agent({ terminalServer: 'absent', update: UPDATE })], 'a1');
    const panel = screen.getByTestId('agent-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Update to 0.5.0' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('totality and the catalogs', () => {
  it('every state has a tone, and updating is followed like the other states in motion', () => {
    for (const state of AGENT_INSTANCE_STATES) expect(AGENT_STATE_TONE[state]).toBeTruthy();
    expect(AGENT_STATES_IN_MOTION.has('updating')).toBe(true);
  });

  it('every update key exists in en and zh', () => {
    const keys = (o: unknown, p = ''): string[] =>
      typeof o === 'object' && o !== null
        ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k))
        : [p];
    const en = keys((enMessages as Record<string, Record<string, unknown>>).myAgents!.update);
    const zh = keys((zhMessages as Record<string, Record<string, unknown>>).myAgents!.update);
    expect(zh.sort()).toEqual(en.sort());
    expect(en.length).toBeGreaterThan(20);
  });
});
