import { describe, expect, it } from 'vitest';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import {
  PINNED_CALCULATOR_REQUEST,
  PINNED_CATEGORIES_ANSWER,
  PINNED_CATEGORIES_RAW_BODY,
  PINNED_ESTIMATE_ANSWER,
  PINNED_ESTIMATE_RAW_BODY,
  PINNED_VECTOR_BASIS,
} from './fixtures/calculatorPinnedVector';

// The guard over the PINNED CROSS-SURFACE ESTIMATE VECTOR (Story MOTIR-8381 ·
// MOTIR-8642). It asserts the RECORD's own integrity and nothing about the live
// engine: a motir-core suite has no seam to motir-ai, so "the engine still
// answers this" belongs to the engine's public lane and to the integration card.
// What it does catch is the record being edited instead of re-recorded — a figure
// typed into the answer, provenance left blank, a basis that no longer describes
// the answer, or a selection the engine's live list never offered.

// The pattern motir-ai's own public lane asserts (tests/calculatorPublicE2E.test.ts):
// the answer carries no seat, quantity, cost or margin field for a surface to render.
const FORBIDDEN_KEY = /^seat|quantity|^cost|^margin|readAt|time/i;

function everyKey(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) everyKey(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      everyKey(child, out);
    }
  }
  return out;
}

function isWholeNonNegative(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

describe('the pinned calculator vector', () => {
  it('the recorded answer is the engine’s bytes — parsing the raw body deep-equals it', () => {
    expect(JSON.parse(PINNED_ESTIMATE_RAW_BODY)).toStrictEqual(PINNED_ESTIMATE_ANSWER);
    expect(JSON.parse(PINNED_CATEGORIES_RAW_BODY)).toStrictEqual(PINNED_CATEGORIES_ANSWER);
  });

  it('the basis is complete and agrees with the answer it describes', () => {
    expect(PINNED_VECTOR_BASIS.endpoint).toBe('POST /v1/public/calculator/estimate');
    expect(PINNED_VECTOR_BASIS.host).toMatch(/^https:\/\/\S+$/);
    for (const at of [PINNED_VECTOR_BASIS.recordedAt, PINNED_VECTOR_BASIS.categoriesRecordedAt]) {
      expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      expect(Number.isNaN(Date.parse(at))).toBe(false);
    }
    expect(PINNED_VECTOR_BASIS.engineVersion).toBe(PINNED_ESTIMATE_ANSWER.version);
    expect(PINNED_VECTOR_BASIS.profilesVersion).toBe(PINNED_ESTIMATE_ANSWER.profilesVersion);
    expect(PINNED_VECTOR_BASIS.categoryRuleVersion).toBe(
      PINNED_ESTIMATE_ANSWER.categoryRuleVersion,
    );
    // The categories were read on the same category rule the estimate used.
    expect(PINNED_CATEGORIES_ANSWER.categoryRuleVersion).toBe(
      PINNED_ESTIMATE_ANSWER.categoryRuleVersion,
    );
  });

  it('the pinned input is a legal engine request — one range, one selection per lane, one cadence', () => {
    const { itemsPerMonth, planning, running, cadence } = PINNED_CALCULATOR_REQUEST;
    expect(Object.keys(PINNED_CALCULATOR_REQUEST).sort()).toEqual([
      'cadence',
      'itemsPerMonth',
      'planning',
      'running',
    ]);
    expect(isWholeNonNegative(itemsPerMonth.low)).toBe(true);
    expect(isWholeNonNegative(itemsPerMonth.high)).toBe(true);
    expect(itemsPerMonth.low).toBeLessThanOrEqual(itemsPerMonth.high);
    for (const lane of [planning, running]) {
      expect(lane.category.trim()).not.toBe('');
      expect(lane.modelIds.length).toBeGreaterThan(0);
    }
    // The cadences the shipped catalog prices — read, not typed as a pair here.
    expect(Object.keys(BILLING_CATALOG.seatPlan.prices)).toContain(cadence);
  });

  it('the recorded answer is an ordered estimate at the request’s cadence', () => {
    expect(PINNED_ESTIMATE_ANSWER.kind).toBe('estimate');
    expect(PINNED_ESTIMATE_ANSWER.cadence).toBe(PINNED_CALCULATOR_REQUEST.cadence);
    const { low, high } = PINNED_ESTIMATE_ANSWER.credits;
    expect(isWholeNonNegative(low)).toBe(true);
    expect(isWholeNonNegative(high)).toBe(true);
    expect(low).toBeLessThanOrEqual(high);
  });

  it('no key of the recorded answer names a seat, quantity, cost, margin or time', () => {
    expect(everyKey(PINNED_ESTIMATE_ANSWER).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
  });

  it('the selections were live when it was recorded — each id is listed under its category', () => {
    for (const lane of ['planning', 'running'] as const) {
      const selection = PINNED_CALCULATOR_REQUEST[lane];
      const band = PINNED_CATEGORIES_ANSWER.categories.find((c) => c.key === selection.category);
      expect(
        band,
        `${lane}: category ${selection.category} is not in the recorded list`,
      ).toBeDefined();
      const live = band!.models.map((m) => m.id);
      for (const id of selection.modelIds) expect(live).toContain(id);
      // And the engine split over exactly the ids that were asked for.
      expect(PINNED_ESTIMATE_ANSWER.models[lane]).toEqual(selection.modelIds);
      expect(PINNED_ESTIMATE_ANSWER.droppedModelIds[lane]).toEqual([]);
    }
  });
});
