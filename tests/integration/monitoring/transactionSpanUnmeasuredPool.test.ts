import * as Sentry from '@sentry/nextjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  measureTransactionAttempt,
  TRANSACTION_ATTR,
  TRANSACTION_SPAN,
} from '@/lib/monitoring/transactionSpan';
import { clearTransactionStallPools } from '@/lib/monitoring/transactionStall';

// MOTIR-8556 — a SAMPLED transaction span when no pool is registered (a script,
// the job worker before `lib/db.ts` loads) says `unmeasured`, never zeros. The
// real SDK, a capture transport, no database: the pool registry is empty on
// purpose, which the database path never is.

type Span = { description?: string; data?: Record<string, unknown> };
const sent: unknown[] = [];

afterAll(async () => {
  await Sentry.close(2000);
});

describe('a sampled db.transaction span with no registered pool', () => {
  it("carries db.pool.count='unmeasured' and no pool number at all", async () => {
    Sentry.init({
      dsn: 'https://key@o1.ingest.us.sentry.io/2',
      tracesSampleRate: 1,
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
    clearTransactionStallPools();

    await Sentry.startSpan({ name: 'root', forceTransaction: true }, () =>
      measureTransactionAttempt(
        'system',
        1,
        (bodyStarted, settled) => settled(Promise.resolve(bodyStarted(() => 1))),
        () => {},
      ),
    );
    await Sentry.flush(2000);

    const spans = (sent as [unknown, [{ type: string }, { spans?: Span[] }][]][])
      .flatMap((e) => e[1])
      .filter(([h]) => h.type === 'transaction')
      .flatMap(([, p]) => p.spans ?? []);
    const tx = spans.filter((s) => s.description === TRANSACTION_SPAN.transaction);
    expect(tx).toHaveLength(1);
    expect(tx[0]!.data?.[TRANSACTION_ATTR.poolCount]).toBe('unmeasured');
    for (const key of [
      TRANSACTION_ATTR.poolTotal,
      TRANSACTION_ATTR.poolIdle,
      TRANSACTION_ATTR.poolWaiting,
      TRANSACTION_ATTR.poolMax,
    ]) {
      expect(tx[0]!.data, key).not.toHaveProperty(key);
    }
  });
});
