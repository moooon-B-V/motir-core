import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
}));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));
vi.mock('@/lib/ai/codeContext', () => ({ resolveCodeContext: vi.fn() }));
vi.mock('@/lib/services/plansService');
vi.mock('@/lib/repositories/workItemRepository');

import { aiPlanEditsService, InvalidTargetError } from '@/lib/services/aiPlanEditsService';
import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { plansService } from '@/lib/services/plansService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent, JobContextBag } from '@/lib/ai/types';
import type { PlanDto } from '@/lib/dto/plans';
import type { WorkItem } from '@prisma/client';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  // `aiGenerateExplanations` is a non-null boolean column defaulting to false —
  // the OFF project, so the submits assert the flag is SENT as `false` rather
  // than omitted (MOTIR-2110).
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir', aiGenerateExplanations: false },
} as ProjectContext;

/** The same actor on a project that has opted INTO AI-drafted explanations. */
const ctxWithExplanations = {
  ...ctx,
  project: { ...ctx.project, aiGenerateExplanations: true },
} as ProjectContext;

const mockOrg = { organizationId: 'org_1', isMeta: false };

function mockWorkItem(overrides: {
  id?: string;
  identifier?: string;
  kind?: string;
  status?: string;
  projectId?: string;
}) {
  return {
    id: overrides.id ?? 'wi_99',
    identifier: overrides.identifier ?? 'MOTIR-1',
    kind: overrides.kind ?? 'bug',
    status: overrides.status ?? 'todo',
    projectId: overrides.projectId ?? 'pj_1',
    title: 'Mocked',
    parentId: null as string | null,
    descriptionMd: null as string | null,
    explanationMd: null as string | null,
    explanationSource: null as string | null,
    priority: 'medium' as const,
    dueDate: null as string | null,
    estimateMinutes: null as number | null,
    storyPoints: null as number | null,
    type: null as string | null,
    executor: null as string | null,
    assigneeId: null as string | null,
    reporterId: null as string | null,
    deletedAt: null as Date | null,
    archivedAt: null as Date | null,
    fractionalIndex: '0000',
    sprintId: null as string | null,
    workflowStatusId: null as string | null,
    sprintRank: null as string | null,
    backlogRank: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkItem;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTenantOrg).mockResolvedValue(mockOrg);
  vi.mocked(resolveCodeContext).mockResolvedValue(undefined);
  vi.mocked(plansService.createPlan).mockResolvedValue({ id: 'plan_1' } as PlanDto);
});

function mockSubmitJob() {
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });
}

describe('aiPlanEditsService.submitAugment', () => {
  it('submits an augment job with the prompt + tenant + code context', async () => {
    vi.mocked(resolveCodeContext).mockResolvedValue({
      repos: [{ provider: 'github', repoRef: 'o/r', defaultBranch: 'main' }],
    });
    mockSubmitJob();

    const out = await aiPlanEditsService.submitAugment('add a login flow', ctx);

    expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    expect(submitJob).toHaveBeenCalledWith(
      'augment',
      {
        organizationId: 'org_1',
        isMeta: false,
        workspaceId: 'ws_1',
        projectId: 'pj_1',
        projectKey: 'MOTIR',
      },
      expect.objectContaining({ prompt: 'add a login flow', code: expect.any(Object) }),
      { userId: 'user_1' },
    );
  });

  it('submits without code context when none', async () => {
    vi.mocked(resolveCodeContext).mockResolvedValue(undefined);
    mockSubmitJob();

    const out = await aiPlanEditsService.submitAugment('add a login flow', ctx);

    expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    const contextArg = vi.mocked(submitJob).mock.calls[0]?.[2] as JobContextBag;
    expect(contextArg.code).toBeUndefined();
  });

  it('passes the META flag', async () => {
    vi.mocked(resolveTenantOrg).mockResolvedValue({ organizationId: 'org_1', isMeta: true });
    mockSubmitJob();

    await aiPlanEditsService.submitAugment('prompt', ctx);

    expect(submitJob).toHaveBeenCalledWith(
      'augment',
      expect.objectContaining({ isMeta: true }),
      expect.any(Object),
      expect.any(Object),
    );
  });
});

describe('aiPlanEditsService.submitExpand', () => {
  it('submits an expand_item job for a valid container', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
    mockSubmitJob();

    const out = await aiPlanEditsService.submitExpand('MOTIR-100', ctx);

    expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    expect(submitJob).toHaveBeenCalledWith(
      'expand_item',
      expect.objectContaining({ projectKey: 'MOTIR' }),
      expect.objectContaining({ rootItemKey: 'MOTIR-100' }),
      { userId: 'user_1' },
    );
  });

  it('rejects a non-container (subtask)', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-200', kind: 'subtask' }),
    );

    await expect(aiPlanEditsService.submitExpand('MOTIR-200', ctx)).rejects.toThrow(
      InvalidTargetError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('rejects a missing item', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(null);

    await expect(aiPlanEditsService.submitExpand('MOTIR-999', ctx)).rejects.toThrow(
      InvalidTargetError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('rejects an item from another project', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story', projectId: 'pj_other' }),
    );

    await expect(aiPlanEditsService.submitExpand('MOTIR-100', ctx)).rejects.toThrow(
      InvalidTargetError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });
});

describe('aiPlanEditsService.submitReplan', () => {
  it('submits a replan job for a story', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
    mockSubmitJob();

    const out = await aiPlanEditsService.submitReplan('MOTIR-100', ctx);

    expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    expect(submitJob).toHaveBeenCalledWith(
      'replan',
      expect.any(Object),
      expect.objectContaining({ rootItemKey: 'MOTIR-100' }),
      { userId: 'user_1' },
    );
  });

  it('rejects a non-epic/story (task)', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-300', kind: 'task' }),
    );

    await expect(aiPlanEditsService.submitReplan('MOTIR-300', ctx)).rejects.toThrow(
      InvalidTargetError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('rejects a missing item', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(null);

    await expect(aiPlanEditsService.submitReplan('MOTIR-999', ctx)).rejects.toThrow(
      InvalidTargetError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });
});

// ─── The job's Plan (MOTIR-1743) ─────────────────────────────────────────────
// Every plan-edit submit must OPEN a `generating` Plan bound to the job via
// `sourceJobId` — motir-ai's augment / expand_item / replan handlers append their
// output through the 7.21 proposal store, and the core callback seam resolves the
// plan by that jobId. Without it every one of these jobs 404s on its FIRST
// `addProposals` callback. These assert the half the submit tests above never
// covered: the resulting Plan, not just that the job fired.
describe("aiPlanEditsService — opens the job's Plan on submit", () => {
  const CASES: Array<{ name: string; run: () => Promise<{ jobId: string; planId: string }> }> = [
    { name: 'submitAugment', run: () => aiPlanEditsService.submitAugment('add a login flow', ctx) },
    {
      name: 'submitContextual',
      run: () => aiPlanEditsService.submitContextual('split this', ['MOTIR-100'], ctx),
    },
    { name: 'submitExpand', run: () => aiPlanEditsService.submitExpand('MOTIR-100', ctx) },
    { name: 'submitReplan', run: () => aiPlanEditsService.submitReplan('MOTIR-100', ctx) },
  ];

  beforeEach(() => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
  });

  for (const c of CASES) {
    it(`${c.name} opens a Plan bound to the submitted job via sourceJobId`, async () => {
      mockSubmitJob();

      const out = await c.run();

      expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
      expect(plansService.createPlan).toHaveBeenCalledTimes(1);
      // `origin: 'user'` (MOTIR-916) — every REQUEST-path submit records a
      // human-initiated plan; only the auto-plan cadence watcher passes
      // `cadence`. Asserted on the call, not just defaulted downstream, so a
      // future submit path can't silently start mislabelling its provenance.
      expect(plansService.createPlan).toHaveBeenCalledWith(
        'pj_1',
        { title: null, summary: null, sourceJobId: 'job_1', origin: 'user' },
        ctx,
      );
    });

    it(`${c.name} opens NO Plan when the submit fails (no orphan)`, async () => {
      vi.mocked(submitJob).mockRejectedValue(new Error('motir-ai unreachable'));

      await expect(c.run()).rejects.toThrow('motir-ai unreachable');

      expect(plansService.createPlan).not.toHaveBeenCalled();
    });
  }

  it('submits the job BEFORE opening the plan (so a failed submit leaves no orphan)', async () => {
    mockSubmitJob();

    await aiPlanEditsService.submitAugment('prompt', ctx);

    const submitOrder = vi.mocked(submitJob).mock.invocationCallOrder[0]!;
    const createOrder = vi.mocked(plansService.createPlan).mock.invocationCallOrder[0]!;
    expect(submitOrder).toBeLessThan(createOrder);
  });

  it('submitContextual sends the anchor set with the augment kind', async () => {
    mockSubmitJob();

    await aiPlanEditsService.submitContextual('split this', ['MOTIR-100', 'MOTIR-101'], ctx);

    expect(submitJob).toHaveBeenCalledWith(
      'augment',
      expect.objectContaining({ projectKey: 'MOTIR' }),
      expect.objectContaining({
        prompt: 'split this',
        targetKeys: ['MOTIR-100', 'MOTIR-101'],
      }),
      { userId: 'user_1' },
    );
  });
});

// ─── The AI-drafted-explanations opt-in on the wire (MOTIR-2110) ─────────────
// The producer half of a two-repo contract: motir-ai reads the flag ONLY from
// `context.generateExplanations` (never from motir-core config), so a submit
// that omits it silently disables the project's setting on that path — which is
// what a re-plan did, leaving the toggle working on first generation alone.
// Asserted on EVERY plan-edit submit, not just `submitReplan`: a contextual turn
// submits as `augment` and motir-ai's scoping module can resolve it INTO a
// re-plan, so a replan-only fix would leave the same hole one path over.
describe('aiPlanEditsService — the generateExplanations opt-in rides every plan-edit envelope', () => {
  const CASES: Array<{
    name: string;
    kind: string;
    run: (c: ProjectContext) => Promise<{ jobId: string; planId: string }>;
  }> = [
    {
      name: 'submitAugment',
      kind: 'augment',
      run: (c) => aiPlanEditsService.submitAugment('add a login flow', c),
    },
    {
      name: 'submitContextual',
      kind: 'augment',
      run: (c) => aiPlanEditsService.submitContextual('split this', ['MOTIR-100'], c),
    },
    {
      name: 'submitExpand',
      kind: 'expand_item',
      run: (c) => aiPlanEditsService.submitExpand('MOTIR-100', c),
    },
    {
      name: 'submitReplan',
      kind: 'replan',
      run: (c) => aiPlanEditsService.submitReplan('MOTIR-100', c),
    },
  ];

  beforeEach(() => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
  });

  for (const c of CASES) {
    it(`${c.name} sends generateExplanations: true for an opted-in project`, async () => {
      mockSubmitJob();

      await c.run(ctxWithExplanations);

      const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
      expect(kind).toBe(c.kind);
      expect((context as JobContextBag).generateExplanations).toBe(true);
    });

    it(`${c.name} sends generateExplanations: false — PRESENT, not omitted — when off`, async () => {
      mockSubmitJob();

      await c.run(ctx);

      const context = vi.mocked(submitJob).mock.calls[0]![2] as JobContextBag;
      // Strictly `false`, and the KEY is there: an omission reads as "unset" on
      // the far side, which is exactly the state this bug shipped. Same
      // discipline the `generate_tree` submit already uses for the OFF case.
      expect(context.generateExplanations).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(context, 'generateExplanations')).toBe(true);
    });
  }

  it('reads the flag from the project, never from a caller-supplied context', async () => {
    mockSubmitJob();

    // The submit's own context (`rootItemKey`) is preserved alongside the flag —
    // the field is added to the envelope, it does not replace what the caller
    // built (the `code` hole included).
    vi.mocked(resolveCodeContext).mockResolvedValue({
      repos: [{ provider: 'github', repoRef: 'o/r', defaultBranch: 'main' }],
    });
    await aiPlanEditsService.submitReplan('MOTIR-100', ctxWithExplanations);

    const context = vi.mocked(submitJob).mock.calls[0]![2] as JobContextBag;
    expect(context).toMatchObject({
      rootItemKey: 'MOTIR-100',
      generateExplanations: true,
      code: expect.any(Object),
    });
  });
});

describe('aiPlanEditsService.stream*', () => {
  const frames: JobStreamEvent[] = [
    { event: 'status', data: { status: 'running' } },
    { event: 'done', data: { status: 'succeeded' } },
  ];

  it('streamAugment relays the client stream', async () => {
    async function* gen(): AsyncGenerator<JobStreamEvent> {
      for (const f of frames) yield f;
    }
    vi.mocked(streamJob).mockReturnValue(gen());

    const got: JobStreamEvent[] = [];
    for await (const f of aiPlanEditsService.streamAugment('job_1')) got.push(f);

    expect(streamJob).toHaveBeenCalledWith('job_1');
    expect(got).toEqual(frames);
  });

  it('streamExpand relays the client stream', async () => {
    async function* gen(): AsyncGenerator<JobStreamEvent> {
      for (const f of frames) yield f;
    }
    vi.mocked(streamJob).mockReturnValue(gen());

    const got: JobStreamEvent[] = [];
    for await (const f of aiPlanEditsService.streamExpand('job_1')) got.push(f);

    expect(streamJob).toHaveBeenCalledWith('job_1');
    expect(got).toEqual(frames);
  });

  it('streamReplan relays the client stream', async () => {
    async function* gen(): AsyncGenerator<JobStreamEvent> {
      for (const f of frames) yield f;
    }
    vi.mocked(streamJob).mockReturnValue(gen());

    const got: JobStreamEvent[] = [];
    for await (const f of aiPlanEditsService.streamReplan('job_1')) got.push(f);

    expect(streamJob).toHaveBeenCalledWith('job_1');
    expect(got).toEqual(frames);
  });
});
