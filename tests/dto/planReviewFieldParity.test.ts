import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The PARITY GUARD (MOTIR-3084 / bug MOTIR-3070).
//
// ── What went wrong, and why a test rather than four fields ─────────────────
// `PlanReviewItemDto` is the model the plan-review surface renders. It is a
// projection built for a COMPACT CANVAS NODE, and it was used as the whole
// review model — so every proposed value the node does not draw was simply
// absent from the surface a person approves on. `explanationMd` was the
// sharpest: carried on the proposal, diffed, written onto the created work item
// by `materialize`, and read by NOTHING in the review surface. The reviewer
// approved a second content body they were never shown.
//
// Adding the missing fields fixes today's instance. It does not stop the next
// one, and there WAS a next one already: `planningProvenance` was added to
// `PlanItemProposedFields` and not to the review model while the card to fix
// this sat in the backlog, and nothing went red. So the durable half of the fix
// is this test.
//
// ── HOW IT FAILS (the mechanism, stated because a weaker one would not) ─────
// A hand-written list of field names would pass forever — it only ever compares
// itself. This test derives BOTH sides from the source of truth: it parses the
// two interface declarations out of the `.ts` files and compares the key SETS.
// Add a field to `PlanItemProposedFields` alone and this goes red on the next
// run, naming the field, with no list to remember to update.
//
// Reading the source text is deliberate. A type-level check
// (`Exclude<keyof A, keyof B> extends never`) is compile-time and would be
// silenced by the same `tsc` run that the missing field type-checks fine under;
// a runtime shape comparison needs an instance of each, and a DTO has no
// runtime presence at all. The declarations are the only place both sets exist
// side by side.

const ROOT = resolve(__dirname, '../..');

/** The property names declared directly in one interface body. */
function interfaceKeys(file: string, name: string): Set<string> {
  const src = readFileSync(resolve(ROOT, file), 'utf8');
  const start = src.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);

  // Walk the braces so a nested object type (e.g. `planningProvenance`) is
  // consumed whole rather than leaking its members into the key set.
  let depth = 0;
  let i = src.indexOf('{', start);
  const bodyStart = i + 1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(bodyStart, i);

  const keys = new Set<string>();
  let nest = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    // Only depth-0 declarations are this interface's own keys.
    if (nest === 0) {
      const m = /^([a-zA-Z_][\w]*)\??:/.exec(line);
      if (m) keys.add(m[1]!);
    }
    nest += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return keys;
}

describe('PlanReviewItemDto ⟷ PlanItemProposedFields parity', () => {
  const proposed = interfaceKeys('lib/dto/plans.ts', 'PlanItemProposedFields');
  const review = interfaceKeys('lib/dto/planReview.ts', 'PlanReviewItemDto');

  // `title` and `kind` ARE carried — under the same names — so they need no
  // exception. Nothing else on the proposal is deliberately withheld from the
  // reviewer, which is the whole point: if a field is worth materializing onto
  // the created work item, it is worth showing before it is created.
  it('every proposed field a reviewer decides on is carried by the review model', () => {
    const missing = [...proposed].filter((k) => !review.has(k));
    expect({ missing }).toEqual({ missing: [] });
  });

  it('parses BOTH declarations — a guard that read nothing would pass vacuously', () => {
    // Without this, a rename that made either lookup return an empty set would
    // turn the assertion above into a tautology.
    expect(proposed.size).toBeGreaterThan(8);
    expect(review.size).toBeGreaterThan(8);
    expect(proposed.has('explanationMd')).toBe(true);
    expect(review.has('explanationMd')).toBe(true);
  });

  it('would have caught `planningProvenance` — the field that was already missed', () => {
    // The real regression this test is built from: it reached the proposal and
    // not the review model, silently. Both sides must carry it now, and the
    // first assertion is what would have gone red at the time.
    expect(proposed.has('planningProvenance')).toBe(true);
    expect(review.has('planningProvenance')).toBe(true);
  });

  it('ignores the members of a NESTED object type', () => {
    // `planningProvenance: { source?, harness?, model? }` must contribute one
    // key, not four — otherwise the guard demands `source` on the review model
    // and fails for the wrong reason.
    expect(proposed.has('source')).toBe(false);
    expect(proposed.has('harness')).toBe(false);
  });
});
