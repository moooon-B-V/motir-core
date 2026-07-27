import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));
vi.mock('@/lib/ai/codeContext', () => ({ resolveCodeContext: vi.fn() }));
vi.mock('@/lib/repositories/workItemRepository');

import {
  aiPlanEditsService,
  InvalidTargetError,
  PlanDeltaApproveError,
} from '@/lib/services/aiPlanEditsService';
import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent, JobContextBag } from '@/lib/ai/types';
import { PlanDeltaValidationError } from '@/lib/ai/planDelta';
import type { WorkItem } from '@prisma/client';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir' },
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

    expect(out).toEqual({ jobId: 'job_1' });
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

    expect(out).toEqual({ jobId: 'job_1' });
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

    expect(out).toEqual({ jobId: 'job_1' });
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

    expect(out).toEqual({ jobId: 'job_1' });
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
describe('aiPlanEditsService.approveDelta — the pre-persist boundary', () => {
  // Everything that PERSISTS now lives in `aiPlanEditsIntegration.test.ts`
  // against a real Postgres: since MOTIR-911 the confirm applies the whole delta
  // in ONE transaction composed of the work-item LEAF repositories (it can no
  // longer call `workItemsService.createWorkItem`, whose own transaction cannot
  // nest), so mocking the persist chain here would assert a shape rather than
  // the atomicity contract. What stays is what genuinely resolves BEFORE any DB
  // access: where the delta is sourced from, and the shape gate.

  it('rejects an invalid delta shape', async () => {
    const editedDelta = { operations: 'not-an-array' };

    await expect(aiPlanEditsService.approveDelta('job_1', editedDelta, ctx)).rejects.toThrow(
      PlanDeltaValidationError,
    );
  });

  it('throws when the job has no delta and no editedDelta is provided', async () => {
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_1',
      status: 'failed',
      result: null,
      error: null,
    });

    await expect(aiPlanEditsService.approveDelta('job_1', undefined, ctx)).rejects.toThrow(
      PlanDeltaApproveError,
    );
  });

  it("falls back to the JOB's delta when none is supplied — and still gates its shape", async () => {
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_1',
      status: 'succeeded',
      result: {
        envelopeVersion: 'v1',
        jobKind: 'augment',
        planDelta: { operations: 'not-an-array' },
      },
    } as never);

    await expect(aiPlanEditsService.approveDelta('job_1', undefined, ctx)).rejects.toThrow(
      PlanDeltaValidationError,
    );
    expect(getJob).toHaveBeenCalledWith('job_1');
  });
});
