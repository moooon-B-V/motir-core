import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// MOTIR-5547 AC 6 — every key the plan-history section reads exists in BOTH
// catalogues. The keys are read out of the component's own source rather than
// listed here, so a key added to the component later is measured too.

const SOURCE = readFileSync(
  join(process.cwd(), 'app/(authed)/items/[key]/_components/PlanHistorySection.tsx'),
  'utf8',
);

/** The `planHistory*` keys the component passes to its `issueViews` translator. */
const USED = [
  ...new Set([...SOURCE.matchAll(/'(planHistory[A-Za-z]+)'/g)].map((m) => m[1]!)),
].sort();

/** The keys it REUSES from other namespaces (design-notes § Plan history 3). */
const REUSED: Array<[string, string]> = [
  ['planReview', 'untitledPlan'],
  ['aiPlanning', 'createdAt'],
  ['aiPlanning', 'approvedAt'],
  ['aiPlanning', 'approvedByName'],
  ['aiPlanning', 'declinedAt'],
  ['aiPlanning', 'declinedByName'],
  ['aiPlanning', 'viaHarness'],
  ['aiPlanning', 'viaMotir'],
  ['common', 'retry'],
];

type Catalog = Record<string, Record<string, unknown>>;

describe('the plan-history copy exists in en AND zh', () => {
  it('reads real keys out of the component (a guard on the guard)', () => {
    // The design's table names 24 new keys; the component uses every one.
    expect(USED).toHaveLength(24);
  });

  for (const [name, catalog] of [
    ['en', en],
    ['zh', zh],
  ] as const) {
    it(`${name}: every new issueViews.planHistory* key the component uses`, () => {
      const issueViews = (catalog as unknown as Catalog).issueViews!;
      const missing = USED.filter((key) => typeof issueViews[key] !== 'string');
      expect(missing).toEqual([]);
    });

    it(`${name}: every reused key, including every plan status label`, () => {
      const c = catalog as unknown as Catalog;
      const missing = REUSED.filter(([ns, key]) => typeof c[ns]?.[key] !== 'string').map(
        ([ns, key]) => `${ns}.${key}`,
      );
      const status = (c.aiPlanning?.status ?? {}) as Record<string, unknown>;
      for (const s of ['generating', 'planned', 'stale', 'approved', 'declined']) {
        if (typeof status[s] !== 'string') missing.push(`aiPlanning.status.${s}`);
      }
      expect(missing).toEqual([]);
    });
  }
});
