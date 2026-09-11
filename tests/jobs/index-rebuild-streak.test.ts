import { beforeEach, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import {
  indexRebuildStreakService,
  INDEX_REBUILD_STREAK_THRESHOLD,
} from '@/lib/services/indexRebuildStreakService';
import { INDEX_REBUILD_STREAK_BLIND_SPOT } from '@/lib/dto/indexRebuildStreak';

// THE REBUILD-STREAK PROBE (MOTIR-5027) — the reader that turns a fact the
// ledger has recorded since MOTIR-4945 into a signal somebody sees.
//
// Every fixture here writes REAL `job_run` rows with `workspace_id IS NULL`,
// because that is what `system.*` jobs write and the read is only correct under
// `withSystemContext`. Seeding tenanted rows would pass against a read that
// forgot the system context — the exact defect that makes 1031 real rows come
// back as zero — so the fixture is faithful on purpose.

let clock = 0;

/** One succeeded code-graph run. Rows are seeded oldest-first; `startedAt`
 *  strictly increases so `order by started_at desc` is deterministic. */
async function seedRun(opts: {
  repoRef?: string;
  modes?: Array<'sync' | 'rebuild'> | null;
  status?: 'succeeded' | 'failed';
  functionId?: 'system.code-graph-refresh' | 'system.code-graph-index';
  indexed?: boolean;
}) {
  clock += 1;
  const { repoRef = 'moooon-B-V/motir-core', modes = ['rebuild'], status = 'succeeded' } = opts;
  await adminDb.jobRun.create({
    data: {
      workspaceId: null,
      functionId: opts.functionId ?? 'system.code-graph-refresh',
      eventName: `scheduled.${opts.functionId ?? 'system.code-graph-refresh'}`,
      eventId: `evt-streak-${clock}`,
      lane: 'engine',
      attempt: 1,
      status,
      startedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, clock)),
      output:
        opts.indexed === false
          ? { indexed: false, reason: 'no_projects' }
          : {
              indexed: true,
              repoRef,
              projectsIndexed: 1,
              ...(modes
                ? { indexModes: modes.map((mode, i) => ({ projectId: `p${i}`, mode })) }
                : {}),
            },
    },
  });
}

beforeEach(async () => {
  await truncateJobRuns();
  clock = 0;
});

describe('the rebuild-streak probe', () => {
  it('is NOT_APPLICABLE when nothing has ever indexed — an unindexed deployment is not unhealthy', async () => {
    const verdict = await indexRebuildStreakService.check();
    expect(verdict.verdict).toBe('not_applicable');
    // Even here the boundary travels, so no arm of this check can be read as a
    // guarantee it cannot make.
    expect(verdict.blindSpot).toBe(INDEX_REBUILD_STREAK_BLIND_SPOT);
  });

  it('counts the streak PER repoRef, back from the newest run, and stops at a sync', async () => {
    // motir-core: two rebuilds, then a sync, then two more rebuilds (newest).
    // The streak is 2 — the sync BELOW them is where counting stops.
    await seedRun({ modes: ['rebuild'] });
    await seedRun({ modes: ['rebuild'] });
    await seedRun({ modes: ['sync'] });
    await seedRun({ modes: ['rebuild'] });
    await seedRun({ modes: ['rebuild'] });
    // A different repository, entirely healthy, in the same ledger.
    await seedRun({ repoRef: 'moooon-B-V/motir-ai', modes: ['sync'] });

    const verdict = await indexRebuildStreakService.check();
    if (verdict.verdict === 'not_applicable') throw new Error('expected a reading');

    const core = verdict.entries.find((e) => e.repoRef === 'moooon-B-V/motir-core');
    const ai = verdict.entries.find((e) => e.repoRef === 'moooon-B-V/motir-ai');
    expect(core).toMatchObject({ consecutiveRebuilds: 2, modeRuns: 5, state: 'syncing' });
    expect(ai).toMatchObject({ consecutiveRebuilds: 0, modeRuns: 1, state: 'syncing' });
  });

  it('reads BOTH function ids — a refresh streak is not broken by an index run', async () => {
    // Both write `indexModes` through the same `finishIndexRun`. A reader over
    // only one of them would compute a streak the other silently interrupts.
    await seedRun({ functionId: 'system.code-graph-index', modes: ['rebuild'] });
    await seedRun({ functionId: 'system.code-graph-refresh', modes: ['rebuild'] });

    const verdict = await indexRebuildStreakService.check();
    if (verdict.verdict === 'not_applicable') throw new Error('expected a reading');
    expect(verdict.entries[0]).toMatchObject({ consecutiveRebuilds: 2, modeRuns: 2 });
  });

  it('EXCLUDES a failed run and a mode-less run from the streak rather than letting either BREAK it', async () => {
    // ⚠️ The one decision that silently changes the number. A failed run records
    // no mode, and a row written before MOTIR-4945 carries none either; if
    // either ended the streak, a repository that has rebuilt continuously would
    // report as recovering because an unreadable row happened to sit between two
    // rebuilds. Both are skipped, so the streak reads through them.
    await seedRun({ modes: ['rebuild'] });
    await seedRun({ modes: ['rebuild'] });
    await seedRun({ modes: null }); // a pre-MOTIR-4945 row
    await seedRun({ status: 'failed', modes: null }); // a failure
    await seedRun({ indexed: false }); // a succeeded run that indexed nothing
    await seedRun({ modes: ['rebuild'] });

    const verdict = await indexRebuildStreakService.check();
    if (verdict.verdict === 'not_applicable') throw new Error('expected a reading');
    // Three rebuilds read THROUGH the two unreadable rows; the failed run and
    // the indexed:false run are not part of the population at all.
    expect(verdict.entries[0]).toMatchObject({
      consecutiveRebuilds: 3,
      modeRuns: 3,
      succeededRuns: 4,
    });
  });

  it('counts a multi-project run as a rebuild ONLY when every entry is one', async () => {
    // A run that synced any project did not rebuild from scratch. Treating a
    // mixed run as a rebuild would grow the streak through the very recovery
    // this probe is watching for.
    await seedRun({ modes: ['rebuild', 'rebuild'] });
    await seedRun({ modes: ['rebuild', 'sync'] });

    const verdict = await indexRebuildStreakService.check();
    if (verdict.verdict === 'not_applicable') throw new Error('expected a reading');
    expect(verdict.entries[0]).toMatchObject({ consecutiveRebuilds: 0 });
  });

  it('PINS the calibrated threshold at 5 — MOTIR-5059, and the number is not free to drift', async () => {
    // ⚠️ The boundary case below drives the constant, so it passes for ANY
    // value and pins none. That was right while the number was openly chosen;
    // it is not right now that it rests on a reading (the 2026-09-11 reading in
    // `indexRebuildStreakService.ts`, whose separation is: largest observed
    // LEGITIMATE rebuild episode 1, smallest observed DEFECT episode 4).
    // Changing 5 should be a diff that edits this line and the reasoning beside
    // the constant together, not a one-character edit nothing notices.
    expect(INDEX_REBUILD_STREAK_THRESHOLD).toBe(5);

    // And the boundary asserted against the LITERAL, so the claim "a repository
    // at 5 is loud and one at 4 is not" is checked independently of the symbol.
    for (let i = 0; i < 4; i += 1) await seedRun({ modes: ['rebuild'] });
    expect((await indexRebuildStreakService.check()).verdict).toBe('ok');

    await seedRun({ modes: ['rebuild'] });
    const at5 = await indexRebuildStreakService.check();
    expect(at5.verdict).toBe('rebuilding');
    if (at5.verdict !== 'rebuilding') throw new Error('unreachable');
    expect(at5.offenders[0]).toMatchObject({ consecutiveRebuilds: 5, state: 'rebuilding' });
    expect(at5.threshold).toBe(5);
  });

  it(`is LOUD at ${INDEX_REBUILD_STREAK_THRESHOLD} consecutive rebuilds and SILENT at one fewer`, async () => {
    // AC 3 — the boundary itself, asserted from both sides so the threshold is
    // a tested value rather than a bare number.
    for (let i = 0; i < INDEX_REBUILD_STREAK_THRESHOLD - 1; i += 1) {
      await seedRun({ modes: ['rebuild'] });
    }
    const under = await indexRebuildStreakService.check();
    expect(under.verdict).toBe('ok');

    await seedRun({ modes: ['rebuild'] });
    const at = await indexRebuildStreakService.check();
    expect(at.verdict).toBe('rebuilding');
    if (at.verdict !== 'rebuilding') throw new Error('unreachable');
    expect(at.offenders).toHaveLength(1);
    expect(at.offenders[0]).toMatchObject({
      repoRef: 'moooon-B-V/motir-core',
      consecutiveRebuilds: INDEX_REBUILD_STREAK_THRESHOLD,
      state: 'rebuilding',
    });
    // AC 5 — the fork, on the verdict itself.
    expect(at.candidates).toHaveLength(2);
    expect(at.candidates.join(' ')).toMatch(/MOTIR_INDEXER_IMAGE/);
    expect(at.candidates.join(' ')).toMatch(/codegraphVersion/);
  });

  it('reports a repository whose runs recorded NO mode as UNKNOWN, never as healthy', async () => {
    // AC 4's mirror, and the state that dominates the real ledger: 844 of 899
    // succeeded runs carried no mode on the day this shipped. An absent reading
    // must be visible on the wire, not folded into a pass.
    await seedRun({ repoRef: 'moooon-B-V/motir-meta', modes: null });
    await seedRun({ repoRef: 'moooon-B-V/motir-meta', modes: null });
    await seedRun({ repoRef: 'moooon-B-V/motir-ai', modes: ['sync'] });

    const verdict = await indexRebuildStreakService.check();
    if (verdict.verdict !== 'ok') throw new Error('expected ok');

    const meta = verdict.entries.find((e) => e.repoRef === 'moooon-B-V/motir-meta');
    expect(meta).toMatchObject({ state: 'unknown', modeRuns: 0, succeededRuns: 2 });
    // Named in its own field, so a consumer reading the verdict cannot miss it.
    expect(verdict.unknownRepoRefs).toEqual(['moooon-B-V/motir-meta']);
    // And the repository that really is syncing is NOT in that list.
    expect(verdict.entries.find((e) => e.repoRef === 'moooon-B-V/motir-ai')?.state).toBe('syncing');
  });

  it('carries the coverage boundary on EVERY arm — a green verdict may not read as a guarantee', async () => {
    // AC 6. Asserted on the arms a reader is most likely to take as an
    // all-clear, because that is where an implied guarantee does the damage.
    await seedRun({ modes: ['sync'] });
    const ok = await indexRebuildStreakService.check();
    expect(ok.blindSpot).toContain('OFFERED');
    expect(ok.blindSpot).toContain('MOTIR-5058');

    for (let i = 0; i < INDEX_REBUILD_STREAK_THRESHOLD; i += 1) {
      await seedRun({ repoRef: 'moooon-B-V/motir-gateway', modes: ['rebuild'] });
    }
    const loud = await indexRebuildStreakService.check();
    expect(loud.blindSpot).toBe(INDEX_REBUILD_STREAK_BLIND_SPOT);
  });
});
