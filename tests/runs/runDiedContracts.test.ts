import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCron } from '@/lib/jobs/cron';
import { SUB_HOURLY_CADENCE } from '@/lib/jobs/schedules';
import { RUN_HEARTBEAT_LAPSE_MS } from '@/lib/runs/runLiveness';
import { RUN_LIVENESS_SWEEP_CRON, runLivenessSweep } from '@/lib/jobs/definitions/runLivenessSweep';

// THE STORY'S CONTRACT GUARDS (Story MOTIR-6526 · MOTIR-6537) — three promises that
// coverage cannot see, because breaking any of them leaves every line covered and
// every test green:
//
//   1. NO CODE PATH IN THIS STORY WRITES A WORK ITEM'S STATUS. A run dying is a
//      fact about the RUN; the card stays where it was (`run-death-keeps-work.md`
//      §1), and the continue claim re-assigns without moving it.
//   2. `isRunAlive` IS THE ONLY LIVENESS PREDICATE. The marker, the claim and the
//      sweep must agree on the same instant; a second `lastHeartbeatAt` comparison
//      is how they come to disagree.
//   3. `system.run-liveness-sweep` RUNS EVERY 5 MINUTES, so a silent run's ROW
//      reads `abandoned` at most 10 minutes after its last heartbeat (MOTIR-6932;
//      it was 35 while the sweep sat on the retired :00/:30 cluster).
//
// Each detector is a pure function of source text, and each is shown FAILING once
// against a deliberate violation, so a green here is not the green of a scanner
// that matches nothing.

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// ── 1 · no status write ────────────────────────────────────────────────────────

/** The files this story ADDED on the server whose job touches a run's card. */
const NO_STATUS_WRITE_FILES = [
  'lib/services/workItemContinueService.ts',
  'lib/services/dispatchRunSweepService.ts',
  'lib/jobs/definitions/runLivenessSweep.ts',
  'lib/runs/runLiveness.ts',
  'app/api/v1/work-items/[key]/continue/route.ts',
  'app/api/v1/dispatch-runs/[id]/heartbeat/route.ts',
];

/** Every way a server file could move a work item's status, found in `src`. */
export function statusWrites(src: string): string[] {
  const found: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\.updateStatus\s*\(/g, 'calls updateStatus'],
    [/\btransitionStatus\b/g, 'names transitionStatus'],
    [/\bworkflowTransition\w*/g, 'names a workflow transition'],
    [/from\s+'@\/lib\/services\/workItemStatus\w*'/g, 'imports a status service'],
    [/workItemRepository\.update\w*\([^;]*?\bstatus\s*:/g, 'writes `status` on a work item'],
  ];
  for (const [re, what] of patterns) if (re.test(src)) found.push(what);
  return found;
}

describe('1 · no code path in this story writes a work item’s status', () => {
  it.each(NO_STATUS_WRITE_FILES)('%s', (path) => {
    expect(statusWrites(read(path))).toEqual([]);
  });

  it('the detector FAILS on a deliberate violation', () => {
    expect(
      statusWrites(
        "await workItemRepository.update(item.id, { assigneeId: me, status: 'todo' }, tx);",
      ),
    ).toEqual(['writes `status` on a work item']);
    expect(statusWrites('await workItemsService.updateStatus(id, "todo", ctx);')).toEqual([
      'calls updateStatus',
    ]);
    // …and passes the re-assignment the claim actually does.
    expect(
      statusWrites('await workItemRepository.update(id, { assigneeId: ctx.userId }, tx);'),
    ).toEqual([]);
  });
});

// ── 2 · one liveness predicate ─────────────────────────────────────────────────

const LIVENESS_HOME = 'lib/runs/runLiveness.ts';
const SCANNED_ROOTS = ['lib', 'app', 'components', 'packages/cli/src'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === 'generated') continue;
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Each place `src` decides liveness for itself instead of asking `runLiveness`. */
export function livenessComparisons(src: string): string[] {
  const found: string[] = [];
  src.split('\n').forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (/\bRUN_(HEARTBEAT_LAPSE|LEGACY_ALIVE)_MS\b/.test(line)) {
      found.push(`${at}: reads the lapse window`);
    } else if (
      /lastHeartbeatAt/.test(line) &&
      /(getTime\(\)|valueOf\(\)|Date\.parse|\s[<>]=?\s|\s-\s)/.test(line)
    ) {
      found.push(`${at}: compares lastHeartbeatAt`);
    }
  });
  return found;
}

describe('2 · `isRunAlive` is the only liveness predicate', () => {
  it('no source file outside runLiveness.ts compares a heartbeat or reads the window', () => {
    const offenders = SCANNED_ROOTS.flatMap(sourceFiles)
      .filter((path) => relative(ROOT, join(ROOT, path)) !== LIVENESS_HOME)
      .flatMap((path) => livenessComparisons(read(path)).map((hit) => `${path} ${hit}`));
    expect(offenders).toEqual([]);
  });

  it('the scan reaches the files that ask the question', () => {
    const scanned = new Set(SCANNED_ROOTS.flatMap(sourceFiles));
    for (const path of [
      'lib/services/workItemContinueService.ts',
      'lib/services/dispatchRunSweepService.ts',
      'app/(authed)/items/[key]/_components/RunSection.tsx',
    ]) {
      expect(scanned.has(path), path).toBe(true);
      expect(read(path)).toMatch(/from '@\/lib\/runs\/runLiveness'/);
    }
  });

  it('the detector FAILS on a deliberate violation', () => {
    expect(
      livenessComparisons('const dead = Date.now() - run.lastHeartbeatAt.getTime() > 300_000;'),
    ).toEqual(['line 1: compares lastHeartbeatAt']);
    expect(
      livenessComparisons('const cutoff = new Date(now.getTime() - RUN_HEARTBEAT_LAPSE_MS);'),
    ).toEqual(['line 1: reads the lapse window']);
    // A field copied through, or a parametrised query cutoff, is not a decision.
    expect(
      livenessComparisons(
        'lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,\n' +
          'where: { lastHeartbeatAt: { lt: heartbeatBefore } },',
      ),
    ).toEqual([]);
  });
});

// ── 3 · the sweep runs every 5 minutes ─────────────────────────────────────────

/**
 * The longest wait, in minutes, from any instant to `cron`'s next fire within the
 * hour — the gap between consecutive minutes it fires on, read cyclically.
 */
export function longestTickGapMinutes(cron: string): number {
  const minutes = [...parseCron(cron).minute].sort((a, b) => a - b);
  return Math.max(
    ...minutes.map((m, i) =>
      i === minutes.length - 1 ? minutes[0]! + 60 - m : minutes[i + 1]! - m,
    ),
  );
}

/** Worst case before a silent run's ROW says `abandoned`: the lapse + the tick gap. */
export function worstCaseAbandonedMinutes(cron: string): number {
  return RUN_HEARTBEAT_LAPSE_MS / 60_000 + longestTickGapMinutes(cron);
}

describe('3 · `system.run-liveness-sweep` runs every 5 minutes', () => {
  it('its cron is the sub-hourly cadence, so the worst case is 5 min lapse + 5 min tick', () => {
    expect(runLivenessSweep.id).toBe('system.run-liveness-sweep');
    expect(RUN_LIVENESS_SWEEP_CRON).toBe(SUB_HOURLY_CADENCE);
    expect(RUN_HEARTBEAT_LAPSE_MS).toBe(5 * 60_000);
    expect(longestTickGapMinutes(RUN_LIVENESS_SWEEP_CRON)).toBe(5);
    expect(worstCaseAbandonedMinutes(RUN_LIVENESS_SWEEP_CRON)).toBe(10);
  });

  it('the detector FAILS on a deliberate violation', () => {
    // The retired cluster cadence: 5 min lapse + up to 30 min to the next tick.
    expect(worstCaseAbandonedMinutes('0,30 * * * *')).toBe(35);
    expect(longestTickGapMinutes('7,37 * * * *')).toBe(30);
  });
});
