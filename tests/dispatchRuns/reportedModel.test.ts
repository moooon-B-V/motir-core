import { describe, expect, it } from 'vitest';
import {
  MAX_REPORTED_MODEL_LENGTH,
  normalizeReportedModel,
  reportedModelOf,
} from '@/lib/dispatchRuns/reportedModel';

// The ONE validity rule for a leg's self-reported model (MOTIR-7502). Pure, so
// every branch is pinned here; the back-fill migration (MOTIR-7503) mirrors it in
// SQL and its own test pins the same cases against the database.

describe('normalizeReportedModel', () => {
  it('returns a valid model, trimmed', () => {
    expect(normalizeReportedModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(normalizeReportedModel('  gpt-5 \n')).toBe('gpt-5');
  });

  it('accepts exactly the limit and refuses one past it — never truncates', () => {
    expect(MAX_REPORTED_MODEL_LENGTH).toBe(200);
    expect(normalizeReportedModel('m'.repeat(200))).toBe('m'.repeat(200));
    expect(normalizeReportedModel('m'.repeat(201))).toBeNull();
    // The limit is measured AFTER the trim, as the CLI measures it.
    expect(normalizeReportedModel(` ${'m'.repeat(200)} `)).toBe('m'.repeat(200));
  });

  it('is null for blank and whitespace-only strings', () => {
    expect(normalizeReportedModel('')).toBeNull();
    expect(normalizeReportedModel('   \t')).toBeNull();
  });

  it('is null for every non-string', () => {
    for (const value of [undefined, null, 42, true, {}, ['gpt-5'], { model: 'gpt-5' }]) {
      expect(normalizeReportedModel(value)).toBeNull();
    }
  });
});

describe('reportedModelOf — the top-level field, else `data.model`', () => {
  it('reads the top-level `model`', () => {
    expect(reportedModelOf({ model: 'claude-opus-5-5' })).toBe('claude-opus-5-5');
  });

  it('falls back to `data.model`, the shape every installed CLI sends', () => {
    expect(reportedModelOf({ data: { model: 'gpt-5', signal: null } })).toBe('gpt-5');
  });

  it('prefers the top-level value when both are present', () => {
    expect(reportedModelOf({ model: 'claude-opus-5-5', data: { model: 'gpt-5' } })).toBe(
      'claude-opus-5-5',
    );
  });

  it('does not fall back past a top-level value that is present but invalid or null', () => {
    expect(reportedModelOf({ model: null, data: { model: 'gpt-5' } })).toBeNull();
    expect(reportedModelOf({ model: '  ', data: { model: 'gpt-5' } })).toBeNull();
  });

  it('is null when `data` is absent, not an object, an array, or carries no valid model', () => {
    expect(reportedModelOf({})).toBeNull();
    expect(reportedModelOf({ data: null })).toBeNull();
    expect(reportedModelOf({ data: 'gpt-5' })).toBeNull();
    expect(reportedModelOf({ data: ['gpt-5'] })).toBeNull();
    expect(reportedModelOf({ data: { signal: 'SIGTERM' } })).toBeNull();
    expect(reportedModelOf({ data: { model: 7 } })).toBeNull();
    expect(reportedModelOf({ data: { model: 'm'.repeat(201) } })).toBeNull();
  });
});
