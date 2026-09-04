import { vi } from 'vitest';
import { db } from '@/lib/db';

// Count how many times a Prisma DELEGATE METHOD actually runs — the "no N+1"
// instrument — counting the SINGLETON and any TRANSACTION client alike.
//
// ── Why it cannot just spy on `db.<model>.<method>` (MOTIR-2846) ─────────────
// A repository resolves `(tx ?? dbRead).<model>`. Before a call site is bound, `tx`
// is undefined and the singleton spy sees every query. Once it IS bound, the
// read runs on the transaction client — a DIFFERENT object, created inside
// `db.$transaction` and therefore impossible to spy ahead of time — and the
// singleton spy counts ZERO.
//
// That failure is the dangerous direction: `expect(queries).toBe(1)` goes red on
// a correct change, and `expect(queries).toBe(0)` (the empty-input
// short-circuit) passes VACUOUSLY, because 0 is what an unobserved client
// reports too. So the fix is not to move the spy — it is to observe both.
//
// The transaction half is done by intercepting `db.$transaction` and handing the
// callback a Proxy over the real client that counts the one method and forwards
// everything else untouched. The proxy is transparent: the query still runs, on
// the real transaction, with its GUCs intact — so a test using this helper still
// measures the bound path rather than a stand-in for it.

export interface DelegateCallCount<T> {
  result: T;
  /** Calls on the singleton PLUS calls on any transaction client, summed. */
  queries: number;
}

/**
 * Run `fn`, counting every `db[model][method]` call it makes — through the
 * `@/lib/db` singleton or through a `db.$transaction` client.
 *
 * ⚠️ Count against `db`, never `adminDb`: `adminDb` is the fixture/readback
 * client (MOTIR-2513's two-client model) and the code under test never touches
 * it, so a spy there measures 0 and passes only where 0 is expected.
 */
export async function countDelegateCalls<T>(
  model: string,
  method: string,
  fn: () => Promise<T>,
): Promise<DelegateCallCount<T>> {
  const delegate = (db as unknown as Record<string, Record<string, unknown>>)[model];
  const singletonSpy = vi.spyOn(delegate as never, method as never) as unknown as {
    mock: { calls: unknown[] };
    mockRestore: () => void;
  };

  const realTransaction = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
  const txSpy = vi.spyOn(db, '$transaction') as unknown as {
    mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
    mockRestore: () => void;
  };

  let txCalls = 0;
  const countingProxy = (tx: object): object =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== model || value === null || typeof value !== 'object') return value;
        return new Proxy(value as object, {
          get(m, name, mReceiver) {
            const fnValue = Reflect.get(m, name, mReceiver) as unknown;
            if (name !== method || typeof fnValue !== 'function') return fnValue;
            return (...args: unknown[]) => {
              txCalls += 1;
              return (fnValue as (...a: unknown[]) => unknown).apply(m, args);
            };
          },
        });
      },
    });

  txSpy.mockImplementation((...args: unknown[]) => {
    const [first, ...rest] = args;
    // The ARRAY form (`db.$transaction([...])`) carries no client to wrap.
    if (typeof first !== 'function') return realTransaction(...args);
    const wrapped = (tx: object) => (first as (t: object) => unknown)(countingProxy(tx));
    return realTransaction(wrapped, ...rest);
  });

  try {
    const result = await fn();
    return { result, queries: singletonSpy.mock.calls.length + txCalls };
  } finally {
    singletonSpy.mockRestore();
    txSpy.mockRestore();
  }
}
