import * as Sentry from '@sentry/nextjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  onTransactionMeasured,
  TRANSACTION_ATTR,
  TRANSACTION_SPAN,
  type TransactionMeasurement,
} from '@/lib/monitoring/transactionSpan';
import { withoutAutoPostgresSpans } from '@/lib/monitoring/serverInit';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';
import { withSystemContext } from '@/lib/workspaces/context';

// MOTIR-8550 — THE REAL SEAM: a real `with*Context` helper, the real pool
// `lib/db.ts` registered, a real Postgres, and a real Sentry client whose
// transactions are captured in memory (`beforeSendTransaction` keeps the event
// and returns null, so nothing leaves the process).

type CapturedSpan = {
  span_id: string;
  parent_span_id?: string;
  description?: string;
  op?: string;
  data?: Record<string, unknown>;
};
type CapturedTransaction = {
  transaction?: string;
  contexts?: { trace?: { span_id?: string } };
  spans?: CapturedSpan[];
};

const captured: CapturedTransaction[] = [];
const measured: TransactionMeasurement[] = [];
let stopListening: () => void = () => {};

beforeAll(() => {
  Sentry.init({
    dsn: 'https://key@o1.ingest.us.sentry.io/2',
    tracesSampleRate: 1,
    integrations: withoutAutoPostgresSpans,
    beforeSendTransaction(event) {
      captured.push(event as unknown as CapturedTransaction);
      return null;
    },
  });
  stopListening = onTransactionMeasured((m) => measured.push(m));
});

afterAll(async () => {
  stopListening();
  await Sentry.close(2000);
});

beforeEach(() => {
  captured.length = 0;
  measured.length = 0;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every span below `ancestorId` in the captured tree. */
function descendants(spans: CapturedSpan[], ancestorId: string): CapturedSpan[] {
  const below = spans.filter((s) => s.parent_span_id === ancestorId);
  return below.flatMap((s) => [s, ...descendants(spans, s.span_id)]);
}

/** JSON of the event, cycles cut — the SDK's event holds references to itself. */
function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[cycle]';
      seen.add(v);
    }
    return v;
  });
}

/** Run `work` as one sampled request and return its captured transaction. */
async function traced(name: string, work: () => Promise<unknown>): Promise<CapturedTransaction> {
  await Sentry.startSpan({ name, forceTransaction: true }, async () => {
    await work().catch(() => {});
  });
  await Sentry.flush(2000);
  const event = captured.find((e) => e.transaction === name);
  if (!event) throw new Error(`no transaction captured for ${name}`);
  return event;
}

describe('the measurement, on a real transaction', () => {
  it('a body that sleeps is HOLD, not WAIT; deferred after-commit work is neither', async () => {
    // Warm the pool first, so the measured WAIT is not a cold connect.
    await withSystemContext((tx) => tx.$queryRaw`SELECT 1`);
    measured.length = 0;
    await withSystemContext(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      deferUntilCommit(async () => {
        await sleep(200);
      });
      await sleep(120);
    });
    expect(measured).toHaveLength(1);
    const [m] = measured;
    expect(m!.context).toBe('system');
    expect(m!.outcome).toBe('committed');
    expect(m!.holdMs).toBeGreaterThanOrEqual(115);
    expect(m!.holdMs).toBeLessThan(200);
    expect(m!.waitMs).toBeLessThan(115);
    // The real pool is registered by `lib/db.ts`.
    expect(m!.pool).not.toBe('unmeasured');
    expect(m!.pool).toMatchObject({ count: expect.any(Number) as number });
  });

  it('a body that throws rolls back and is recorded rolled_back', async () => {
    await expect(
      withSystemContext(async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(measured.map((m) => m.outcome)).toEqual(['rolled_back']);
  });
});

describe('the spans, on a sampled request', () => {
  it('draws db.transaction → wait + hold, the binds under wait and the body’s statements under hold', async () => {
    const event = await traced('seam-shape', () =>
      withSystemContext(async (tx) => {
        await tx.$queryRaw`SELECT ${'shape'}::text AS v`;
      }),
    );
    const spans = event.spans ?? [];
    const txSpan = spans.find((s) => s.description === TRANSACTION_SPAN.transaction);
    expect(txSpan).toBeDefined();
    expect(txSpan!.parent_span_id).toBe(event.contexts?.trace?.span_id);
    expect(txSpan!.data?.[TRANSACTION_ATTR.context]).toBe('system');
    expect(txSpan!.data?.[TRANSACTION_ATTR.outcome]).toBe('committed');
    expect(typeof txSpan!.data?.[TRANSACTION_ATTR.waitMs]).toBe('number');
    expect(typeof txSpan!.data?.[TRANSACTION_ATTR.holdMs]).toBe('number');
    expect(typeof txSpan!.data?.[TRANSACTION_ATTR.poolCount]).toBe('number');

    const wait = spans.find((s) => s.description === TRANSACTION_SPAN.wait);
    const hold = spans.find((s) => s.description === TRANSACTION_SPAN.hold);
    expect(wait?.parent_span_id).toBe(txSpan!.span_id);
    expect(hold?.parent_span_id).toBe(txSpan!.span_id);

    // The statements are Prisma's spans: the binds beneath WAIT, the body's
    // beneath HOLD, each with its parameterised text.
    const statements = spans.filter((s) => s.op === TRANSACTION_SPAN.statementOp);
    const underWait = descendants(spans, wait!.span_id).filter((s) => statements.includes(s));
    const underHold = descendants(spans, hold!.span_id).filter((s) => statements.includes(s));
    expect(underWait.some((s) => s.description?.includes('set_config'))).toBe(true);
    const body = underHold.find((s) => s.description?.includes('::text AS v'));
    expect(body).toBeDefined();
    expect(body!.description).toMatch(/\$1/);
    expect(body!.data?.[TRANSACTION_ATTR.statement]).toBe(body!.description);
    expect(underHold.some((s) => s.description?.includes('set_config'))).toBe(false);
  });

  it('no bound value reaches any span — a sentinel parameter appears nowhere in the event', async () => {
    const SENTINEL = 'sentinel-8550-bound-value-must-not-leak';
    const event = await traced('seam-sentinel', () =>
      withSystemContext(async (tx) => {
        await tx.$queryRaw`SELECT ${SENTINEL}::text AS v`;
        await tx.$executeRaw`SELECT set_config('app.sentinel_probe', ${SENTINEL}, true)`;
      }),
    );
    expect((event.spans ?? []).length).toBeGreaterThan(3);
    expect(serialize(event)).not.toContain(SENTINEL);
  });

  it('a rolled-back transaction carries its outcome on the span', async () => {
    const event = await traced('seam-rollback', () =>
      withSystemContext(async () => {
        throw new Error('nope');
      }),
    );
    const txSpan = (event.spans ?? []).find((s) => s.description === TRANSACTION_SPAN.transaction);
    expect(txSpan?.data?.[TRANSACTION_ATTR.outcome]).toBe('rolled_back');
  });

  it('a transaction outside any request draws no db.transaction span, and is still measured', async () => {
    await withSystemContext(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
    });
    await Sentry.flush(2000);
    // Prisma's own integration may start a root span of its own here; the seam's
    // span only ever nests under a request (`onlyIfParent`).
    for (const event of captured) {
      expect(event.transaction).not.toBe(TRANSACTION_SPAN.transaction);
      expect((event.spans ?? []).some((s) => s.description === TRANSACTION_SPAN.transaction)).toBe(
        false,
      );
    }
    expect(measured).toHaveLength(1);
  });
});
