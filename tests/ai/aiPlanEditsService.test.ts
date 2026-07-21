import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));
vi.mock('@/lib/ai/codeContext', () => ({ resolveCodeContext: vi.fn() }));
vi.mock('@/lib/services/workItemsService');
vi.mock('@/lib/services/workflowsService');
vi.mock('@/lib/repositories/workItemRepository');

import {
  aiPlanEditsService,
  InvalidTargetError,
  PlanDeltaImmutabilityError,
  PlanDeltaApproveError,
} from '@/lib/services/aiPlanEditsService';
import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent, JobContextBag } from '@/lib/ai/types';
import { PlanDeltaValidationError } from '@/lib/ai/planDelta';
import type { WorkItemKindDto, WorkItemDto } from '@/lib/dto/workItems';
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

function mockWorkItemDto(identifier: string): WorkItemDto {
  return {
    id: 'wi_1',
    projectId: 'pj_1',
    parentId: null,
    kind: 'task' as WorkItemKindDto,
    key: 99,
    identifier,
    title: 'Mocked',
    descriptionMd: null,
    explanationMd: null,
    explanationSource: 'user_authored',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    reporterId: 'user_1',
    dueDate: null,
    estimateMinutes: null,
    type: null,
    executor: null,
    storyPoints: null,
    position: '0',
    sprintId: null,
    backlogRank: null,
    publicChildrenHidden: false,
    sessionBranch: null,
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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

describe('aiPlanEditsService.approveDelta', () => {
  it('parses + persists a create delta', async () => {
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_1',
      status: 'succeeded',
      result: {
        envelopeVersion: 'v1',
        jobKind: 'augment',
        planDelta: {
          operations: [{ op: 'create', kind: 'task', fields: { title: 'New task' } }],
        },
        summary: '',
        usage: { model: null, inputTokens: 0, outputTokens: 0 },
      },
      error: null,
    });
    vi.mocked(workflowsService.getTerminalStatusKeys).mockResolvedValue(
      new Set(['done', 'cancelled']),
    );
    vi.mocked(workItemsService.createWorkItem).mockResolvedValue(mockWorkItemDto('MOTIR-500'));

    const result = await aiPlanEditsService.approveDelta('job_1', undefined, ctx);

    expect(result.created).toEqual(['MOTIR-500']);
    expect(result.updated).toEqual([]);
    expect(workItemsService.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'pj_1',
        kind: 'task',
        title: 'New task',
      }),
      { userId: 'user_1', workspaceId: 'ws_1' },
    );
  });

  it('uses the provided editedDelta', async () => {
    vi.mocked(workflowsService.getTerminalStatusKeys).mockResolvedValue(
      new Set(['done', 'cancelled']),
    );
    vi.mocked(workItemsService.createWorkItem).mockResolvedValue(mockWorkItemDto('MOTIR-501'));

    const editedDelta = {
      operations: [{ op: 'create', kind: 'bug', fields: { title: 'Fix bug' } }],
    };

    await aiPlanEditsService.approveDelta('job_1', editedDelta, ctx);

    expect(getJob).not.toHaveBeenCalled();
    expect(workItemsService.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bug',
        title: 'Fix bug',
      }),
      expect.any(Object),
    );
  });

  it('updates an existing item', async () => {
    const editedDelta = {
      operations: [{ op: 'update', targetKey: 'MOTIR-100', fields: { title: 'Renamed' } }],
    };
    vi.mocked(workflowsService.getTerminalStatusKeys).mockResolvedValue(
      new Set(['done', 'cancelled']),
    );
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', status: 'in_progress' }),
    );
    vi.mocked(workItemsService.updateWorkItem).mockResolvedValue(mockWorkItemDto('MOTIR-100'));

    const result = await aiPlanEditsService.approveDelta('job_1', editedDelta, ctx);

    expect(result.updated).toEqual(['MOTIR-100']);
    expect(workItemsService.updateWorkItem).toHaveBeenCalledWith(
      'wi_99',
      expect.objectContaining({ title: 'Renamed' }),
      expect.any(Object),
    );
  });

  it('rejects an update to a terminal item', async () => {
    const editedDelta = {
      operations: [{ op: 'update', targetKey: 'MOTIR-100', fields: { title: 'Renamed' } }],
    };
    vi.mocked(workflowsService.getTerminalStatusKeys).mockResolvedValue(
      new Set(['done', 'cancelled']),
    );
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', status: 'done' }),
    );

    await expect(aiPlanEditsService.approveDelta('job_1', editedDelta, ctx)).rejects.toThrow(
      PlanDeltaImmutabilityError,
    );
    expect(workItemsService.updateWorkItem).not.toHaveBeenCalled();
  });

  it('rejects an invalid delta shape', async () => {
    const editedDelta = { operations: 'not-an-array' };

    await expect(aiPlanEditsService.approveDelta('job_1', editedDelta, ctx)).rejects.toThrow(
      PlanDeltaValidationError,
    );
  });

  it('returns empty arrays for an empty delta', async () => {
    const editedDelta = { operations: [] };
    vi.mocked(workflowsService.getTerminalStatusKeys).mockResolvedValue(
      new Set(['done', 'cancelled']),
    );

    const result = await aiPlanEditsService.approveDelta('job_1', editedDelta, ctx);

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(workItemsService.createWorkItem).not.toHaveBeenCalled();
    expect(workItemsService.updateWorkItem).not.toHaveBeenCalled();
  });

  it('throws when job has no delta and no editedDelta provided', async () => {
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

  it('handles multiple ops in a single delta', async () => {
    const editedDelta = {
      operations: [
        { op: 'create', kind: 'task', fields: { title: 'Task 1' } },
        { op: 'create', kind: 'task', fields: { title: 'Task 2' } },
        { op: 'update', targetKey: 'MOTIR-100', fields: { priority: 'high' } },
      ],
    };
    vi.mocked(workflowsService.getTerminalStatusKeys).mockResolvedValue(
      new Set(['done', 'cancelled']),
    );
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', status: 'todo' }),
    );
    let idCounter = 500;
    vi.mocked(workItemsService.createWorkItem).mockImplementation(async (_input) => {
      return mockWorkItemDto(`MOTIR-${idCounter++}`);
    });
    vi.mocked(workItemsService.updateWorkItem).mockResolvedValue(mockWorkItemDto('MOTIR-100'));

    const result = await aiPlanEditsService.approveDelta('job_1', editedDelta, ctx);

    expect(result.created).toEqual(['MOTIR-500', 'MOTIR-501']);
    expect(result.updated).toEqual(['MOTIR-100']);
    expect(workItemsService.createWorkItem).toHaveBeenCalledTimes(2);
    expect(workItemsService.updateWorkItem).toHaveBeenCalledTimes(1);
  });
});
