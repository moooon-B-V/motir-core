import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { type CatchUpPolicy } from '@/lib/jobs/catchUp';
import { jobSchedules } from '@/lib/jobs/schedules';
import { engineScheduledJobs } from '@/lib/jobs/engine/registry';
import '@/lib/jobs/registry';

// MOTIR-4408 — SPLIT OUT of `tests/jobs/engine-units.test.ts`, whose
// `describe('the catch-up disposition is DECLARED and cannot be omitted
// (MOTIR-3470)')` block this test was the third member of.
//
// ── Why it moved, and why only this one ─────────────────────────────────────
// This is the one assertion in that file whose SUBJECT is a `docs/**` file:
// it reads `docs/decisions/job-queue-foundation.md` §11.4 off disk and holds
// the registry against it. So it belongs in the docs-guard lane
// (`vitest.docs.config.ts`), which runs unconditionally — including on the
// documentation-only pull request that is the only kind able to break it by
// editing the §11.4 table.
//
// `engine-units.test.ts` cannot go there. It imports `@/lib/db`,
// `../helpers/adminDb` and the truncation helpers, and its file-scoped
// `beforeEach` / `afterEach` / `afterAll` open a database on every test in the
// file — so putting it in a lane with no Postgres would wedge the lane. Its two
// SIBLING assertions in that block stay behind: neither reads the record. One
// is a `@ts-expect-error` compile-level check and the other walks the registry
// alone, so a `docs/**` diff cannot falsify either.
//
// The block's own header applies unchanged and is worth restating where the
// assertion now lives: the three assertions are deliberately different KINDS —
// one holds at compile time, one walks the real registry, and one (this file)
// reads the record itself — so neither the code nor the document can move
// alone.

describe('the catch-up disposition matches the record (MOTIR-3470)', () => {
  it('each disposition MATCHES the amendment — the code and the record cannot drift', () => {
    // The value on each job is taken from `docs/decisions/job-queue-foundation.md`
    // §11.4, so this reads that table back rather than restating it. Both
    // directions are checked: a job in the registry and absent from the table is
    // the defect the amendment says it exists to prevent, and a row in the table
    // naming a job that no longer exists is the same defect inverted.
    const adr = readFileSync('docs/decisions/job-queue-foundation.md', 'utf8');
    const section = adr.slice(adr.indexOf('### §11.4'), adr.indexOf('### §11.5'));
    expect(section.length).toBeGreaterThan(0);

    const tabled = new Map<string, { cron: string; catchUp: CatchUpPolicy }>();
    for (const line of section.split('\n')) {
      const m =
        /^\|\s*`(system\.[a-z0-9.-]+)`\s*\|\s*`([^`]+)`\s*\|\s*\*{0,2}`?([a-z]+)`?\*{0,2}\s*\|/.exec(
          line,
        );
      if (m) tabled.set(m[1]!, { cron: m[2]!, catchUp: m[3] as CatchUpPolicy });
    }

    const registry = new Map(engineScheduledJobs().map((d) => [d.id, d]));
    expect([...tabled.keys()].sort()).toEqual([...registry.keys()].sort());
    for (const [id, def] of registry) {
      expect(def.catchUp, `${id}'s disposition matches §11.4`).toBe(tabled.get(id)?.catchUp);
      // The CRON too — §11.9 promises no schedule changes, and a table quoting a
      // stale expression would make that promise unverifiable from the record.
      expect(def.cron, `${id}'s cron matches §11.4`).toBe(tabled.get(id)?.cron);
    }

    // The schedule table `jobScheduleHealthService` reads is the same population,
    // so the two registries cannot disagree about which jobs are scheduled.
    expect(
      jobSchedules()
        .map((s) => s.functionId)
        .sort(),
    ).toEqual([...registry.keys()].sort());
  });
});
