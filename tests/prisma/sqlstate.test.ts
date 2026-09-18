import { describe, expect, it } from 'vitest';
import { sqlStateOf } from '@/lib/prisma/sqlstate';

// THE ONE PLACE THE SQLSTATE IS READ FROM (MOTIR-5687).
//
// ⚠️ THIS SUITE EXISTS BECAUSE THE SHAPE MOVED ONCE AND WILL MOVE AGAIN. Three
// repositories each carried their own copy of this extractor, all reading
// `err.cause` alone, and a Prisma upgrade relocated the SQLSTATE under
// `meta.driverAdapterError.cause` — which silently retired the SQLSTATE arm of
// every one of them at the same moment. Two only kept working because they also
// match a message marker; nothing went red where it mattered, and the RLS suites
// went red for a reason that read like cosmetics.
//
// So the shapes are pinned HERE, as data, against a PURE function — no database,
// no fixture, no gated table. That matters for two reasons beyond speed: an
// unbound read of a policy-gated table is forbidden by
// `tests/rls/test-call-site-guard.test.ts` (and rightly — it "will PASS while
// checking nothing"), and a driver shape is a fact about the DRIVER, so a test
// that needs a live row to state it is describing the wrong thing.
//
// The live shapes are asserted end to end by the RLS suites through
// `isRlsDenial`; what these cases add is the arms a real error never takes —
// the malformed and the absent — which are exactly the ones that decide whether
// a future move is caught or silently swallowed.

describe('sqlStateOf — every shape a pg driver error has carried', () => {
  it('reads the FLAT shape (prisma <= 7.8): `err.cause.code`', () => {
    expect(sqlStateOf(Object.assign(new Error('refused'), { cause: { code: '23514' } }))).toBe(
      '23514',
    );
  });

  it('reads the flat shape via `originalCode` — a driver that names it differently', () => {
    expect(
      sqlStateOf(Object.assign(new Error('refused'), { cause: { originalCode: '23514' } })),
    ).toBe('23514');
  });

  it('reads the NESTED shape (prisma >= 7.9): `meta.driverAdapterError.cause.code`', () => {
    expect(
      sqlStateOf(
        Object.assign(new Error('refused'), {
          code: 'P2039',
          meta: { driverAdapterError: { cause: { code: '42501' } } },
        }),
      ),
    ).toBe('42501');
  });

  it('reads the nested shape via `originalCode` — the form 7.10 actually emits for a unique', () => {
    // Measured against the live client: a unique violation nests
    // `{ originalCode: '23505', kind: 'UniqueConstraintViolation', … }` and
    // carries NO `code` on the cause at all.
    expect(
      sqlStateOf(
        Object.assign(new Error('duplicate'), {
          code: 'P2002',
          meta: { driverAdapterError: { cause: { originalCode: '23505' } } },
        }),
      ),
    ).toBe('23505');
  });

  it('prefers the FLAT shape when a driver somehow carries both', () => {
    // Not a shape any client emits — it is the tie-break, stated so a future
    // reader does not have to infer the precedence from the implementation.
    expect(
      sqlStateOf(
        Object.assign(new Error('both'), {
          cause: { code: '23514' },
          meta: { driverAdapterError: { cause: { code: '42501' } } },
        }),
      ),
    ).toBe('23514');
  });

  describe('answers undefined rather than guessing', () => {
    it.each([
      ['a plain Error with no cause at all', new Error('plain')],
      ['a cause that is not an object', Object.assign(new Error('x'), { cause: '23514' })],
      [
        'a cause object carrying NEITHER code nor originalCode',
        Object.assign(new Error('x'), { cause: { detail: 'nothing useful' } }),
      ],
      [
        'meta present but carrying no driverAdapterError',
        Object.assign(new Error('x'), { meta: { modelName: 'ApprovalGate' } }),
      ],
      [
        'a driverAdapterError with no cause',
        Object.assign(new Error('x'), { meta: { driverAdapterError: { name: 'X' } } }),
      ],
      ['a thrown string', 'AG_DECIDED_IMMUTABLE'],
      ['null', null],
      ['undefined', undefined],
    ])('%s', (_label, err) => {
      expect(sqlStateOf(err)).toBeUndefined();
    });
  });
});
