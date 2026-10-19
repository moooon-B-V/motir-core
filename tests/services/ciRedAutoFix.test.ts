import { beforeEach, describe, expect, it, vi } from 'vitest';

// The dispositions of the automatic fix on a red delivery (MOTIR-9054). Every
// collaborator is faked: this pins the ORDER of the walk and what each refusal does.

const h = vi.hoisted(() => ({
  cards: new Map<string, Record<string, unknown>>(),
  enabled: vi.fn(),
  resolve: vi.fn(),
  lastRun: vi.fn(),
  agent: vi.fn(),
  open: vi.fn(),
  start: vi.fn(),
}));

vi.mock('@/lib/workspaces/context', () => ({
  withSystemContext: (fn: (tx: unknown) => unknown) => fn({}),
  bindWorkspaceContext: async () => {},
}));
vi.mock('@/lib/repositories/workItemRepository', () => ({
  workItemRepository: { findById: async (id: string) => h.cards.get(id) ?? null },
}));
vi.mock('@/lib/repositories/projectRepository', () => ({
  projectRepository: { findAgentAutoFixEnabled: h.enabled },
}));
vi.mock('@/lib/repositories/dispatchRunRepository', () => ({
  dispatchRunRepository: { findLatestResumeRunForWorkItem: h.lastRun },
}));
vi.mock('@/lib/repositories/agentInstanceRepository', () => ({
  agentInstanceRepository: { findLiveForOwner: h.agent },
}));
vi.mock('@/lib/services/runTarget', () => ({ resolveRunTargetFor: h.resolve }));
vi.mock('@/lib/services/workItemRepairService', () => ({
  workItemRepairService: { findOpenRepairRuns: h.open },
}));
vi.mock('@/lib/services/agentInstanceRunService', () => ({
  agentInstanceRunService: { start: h.start },
}));

import { autoFixKey, maybeAutoFixOnRed } from '@/lib/services/ciRedAutoFixService';

const card = (id: string) => ({ id, identifier: `P-${id}`, projectId: 'proj', workspaceId: 'ws' });
const input = (ids = ['a']) => ({
  changeRequestId: 'cr1',
  headSha: 'sha1',
  workspaceId: 'ws',
  deliveredWorkItemIds: ids,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.cards = new Map([
    ['a', card('a')],
    ['b', card('b')],
    ['c', card('c')],
    ['story', card('story')],
  ]);
  h.enabled.mockResolvedValue({ agentAutoFixEnabled: true });
  h.resolve.mockResolvedValue({ kind: 'self' });
  h.lastRun.mockResolvedValue({ agentInstance: { id: 'ag', ownerId: 'owner' } });
  h.agent.mockResolvedValue({ id: 'ag', ownerId: 'owner', state: 'running' });
  h.open.mockResolvedValue(new Map());
  h.start.mockResolvedValue({ dispatchRunId: 'r1', created: true, woke: false });
});

describe('maybeAutoFixOnRed', () => {
  it('starts one fix as the agent owner, keyed on change request, head and target', async () => {
    expect(await maybeAutoFixOnRed(input())).toBe('started');
    expect(h.enabled).toHaveBeenCalledWith('proj', expect.anything());
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith(
      {
        workItemKey: 'P-a',
        agentInstanceId: 'ag',
        idempotencyKey: autoFixKey('cr1', 'sha1', 'a'),
        command: 'fix',
      },
      { userId: 'owner', workspaceId: 'ws' },
    );
  });

  it('does nothing when the switch is off', async () => {
    h.enabled.mockResolvedValue({ agentAutoFixEnabled: false });
    expect(await maybeAutoFixOnRed(input())).toBe('setting_off');
    expect(h.start).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('reports a repeated key as already started', async () => {
    h.start.mockResolvedValue({ dispatchRunId: 'r1', created: false, woke: false });
    expect(await maybeAutoFixOnRed(input())).toBe('already_started');
  });

  it('collapses cards that share a run target into one run on the holder', async () => {
    h.resolve.mockResolvedValue({ kind: 'ancestor', holder: card('story') });
    expect(await maybeAutoFixOnRed(input(['a', 'b', 'c']))).toBe('started');
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start.mock.calls[0]![0].workItemKey).toBe('P-story');
  });

  it('starts nothing when the cards resolve to more than one run target', async () => {
    expect(await maybeAutoFixOnRed(input(['a', 'b']))).toBe('multiple_run_targets');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('starts nothing when the card has no run in an agent', async () => {
    h.lastRun.mockResolvedValue({ agentInstance: null });
    expect(await maybeAutoFixOnRed(input())).toBe('no_agent_run');
    h.lastRun.mockResolvedValue(null);
    expect(await maybeAutoFixOnRed(input())).toBe('no_agent_run');
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(['hibernated', 'starting', 'waking', 'failed', 'updating'])(
    'does not wake an agent in state %s',
    async (state) => {
      h.agent.mockResolvedValue({ id: 'ag', ownerId: 'owner', state });
      expect(await maybeAutoFixOnRed(input())).toBe('agent_not_running');
      expect(h.start).not.toHaveBeenCalled();
    },
  );

  it('treats a deleted agent as not running', async () => {
    h.agent.mockResolvedValue(null);
    expect(await maybeAutoFixOnRed(input())).toBe('agent_not_running');
  });

  it('starts nothing while a repair holds the card', async () => {
    h.open.mockResolvedValue(new Map([['a', { id: 'run' }]]));
    expect(await maybeAutoFixOnRed(input())).toBe('repair_open');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('turns any refusal from the start into a disposition, never a throw', async () => {
    h.start.mockRejectedValue(new Error('credits'));
    await expect(maybeAutoFixOnRed(input())).resolves.toBe('refused');
  });

  it('does nothing for a delivery with no cards', async () => {
    expect(await maybeAutoFixOnRed(input([]))).toBe('no_cards');
    expect(await maybeAutoFixOnRed(input(['gone']))).toBe('no_cards');
  });

  it('logs one structured line per call naming the disposition, request, head and target', async () => {
    h.open.mockResolvedValue(new Map([['a', { id: 'run' }]]));
    await maybeAutoFixOnRed(input());
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('[ciRedAutoFix]', {
      disposition: 'repair_open',
      changeRequestId: 'cr1',
      headSha: 'sha1',
      runTarget: 'P-a',
    });
  });

  it('keys a new head differently so the same head cannot start twice but a new one can', () => {
    expect(autoFixKey('cr1', 'sha1', 'a')).not.toBe(autoFixKey('cr1', 'sha2', 'a'));
  });
});
