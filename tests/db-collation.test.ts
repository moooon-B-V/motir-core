import { afterAll, describe, expect, it } from 'vitest';
import { adminDb } from './helpers/adminDb';

// THE DATABASE MUST COLLATE BY BYTE (MOTIR-2696).
//
// This repo orders by fractional-index keys. `lib/workItems/positioning.ts`
// mints base-62 strings for `work_item.position` and `work_item.backlogRank`,
// and the same scheme orders board columns, dashboard widgets, custom-field
// options, sprint backlogs and the project repository set. Base-62 uses BOTH
// cases, and its ordering is only correct under BYTE comparison: `'Zz' < 'a0'`
// holds because `Z` (0x5A) precedes `a` (0x61), and under a dictionary
// collation — which ignores case at the primary level — it simply does not.
//
// Production is Neon at `datcollate = 'C.UTF-8'` (verified 2026-08-12 against
// the instance), so byte ordering is what the product actually runs on. This
// file asserts the TEST database agrees, because for two years it agreed only by
// accident: `postgres:16-alpine` is musl, which has no real locale support and
// collates by byte whatever the locale string says. MOTIR-2696 moved the image
// to a glibc base (pgvector ships no alpine build), glibc honoured the default
// `en_US.utf8`, and eleven ordering assertions went red across three Vitest
// shards — none of which named the cause. `POSTGRES_INITDB_ARGS=--locale=C.UTF-8`
// in `.github/actions/postgres` and `docker-compose.yml` is the fix; this is
// what makes it checkable.
//
// It asserts the OBSERVED ORDERING rather than the locale NAME on purpose. The
// name is a proxy — `C`, `C.UTF-8` and musl's `en_US.utf8` are three different
// strings that all collate identically — and the thing the product depends on is
// the comparison, not the label.

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('the database collates text by byte', () => {
  it('orders a base-62 fractional-key sample the way positioning.ts assumes', async () => {
    // `Zz` before `a0` is the whole property: uppercase sorts BEFORE lowercase.
    // Under `en_US.utf8` on glibc this comes back `a0, a1, b0V, Zz`.
    const rows = await adminDb.$queryRawUnsafe<{ key: string }[]>(
      `SELECT key FROM (VALUES ('a1'), ('b0V'), ('Zz'), ('a0')) t(key) ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual(['Zz', 'a0', 'a1', 'b0V']);
  });

  it('does not fold case or ignore punctuation, as a dictionary collation would', async () => {
    // The shape that first surfaced this, from `labelRepository.searchByPrefix`:
    // glibc drops the hyphen at the primary level and compares `perfq3` /
    // `perfq4` / `performance`, putting `performance` first.
    const rows = await adminDb.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM (VALUES ('performance'), ('Perf-Q3'), ('perf-q4')) t(name) ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(['Perf-Q3', 'perf-q4', 'performance']);
  });

  it('agrees with the JavaScript comparison the key generator is built on', async () => {
    // `generateKeyBetween` compares keys in JS with `<`, which is UTF-16 code
    // unit order. A database that disagreed would mean the process that MINTS a
    // key between two neighbours and the query that READS them back sorted are
    // using two different orders — the kind of split that shows up as a card
    // landing in the wrong slot rather than as an error.
    const sample = ['a0', 'a1', 'Zz', 'b0V', 'A00', 'zz', 'a0V'];
    const rows = await adminDb.$queryRawUnsafe<{ key: string }[]>(
      `SELECT key FROM (VALUES ${sample.map((s) => `('${s}')`).join(', ')}) t(key) ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual([...sample].sort());
  });

  it('reports a byte-ordering collation on the database itself', async () => {
    // The label, checked last and separately: it is what an operator reads when
    // provisioning a new environment, and `C` / `C.UTF-8` are the only two
    // values that give the ordering the three assertions above require.
    const rows = await adminDb.$queryRawUnsafe<{ datcollate: string }[]>(
      `SELECT datcollate FROM pg_database WHERE datname = current_database()`,
    );
    expect(rows[0]?.datcollate).toMatch(/^C(\.UTF-?8)?$/i);
  });
});
