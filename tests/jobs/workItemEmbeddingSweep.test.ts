import { describe, expect, it } from 'vitest';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobSchedules } from '@/lib/jobs/schedules';
import { WORK_ITEM_EMBEDDING_SWEEP_CRON } from '@/lib/jobs/definitions/workItemEmbeddingSweep';

// MOTIR-8227 — what the sweep embeds, bounds and isolates is covered against a real
// database in tests/embeddings/workItemEmbeddingBackfillBatch.test.ts. This pins the
// registration: the job exists, is on the schedule table, and is hourly.
describe('system.work-item-embedding-sweep registration', () => {
  it('is registered and appears in the schedule table', () => {
    expect(jobDefinitions.some((d) => d.id === 'system.work-item-embedding-sweep')).toBe(true);
    expect(jobSchedules()).toContainEqual(
      expect.objectContaining({
        functionId: 'system.work-item-embedding-sweep',
        cron: WORK_ITEM_EMBEDDING_SWEEP_CRON,
      }),
    );
  });

  it('is hourly: a fixed minute, every hour, no finer', () => {
    expect(WORK_ITEM_EMBEDDING_SWEEP_CRON).toMatch(/^\d+ \* \* \* \*$/);
  });
});
