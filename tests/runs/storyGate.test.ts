import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';

// THE STORY GATE's contract guards (Story MOTIR-1789 · MOTIR-1798).
//
// These protect DECISIONS rather than behaviour, and each is a sentence somebody
// could reasonably delete in six months. A test is the only form of that
// sentence that argues back.
//
// ⚠️ WHAT IS **NOT** HERE, and where it lives instead — stated so the absence
// reads as a decision rather than a gap:
//
//   · the record owns no PR / CI / status / cost column → `dispatchRunSchemaBoundaries.test.ts`
//   · the closed enums are the ADR's vocabulary, exactly  → `dispatchRunSchemaBoundaries.test.ts`
//   · every enum has a total renderer                     → `tests/runs/runTimeline.test.ts`
//   · cross-tenant isolation, incl. the RLS backstop      → `tests/dispatch-run-rls.test.ts`
//   · the findings round trip through the real ingest     → `tests/dispatchRunFindings.test.ts`
//   · the reporter's own shape + the log opt-in           → `packages/cli/test/**` (its OWN runner)
//
// What is here is the set that had no home: the SINGLE-MAP rule, the composed
// canvas, the bounded surfaces, the producer's existence, and the version.

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** Every `.ts`/`.tsx` under a directory, recursively. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.tsx?$/.test(entry.name)) out.push(next);
    }
  };
  walk(dir);
  return out;
}

const APP_SOURCES = [...sourcesUnder('app'), ...sourcesUnder('components'), ...sourcesUnder('lib')];

describe('⚠️ ONE map per enum — a second private copy is the drift this catches', () => {
  // The item page's run section, the runs index and the modal's canvas pane all
  // render the same vocabulary. Each was one `const TONE_CLASS = {…}` away from
  // owning a private copy, and two of them HAD one before MOTIR-3895 extracted
  // the chip — which is exactly how the same word starts meaning two colours
  // depending which page a reader is on.
  const mapDefinitions = (needle: RegExp): string[] =>
    APP_SOURCES.filter((f) => needle.test(read(f)));

  it('`DISPOSITION_TONE` is defined exactly once, in `lib/runs/timeline.ts`', () => {
    expect(mapDefinitions(/const DISPOSITION_TONE\s*=/)).toEqual(['lib/runs/timeline.ts']);
  });

  it('`RUN_STATUS_TONE` is defined exactly once, in the same file', () => {
    expect(mapDefinitions(/const RUN_STATUS_TONE\s*=/)).toEqual(['lib/runs/timeline.ts']);
  });

  it('`SKIP_REASON_KEY` and `EVENT_STEP` are defined exactly once, in the same file', () => {
    expect(mapDefinitions(/const SKIP_REASON_KEY\s*=/)).toEqual(['lib/runs/timeline.ts']);
    expect(mapDefinitions(/const EVENT_STEP\s*=/)).toEqual(['lib/runs/timeline.ts']);
  });

  it('the tone → CLASS table is defined exactly once, in the shared chip', () => {
    // The vocabulary lives in `timeline.ts`; the RENDERING of it lives in one
    // component. Three copies of a ten-row class table is how one of them
    // quietly stops matching the design's tone table.
    expect(mapDefinitions(/satisfies Record<RunTone, string>/)).toEqual([
      'components/runs/RunTonePill.tsx',
    ]);
  });
});

describe('⚠️ the run canvas is COMPOSED, not re-implemented — bug MOTIR-3152', () => {
  // Casting a wire DTO to `ProjectCanvasNode` type-checks (the cast is from
  // `unknown`), renders, and produces nothing: the shapes share no field name,
  // so every node arrives with an undefined `content` that paints into a 0x0
  // box. *The card was not blank, it was INVISIBLE*, and no test went red.
  const pane = read('app/(authed)/runs/_components/RunCanvasPane.tsx');

  it('builds its level through the shipped adapter', () => {
    expect(pane).toContain("from '@/components/planning/workItemLevel'");
    expect(pane).toContain('buildWorkItemLevel');
  });

  it('contains no cast into the canvas view model', () => {
    expect(pane).not.toMatch(/as unknown as/);
    expect(pane).not.toMatch(/as ProjectCanvasNode/);
    expect(pane).not.toMatch(/as RoadmapLevel\b/);
  });

  it('mounts the shipped canvas rather than drawing a second one', () => {
    expect(pane).toContain('ProjectRoadmapCanvas');
    // A consumer that hand-rolled edges would need its own SVG.
    expect(pane).not.toMatch(/<svg/);
  });
});

describe('⚠️ the run surfaces are BOUNDED — a fan-out wears many names', () => {
  const index = read('app/(authed)/runs/_components/RunsIndex.tsx');
  const modal = read('app/(authed)/runs/_components/RunModal.tsx');
  const logPane = read('app/(authed)/runs/_components/RunLogPane.tsx');
  const findings = read('app/(authed)/runs/_components/RunFindings.tsx');

  it('the INDEX opens no stream and prefetches no per-row detail', () => {
    // This guard replaces the archived `/ready` strip's N+1 guard. A list that
    // opens a connection per row, or prefetches every row's detail, is the same
    // defect one interaction earlier.
    expect(index).not.toContain('/stream');
    expect(index).not.toMatch(/dispatch-runs\/\$\{/);
  });

  it('the MODAL holds exactly ONE stream, and its readers do not open their own', () => {
    // The log pane and the findings strip are two READERS of one stream. Each
    // owning a connection is the fan-out this whole guard is about — and it was
    // briefly true while MOTIR-3983 was being wired, which is why it is asserted
    // at the source rather than left to a component test.
    expect(modal).toContain('useRunEvents');
    expect(logPane).not.toContain('/stream');
    expect(findings).not.toContain('/stream');
    const streams = [...modal.matchAll(/useRunEvents\(/g)];
    expect(streams).toHaveLength(1);
  });

  it('the modal reads the run itself from exactly one place', () => {
    const reads = [...modal.matchAll(/fetch\(\s*`\/api\/dispatch-runs\//g)];
    expect(reads).toHaveLength(1);
  });
});

describe('⚠️ the log stream has a PRODUCER — the guard that would have caught the gap', () => {
  // The whole mechanism shipped once with a flag, a scrubber, a retention job
  // and a line of help text — and NO CALLER anywhere in `packages/cli/src`.
  // Every unit around it stayed green, because a green test proves a method
  // works when called and never that anything calls it.
  const cliSources = sourcesUnder('packages/cli/src');

  it("a production call site emits `kind: 'log'`", () => {
    const emitters = cliSources.filter((f) => /kind:\s*'log'/.test(read(f)));
    expect(emitters.length).toBeGreaterThan(0);
  });

  it('the emitter is gated on the opt-in, not unconditional', () => {
    const tee = read('packages/cli/src/agentLogTee.ts');
    // `createLegLogTee` returns null when the reporter does not want bodies —
    // the privacy promise, at the one place a body could start existing.
    expect(tee).toContain('wantsLogBodies');
    expect(tee).toMatch(/if\s*\(!reporter\.wantsLogBodies\)\s*return null/);
  });
});

describe('the /api/v1 contract version moved for this story', () => {
  it('is ahead of the value on the merge base', () => {
    // The story added three ingest operations, which is an additive contract
    // change under ADR §8 — so the number a client reads off
    // `X-Motir-Api-Version` has to say so.
    const base = execFileSync('git', ['show', 'origin/main:lib/api/v1/contractVersion.ts'], {
      encoding: 'utf8',
    });
    const onMain = /V1_CONTRACT_VERSION = '([^']+)'/.exec(base)?.[1];
    expect(onMain).toBeTruthy();

    const parse = (v: string): number[] => v.split('.').map(Number);
    const [aMaj, aMin, aPat] = parse(V1_CONTRACT_VERSION);
    const [bMaj, bMin, bPat] = parse(onMain!);
    const ahead =
      aMaj! > bMaj! ||
      (aMaj === bMaj && aMin! > bMin!) ||
      (aMaj === bMaj && aMin === bMin && aPat! > bPat!);
    expect(ahead).toBe(true);
  });

  it('the three ingest operations are in the emitted document', () => {
    const ops = read('lib/api/v1/workLoop/operations.ts');
    expect(ops).toContain("path: '/api/v1/dispatch-runs'");
    expect(ops).toContain("path: '/api/v1/dispatch-runs/{id}/events'");
    expect(ops).toContain("path: '/api/v1/dispatch-runs/{id}/close'");
  });

  it('⚠️ the ingest still REFUSES the two server-written kinds', () => {
    // MOTIR-3981: `bug_filed` / `plan_submitted` carry ids that exist only
    // server-side, so accepting them here would let a client with a run token
    // assert a finding the run never produced.
    const schema = read('lib/api/v1/workLoop/schema.ts');
    const enumBlock = /export const dispatchEventKindSchema = z\.enum\(\[([\s\S]*?)\]\);/.exec(
      schema,
    )?.[1];
    expect(enumBlock).toBeTruthy();
    expect(enumBlock).not.toContain('bug_filed');
    expect(enumBlock).not.toContain('plan_submitted');
  });
});
