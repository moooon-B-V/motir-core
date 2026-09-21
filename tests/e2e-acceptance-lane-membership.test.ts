import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLaneMembers, judgeLane, parseDeclaredStory } from './helpers/acceptanceLaneGuard';

// THE LANE-MEMBERSHIP GUARD (Story MOTIR-2765 · Subtask MOTIR-2770).
//
// ⚠️ RE-KEYED BY MOTIR-5872, AND ITS PRODUCT READ RETIRED BY MOTIR-5874. The
// check used to ask the product whether a story's receipt was `approved` and
// evict the spec when it was. That tied a TEST's lane to whether a RECORD had
// been signed: MOTIR-5799's receipt was approved while its pull request sat in
// the merge queue, the queue ejected it, the story came back to be reworked —
// and this guard, which runs in the MAIN suite, turned every pull request in the
// repository red demanding the spec of a still-live feature leave the lane. A
// spec's lane is a PLACEMENT, decided once when the spec is written
// (`docs/decisions/acceptance-receipt-lifecycle.md` AMENDMENT 1). What the check
// keeps is the half that is true of the FILE: a spec declaring no story can
// never publish a receipt. The status read, its credential and its binding
// declaration had no reader left, so they are gone rather than kept as tests of
// a read nothing makes.
//
// The guard's functions are in `tests/helpers/acceptanceLaneGuard.ts`.

describe('every spec in the acceptance lane declares its story (MOTIR-2770, re-keyed by MOTIR-5872)', () => {
  // ⚠️ NO NETWORK, NO CREDENTIAL, AND THAT IS THE FIX. The retired half asked the
  // product which receipts were approved and failed the run on each one; a
  // receipt's status says nothing about where its TEST belongs. What is checked
  // here is a property of the spec file alone, so it runs identically on a laptop,
  // a fork and the merge queue.
  it('no spec in the lane is missing its acceptanceStory() declaration', () => {
    const verdict = judgeLane(collectLaneMembers());
    expect(verdict.ok, verdict.message).toBe(true);
  });
});

// ── THE GUARD CAN FAIL ──────────────────────────────────────────────────────
//
// A guard nobody has watched fail is a guard nobody knows works. These drive the
// same judgement the check above runs, on fixtures.

describe('the guard itself', () => {
  it('PASSES a declared spec WHATEVER its story’s receipt says — approval evicts nothing (MOTIR-5872)', () => {
    // The retired half failed `acceptance-cadence.spec.ts` here because MOTIR-813's
    // receipt was approved. A signed record says nothing about where its TEST
    // belongs, so the judgement no longer takes an approved set at all — and the
    // failure text can never name a receipt again.
    const verdict = judgeLane([
      { file: 'acceptance-cadence.spec.ts', storyKey: 'MOTIR-813' },
      { file: 'acceptance-in-flight.spec.ts', storyKey: 'MOTIR-9999' },
    ]);
    expect(verdict).toEqual({ ok: true, message: '' });
    expect(judgeLane.length).toBe(1);
  });

  it('FAILS a spec with NO acceptanceStory() — the half that stays', () => {
    const verdict = judgeLane([{ file: 'acceptance-orphan.spec.ts', storyKey: null }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('declare NO story');
    expect(verdict.message).toContain('acceptance-orphan.spec.ts');
    // It names the way out, and never a receipt's status.
    expect(verdict.message).toContain('promoted-regression');
    expect(verdict.message).not.toMatch(/approved/i);
  });

  it('reads the declaration from CODE, not from a header comment', () => {
    // `acceptance-shell-context-path.spec.ts` named its story only in a comment
    // and published against the uploader's PR fallback for its whole life.
    expect(parseDeclaredStory("// Story MOTIR-2554 — the shell's context path.")).toBeNull();
    expect(parseDeclaredStory("/* acceptanceStory('MOTIR-2554') */")).toBeNull();
    expect(parseDeclaredStory("  acceptanceStory('MOTIR-2554');")).toBe('MOTIR-2554');
    expect(parseDeclaredStory('  acceptanceStory( "MOTIR-2554" );')).toBe('MOTIR-2554');
  });

  it('enumerates from the FILESYSTEM — a spec added tomorrow needs no edit here', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-'));
    fs.writeFileSync(path.join(dir, 'acceptance-new.spec.ts'), "acceptanceStory('MOTIR-42');");
    fs.writeFileSync(path.join(dir, 'ordinary.spec.ts'), "acceptanceStory('MOTIR-43');");
    fs.writeFileSync(path.join(dir, 'acceptance-helper.ts'), "acceptanceStory('MOTIR-44');");

    expect(collectLaneMembers(dir)).toEqual([
      { file: 'acceptance-new.spec.ts', storyKey: 'MOTIR-42' },
    ]);
  });
});
