import { describe, expect, it } from 'vitest';
import {
  buildRepoAuditRows,
  defaultSelectedRepoKey,
  orderRepoAuditRows,
  rollupRepoAuditRows,
} from '@/lib/codeHealth/repoAuditRows';
import type { CodeAuditSurfaceDTO, RepoAuditSurfaceDTO } from '@/lib/dto/codeHealth';

// The audit tab's per-repo LIST model (MOTIR-2207 · design/coding-convention
// Panel 7). Pure and shared by the server page and the client island, so both
// agree on worst-first order and on what "the first row" means — which is also
// what the re-audit poll watches.

function audited(
  repoKey: string,
  conformancePct: number | undefined,
  total = 10,
): RepoAuditSurfaceDTO {
  const surface: CodeAuditSurfaceDTO = {
    audit: {
      id: `audit_${repoKey}`,
      healthSummary: { grade: 'B', conformancePct },
      codeGraphRef: null,
      repoKey,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [],
    total,
    nextOffset: null,
    scanner: null,
  };
  return { repoKey, surface };
}

function neverAudited(repoKey: string): RepoAuditSurfaceDTO {
  return {
    repoKey,
    surface: { audit: null, findings: [], total: 0, nextOffset: null, scanner: null },
  };
}

/** ⚠️ `surface: null` is the read that FAILED — not the repo with no audit. */
function unloadable(repoKey: string): RepoAuditSurfaceDTO {
  return { repoKey, surface: null };
}

const keys = (rows: { repoKey: string }[]) => rows.map((r) => r.repoKey);

describe('buildRepoAuditRows — the four row states', () => {
  it('tells "no audit yet" apart from "the read failed"', () => {
    const rows = buildRepoAuditRows([neverAudited('a/one'), unloadable('a/two')]);

    // The distinction the design's row table turns on: one is routine, the
    // other is a failure with a recovery. Collapsing them is how a broken read
    // would silently read as "you have never audited this repo".
    expect(rows.map((r) => r.state)).toEqual(['not_audited', 'unavailable']);
  });

  it('reads the grade + conformance off the audit, and the count off `total`', () => {
    const [row] = buildRepoAuditRows([audited('a/one', 78, 212)]);

    expect(row).toMatchObject({ state: 'audited', grade: 'B', conformancePct: 78 });
    // `total`, never `findings.length` — the list reads at `findingsLimit=1`, so
    // the page it holds is one row long and says nothing about the count.
    expect(row!.findingCount).toBe(212);
  });

  it('nulls a grade the audit did not report, rather than passing undefined on', () => {
    const surface = audited('a/one', undefined).surface!;
    surface.audit!.healthSummary = {};

    const [row] = buildRepoAuditRows([{ repoKey: 'a/one', surface }]);

    // The row model is what the LIST renders off, so "absent" has to be one
    // value: a mix of undefined and null is how a chip renders as "undefined".
    expect(row).toMatchObject({ state: 'audited', grade: null, conformancePct: null });
  });

  it('marks a queued repo as deriving, whether or not it already had an audit', () => {
    const rows = buildRepoAuditRows(
      [audited('a/one', 78), neverAudited('a/two'), audited('a/three', 40)],
      ['a/one', 'a/two'],
    );

    // A repo whose PREVIOUS audit is on screen while a fresh one derives reads
    // as deriving: the number is about to change, and a row has one state.
    expect(rows.map((r) => r.state)).toEqual(['deriving', 'deriving', 'audited']);
    expect(rows[0]!.grade).toBeNull();
  });
});

describe('orderRepoAuditRows — worst first, then by state', () => {
  it('sorts ascending by conformance, so the worst repo opens the tab', () => {
    const rows = buildRepoAuditRows([
      audited('a/ai', 63),
      audited('a/core', 78),
      audited('a/gateway', 34),
    ]);

    expect(keys(orderRepoAuditRows(rows))).toEqual(['a/gateway', 'a/ai', 'a/core']);
  });

  it('ranks audited → deriving → not audited → unavailable', () => {
    const rows = buildRepoAuditRows(
      [unloadable('a/four'), neverAudited('a/three'), neverAudited('a/two'), audited('a/one', 90)],
      ['a/two'],
    );

    expect(keys(orderRepoAuditRows(rows))).toEqual(['a/one', 'a/two', 'a/three', 'a/four']);
  });

  it('falls back to CONNECTED order — and uses it wholly before any audit exists', () => {
    const connected = [neverAudited('a/one'), neverAudited('a/two'), neverAudited('a/three')];

    expect(keys(orderRepoAuditRows(buildRepoAuditRows(connected)))).toEqual([
      'a/one',
      'a/two',
      'a/three',
    ]);
  });

  it('puts an audit with NO conformance number after the graded ones', () => {
    // Both orders, because the comparator has to answer this symmetrically —
    // an ungraded audit sorting to the top in one direction only is the classic
    // way a "worst first" list quietly stops being worst-first.
    expect(
      keys(
        orderRepoAuditRows(buildRepoAuditRows([audited('a/one', undefined), audited('a/two', 99)])),
      ),
    ).toEqual(['a/two', 'a/one']);
    expect(
      keys(
        orderRepoAuditRows(buildRepoAuditRows([audited('a/two', 99), audited('a/one', undefined)])),
      ),
    ).toEqual(['a/two', 'a/one']);
  });

  it('does not mutate its input', () => {
    const rows = buildRepoAuditRows([audited('a/one', 90), audited('a/two', 10)]);
    const before = keys(rows);

    orderRepoAuditRows(rows);

    expect(keys(rows)).toEqual(before);
  });
});

describe('defaultSelectedRepoKey', () => {
  it('opens on the worst-conforming repo', () => {
    const rows = buildRepoAuditRows([audited('a/one', 90), audited('a/two', 10)]);

    expect(defaultSelectedRepoKey(rows)).toBe('a/two');
  });

  it('never DEFAULTS to a row whose read failed, while readable siblings exist', () => {
    const rows = buildRepoAuditRows([unloadable('a/broken'), audited('a/ok', 50)]);

    // Opening the tab on an error, with a readable report one click away, is the
    // thing worth avoiding — the row stays selectable by hand.
    expect(defaultSelectedRepoKey(rows)).toBe('a/ok');
  });

  it('is null when every row is unavailable, and when there are no repos', () => {
    expect(defaultSelectedRepoKey(buildRepoAuditRows([unloadable('a/one')]))).toBeNull();
    expect(defaultSelectedRepoKey([])).toBeNull();
  });
});

describe('rollupRepoAuditRows — counts TRUE BY ADDITION, never a mean', () => {
  it('counts what has LANDED, never what a run queued', () => {
    const rows = buildRepoAuditRows(
      [
        audited('a/one', 78, 212),
        audited('a/two', 94, 11),
        neverAudited('a/three'),
        neverAudited('a/four'),
        neverAudited('a/five'),
      ],
      ['a/three', 'a/four'],
    );

    // Panel 7b's E1 line: "2 of 5 audited · 223 findings across them · 2
    // deriving · 1 not audited yet".
    expect(rollupRepoAuditRows(rows)).toEqual({
      connected: 5,
      audited: 2,
      findings: 223,
      deriving: 2,
      notAudited: 1,
      unavailable: 0,
    });
  });

  it('counts an unavailable row as neither audited nor not-audited', () => {
    const rows = buildRepoAuditRows([audited('a/one', 50, 4), unloadable('a/two')]);

    const rollup = rollupRepoAuditRows(rows);
    expect(rollup).toMatchObject({ connected: 2, audited: 1, unavailable: 1, notAudited: 0 });
    // A failed read contributes NO findings — the total stays a fact about the
    // reports actually read.
    expect(rollup.findings).toBe(4);
  });

  it('publishes no project-level grade at all', () => {
    const rollup = rollupRepoAuditRows(
      buildRepoAuditRows([audited('a/one', 34), audited('a/two', 94)]),
    );

    // The design's load-bearing refusal (§2): a mean over codebases of different
    // sizes would report "64%" here and would MOVE when a repo is connected
    // rather than when any code changed.
    expect(rollup).not.toHaveProperty('grade');
    expect(rollup).not.toHaveProperty('conformancePct');
  });
});
