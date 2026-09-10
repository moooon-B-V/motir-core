import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE `proposedFields` REPOSITORY-AXIS DRIFT GUARD (bug MOTIR-4924, AC4).
//
// ── What went wrong ─────────────────────────────────────────────────────────
// motir-ai has emitted `targetRepositoryRef` on a proposal's `proposedFields`
// since MOTIR-3045, and motir-core READ NOTHING off it — the field was never
// declared on `PlanItemProposedFields`, so a leaf pinned only by row ref
// materialized unrouted and indistinguishable from a leaf the planner could not
// classify. Nothing errored; the plan looked complete; the pin was silently
// gone. This is the FOURTH key on this open-core contract to reach one side of
// the boundary and not the other — the MOTIR-3860 family — and each was found
// by accident, months later.
//
// ── Why a LITERAL COPY, and why this file lives in motir-core ───────────────
// The producer (`motir-ai`) and the consumer (`motir-core`) are different
// repositories: neither can import the other's constant, so the guard that holds
// them together must carry one side's list as a literal. motir-core cannot reach
// into motir-ai's tree, so it holds a literal of WHAT THE PRODUCER EMITS and
// asserts every member is DECLARED on core's `PlanItemProposedFields`. The
// mirror — motir-ai holding core's `PLAN_ITEM_PATCH_KEYS` as a literal — lives
// in motir-ai's own suite; the two guards face each other across the boundary.
//
// ── Why the SOURCE TEXT, not the runtime type ───────────────────────────────
// A type-level check is silenced by the same `tsc` that a missing field
// type-checks fine under; the interfaces are the only place both sides exist
// side by side at runtime. So the axis members are parsed out of the interface
// declaration the same way `planReviewFieldParity.test.ts` reads its two — the
// guard reads the file it thinks it does, and cannot pass vacuously.

const ROOT = resolve(__dirname, '../../..');

/** The repository-axis member keys of one interface's own declaration. */
function proposedFieldKeys(): Set<string> {
  const src = readFileSync(resolve(ROOT, 'lib/dto/plans.ts'), 'utf8');
  const start = src.indexOf('export interface PlanItemProposedFields {');
  if (start === -1) throw new Error('PlanItemProposedFields not found');

  // Walk the braces so a nested object type (e.g. `planningProvenance`) and the
  // `{@link …}` tokens inside doc comments are consumed without leaking members
  // or links into the key set — the same discipline the field-parity guard uses.
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
      if (m && /^targetRepo/.test(m[1]!)) keys.add(m[1]!);
    }
    nest += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return keys;
}

describe('the `proposedFields` repository axis is TOTAL over what motir-ai emits (bug MOTIR-4924, AC4)', () => {
  // A LITERAL COPY of the producer's field list — `PROPOSE_REPO_AXIS_KEYS` in
  // `motir-ai/src/llm/treeGeneration.ts`. Sorted, because a literal's ORDER is
  // the producer's business and the guard is about the SET.
  const PRODUCER_REPO_AXIS = [
    'targetRepoRole',
    'targetRepositoryRef',
    'targetRepos',
    'targetRepositories',
  ].sort();

  const declared = [...proposedFieldKeys()].sort();

  it('parses the interface — a guard that read nothing would pass vacuously', () => {
    expect(declared.length).toBeGreaterThan(1);
    expect(declared).toContain('targetRepo');
  });

  it('every repository-axis key the producer emits is DECLARED on core’s `proposedFields`', () => {
    const missing = PRODUCER_REPO_AXIS.filter((k) => !declared.includes(k));
    expect({ missing }).toEqual({ missing: [] });
  });

  it('names the four spellings, so a SILENT narrowing of either side fails here too', () => {
    // The absolute half. Relative assertions above would all pass if the axis
    // were reduced to one member on both sides.
    expect(PRODUCER_REPO_AXIS).toEqual(
      ['targetRepoRole', 'targetRepositoryRef', 'targetRepos', 'targetRepositories'].sort(),
    );
    expect(declared).toEqual(expect.arrayContaining(PRODUCER_REPO_AXIS));
  });

  it('would have caught `targetRepositoryRef` — the field that was already missed', () => {
    // The regression this guard is built from, asserted as itself: before the fix
    // core's side lacked the singular row-ref, so the first assertion went red.
    expect(declared).toContain('targetRepositoryRef');
  });
});
