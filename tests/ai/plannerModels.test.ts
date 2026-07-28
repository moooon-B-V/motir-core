import { describe, expect, it } from 'vitest';
import {
  PLANNER_MODEL_DEFAULT,
  PLANNER_MODEL_IDS,
  PLANNER_MODEL_OPTIONS,
  choiceToPlannerModel,
  plannerModelToChoice,
} from '@/lib/projectAiSettings/plannerModels';
import {
  AI_PLANNER_MODEL_MAX_LENGTH,
  AI_PLANNER_MODEL_PATTERN,
} from '@/lib/projectAiSettings/limits';

// Story 7.13 · Subtask 7.13.7 (MOTIR-920) — the planner-model PICKER module,
// which shipped with MOTIR-919 at 0% coverage: the panel's component test drives
// the rendered Combobox, never these two mapping functions or the options table
// they read from.
//
// The module is small but it is a TWO-WAY MAPPING across a persistence boundary,
// which is exactly where silent data loss lives: the picker's "Default" row is a
// SENTINEL STRING that must never be persisted, and the stored `null` must map
// back to it. Invert either direction and a project's pinned model is silently
// reset to the deployment default on the next save — a change no type checks and
// no existing test would catch, because both sides still hold valid strings.
//
// The closing describe locks the cross-module invariant that makes the picker
// safe: every value it can OFFER must survive the server's own validation, so
// choosing a listed model can never 422. `projectAiSettingsService` validates
// SHAPE only (the model vocabulary belongs to the gateway + motir-ai), so the
// picker and the validator are two modules that must agree with no compiler
// between them. The live round-trip through the real service is asserted in
// `tests/integration/ai/story713CoverageGate.test.ts`.

describe('Planner-model picker — the options table (MOTIR-919 · MOTIR-920)', () => {
  it('offers the Default sentinel first, then every pinnable id in picker order', () => {
    expect(PLANNER_MODEL_OPTIONS.map((o) => o.value)).toEqual([
      PLANNER_MODEL_DEFAULT,
      ...PLANNER_MODEL_IDS,
    ]);
  });

  it('shows the model id as secondary text for a pinned row, and none for Default', () => {
    const [defaultRow, ...pinnedRows] = PLANNER_MODEL_OPTIONS;

    // The Default row's secondary is a translated word, not an id.
    expect(defaultRow?.value).toBe(PLANNER_MODEL_DEFAULT);
    expect(defaultRow?.modelId).toBeNull();

    // Every other row shows exactly the id it pins — an engineer reading the
    // panel sees precisely what will run.
    for (const row of pinnedRows) {
      expect(row.modelId).toBe(row.value);
    }
  });

  it('gives every row a distinct value and a distinct label key', () => {
    const values = PLANNER_MODEL_OPTIONS.map((o) => o.value);
    const labelKeys = PLANNER_MODEL_OPTIONS.map((o) => o.labelKey);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(labelKeys).size).toBe(labelKeys.length);
  });

  it('never lists the sentinel as a pinnable id — it is a UI value, never persisted', () => {
    expect(PLANNER_MODEL_IDS).not.toContain(PLANNER_MODEL_DEFAULT);
  });
});

describe('Planner-model picker — the stored ↔ chosen mapping (MOTIR-920)', () => {
  it('maps the stored NULL override to the Default sentinel', () => {
    expect(plannerModelToChoice(null)).toBe(PLANNER_MODEL_DEFAULT);
  });

  it('maps an empty / blank stored value to Default too — a cleared override reads as Default', () => {
    // The service normalises a blank override to null on write; this covers the
    // read side if a legacy row ever holds an empty string.
    expect(plannerModelToChoice('')).toBe(PLANNER_MODEL_DEFAULT);
  });

  it('maps the Default sentinel back to NULL — the sentinel is never persisted', () => {
    expect(choiceToPlannerModel(PLANNER_MODEL_DEFAULT)).toBeNull();
  });

  it('round-trips every pinnable id in BOTH directions without drift', () => {
    for (const id of PLANNER_MODEL_IDS) {
      // stored → chosen → stored
      expect(choiceToPlannerModel(plannerModelToChoice(id))).toBe(id);
      // chosen → stored → chosen
      expect(plannerModelToChoice(choiceToPlannerModel(id))).toBe(id);
    }
  });

  it('round-trips an UNKNOWN pinned id unchanged — a retired model is not silently reset', () => {
    // A project pinned by an older release (or a hand-edited row) must survive a
    // save through the panel. Resetting it to the default here would silently
    // change which model a tenant pays for.
    const retired = 'deepseek-v3-legacy';
    expect(plannerModelToChoice(retired)).toBe(retired);
    expect(choiceToPlannerModel(retired as never)).toBe(retired);
  });
});

describe('Planner-model picker ↔ server validator — the picker can never 422 (MOTIR-920)', () => {
  // The seam: `plannerModels.ts` decides what the panel may OFFER;
  // `projectAiSettingsService` decides what the server ACCEPTS, via the SHAPE
  // rules in `limits.ts`. Nothing in the type system connects them, so adding a
  // model id that violates the pattern would ship a picker row that always
  // fails to save. This is the guard for that.
  it('every offered id satisfies the server’s model-id pattern and length bound', () => {
    for (const id of PLANNER_MODEL_IDS) {
      expect(AI_PLANNER_MODEL_PATTERN.test(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(AI_PLANNER_MODEL_MAX_LENGTH);
      // A shape-valid id is also trimmed — the service trims, so an id with
      // surrounding whitespace would persist as something the picker cannot
      // match on read-back.
      expect(id).toBe(id.trim());
    }
  });

  it('the guard BITES — a malformed id would be rejected by the same pattern', () => {
    // Proves the assertion above is not vacuous: the pattern really does
    // discriminate, so a bad future entry would fail rather than slip through.
    expect(AI_PLANNER_MODEL_PATTERN.test('has spaces')).toBe(false);
    expect(AI_PLANNER_MODEL_PATTERN.test('-leading-dash')).toBe(false);
    expect(AI_PLANNER_MODEL_PATTERN.test('trailing-dash-')).toBe(false);
  });
});
