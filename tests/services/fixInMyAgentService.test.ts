import { beforeEach, describe, expect, it, vi } from 'vitest';

// The "Fix in my agent" door's read (Story MOTIR-8981 · MOTIR-9053): one case per
// partition. The four services it composes are replaced by canned answers, so what is
// asserted is the COMPOSITION — the repair claim's verdict first, then the agent.

const m = vi.hoisted(() => ({
  view: vi.fn(),
  agents: vi.fn(),
  last: vi.fn(),
}));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { getByKey: async () => ({ id: 'p1' }) },
}));
vi.mock('@/lib/services/workItemsService', () => ({
  workItemsService: { getWorkItemByIdentifier: async () => ({ id: 'w1' }) },
}));
vi.mock('@/lib/services/workItemRepairService', () => ({
  workItemRepairService: { getRepairView: m.view },
}));
vi.mock('@/lib/services/agentInstanceRunService', () => ({
  agentInstanceRunService: { listAgentsForCard: m.agents, resumeTargetForCard: m.last },
}));

const { fixInMyAgentService } = await import('@/lib/services/fixInMyAgentService');
const ctx = { userId: 'u1', workspaceId: 'w' };

const agent = (id: string, refusal: unknown = null, runningRun: unknown = null) => ({
  id,
  name: `agent-${id}`,
  profileId: 'claude',
  profileName: 'Claude Code',
  state: 'running',
  refusal,
  runningRun,
});
const OFFER = { state: 'offer', repairClass: 'ci', failing: [], lastGaveUp: null };

beforeEach(() => {
  m.view.mockReset().mockResolvedValue(OFFER);
  m.agents.mockReset().mockResolvedValue({ agents: [agent('a1'), agent('a2')] });
  m.last.mockReset().mockResolvedValue({ lastRun: { agent: { id: 'a2' }, agentIsReaders: true } });
});

const read = () => fixInMyAgentService.readDoor('prod-7', ctx);

describe('fixInMyAgentService.readDoor', () => {
  it('offers the agent the last run used', async () => {
    await expect(read()).resolves.toMatchObject({ offered: true, agent: { id: 'a2' } });
  });

  it('falls back to the first usable agent when the last run was not the viewer’s', async () => {
    m.last.mockResolvedValue({ lastRun: { agent: { id: 'a2' }, agentIsReaders: false } });
    await expect(read()).resolves.toMatchObject({ offered: true, agent: { id: 'a1' } });
  });

  it('no agent of the viewer’s → no_agent', async () => {
    m.agents.mockResolvedValue({ agents: [] });
    await expect(read()).resolves.toMatchObject({ offered: false, reason: 'no_agent' });
  });

  it('the last run’s agent refused → agent_unusable carrying the refusal verbatim', async () => {
    m.agents.mockResolvedValue({ agents: [agent('a2', { kind: 'busy' })] });
    await expect(read()).resolves.toMatchObject({
      offered: false,
      reason: 'agent_unusable',
      refusal: { kind: 'busy' },
    });
  });

  it('a hidden view → green; a pointer → no_pull_request; a non-ci class → not_ci', async () => {
    m.view.mockResolvedValueOnce({ state: 'hidden' });
    await expect(read()).resolves.toMatchObject({ offered: false, reason: 'green' });
    m.view.mockResolvedValueOnce({ state: 'pointer', failing: [], runTargetKey: 'P-1' });
    await expect(read()).resolves.toMatchObject({ offered: false, reason: 'no_pull_request' });
    m.view.mockResolvedValueOnce({ ...OFFER, repairClass: 'review' });
    await expect(read()).resolves.toMatchObject({ offered: false, reason: 'not_ci' });
  });

  it('a fix already running → repair_open with the run, its holder and the agent’s name', async () => {
    m.view.mockResolvedValue({
      state: 'in_progress',
      repairClass: 'ci',
      failing: [],
      holder: { id: 'u2', name: 'Ada' },
      byViewer: false,
      startedAt: '2026-10-19T10:00:00.000Z',
      run: { id: 'run1', label: 'Fix', hosted: false },
    });
    m.agents.mockResolvedValue({ agents: [agent('a1', null, { id: 'run1' })] });
    await expect(read()).resolves.toMatchObject({
      offered: false,
      reason: 'repair_open',
      run: { id: 'run1', holder: { name: 'Ada' }, agentName: 'agent-a1', byViewer: false },
    });
  });
});
