import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';

// The OUTWARD bug-telemetry TRIGGER, proven through the SHIPPED fan-in (Story
// 7.6 · MOTIR-1481). A real `workItemsService.createWorkItem` emits the
// Story-1.6 `work-item/created` event (captured off the Inngest client), and we
// drive the REAL job function over that exact payload — so this asserts the
// loop fires from the shipped pipeline event (channel-agnostic), NOT a
// bug-create-specific hook. Real Postgres; the one boundary seam stubbed is the
// motir-ai client. The event omits `kind`, so a pass also proves the handler
// resolves it by loading the item.

vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));

import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { outwardBugTelemetryOnCreated } from '@/lib/jobs/definitions/outwardBugTelemetry';
import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { WorkItemCreatedData } from '@/lib/jobs/types';
import { makeWorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';

let cap: { events: CapturedJobEvent[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(resolveTenantOrg).mockResolvedValue({ organizationId: 'org_1', isMeta: false });
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** The single `work-item/created` payload emitted since buffer index `from`. */
function createdSince(from: number): WorkItemCreatedData {
  const evts = cap.events.slice(from).filter((e) => e.name === 'work-item/created');
  expect(evts).toHaveLength(1);
  return evts[0]!.data as WorkItemCreatedData;
}

describe('outwardBugTelemetryOnCreated (fan-in from work-item/created)', () => {
  it('dispatches analyze_bug when a bug-create fires the shipped event', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'bug',
        title: 'Broken export',
        descriptionMd: 'CSV export 500s.',
      },
      fx.ctx,
    );
    const data = createdSince(from);

    await new InngestTestEngine({
      function: outwardBugTelemetryOnCreated,
      events: [{ name: 'work-item/created', data }],
    }).execute();

    expect(submitJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitJob).mock.calls[0]![0]).toBe('analyze_bug');
  });

  it('dispatches nothing when a NON-bug create fires the same event', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A story' },
      fx.ctx,
    );
    const data = createdSince(from);

    await new InngestTestEngine({
      function: outwardBugTelemetryOnCreated,
      events: [{ name: 'work-item/created', data }],
    }).execute();

    expect(submitJob).not.toHaveBeenCalled();
  });
});
