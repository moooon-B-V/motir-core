import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRAME_DISPOSITIONS, isKnownFrameKind } from '@/lib/planning/planChangeFrames';

// PARITY WITH motir-ai (MOTIR-8158). An unlisted frame kind used to be drawn raw
// on the rail as `frame: <name>`; it now draws nothing, which would make a NEW
// kind invisible without a trace. This test is what catches it instead: every
// kind motir-ai can emit must have a disposition here.
//
// The kinds come from a CHECKED-IN copy (`tests/fixtures/plan-change/
// motir-ai-frame-kinds.json`, its header says how to refresh it). When a motir-ai
// checkout sits beside this one (or `MOTIR_AI_CHECKOUT` names one) the second
// test also sweeps it live, so drift is caught before the copy is refreshed.

const KINDS_FILE = path.resolve(__dirname, '../fixtures/plan-change/motir-ai-frame-kinds.json');
const emitted = JSON.parse(readFileSync(KINDS_FILE, 'utf8')) as { kinds: string[] };

describe('every frame kind motir-ai emits has a disposition in core', () => {
  it('the checked-in list of emitted kinds is all accounted for', () => {
    const unlisted = emitted.kinds.filter((kind) => !isKnownFrameKind(kind));
    expect(unlisted, 'add these to PLAN_CHANGE_FRAME_KINDS and give each a disposition').toEqual(
      [],
    );
  });

  it('the lookup frames are quiet', () => {
    for (const kind of ['retrieval', 'search', 'drill', 'tool_call', 'tool_call_failed']) {
      expect(FRAME_DISPOSITIONS[kind as keyof typeof FRAME_DISPOSITIONS], kind).toHaveProperty(
        'quiet',
      );
    }
  });

  it('the five kinds the live rail used to draw raw are quiet, each with a reason', () => {
    for (const kind of [
      'model_stop',
      'session_summary',
      'gap',
      'planning_record_not_filed',
      'planning_failure_filed',
    ]) {
      const disposition = FRAME_DISPOSITIONS[kind as keyof typeof FRAME_DISPOSITIONS];
      expect(disposition, kind).toHaveProperty('quiet');
      expect((disposition as { quiet: string }).quiet.length, kind).toBeGreaterThan(10);
    }
  });

  const checkout = process.env.MOTIR_AI_CHECKOUT ?? path.resolve(process.cwd(), '..', 'motir-ai');
  const live = existsSync(path.join(checkout, 'src')) ? it : it.skip;
  live('a live sweep of the motir-ai checkout finds no kind core has not listed', () => {
    const out = execFileSync(
      'git',
      [
        '-C',
        checkout,
        'grep',
        '-ohE',
        "(emit|signal|safeEmit)\\??\\.?\\(\\s*'[a-z_]+'|event: '[a-z_]+'",
        '--',
        'src',
      ],
      { encoding: 'utf8' },
    );
    const swept = new Set((out.match(/'[a-z_]+'/g) ?? []).map((quoted) => quoted.slice(1, -1)));
    expect([...swept].filter((kind) => !isKnownFrameKind(kind)).sort()).toEqual([]);
  });
});

// The fixture is read as JSON; make a stray edit that empties it loud.
describe('the checked-in list', () => {
  it('is non-empty, sorted and duplicate-free', () => {
    const raw = emitted;
    expect(raw.kinds.length).toBeGreaterThan(40);
    expect(raw.kinds).toEqual([...new Set(raw.kinds)].sort());
  });
});
