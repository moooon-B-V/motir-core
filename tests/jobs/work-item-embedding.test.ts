import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';

// The plan-tree embedding JOB, driven end-to-end from the SHIPPED pipeline event
// (Story MOTIR-2694 · Subtask MOTIR-2696, `docs/decisions/plan-tree-embeddings.md`
// §6.3). A real `workItemsService.createWorkItem` emits
// `work-item/embedding.requested`, and the REAL job function is executed over
// that exact payload — so this proves the wiring the two halves are otherwise
// tested apart from: the event the write path emits is the event the job
// consumes, and the payload it carries is enough to do the work.
//
// Real Postgres; the one boundary seam stubbed is the motir-ai client, because
// there is no gateway in tests and an embedding is a metered external call.

vi.mock('@/lib/ai/motirAiClient', () => ({ embedTexts: vi.fn() }));

import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemEmbeddingRequested } from '@/lib/jobs/definitions/workItemEmbedding';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import type { WorkItemEmbeddingRequestedData } from '@/lib/jobs/types';
import { makeWorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';

const MODEL = 'text-embedding-3-small';

let cap: { events: CapturedJobEvent[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
    model: MODEL,
    dimensions: 1536,
    embeddings: input.map(() => Array.from({ length: 1536 }, (_, i) => (i === 7 ? 1 : 0))),
  }));
  cap = captureJobEvents();
});

afterEach(() => {
  cap.restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The single `work-item/embedding.requested` payload emitted since `from`. */
function requestedSince(from: number): WorkItemEmbeddingRequestedData {
  const evts = cap.events.slice(from).filter((e) => e.name === 'work-item/embedding.requested');
  expect(evts).toHaveLength(1);
  return evts[0]!.data as WorkItemEmbeddingRequestedData;
}

describe('workItemEmbeddingRequested', () => {
  it('embeds the item named by the event the shipped create emitted', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'JOB' });
    const from = cap.events.length;
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Board columns', descriptionMd: 'Collapse.' },
      fx.ctx,
    );
    const data = requestedSince(from);

    const { result } = await new InngestTestEngine({
      function: workItemEmbeddingRequested,
      events: [{ name: 'work-item/embedding.requested', data }],
    }).execute();

    expect(result).toEqual({ embedded: true, model: MODEL });
    expect(vi.mocked(embedTexts).mock.calls[0]?.[0]).toEqual(['Board columns\n\nCollapse.']);
    const row = await adminDb.workItemEmbedding.findUnique({ where: { workItemId: created.id } });
    expect(row?.model).toBe(MODEL);
  });

  it('is idempotent across a redelivery of the SAME event', async () => {
    // Inngest can redeliver, and the retry budget is `idempotent` (5 attempts) —
    // so running the same event twice must cost one provider call, not two.
    const fx = await makeWorkItemFixture({ identifier: 'IDEM' });
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Once' },
      fx.ctx,
    );
    const data = requestedSince(from);
    const run = () =>
      new InngestTestEngine({
        function: workItemEmbeddingRequested,
        events: [{ name: 'work-item/embedding.requested', data }],
      }).execute();

    await run();
    const second = await run();

    expect(second.result).toEqual({ embedded: false, reason: 'unchanged' });
    expect(embedTexts).toHaveBeenCalledTimes(1);
    const workItemEmbeddingCount = await adminDb.workItemEmbedding.count();
    expect(workItemEmbeddingCount).toBe(1);
  });

  it('lets a provider outage FAIL, so the retry budget can absorb it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'OUT' });
    const from = cap.events.length;
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unlucky' },
      fx.ctx,
    );
    const data = requestedSince(from);
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));

    const { error } = await new InngestTestEngine({
      function: workItemEmbeddingRequested,
      events: [{ name: 'work-item/embedding.requested', data }],
    }).execute();

    // Swallowing here would turn a transient outage into a permanently
    // un-embedded item, because nothing else ever revisits it.
    expect(error).toBeTruthy();
    const workItemEmbeddingCount = await adminDb.workItemEmbedding.count();
    expect(workItemEmbeddingCount).toBe(0);
  });
});
