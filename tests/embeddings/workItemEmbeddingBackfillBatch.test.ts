import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The motir-ai boundary is the one stubbed seam, as in workItemEmbeddingsService.test.ts:
// an embedding is a metered external call. Postgres, RLS and every repository and
// service here are real.
vi.mock('@/lib/ai/motirAiClient', () => ({ embedTexts: vi.fn() }));

import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiBadRequestError, MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  EMBEDDING_MAX_ATTEMPTS,
  workItemEmbeddingsService,
  type WitnessProbe,
} from '@/lib/services/workItemEmbeddingsService';
import { workItemEmbeddingSweepService } from '@/lib/services/workItemEmbeddingSweepService';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

const POISON = 'POISONED-TEXT';

function vector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === seed % 1536 ? 1 : 0));
}

/** Embed fine, except a call whose inputs include POISON is refused with `status`. */
function refusePoison(status = 422): void {
  vi.mocked(embedTexts).mockImplementation(async (input: string[]) => {
    if (input.some((t) => t.includes(POISON))) {
      throw new MotirAiBadRequestError('input rejected', status);
    }
    return {
      model: 'text-embedding-3-small',
      dimensions: 1536,
      embeddings: input.map((_, i) => vector(i + 1)),
    };
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  refusePoison();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const witness = (): WitnessProbe => ({ confirmed: false });

async function embeddedIds(fx: WorkItemFixture): Promise<string[]> {
  const rows = await adminDb.$queryRawUnsafe<Array<{ workItemId: string }>>(
    `SELECT "workItemId" FROM "work_item_embedding" WHERE "projectId" = $1`,
    fx.projectId,
  );
  return rows.map((r) => r.workItemId);
}

async function failureState(id: string) {
  const [row] = await adminDb.$queryRawUnsafe<
    Array<{ hash: string | null; attempts: number | null }>
  >(
    `SELECT "embedding_failed_hash" AS hash, "embedding_failed_attempts" AS attempts
       FROM "work_item" WHERE "id" = $1`,
    id,
  );
  return row!;
}

async function scenario() {
  const fx = await makeWorkItemFixture({ name: 'Batch', identifier: 'BAT' });
  const good = await createTestWorkItem(fx, { kind: 'task', title: 'Good one' });
  const bad = await createTestWorkItem(fx, { kind: 'task', title: POISON });
  const good2 = await createTestWorkItem(fx, { kind: 'task', title: 'Good two' });
  return { fx, good, bad, good2 };
}

const run = (fx: WorkItemFixture, w: WitnessProbe = witness()) =>
  workItemEmbeddingsService.backfillBatch({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    afterId: null,
    witness: w,
  });

describe('backfillBatch — poison-item isolation', () => {
  it('embeds the healthy neighbours and records the refused item', async () => {
    const { fx, good, bad, good2 } = await scenario();

    const result = await run(fx);

    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failedIds).toEqual([bad.id]);
    expect((await embeddedIds(fx)).sort()).toEqual([good.id, good2.id].sort());
    expect((await failureState(bad.id)).attempts).toBe(1);
  });

  it('probes the provider once, however many groups are refused', async () => {
    const { fx } = await scenario();
    const w = witness();

    await run(fx, w);

    expect(w.confirmed).toBe(true);
    const probes = vi
      .mocked(embedTexts)
      .mock.calls.filter(([input]) => input.length === 1 && !input[0]!.includes('Good'));
    expect(probes.filter(([input]) => !input[0]!.includes(POISON))).toHaveLength(1);
  });

  it('counts attempts across runs, then skips the item without a provider call', async () => {
    const { fx, bad } = await scenario();

    for (let i = 1; i <= EMBEDDING_MAX_ATTEMPTS; i += 1) {
      await run(fx);
      expect((await failureState(bad.id)).attempts).toBe(i);
    }
    vi.mocked(embedTexts).mockClear();

    const after = await run(fx);

    expect(after.givenUpIds).toEqual([bad.id]);
    expect(after.failed).toBe(0);
    expect(embedTexts).not.toHaveBeenCalled();
    expect((await failureState(bad.id)).attempts).toBe(EMBEDDING_MAX_ATTEMPTS);
  });

  it('starts again when the item text changes', async () => {
    const { fx, bad } = await scenario();
    for (let i = 0; i < EMBEDDING_MAX_ATTEMPTS; i += 1) await run(fx);

    await adminDb.$executeRawUnsafe(
      `UPDATE "work_item" SET "title" = 'Fixed title' WHERE "id" = $1`,
      bad.id,
    );
    const after = await run(fx);

    expect(after.embedded).toBe(1);
    expect(after.givenUp).toBe(0);
    expect(await embeddedIds(fx)).toContain(bad.id);
    expect((await failureState(bad.id)).attempts).toBeNull();
  });

  it('does not blame an item when the provider also refuses the witness', async () => {
    const { fx, bad } = await scenario();
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiBadRequestError('wrong model', 400));

    await expect(run(fx)).rejects.toBeInstanceOf(MotirAiBadRequestError);

    expect((await failureState(bad.id)).attempts).toBeNull();
    expect(await embeddedIds(fx)).toEqual([]);
  });

  it('rethrows an outage untouched and records nothing', async () => {
    const { fx, bad } = await scenario();
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('503'));

    await expect(run(fx)).rejects.toBeInstanceOf(MotirAiUnavailableError);

    expect((await failureState(bad.id)).attempts).toBeNull();
  });

  it('treats a 401-class bad request as an outage, not a poison item', async () => {
    const { fx } = await scenario();
    refusePoison(401);

    await expect(run(fx)).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });
});

describe('backfillBatch — scope', () => {
  it('skips archived items', async () => {
    const fx = await makeWorkItemFixture({ name: 'Archived', identifier: 'ARC' });
    const live = await createTestWorkItem(fx, { kind: 'task', title: 'Live' });
    const gone = await createTestWorkItem(fx, { kind: 'task', title: 'Gone' });
    await adminDb.$executeRawUnsafe(
      `UPDATE "work_item" SET "archivedAt" = now() WHERE "id" = $1`,
      gone.id,
    );

    const result = await run(fx);

    expect(result.scanned).toBe(1);
    expect(await embeddedIds(fx)).toEqual([live.id]);
  });

  it('returns an empty result for a project with no items', async () => {
    const fx = await makeWorkItemFixture({ name: 'Empty', identifier: 'EMP' });

    const result = await run(fx);

    expect(result.scanned).toBe(0);
    expect(result.nextAfterId).toBeNull();
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('does nothing when motir-ai is not configured', async () => {
    const { fx } = await scenario();
    vi.stubEnv('MOTIR_AI_URL', '');

    const result = await run(fx);

    expect(result.scanned).toBe(0);
    expect(embedTexts).not.toHaveBeenCalled();
  });
});

describe('workItemEmbeddingSweepService', () => {
  it('embeds across projects and reports what it isolated', async () => {
    const a = await scenario();
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const other = await createTestWorkItem(b, { kind: 'task', title: 'Elsewhere' });

    const summary = await workItemEmbeddingSweepService.sweep();

    expect(summary.configured).toBe(true);
    expect(summary.projectsVisited).toBe(2);
    expect(summary.embedded).toBe(3);
    expect(summary.failedIds).toEqual([a.bad.id]);
    expect(summary.truncated).toBe(false);
    expect(await embeddedIds(b)).toEqual([other.id]);
  });

  it('is idempotent: a second run makes no provider call for finished items', async () => {
    await scenario();
    await workItemEmbeddingSweepService.sweep();
    vi.mocked(embedTexts).mockClear();
    refusePoison();

    const again = await workItemEmbeddingSweepService.sweep();

    expect(again.embedded).toBe(0);
    // The poison item is retried (attempt 2) — the only call made.
    expect(again.failed).toBe(1);
  });

  it('stops at the embed cap and says so', async () => {
    const fx = await makeWorkItemFixture({ name: 'Cap', identifier: 'CAP' });
    await createTestWorkItem(fx, { kind: 'task', title: 'One' });
    await createTestWorkItem(fx, { kind: 'task', title: 'Two' });

    const first = await workItemEmbeddingSweepService.sweep({ maxEmbeds: 1 });
    // The cap is checked between pages, so the first page (both items) lands whole.
    expect(first.embedded).toBe(2);

    const none = await workItemEmbeddingSweepService.sweep({ maxEmbeds: 0 });
    expect(none.truncated).toBe(true);
    expect(none.embedded).toBe(0);
  });

  it('stops at the page cap and says so', async () => {
    await scenario();

    const summary = await workItemEmbeddingSweepService.sweep({ maxPages: 0 });

    expect(summary.truncated).toBe(true);
    expect(summary.scanned).toBe(0);
  });

  it('does nothing when motir-ai is not configured', async () => {
    await scenario();
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');

    const summary = await workItemEmbeddingSweepService.sweep();

    expect(summary.configured).toBe(false);
    expect(summary.projectsVisited).toBe(0);
  });
});
