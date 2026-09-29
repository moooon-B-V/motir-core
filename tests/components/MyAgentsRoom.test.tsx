// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { MyAgentsRoom } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import type { AgentInstanceListItemDto, AgentInstanceListPageDto } from '@/lib/dto/agentInstances';

// THE MY AGENTS ROOM (Story MOTIR-6860 · MOTIR-6874), held to the approved
// `design/my-agents/my-agents.mock.html` (MOTIR-6868 revision 3). The routes are
// stubbed at `fetch`; what is asserted is the page's own decisions — which face it
// wears, what each action sends, and that it re-reads itself after every one.

const PROFILES = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'kimi', name: 'Kimi Code' },
  { id: 'aider', name: 'Aider' },
  { id: 'goose', name: 'Goose' },
];

function agent(over: Partial<AgentInstanceListItemDto> = {}): AgentInstanceListItemDto {
  return {
    id: 'a1',
    name: 'yue-claude',
    projectId: 'p1',
    profileId: 'claude',
    profileName: 'Claude Code',
    imageTag: 'ghcr.io/moooon-b-v/motir-sandbox:claude',
    imageDigest: 'sha256:abc',
    region: 'iad',
    state: 'running',
    failureReason: null,
    stateChangedAt: '2026-09-29T10:00:00.000Z',
    lastActivityAt: '2026-09-29T10:00:00.000Z',
    createdAt: '2026-09-29T10:00:00.000Z',
    machineSecondsThisMonth: 72 * 60,
    creditsThisMonth: 72,
    stopReason: null,
    ...over,
  };
}

const page = (instances: AgentInstanceListItemDto[]): AgentInstanceListPageDto => ({
  instances,
  total: instances.length,
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
  vi.useRealTimers();
});

const mount = (initial: AgentInstanceListPageDto | null, messages?: Record<string, unknown>) =>
  render(
    <MyAgentsRoom
      projectKey="MOTIR"
      projectName="motir"
      initial={initial}
      profiles={PROFILES}
      maxPerUser={10}
    />,
    messages ? { messages, locale: 'zh' } : {},
  );

const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    body: (init as RequestInit | undefined)?.body,
  }));

async function openMenu(name: string) {
  fireEvent.click(screen.getAllByRole('button', { name: `Actions for ${name}` })[0]!);
  return screen.findByRole('menu');
}

describe('the faces', () => {
  it('no agents yet: explains what an agent is and offers New agent — never an error', () => {
    mount(page([]));
    expect(screen.getByRole('heading', { name: 'My agents' })).toBeTruthy();
    expect(screen.getByText('No agents yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New agent' })).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed first read is its own face, never the empty state', () => {
    mount(null);
    expect(screen.getByRole('alert').textContent).toContain('We couldn’t load your agents.');
    expect(screen.queryByText('No agents yet')).toBeNull();
  });

  it('the list: every column the design names, the total and the page', () => {
    mount(
      page([
        agent(),
        agent({
          id: 'a2',
          name: 'yue-codex',
          profileName: 'Codex',
          state: 'hibernated',
          stopReason: 'credits',
          machineSecondsThisMonth: 123 * 60,
          creditsThisMonth: 123,
        }),
        agent({
          id: 'a3',
          name: 'old-box',
          state: 'failed',
          failureReason: 'The machine could not start: no capacity on its host.',
        }),
        agent({ id: 'a4', name: 'booting', state: 'starting', machineSecondsThisMonth: 0 }),
      ]),
    );
    const table = screen.getByRole('table');
    for (const col of [
      'Name',
      'Coding agent',
      'Project',
      'State',
      'Machine time this month',
      'Credits',
    ]) {
      expect(within(table).getByRole('columnheader', { name: col })).toBeTruthy();
    }
    const rows = within(table).getAllByTestId('agent-row');
    expect(rows[0]!.textContent).toContain('yue-claude');
    expect(rows[0]!.textContent).toContain('Claude Code');
    expect(rows[0]!.textContent).toContain('Running');
    expect(rows[0]!.textContent).toContain('1h 12m');
    expect(rows[1]!.textContent).toContain('Hibernated');
    expect(rows[1]!.textContent).toContain(
      'Stopped: your organization ran out of credits. Add credits, then wake it.',
    );
    expect(rows[1]!.textContent).toContain('2h 03m');
    expect(rows[2]!.textContent).toContain(
      'The machine could not start: no capacity on its host. Wake to try again, or delete it.',
    );
    expect(rows[3]!.textContent).toContain('Booting — cloning the project’s repositories');
    expect(screen.getByText('4 agents')).toBeTruthy();
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
  });

  it('renders in Chinese from the zh catalog', () => {
    mount(page([agent()]), zhMessages as Record<string, unknown>);
    expect(screen.getByRole('heading', { name: '我的智能体' })).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('运行中')).toBeTruthy();
  });
});

describe('create', () => {
  it('offers exactly the six coding agents with the price line, posts, closes and re-reads', async () => {
    mount(page([]));
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    const dialog = await screen.findByRole('dialog');
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(within(dialog).getByText('Kimi Code')).toBeTruthy();
    expect(within(dialog).queryByText('Cursor')).toBeNull();
    expect(dialog.textContent).toContain('1 credit per minute');

    fetchMock
      .mockResolvedValueOnce(json(201, { instance: agent({ name: 'my-codex' }) }))
      .mockResolvedValueOnce(json(200, page([agent({ name: 'my-codex' })])));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'my-codex' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Codex/ }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });

    const [post, get] = calls();
    expect(post).toMatchObject({ url: '/api/projects/MOTIR/instances', method: 'POST' });
    expect(JSON.parse(String(post!.body))).toEqual({ name: 'my-codex', profileId: 'codex' });
    expect(get).toMatchObject({ method: 'GET' });
    expect(get!.url).toContain('/api/projects/MOTIR/instances?page=1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByText('my-codex').length).toBeGreaterThan(0);
  });

  it('a refusal lands in the dialog, in the design’s words, and keeps the dialog open', async () => {
    mount(page([]));
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'x' } });

    fetchMock.mockResolvedValueOnce(
      json(402, { code: 'agent_instance_start_refused', reason: 'credits', error: 'nope' }),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain('Your organization’s credits can’t start a machine');
    expect(within(alert).getByRole('link', { name: 'Add credits' }).getAttribute('href')).toBe(
      '/settings/organization/billing',
    );

    fetchMock.mockResolvedValueOnce(
      json(429, { code: 'agent_instance_start_refused', reason: 'user_cap' }),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'You already have 10 agents. Delete one to create another.',
    );

    fetchMock.mockResolvedValueOnce(json(409, { code: 'agent_instance_name_taken' }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'You already have an agent called x on this project.',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('the row menu', () => {
  it('offers only the moves the state allows — the rest disabled, not hidden', async () => {
    mount(page([agent()]));
    const menu = await openMenu('yue-claude');
    expect(within(menu).getByRole('menuitem', { name: 'Wake' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Hibernate' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Delete…' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('Wake posts to its route and the row re-reads to the new state', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    const menu = await openMenu('yue-claude');
    fetchMock
      .mockResolvedValueOnce(json(200, { instance: agent({ state: 'running' }) }))
      .mockResolvedValueOnce(json(200, page([agent({ state: 'running' })])));
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Wake' }));
    });
    expect(calls()[0]).toMatchObject({
      url: '/api/projects/MOTIR/instances/a1/wake',
      method: 'POST',
    });
    const row = within(screen.getByRole('table')).getByTestId('agent-row');
    expect(row.getAttribute('data-state')).toBe('running');
  });

  it('a refused Wake shows above the list', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    const menu = await openMenu('yue-claude');
    fetchMock
      .mockResolvedValueOnce(
        json(429, { code: 'agent_instance_start_refused', reason: 'fleet_busy' }),
      )
      .mockResolvedValueOnce(json(200, page([agent({ state: 'hibernated' })])));
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Wake' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'Motir is running as many machines as it can right now. Try again in a few minutes.',
    );
  });

  it('Delete… confirms first, naming what is lost, then deletes and re-reads', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    const menu = await openMenu('yue-claude');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Delete yue-claude?');
    expect(dialog.textContent).toContain('any work you have not committed and pushed.');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock
      .mockResolvedValueOnce(json(200, { instance: agent({ state: 'deleting' }) }))
      .mockResolvedValueOnce(json(200, page([])));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete agent' }));
    });
    expect(calls()[0]).toMatchObject({ url: '/api/projects/MOTIR/instances/a1', method: 'DELETE' });
    await waitFor(() => expect(screen.getByText('No agents yet')).toBeTruthy());
  });
});

describe('freshness', () => {
  it('polls while a row is in motion, and stops once it settles', async () => {
    vi.useFakeTimers();
    mount(page([agent({ state: 'starting' })]));
    fetchMock.mockResolvedValue(json(200, page([agent({ state: 'running' })])));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByRole('table')).getByTestId('agent-row').getAttribute('data-state'),
    ).toBe('running');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
