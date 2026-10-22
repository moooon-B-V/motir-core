// THE AGENT MIX, SERVED (MOTIR-9152 · Story MOTIR-8538).
//
// One row per class of the load the profile offers — the MCP groups read, write,
// claim and burst, the run lifecycle, and the readers — with the VUs the profile
// offered it beside what the steady window served it. The reader row splits into
// tab and browse when k6's `scenario` tag names them. It is the check a reader makes
// before trusting any threshold line: did the served mix match the offered one, and
// did one class starve while another was fine?
//
// Served is `ok` + `empty`, as the throughput line counts it; the held stream and
// the run recycle step are in no class (k6Points.ts `mixClassesOf`), so the
// top-level rows sum to the report's served rps. A class with no points reads
// `unmeasured` in every measured column, never 0.

import type { Vus } from '../profiles/resolve';
import { percentile, type MixCell, type PointsAggregate } from './k6Points';
import { OUTCOME_BUCKETS, THROUGHPUT_BUCKETS, type Bucket } from './thresholds';

export const MIX_UNMEASURED = 'unmeasured' as const;
type M<T> = T | typeof MIX_UNMEASURED;

export interface MixRow {
  /** The class key: an MCP group, `run`, `readers`, or `readers.tab` / `readers.browse`. */
  class: string;
  label: string;
  /** The row this one splits, for a reader sub-class; null for a top-level class. */
  of: string | null;
  offeredVus: M<number>;
  servedRps: M<number>;
  /** Of the total served rps. */
  share: M<number>;
  ok: M<number>;
  empty: M<number>;
  error: M<number>;
  limited: M<number>;
  p95Ms: M<number>;
  p99Ms: M<number>;
}

export interface MixTable {
  rows: MixRow[];
  total: { offeredVus: M<number>; servedRps: number };
  note: string;
}

export const MIX_NOTE =
  'Served is ok + empty over the steady window, as the throughput line counts it; the held workbench stream and the run recycle step are in no class, so the top-level rows sum to the served rps. readers · tab and readers · browse split the readers row by k6’s scenario tag.';

interface ClassSpec {
  key: string;
  label: string;
  of: string | null;
  vus: (v: Vus) => number;
}

const TOP: readonly ClassSpec[] = [
  { key: 'read', label: 'read', of: null, vus: (v) => v.read },
  { key: 'write', label: 'write', of: null, vus: (v) => v.write },
  { key: 'claim', label: 'claim', of: null, vus: (v) => v.claim },
  { key: 'burst', label: 'burst', of: null, vus: (v) => v.burst },
  { key: 'run', label: 'run', of: null, vus: (v) => v.run },
  { key: 'readers', label: 'readers', of: null, vus: (v) => v.readers },
];
const READER_SPLIT: readonly ClassSpec[] = [
  { key: 'readers.tab', label: 'readers · tab', of: 'readers', vus: (v) => v.tab },
  { key: 'readers.browse', label: 'readers · browse', of: 'readers', vus: (v) => v.browse },
];

const servedOf = (cell: MixCell) =>
  Object.entries(cell.outcomes)
    .filter(([o]) =>
      THROUGHPUT_BUCKETS.includes((OUTCOME_BUCKETS as Record<string, Bucket>)[o] as Bucket),
    )
    .reduce((a, [, n]) => a + n, 0);

/** The served agent mix over the steady window; `vus` null when profile.resolved.json is unreadable. */
export function mixTable(agg: PointsAggregate, vus: Vus | null): MixTable {
  const known = new Set([...TOP, ...READER_SPLIT].map((c) => c.key));
  // An MCP group the profile does not name still counts, so the rows keep summing.
  const extra: ClassSpec[] = [...agg.mix.keys()]
    .filter((k) => !known.has(k))
    .sort()
    .map((k) => ({ key: k, label: k, of: null, vus: () => Number.NaN }));
  const split = READER_SPLIT.some((c) => agg.mix.has(c.key)) ? READER_SPLIT : [];
  const specs = [...TOP, ...extra, ...split];

  const perSecond = (n: number) => (agg.steadySeconds > 0 ? n / agg.steadySeconds : 0);
  const totalServed = TOP.concat(extra).reduce((a, c) => {
    const cell = agg.mix.get(c.key);
    return a + (cell ? perSecond(servedOf(cell)) : 0);
  }, 0);

  const rows = specs.map((c): MixRow => {
    const offered = vus ? c.vus(vus) : Number.NaN;
    const offeredVus = Number.isFinite(offered) ? offered : MIX_UNMEASURED;
    const cell = agg.mix.get(c.key);
    if (!cell)
      return {
        class: c.key,
        label: c.label,
        of: c.of,
        offeredVus,
        servedRps: MIX_UNMEASURED,
        share: MIX_UNMEASURED,
        ok: MIX_UNMEASURED,
        empty: MIX_UNMEASURED,
        error: MIX_UNMEASURED,
        limited: MIX_UNMEASURED,
        p95Ms: MIX_UNMEASURED,
        p99Ms: MIX_UNMEASURED,
      };
    const servedRps = perSecond(servedOf(cell));
    const pct = (q: number) => percentile(cell.samples, q) ?? MIX_UNMEASURED;
    return {
      class: c.key,
      label: c.label,
      of: c.of,
      offeredVus,
      servedRps,
      share: totalServed > 0 ? servedRps / totalServed : MIX_UNMEASURED,
      ok: cell.outcomes['ok'] ?? 0,
      empty: cell.outcomes['empty'] ?? 0,
      error: cell.outcomes['error'] ?? 0,
      limited: cell.outcomes['limited'] ?? 0,
      p95Ms: pct(0.95),
      p99Ms: pct(0.99),
    };
  });

  const offeredTotal = rows
    .filter((r) => r.of === null)
    .reduce<
      M<number>
    >((a, r) => (a === MIX_UNMEASURED || r.offeredVus === MIX_UNMEASURED ? a : a + r.offeredVus), vus ? 0 : MIX_UNMEASURED);
  return { rows, total: { offeredVus: offeredTotal, servedRps: totalServed }, note: MIX_NOTE };
}
