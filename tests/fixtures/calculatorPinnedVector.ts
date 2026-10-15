import type {
  CalculatorCategoriesDTO,
  CalculatorEstimateDTO,
  CalculatorEstimateRequestDTO,
} from '@/lib/dto/billing';

// THE PINNED CROSS-SURFACE ESTIMATE VECTOR (Story MOTIR-8381 · MOTIR-8642).
//
// One calculator request — the shared input the Billing & plans Calculator tab
// and motir.co/price are both compared on — and the engine's OWN answer to it,
// recorded verbatim from the shipped public endpoint, with the basis it was
// recorded on. It is a DATED OBSERVATION of one data state (the live model rates,
// the Stripe-priced plan list, the top-up bundle), not something any git ref
// reproduces: when the engine's answer moves, this file is RE-RECORDED — the
// endpoint called again and every export below replaced together — never edited
// by hand. `calculatorPinnedVector.test.ts` keeps it honest against that.
//
// Not a spec file (no `.test.`), so a suite imports it rather than running it.
// Consumed by the Calculator's rendering check (MOTIR-8643).
//
// How it was recorded (re-record the same way, then replace all five exports):
//   curl -sS https://motir-ai.fly.dev/v1/public/calculator/categories
//   curl -sS -X POST -H 'content-type: application/json' \
//     --data '<PINNED_CALCULATOR_REQUEST as JSON>' \
//     https://motir-ai.fly.dev/v1/public/calculator/estimate

/** The shared input: one items-per-month range, one selection per lane, one cadence. */
export const PINNED_CALCULATOR_REQUEST: CalculatorEstimateRequestDTO = {
  itemsPerMonth: { low: 20, high: 60 },
  planning: { category: 'flagship', modelIds: ['claude-sonnet-5-5'] },
  running: { category: 'balanced', modelIds: ['gpt-5-mini'] },
  cadence: 'annual',
};

/** The engine's response body to that request, byte for byte as it answered. */
export const PINNED_ESTIMATE_RAW_BODY =
  '{"version":1,"kind":"estimate","profilesVersion":"2026-10-12.1","categoryRuleVersion":"2026-10-14.1","cadence":"annual","credits":{"low":26789,"high":160730},"perItemCredits":{"planning":656.1316818900001,"running":683.28},"models":{"planning":["claude-sonnet-5-5"],"running":["gpt-5-mini"]},"droppedModelIds":{"planning":[],"running":[]},"recommendation":{"planKey":"max_x2","planName":"Max ×2","monthlyPriceUsd":200},"topUp":{"low":{"units":0,"credits":0,"priceUsd":0},"high":{"units":101,"credits":101000,"priceUsd":505}},"ceiling":{"credits":60000,"exceeded":true,"excessCredits":100730}}';

/** The same answer as a value — must deep-equal `JSON.parse(PINNED_ESTIMATE_RAW_BODY)`. */
export const PINNED_ESTIMATE_ANSWER: CalculatorEstimateDTO = {
  version: 1,
  kind: 'estimate',
  profilesVersion: '2026-10-12.1',
  categoryRuleVersion: '2026-10-14.1',
  cadence: 'annual',
  credits: { low: 26789, high: 160730 },
  perItemCredits: { planning: 656.1316818900001, running: 683.28 },
  models: { planning: ['claude-sonnet-5-5'], running: ['gpt-5-mini'] },
  droppedModelIds: { planning: [], running: [] },
  recommendation: { planKey: 'max_x2', planName: 'Max ×2', monthlyPriceUsd: 200 },
  topUp: {
    low: { units: 0, credits: 0, priceUsd: 0 },
    high: { units: 101, credits: 101000, priceUsd: 505 },
  },
  ceiling: { credits: 60000, exceeded: true, excessCredits: 100730 },
};

/** The categories answer read just before, so the selections can be shown to have been live. */
export const PINNED_CATEGORIES_RAW_BODY =
  '{"version":1,"categoryRuleVersion":"2026-10-14.1","modelsReadAt":"2026-10-15T08:39:35.653Z","cadences":["annual","monthly"],"defaultCadence":"annual","categories":[{"key":"economy","models":[{"id":"deepseek-v4-flash","provider":"qwen"},{"id":"gpt-5-nano","provider":"openai"},{"id":"gpt-5-nano-2025-08-07","provider":"openai"},{"id":"qwen3-vl-flash","provider":"qwen"},{"id":"qwen3-vl-flash-2025-10-15","provider":"qwen"},{"id":"qwen3-vl-flash-2026-01-22","provider":"qwen"},{"id":"gpt-4.1-nano","provider":"openai"},{"id":"gpt-4.1-nano-2025-04-14","provider":"openai"},{"id":"qwen-plus-2025-07-28","provider":"qwen"},{"id":"qwen-plus-2025-09-11","provider":"qwen"},{"id":"qwen3-30b-a3b","provider":"qwen"},{"id":"qwen3-30b-a3b-instruct-2507","provider":"qwen"},{"id":"qwen3-8b","provider":"qwen"},{"id":"qwen3-vl-30b-a3b-instruct","provider":"qwen"},{"id":"qwen3-vl-8b-instruct","provider":"qwen"},{"id":"qwen3.5-flash","provider":"qwen"},{"id":"qwen3.5-flash-2026-02-23","provider":"qwen"},{"id":"claude-haiku-5-5","provider":"anthropic"},{"id":"gpt-6-luna","provider":"openai"},{"id":"qwen3.8-flash","provider":"qwen"},{"id":"deepseek-flash","provider":"deepseek"},{"id":"gpt-4o-mini","provider":"openai"},{"id":"gpt-4o-mini-2024-07-18","provider":"openai"},{"id":"gpt-4o-mini-search-preview","provider":"openai"},{"id":"gpt-4o-mini-search-preview-2025-03-11","provider":"openai"},{"id":"qwen3-next-80b-a3b-instruct","provider":"qwen"},{"id":"qwen3-32b","provider":"qwen"},{"id":"qwen3-vl-32b-instruct","provider":"qwen"},{"id":"qwen3-vl-32b-thinking","provider":"qwen"},{"id":"qwen3-30b-a3b-thinking-2507","provider":"qwen"},{"id":"qwen3-vl-30b-a3b-thinking","provider":"qwen"},{"id":"qwen3-vl-8b-thinking","provider":"qwen"},{"id":"glm-4.5-air","provider":"z-ai"},{"id":"qwen3-235b-a22b-instruct-2507","provider":"qwen"},{"id":"qwen3-coder-30b-a3b-instruct","provider":"qwen"},{"id":"glm-5.3-flash","provider":"z-ai"},{"id":"qwen3-next-80b-a3b-thinking","provider":"qwen"},{"id":"qwen3-vl-plus-2025-09-23","provider":"qwen"},{"id":"gpt-5.6-luna","provider":"openai"},{"id":"qwen3-235b-a22b","provider":"qwen"},{"id":"qwen3-vl-235b-a22b-instruct","provider":"qwen"},{"id":"gpt-5.4-nano","provider":"openai"},{"id":"gpt-5.4-nano-2026-03-17","provider":"openai"},{"id":"qwen-plus","provider":"qwen"},{"id":"qwen-plus-2025-12-01","provider":"qwen"},{"id":"glm-5.3-flashx","provider":"z-ai"},{"id":"qwen3-coder-next","provider":"qwen"},{"id":"gpt-4.1-mini","provider":"openai"},{"id":"gpt-4.1-mini-2025-04-14","provider":"openai"},{"id":"qwen3-vl-plus","provider":"qwen"},{"id":"gpt-3.5-turbo","provider":"openai"},{"id":"gpt-3.5-turbo-0125","provider":"openai"}]},{"key":"balanced","models":[{"id":"gpt-5-mini","provider":"openai"},{"id":"gpt-5-mini-2025-08-07","provider":"openai"},{"id":"gpt-5.1-codex-mini","provider":"openai"},{"id":"qwen3-235b-a22b-thinking-2507","provider":"qwen"},{"id":"glm-5","provider":"z-ai"},{"id":"glm-4.6","provider":"z-ai"},{"id":"glm-4.5","provider":"z-ai"},{"id":"glm-4.7","provider":"z-ai"},{"id":"qwen3-coder-plus","provider":"qwen"},{"id":"qwen3-coder-plus-2025-07-22","provider":"qwen"},{"id":"qwen3-coder-plus-2025-09-23","provider":"qwen"},{"id":"gpt-3.5-turbo-1106","provider":"openai"},{"id":"gpt-audio-mini","provider":"openai"},{"id":"gpt-audio-mini-2025-10-06","provider":"openai"},{"id":"gpt-audio-mini-2025-12-15","provider":"openai"},{"id":"qwen3-vl-235b-a22b-thinking","provider":"qwen"},{"id":"kimi-k2.6","provider":"moonshotai"},{"id":"qwen3-coder-480b-a35b-instruct","provider":"qwen"},{"id":"qwen3-max-2025-09-23","provider":"qwen"},{"id":"qwen3-max-preview","provider":"qwen"},{"id":"deepseek-v4-pro","provider":"deepseek"},{"id":"kimi-k2.7-code","provider":"moonshotai"},{"id":"gpt-5.4-mini","provider":"openai"},{"id":"gpt-5.4-mini-2026-03-17","provider":"openai"},{"id":"glm-5-turbo","provider":"z-ai"},{"id":"glm-5.3","provider":"z-ai"},{"id":"o3-mini","provider":"openai"},{"id":"o3-mini-2025-01-31","provider":"openai"},{"id":"o4-mini","provider":"openai"},{"id":"o4-mini-2025-04-16","provider":"openai"},{"id":"glm-5.1","provider":"z-ai"},{"id":"glm-5.2","provider":"z-ai"},{"id":"claude-haiku-4-5-20251001","provider":"anthropic"},{"id":"qwen3-max","provider":"qwen"},{"id":"qwen3-max-2026-01-23","provider":"qwen"},{"id":"kimi-k2.7-code-highspeed","provider":"moonshotai"},{"id":"gpt-4.1","provider":"openai"},{"id":"gpt-4.1-2025-04-14","provider":"openai"},{"id":"o3","provider":"openai"},{"id":"o3-2025-04-16","provider":"openai"},{"id":"gpt-5","provider":"openai"},{"id":"gpt-5-2025-08-07","provider":"openai"},{"id":"gpt-5-chat-latest","provider":"openai"},{"id":"gpt-5-codex","provider":"openai"},{"id":"gpt-5-search-api","provider":"openai"},{"id":"gpt-5.1","provider":"openai"},{"id":"gpt-5.1-2025-11-13","provider":"openai"},{"id":"gpt-5.1-chat-latest","provider":"openai"},{"id":"gpt-5.1-codex","provider":"openai"},{"id":"gpt-5.1-codex-max","provider":"openai"}]},{"key":"flagship","models":[{"id":"claude-sonnet-5","provider":"anthropic"},{"id":"claude-sonnet-5-5","provider":"anthropic"},{"id":"gpt-5.6-sol","provider":"openai"},{"id":"gpt-6-sol","provider":"openai"},{"id":"gpt-6.1-sol","provider":"openai"},{"id":"gpt-4o","provider":"openai"},{"id":"gpt-4o-2024-08-06","provider":"openai"},{"id":"gpt-4o-2024-11-20","provider":"openai"},{"id":"gpt-4o-search-preview","provider":"openai"},{"id":"gpt-4o-search-preview-2025-03-11","provider":"openai"},{"id":"gpt-audio","provider":"openai"},{"id":"gpt-audio-1.5","provider":"openai"},{"id":"gpt-audio-2025-08-28","provider":"openai"},{"id":"gpt-5.6-terra","provider":"openai"},{"id":"gpt-5.2","provider":"openai"},{"id":"gpt-5.2-2025-12-11","provider":"openai"},{"id":"gpt-5.2-chat-latest","provider":"openai"},{"id":"gpt-5.2-codex","provider":"openai"},{"id":"gpt-5.3-chat-latest","provider":"openai"},{"id":"gpt-5.3-codex","provider":"openai"},{"id":"gpt-5.4","provider":"openai"},{"id":"gpt-5.4-2026-03-05","provider":"openai"},{"id":"claude-sonnet-4-5-20250929","provider":"anthropic"},{"id":"claude-sonnet-4-6","provider":"anthropic"},{"id":"kimi-k3","provider":"moonshotai"},{"id":"gpt-4o-2024-05-13","provider":"openai"},{"id":"claude-opus-5-5","provider":"anthropic"},{"id":"claude-opus-4-5-20251101","provider":"anthropic"},{"id":"claude-opus-4-6","provider":"anthropic"},{"id":"claude-opus-4-7","provider":"anthropic"},{"id":"claude-opus-4-8","provider":"anthropic"},{"id":"claude-opus-5","provider":"anthropic"},{"id":"chat-latest","provider":"openai"},{"id":"gpt-5.5","provider":"openai"},{"id":"gpt-5.5-2026-04-23","provider":"openai"},{"id":"gpt-4-turbo","provider":"openai"},{"id":"gpt-4-turbo-2024-04-09","provider":"openai"},{"id":"claude-fable-5","provider":"anthropic"},{"id":"claude-fable-5-1","provider":"anthropic"},{"id":"gpt-6-astra","provider":"openai"},{"id":"o1","provider":"openai"},{"id":"o1-2024-12-17","provider":"openai"},{"id":"gpt-4","provider":"openai"},{"id":"gpt-4-0613","provider":"openai"},{"id":"gpt-5-pro","provider":"openai"},{"id":"gpt-5-pro-2025-10-06","provider":"openai"},{"id":"gpt-5.2-pro","provider":"openai"},{"id":"gpt-5.2-pro-2025-12-11","provider":"openai"},{"id":"gpt-5.4-pro","provider":"openai"},{"id":"gpt-5.4-pro-2026-03-05","provider":"openai"},{"id":"gpt-5.5-pro","provider":"openai"},{"id":"gpt-5.5-pro-2026-04-23","provider":"openai"},{"id":"o1-pro","provider":"openai"},{"id":"o1-pro-2025-03-19","provider":"openai"}]}]}';

export const PINNED_CATEGORIES_ANSWER = JSON.parse(
  PINNED_CATEGORIES_RAW_BODY,
) as CalculatorCategoriesDTO;

/** Where, when and on which engine versions the answer was taken. */
export const PINNED_VECTOR_BASIS = {
  endpoint: 'POST /v1/public/calculator/estimate',
  categoriesEndpoint: 'GET /v1/public/calculator/categories',
  host: 'https://motir-ai.fly.dev',
  /** UTC, when the estimate request was sent. */
  recordedAt: '2026-10-15T08:39:48Z',
  /** UTC, when the categories request was sent. */
  categoriesRecordedAt: '2026-10-15T08:39:35Z',
  engineVersion: 1,
  profilesVersion: '2026-10-12.1',
  categoryRuleVersion: '2026-10-14.1',
} as const;
