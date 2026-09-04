import { describe, expect, it } from 'vitest';
import {
  PLAN_ITEM_CHANGE_FIELDS,
  PLAN_ITEM_SETTABLE_RAIL_FIELDS,
  type PlanItemChangeField,
} from '@/lib/dto/planReview';
import type { PlanItemPatch } from '@/lib/dto/plans';

// MOTIR-4183 (story MOTIR-4181, design Part XIV §3) — the peek's count line reads
// "{n} of {m} fields it can set", and `m` is the thing that quietly goes wrong.
//
// ── Why this spec exists at all ─────────────────────────────────────────────
// Part XIV's first draft stated the denominator as NINE, in prose. It was wrong
// twice: it counted `executor`, which `PlanItemPatch` has no key for and
// `plansService.applyModify` never writes, and it mixed rail fields with body
// fields under a number that renders at the foot of the RAIL. Both were found by
// reading the type while building against the asset — which is exactly the
// reading a constant in prose does not get a second time.
//
// So the denominator is DERIVED from the patch type, and this spec's job is to
// keep the derivation honest in the one direction the compiler cannot: it can
// prove the map is TOTAL over `keyof PlanItemPatch` (the `satisfies` in
// `planReview.ts` does that), and it cannot prove the map's DISPOSITIONS are the
// ones the design decided. That is what the rows below assert.

/**
 * Every `PlanItemPatch` key, as a value. `Required<PlanItemPatch>` makes this a
 * COMPILE ERROR the moment a key is added to the patch — which is the half of
 * criterion 9 that "a key added to the patch moves the denominator" actually
 * reduces to, since a TYPE cannot be enumerated at runtime.
 */
const EVERY_PATCH_KEY: Required<PlanItemPatch> = {
  title: 't',
  descriptionMd: null,
  explanationMd: null,
  priority: null,
  type: null,
  storyPoints: null,
  estimateMinutes: null,
  targetRepo: null,
  targetRepoRole: null,
  parentRef: null,
  blockedByAdd: [],
  blockedByRemove: [],
};

describe('the proposal envelope’s SETTABLE rail-field set (MOTIR-4183)', () => {
  it('is the SIX rail rows a patch can move — and names them, so a silent change fails here', () => {
    expect([...PLAN_ITEM_SETTABLE_RAIL_FIELDS].sort()).toEqual(
      ['estimateMinutes', 'parent', 'priority', 'storyPoints', 'targetRepo', 'type'].sort(),
    );
  });

  it('EXCLUDES `executor` — the patch has no key for it, so no plan can ever change it', () => {
    // The defect this row is named for: Part XIV marked `executor` changeable on
    // a `modify`. `PlanItemPatch` has no such key, and the assertion below is
    // the one that would have caught it before the asset merged.
    expect(Object.keys(EVERY_PATCH_KEY)).not.toContain('executor');
    expect(PLAN_ITEM_SETTABLE_RAIL_FIELDS).not.toContain('executor' as PlanItemChangeField);
  });

  it('EXCLUDES the body fields, which are patchable and are marked in the MAIN COLUMN', () => {
    // Not an oversight and not a bug: a line at the foot of the rail must not
    // count fields the reader cannot see from where it sits (Part XIV §3).
    for (const bodyField of ['title', 'description', 'explanation'] as PlanItemChangeField[]) {
      expect(PLAN_ITEM_SETTABLE_RAIL_FIELDS).not.toContain(bodyField);
    }
    // …while the patch DOES carry all three, which is why the exclusion has to
    // be stated rather than inferred from the patch type alone.
    expect(Object.keys(EVERY_PATCH_KEY)).toEqual(
      expect.arrayContaining(['title', 'descriptionMd', 'explanationMd']),
    );
  });

  it('EXCLUDES the edge keys — the canvas draws those, not a rail row', () => {
    expect(PLAN_ITEM_SETTABLE_RAIL_FIELDS).not.toContain('links' as PlanItemChangeField);
    expect(Object.keys(EVERY_PATCH_KEY)).toEqual(
      expect.arrayContaining(['blockedByAdd', 'blockedByRemove']),
    );
  });

  it('collapses `targetRepo` and `targetRepoRole` onto ONE row — two keys, one rail field', () => {
    expect(Object.keys(EVERY_PATCH_KEY)).toEqual(
      expect.arrayContaining(['targetRepo', 'targetRepoRole']),
    );
    expect(PLAN_ITEM_SETTABLE_RAIL_FIELDS.filter((f) => f === 'targetRepo')).toHaveLength(1);
    expect(PLAN_ITEM_SETTABLE_RAIL_FIELDS).not.toContain('targetRepoRole' as PlanItemChangeField);
  });

  it('every member is a member of the WIRE vocabulary the surfaces localize', () => {
    // The denominator's members become `field_<name>` message keys on the rail
    // marker exactly as the list row's diff rows do. A member outside the closed
    // list would render its own key at a reader (MOTIR-3151's failure).
    for (const field of PLAN_ITEM_SETTABLE_RAIL_FIELDS) {
      expect(PLAN_ITEM_CHANGE_FIELDS).toContain(field);
    }
  });

  it('is a SUBSET of the changeable set — the marker can never mark a field the diff cannot spell', () => {
    const changeable = new Set<string>(PLAN_ITEM_CHANGE_FIELDS);
    expect(PLAN_ITEM_SETTABLE_RAIL_FIELDS.every((f) => changeable.has(f))).toBe(true);
  });
});
