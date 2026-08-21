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

// ── The EDGE-CARRIER guard (bug MOTIR-3366) ──────────────────────────────────
//
// The parity test above holds the review model against what an `add` PROPOSES.
// A plan's `blocked_by` edges have a second carrier that lives nowhere near
// `PlanItemProposedFields`: a `modify` states them in `patch.blockedByAdd`,
// because a proposal about a card that already exists has no proposed-fields bag
// to put them in. `planReviewService` resolved the `add`'s carrier alone, so
// every edge proposed onto an existing card reached the canvas as an empty
// array — the added card drew with no line to the card it blocks, while the same
// patch was already being read to render the "+1 blocker" diff row.
//
// Adding the second read fixes today's instance; this is the half that survives
// a THIRD carrier. `PlanItemPatch` is where a new one would be declared, and the
// review model is the consumer that must then decide what it means.
describe('PlanItemPatch edge carriers ⟷ planReviewService', () => {
  const patchKeys = interfaceKeys('lib/dto/plans.ts', 'PlanItemPatch');
  const carriers = [...patchKeys].filter((k) => k.startsWith('blockedBy'));
  const service = readFileSync(resolve(ROOT, 'lib/services/planReviewService.ts'), 'utf8');

  it('names EVERY edge carrier the patch declares', () => {
    // A carrier the review model never mentions is one whose edges cannot reach
    // the canvas — and the failure is silent, because an unread carrier renders
    // as a level with one fewer arrow rather than as an error.
    const unread = carriers.filter((k) => !service.includes(k));
    expect({ unread }).toEqual({ unread: [] });
  });

  it('parses the patch — a guard that read nothing would pass vacuously', () => {
    expect(patchKeys.size).toBeGreaterThan(5);
    expect(carriers.sort()).toEqual(['blockedByAdd', 'blockedByRemove']);
  });

  it('resolves the ADD carrier into node ids, and states why REMOVE is excluded', () => {
    // `blockedByAdd` is a blocker the proposal DECLARES, so it becomes an edge.
    // `blockedByRemove` is an edge the plan would DELETE — drawing it as a
    // blocker would say the opposite of what the plan proposes — so it is named
    // in the service, deliberately, and not resolved. Both facts are asserted
    // here so a later reader cannot mistake the exclusion for an oversight.
    expect(service).toContain('item.patch?.blockedByAdd');
    expect(service).not.toContain('item.patch?.blockedByRemove');
    expect(service).toMatch(/`blockedByRemove` is deliberately NOT here/);
  });
});
