/**
 * The console's SPEND vocabulary (Story MOTIR-727 · MOTIR-732) — shared by Usage &
 * cost, Tenants and the org page's Usage tab, so the eight categories, their units,
 * the period grammar and the two totals mean one thing on every screen.
 *
 * Pure: no I/O, no React. The figures come from motir-ai's platform rollup
 * (`GET /v1/platform/usage*`); this module only shapes them.
 */

/** The eight spending categories, in the order every sheet lists them (design notes). */
export const SPEND_CATEGORIES = [
  'planning_tokens',
  'agent_tokens',
  'agent_machine',
  'agent_instance',
  'agent_storage',
  'ci',
  'search',
  'indexing',
] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/** Motir never charges for code indexing: it carries usage and cost, never credits. */
export const NOT_CHARGED: ReadonlySet<SpendCategory> = new Set(['indexing']);

/** What a category's usage is counted in. */
export type SpendUnit = 'tokens' | 'seconds' | 'gbSeconds' | 'searches';
export const SPEND_UNIT: Record<SpendCategory, SpendUnit> = {
  planning_tokens: 'tokens',
  agent_tokens: 'tokens',
  agent_machine: 'seconds',
  agent_instance: 'seconds',
  agent_storage: 'gbSeconds',
  ci: 'seconds',
  search: 'searches',
  indexing: 'seconds',
};

/** A period: one UTC month (`YYYY-MM`) or `all`. */
export type SpendPeriod = string;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The current UTC month, `YYYY-MM`. */
export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** A URL's `period`, or the current month when it is absent or not one the read takes. */
export function parseSpendPeriod(
  raw: string | undefined | null,
  now: Date = new Date(),
): SpendPeriod {
  if (raw === 'all') return 'all';
  if (raw && MONTH.test(raw) && raw <= currentMonth(now)) return raw;
  return currentMonth(now);
}

/** The months the period picker offers: this month and the `count - 1` before it. */
export function recentMonths(now: Date = new Date(), count = 24): string[] {
  const months: string[] = [];
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  for (let i = 0; i < count; i += 1) {
    months.push(new Date(Date.UTC(y, m - i, 1)).toISOString().slice(0, 7));
  }
  return months;
}

/** One category's figures, as the rollup serves them. */
export interface CategoryFigures {
  category: SpendCategory;
  usageQuantity: number;
  inputTokens: number;
  outputTokens: number;
  cacheMissTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  costMicroUsd: number;
}

export interface SpendSheetRow {
  category: SpendCategory;
  unit: SpendUnit;
  /** In the category's unit — tokens are input + output. */
  usage: number;
  /** Credits charged; NULL for a category Motir does not charge (indexing). */
  credits: number | null;
  costMicroUsd: number;
}

export interface SpendSheet {
  rows: SpendSheetRow[];
  /** Σ credits over the CHARGED categories — indexing is never in it. */
  chargedCredits: number;
  /** What the charged categories cost Motir. */
  chargedCostMicroUsd: number;
  /** Motir's whole cost, indexing INCLUDED. */
  costMicroUsdInclIndexing: number;
}

/**
 * The category sheet every spend view draws: all eight rows in order (a category
 * the read omitted is a row of zeros, never a missing row), and the two totals —
 * charged credits WITHOUT indexing, Motir's cost WITH it.
 */
export function buildSpendSheet(categories: readonly CategoryFigures[]): SpendSheet {
  const byCategory = new Map(categories.map((c) => [c.category, c]));
  const rows = SPEND_CATEGORIES.map((category): SpendSheetRow => {
    const c = byCategory.get(category);
    const unit = SPEND_UNIT[category];
    const usage = !c ? 0 : unit === 'tokens' ? c.inputTokens + c.outputTokens : c.usageQuantity;
    return {
      category,
      unit,
      usage,
      credits: NOT_CHARGED.has(category) ? null : (c?.credits ?? 0),
      costMicroUsd: c?.costMicroUsd ?? 0,
    };
  });
  let chargedCredits = 0;
  let chargedCostMicroUsd = 0;
  let costMicroUsdInclIndexing = 0;
  for (const row of rows) {
    costMicroUsdInclIndexing += row.costMicroUsd;
    if (row.credits === null) continue;
    chargedCredits += row.credits;
    chargedCostMicroUsd += row.costMicroUsd;
  }
  return { rows, chargedCredits, chargedCostMicroUsd, costMicroUsdInclIndexing };
}

/** Micro-dollars as dollars, for `Intl` currency formatting. */
export function microUsdToUsd(micro: number): number {
  return micro / 1_000_000;
}
