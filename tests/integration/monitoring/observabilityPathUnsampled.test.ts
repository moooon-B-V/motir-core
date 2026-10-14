import * as Sentry from '@sentry/nextjs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  registerRequestDbTimingListener,
  REQUEST_DB_TIMING_METRICS as M,
  resetRequestDbTimingForTests,
} from '@/lib/monitoring/requestDbTiming';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import {
  connect,
  envelopes,
  histogramCount,
  initSentry,
  request,
  seed,
  transactions,
  transportsCreated,
} from '../../helpers/observabilityPath';

// MOTIR-8556 — THE ASSEMBLED PATH AT `SENTRY_TRACES_SAMPLE_RATE=0`, on the REAL
// SDK (see `observabilityPath.test.ts` for the path itself).
//
// ⚠️ ITS OWN FILE ON PURPOSE. A second `Sentry.init` in one process keeps the
// first init's sampler, so a rate-1 init followed by a rate-0 init still samples.
// This file runs in its own process and initialises exactly once, at 0.
//
// The baseline is the same call with NO SDK at all, made before the init: that is
// how many transactions the call opens when nothing is traced, and the unsampled
// call must record exactly that many.

beforeEach(async () => {
  envelopes.length = 0;
  resetRequestDbTimingForTests();
  await truncateAuthTables();
  spyOnJobDispatch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRequestDbTimingForTests();
});

afterAll(async () => {
  await Sentry.close(2000);
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('unsampled: rate 0 captures nothing and records the same', () => {
  it('move_to_parent sends no transaction event, and the histograms grow by what an untraced call opened', async () => {
    const labels = { route: 'mcp', tool: 'move_to_parent' };
    registerRequestDbTimingListener();

    // The baseline: no SDK in the process yet.
    expect(Sentry.getClient()).toBeUndefined();
    const baseline = await seed();
    let client = await connect(baseline.fx);
    const before = await histogramCount(M.wait, labels);
    expect(
      (
        await request(client, 'move_to_parent', {
          key: baseline.storyKey,
          parentKey: baseline.newParentKey,
        })
      ).isError,
    ).toBeFalsy();
    await client.close();
    const untraced = (await histogramCount(M.wait, labels)) - before;
    expect(untraced).toBeGreaterThanOrEqual(1);

    // A fresh init at rate 0, a fresh tenant, the same call.
    await initSentry('0');
    expect(transportsCreated.count).toBeGreaterThan(0);
    expect(Sentry.getClient()?.getOptions().tracesSampleRate).toBe(0);
    const unsampled = await seed();
    client = await connect(unsampled.fx);
    envelopes.length = 0;
    const waitBefore = await histogramCount(M.wait, labels);
    const holdBefore = await histogramCount(M.hold, labels);
    const result = await request(client, 'move_to_parent', {
      key: unsampled.storyKey,
      parentKey: unsampled.newParentKey,
    });
    await client.close();
    await Sentry.flush(2000);

    expect(result.isError).toBeFalsy();
    expect(transactions()).toHaveLength(0);
    expect((await histogramCount(M.wait, labels)) - waitBefore).toBe(untraced);
    // Every one of those committed, so every one held.
    expect((await histogramCount(M.hold, labels)) - holdBefore).toBe(untraced);
  });
});
