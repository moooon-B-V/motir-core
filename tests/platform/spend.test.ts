import { describe, expect, it } from 'vitest';
import {
  buildSpendSheet,
  parseSpendPeriod,
  recentMonths,
  SPEND_CATEGORIES,
  type CategoryFigures,
} from '@/lib/platform/spend';

/** The console's spend vocabulary (Story MOTIR-727 · MOTIR-732). */

const NOW = new Date('2026-10-02T12:00:00Z');

function figures(
  category: CategoryFigures['category'],
  over: Partial<CategoryFigures> = {},
): CategoryFigures {
  return {
    category,
    usageQuantity: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheMissTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: 0,
    costMicroUsd: 0,
    ...over,
  };
}

describe('parseSpendPeriod', () => {
  it('takes a past or current month and `all`; anything else is this month', () => {
    expect(parseSpendPeriod('all', NOW)).toBe('all');
    expect(parseSpendPeriod('2026-09', NOW)).toBe('2026-09');
    expect(parseSpendPeriod('2026-10', NOW)).toBe('2026-10');
    for (const bad of [undefined, null, '', '2026-13', '2026-9', 'sept', '2026-11']) {
      expect(parseSpendPeriod(bad, NOW)).toBe('2026-10');
    }
  });
});

describe('recentMonths', () => {
  it('lists this month first and walks back across a year boundary', () => {
    expect(recentMonths(NOW, 12)).toEqual([
      '2026-10',
      '2026-09',
      '2026-08',
      '2026-07',
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
      '2026-02',
      '2026-01',
      '2025-12',
      '2025-11',
    ]);
  });
});

describe('buildSpendSheet', () => {
  it('indexing is NOT CHARGED — out of the charged credits total, inside Motir’s cost total', () => {
    const sheet = buildSpendSheet([
      figures('planning_tokens', {
        inputTokens: 1000,
        outputTokens: 200,
        credits: 30,
        costMicroUsd: 13_050,
      }),
      figures('ci', { usageQuantity: 600, credits: 5, costMicroUsd: 19_000 }),
      // A stray credit on indexing must never reach the charged total.
      figures('indexing', { usageQuantity: 3600, credits: 7, costMicroUsd: 114_000 }),
    ]);
    const indexing = sheet.rows.find((r) => r.category === 'indexing')!;
    expect(indexing.credits).toBeNull();
    expect(indexing.costMicroUsd).toBe(114_000);
    expect(sheet.chargedCredits).toBe(35);
    expect(sheet.chargedCostMicroUsd).toBe(32_050);
    expect(sheet.costMicroUsdInclIndexing).toBe(146_050);
  });

  it('always draws all eight rows in order, zero-filling a category the read omitted', () => {
    const sheet = buildSpendSheet([
      figures('search', { usageQuantity: 3, credits: 3, costMicroUsd: 15_000 }),
    ]);
    expect(sheet.rows.map((r) => r.category)).toEqual([...SPEND_CATEGORIES]);
    expect(sheet.rows.find((r) => r.category === 'agent_storage')).toMatchObject({
      usage: 0,
      credits: 0,
      costMicroUsd: 0,
    });
  });

  it('a token category’s usage is input + output; every other is its usage quantity', () => {
    const sheet = buildSpendSheet([
      figures('agent_tokens', { inputTokens: 900, outputTokens: 100, usageQuantity: 0 }),
      figures('agent_storage', { usageQuantity: 864_000 }),
    ]);
    expect(sheet.rows.find((r) => r.category === 'agent_tokens')).toMatchObject({
      unit: 'tokens',
      usage: 1000,
    });
    expect(sheet.rows.find((r) => r.category === 'agent_storage')).toMatchObject({
      unit: 'gbSeconds',
      usage: 864_000,
    });
  });
});
