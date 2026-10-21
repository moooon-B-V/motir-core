interface RecordedEstimate {
  version: number;
  kind: 'estimate';
  profilesVersion: string;
  categoryRuleVersion: string;
  cadence: 'annual' | 'monthly';
  credits: { low: number; high: number };
  perItemCredits: { planning: number; running: number };
  split: { count: number; categories: { key: string; weight: number; models: string[] }[] };
  recommendation: { planKey: string | null; planName: string | null; monthlyPriceUsd: number };
  topUp: {
    low: { units: number; credits: number; priceUsd: number };
    high: { units: number; credits: number; priceUsd: number };
  };
  ceiling: {
    credits: number | null;
    exceeded: boolean;
    excessCredits: number;
    outcome: 'within_ladder' | 'larger_pool' | 'top_ups_only';
  };
}
interface RecordedCategories {
  version: number;
  categoryRuleVersion: string;
  modelsReadAt: string;
  cadences: ('annual' | 'monthly')[];
  defaultCadence: 'annual' | 'monthly';
  categories: { key: string; models: { id: string; provider: string }[] }[];
}

// THE PINNED CROSS-SURFACE ESTIMATE VECTOR (Story MOTIR-8381 · MOTIR-9005).
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
// Recorded on the category contract (v2): a request names 1–3 model CATEGORIES,
// and the answer carries the equal `split` over them and the `ceiling.outcome`.
// On the day it was taken the live engine answered `top_ups_only` for this
// request, so that is what is pinned; it is not edited towards `larger_pool`.
//
// Not a spec file (no `.test.`), so a suite imports it rather than running it.
// Consumed by the Calculator's rendering check (MOTIR-8643).
//
// How it was recorded (re-record the same way, then replace all five exports):
//   curl -sS https://motir-ai.fly.dev/v1/public/calculator/categories
//   curl -sS -X POST -H 'content-type: application/json' \
//     --data '<PINNED_CALCULATOR_REQUEST as JSON>' \
//     https://motir-ai.fly.dev/v1/public/calculator/estimate

/** The shared input: one items-per-month range, two categories, one cadence. */
export const PINNED_CALCULATOR_REQUEST = {
  itemsPerMonth: { low: 20, high: 60 },
  categories: ['balanced', 'flagship'],
  cadence: 'annual',
} as const;

/** The engine's response body to that request, byte for byte as it answered. */
export const PINNED_ESTIMATE_RAW_BODY =
  '{"version":2,"kind":"estimate","profilesVersion":"2026-10-12.1","categoryRuleVersion":"2026-10-14.1","cadence":"annual","credits":{"low":1816158,"high":10896947},"perItemCredits":{"planning":10370.907718933602,"running":80436.9781677741},"split":{"count":2,"categories":[{"key":"balanced","weight":0.5,"models":["gpt-5-mini","gpt-5-mini-2025-08-07","gpt-5.1-codex-mini","qwen3-235b-a22b-thinking-2507","glm-4.7","deepseek-v4-pro","glm-4.5","glm-4.6","qwen3-coder-plus","qwen3-coder-plus-2025-07-22","qwen3-coder-plus-2025-09-23","gpt-3.5-turbo-1106","gpt-audio-mini","gpt-audio-mini-2025-10-06","gpt-audio-mini-2025-12-15","qwen3-vl-235b-a22b-thinking","kimi-k2.6","glm-5","qwen3-coder-480b-a35b-instruct","qwen3-max-2025-09-23","qwen3-max-preview","kimi-k2.7-code","gpt-5.4-mini","gpt-5.4-mini-2026-03-17","glm-5-turbo","o3-mini","o3-mini-2025-01-31","o4-mini","o4-mini-2025-04-16","glm-5.1","glm-5.2","claude-haiku-4-5-20251001","qwen3-max","qwen3-max-2026-01-23","kimi-k2.7-code-highspeed","gpt-4.1","gpt-4.1-2025-04-14","o3","o3-2025-04-16","gpt-5","gpt-5-2025-08-07","gpt-5-chat-latest","gpt-5-codex","gpt-5-search-api","gpt-5.1","gpt-5.1-2025-11-13","gpt-5.1-chat-latest","gpt-5.1-codex","gpt-5.1-codex-max","claude-sonnet-5","claude-sonnet-5-5","gpt-6-sol","gpt-6.1-sol"]},{"key":"flagship","weight":0.5,"models":["gpt-4o","gpt-4o-2024-08-06","gpt-4o-2024-11-20","gpt-4o-search-preview","gpt-4o-search-preview-2025-03-11","gpt-audio","gpt-audio-1.5","gpt-audio-2025-08-28","gpt-5.6-terra","gpt-5.2","gpt-5.2-2025-12-11","gpt-5.2-chat-latest","gpt-5.2-codex","gpt-5.3-chat-latest","gpt-5.3-codex","gpt-5.4","gpt-5.4-2026-03-05","claude-sonnet-4-5-20250929","claude-sonnet-4-6","kimi-k3","gpt-4o-2024-05-13","claude-opus-5-5","gpt-5.6-sol","claude-opus-4-5-20251101","claude-opus-4-6","claude-opus-4-7","claude-opus-4-8","claude-opus-5","chat-latest","gpt-5.5","gpt-5.5-2026-04-23","gpt-4-turbo","gpt-4-turbo-2024-04-09","claude-fable-5","claude-fable-5-1","gpt-6-astra","o1","o1-2024-12-17","gpt-4","gpt-4-0613","gpt-5-pro","gpt-5-pro-2025-10-06","gpt-5.2-pro","gpt-5.2-pro-2025-12-11","gpt-5.4-pro","gpt-5.4-pro-2026-03-05","gpt-5.5-pro","gpt-5.5-pro-2026-04-23","o1-pro","o1-pro-2025-03-19"]}]},"recommendation":{"planKey":"max_x2","planName":"Max ×2","monthlyPriceUsd":200},"topUp":{"low":{"units":1757,"credits":1757000,"priceUsd":8785},"high":{"units":10837,"credits":10837000,"priceUsd":54185}},"ceiling":{"credits":60000,"exceeded":true,"excessCredits":10836947,"outcome":"top_ups_only"}}';

/** The same answer as a value — must deep-equal `JSON.parse(PINNED_ESTIMATE_RAW_BODY)`. */
export const PINNED_ESTIMATE_ANSWER = JSON.parse(PINNED_ESTIMATE_RAW_BODY) as RecordedEstimate;

/** The categories answer read just before, so the selections can be shown to have been live. */
export const PINNED_CATEGORIES_RAW_BODY =
  '{"version":2,"categoryRuleVersion":"2026-10-14.1","modelsReadAt":"2026-10-21T15:16:06.388Z","cadences":["annual","monthly"],"defaultCadence":"annual","categories":[{"key":"economy","models":[{"id":"glm-5.3-flash","provider":"z-ai"},{"id":"deepseek-v4-flash","provider":"qwen"},{"id":"gpt-5-nano","provider":"openai"},{"id":"gpt-5-nano-2025-08-07","provider":"openai"},{"id":"qwen3-vl-flash","provider":"qwen"},{"id":"qwen3-vl-flash-2025-10-15","provider":"qwen"},{"id":"qwen3-vl-flash-2026-01-22","provider":"qwen"},{"id":"gpt-4.1-nano","provider":"openai"},{"id":"gpt-4.1-nano-2025-04-14","provider":"openai"},{"id":"qwen-plus-2025-07-28","provider":"qwen"},{"id":"qwen-plus-2025-09-11","provider":"qwen"},{"id":"qwen3-30b-a3b","provider":"qwen"},{"id":"qwen3-30b-a3b-instruct-2507","provider":"qwen"},{"id":"qwen3-8b","provider":"qwen"},{"id":"qwen3-vl-30b-a3b-instruct","provider":"qwen"},{"id":"qwen3-vl-8b-instruct","provider":"qwen"},{"id":"qwen3.5-flash","provider":"qwen"},{"id":"qwen3.5-flash-2026-02-23","provider":"qwen"},{"id":"claude-haiku-5-5","provider":"anthropic"},{"id":"gpt-6-luna","provider":"openai"},{"id":"qwen3.8-flash","provider":"qwen"},{"id":"deepseek-flash","provider":"deepseek"},{"id":"gpt-4o-mini","provider":"openai"},{"id":"gpt-4o-mini-2024-07-18","provider":"openai"},{"id":"gpt-4o-mini-search-preview","provider":"openai"},{"id":"gpt-4o-mini-search-preview-2025-03-11","provider":"openai"},{"id":"qwen3-next-80b-a3b-instruct","provider":"qwen"},{"id":"qwen3-32b","provider":"qwen"},{"id":"qwen3-vl-32b-instruct","provider":"qwen"},{"id":"qwen3-vl-32b-thinking","provider":"qwen"},{"id":"qwen3-30b-a3b-thinking-2507","provider":"qwen"},{"id":"qwen3-vl-30b-a3b-thinking","provider":"qwen"},{"id":"qwen3-vl-8b-thinking","provider":"qwen"},{"id":"glm-4.5-air","provider":"z-ai"},{"id":"qwen3-235b-a22b-instruct-2507","provider":"qwen"},{"id":"qwen3-coder-30b-a3b-instruct","provider":"qwen"},{"id":"qwen3-next-80b-a3b-thinking","provider":"qwen"},{"id":"qwen3-vl-plus-2025-09-23","provider":"qwen"},{"id":"gpt-5.6-luna","provider":"openai"},{"id":"qwen3-235b-a22b","provider":"qwen"},{"id":"qwen3-vl-235b-a22b-instruct","provider":"qwen"},{"id":"gpt-5.4-nano","provider":"openai"},{"id":"gpt-5.4-nano-2026-03-17","provider":"openai"},{"id":"qwen-plus","provider":"qwen"},{"id":"qwen-plus-2025-12-01","provider":"qwen"},{"id":"glm-5.3","provider":"z-ai"},{"id":"glm-5.3-flashx","provider":"z-ai"},{"id":"qwen3-coder-next","provider":"qwen"},{"id":"gpt-4.1-mini","provider":"openai"},{"id":"gpt-4.1-mini-2025-04-14","provider":"openai"},{"id":"qwen3-vl-plus","provider":"qwen"},{"id":"gpt-3.5-turbo","provider":"openai"},{"id":"gpt-3.5-turbo-0125","provider":"openai"}]},{"key":"balanced","models":[{"id":"gpt-5-mini","provider":"openai"},{"id":"gpt-5-mini-2025-08-07","provider":"openai"},{"id":"gpt-5.1-codex-mini","provider":"openai"},{"id":"qwen3-235b-a22b-thinking-2507","provider":"qwen"},{"id":"glm-4.7","provider":"z-ai"},{"id":"deepseek-v4-pro","provider":"deepseek"},{"id":"glm-4.5","provider":"z-ai"},{"id":"glm-4.6","provider":"z-ai"},{"id":"qwen3-coder-plus","provider":"qwen"},{"id":"qwen3-coder-plus-2025-07-22","provider":"qwen"},{"id":"qwen3-coder-plus-2025-09-23","provider":"qwen"},{"id":"gpt-3.5-turbo-1106","provider":"openai"},{"id":"gpt-audio-mini","provider":"openai"},{"id":"gpt-audio-mini-2025-10-06","provider":"openai"},{"id":"gpt-audio-mini-2025-12-15","provider":"openai"},{"id":"qwen3-vl-235b-a22b-thinking","provider":"qwen"},{"id":"kimi-k2.6","provider":"moonshotai"},{"id":"glm-5","provider":"z-ai"},{"id":"qwen3-coder-480b-a35b-instruct","provider":"qwen"},{"id":"qwen3-max-2025-09-23","provider":"qwen"},{"id":"qwen3-max-preview","provider":"qwen"},{"id":"kimi-k2.7-code","provider":"moonshotai"},{"id":"gpt-5.4-mini","provider":"openai"},{"id":"gpt-5.4-mini-2026-03-17","provider":"openai"},{"id":"glm-5-turbo","provider":"z-ai"},{"id":"o3-mini","provider":"openai"},{"id":"o3-mini-2025-01-31","provider":"openai"},{"id":"o4-mini","provider":"openai"},{"id":"o4-mini-2025-04-16","provider":"openai"},{"id":"glm-5.1","provider":"z-ai"},{"id":"glm-5.2","provider":"z-ai"},{"id":"claude-haiku-4-5-20251001","provider":"anthropic"},{"id":"qwen3-max","provider":"qwen"},{"id":"qwen3-max-2026-01-23","provider":"qwen"},{"id":"kimi-k2.7-code-highspeed","provider":"moonshotai"},{"id":"gpt-4.1","provider":"openai"},{"id":"gpt-4.1-2025-04-14","provider":"openai"},{"id":"o3","provider":"openai"},{"id":"o3-2025-04-16","provider":"openai"},{"id":"gpt-5","provider":"openai"},{"id":"gpt-5-2025-08-07","provider":"openai"},{"id":"gpt-5-chat-latest","provider":"openai"},{"id":"gpt-5-codex","provider":"openai"},{"id":"gpt-5-search-api","provider":"openai"},{"id":"gpt-5.1","provider":"openai"},{"id":"gpt-5.1-2025-11-13","provider":"openai"},{"id":"gpt-5.1-chat-latest","provider":"openai"},{"id":"gpt-5.1-codex","provider":"openai"},{"id":"gpt-5.1-codex-max","provider":"openai"},{"id":"claude-sonnet-5","provider":"anthropic"},{"id":"claude-sonnet-5-5","provider":"anthropic"},{"id":"gpt-6-sol","provider":"openai"},{"id":"gpt-6.1-sol","provider":"openai"}]},{"key":"flagship","models":[{"id":"gpt-4o","provider":"openai"},{"id":"gpt-4o-2024-08-06","provider":"openai"},{"id":"gpt-4o-2024-11-20","provider":"openai"},{"id":"gpt-4o-search-preview","provider":"openai"},{"id":"gpt-4o-search-preview-2025-03-11","provider":"openai"},{"id":"gpt-audio","provider":"openai"},{"id":"gpt-audio-1.5","provider":"openai"},{"id":"gpt-audio-2025-08-28","provider":"openai"},{"id":"gpt-5.6-terra","provider":"openai"},{"id":"gpt-5.2","provider":"openai"},{"id":"gpt-5.2-2025-12-11","provider":"openai"},{"id":"gpt-5.2-chat-latest","provider":"openai"},{"id":"gpt-5.2-codex","provider":"openai"},{"id":"gpt-5.3-chat-latest","provider":"openai"},{"id":"gpt-5.3-codex","provider":"openai"},{"id":"gpt-5.4","provider":"openai"},{"id":"gpt-5.4-2026-03-05","provider":"openai"},{"id":"claude-sonnet-4-5-20250929","provider":"anthropic"},{"id":"claude-sonnet-4-6","provider":"anthropic"},{"id":"kimi-k3","provider":"moonshotai"},{"id":"gpt-4o-2024-05-13","provider":"openai"},{"id":"claude-opus-5-5","provider":"anthropic"},{"id":"gpt-5.6-sol","provider":"openai"},{"id":"claude-opus-4-5-20251101","provider":"anthropic"},{"id":"claude-opus-4-6","provider":"anthropic"},{"id":"claude-opus-4-7","provider":"anthropic"},{"id":"claude-opus-4-8","provider":"anthropic"},{"id":"claude-opus-5","provider":"anthropic"},{"id":"chat-latest","provider":"openai"},{"id":"gpt-5.5","provider":"openai"},{"id":"gpt-5.5-2026-04-23","provider":"openai"},{"id":"gpt-4-turbo","provider":"openai"},{"id":"gpt-4-turbo-2024-04-09","provider":"openai"},{"id":"claude-fable-5","provider":"anthropic"},{"id":"claude-fable-5-1","provider":"anthropic"},{"id":"gpt-6-astra","provider":"openai"},{"id":"o1","provider":"openai"},{"id":"o1-2024-12-17","provider":"openai"},{"id":"gpt-4","provider":"openai"},{"id":"gpt-4-0613","provider":"openai"},{"id":"gpt-5-pro","provider":"openai"},{"id":"gpt-5-pro-2025-10-06","provider":"openai"},{"id":"gpt-5.2-pro","provider":"openai"},{"id":"gpt-5.2-pro-2025-12-11","provider":"openai"},{"id":"gpt-5.4-pro","provider":"openai"},{"id":"gpt-5.4-pro-2026-03-05","provider":"openai"},{"id":"gpt-5.5-pro","provider":"openai"},{"id":"gpt-5.5-pro-2026-04-23","provider":"openai"},{"id":"o1-pro","provider":"openai"},{"id":"o1-pro-2025-03-19","provider":"openai"}]}]}';

export const PINNED_CATEGORIES_ANSWER = JSON.parse(
  PINNED_CATEGORIES_RAW_BODY,
) as RecordedCategories;

/** Where, when and on which engine versions the answer was taken. */
export const PINNED_VECTOR_BASIS = {
  endpoint: 'POST /v1/public/calculator/estimate',
  categoriesEndpoint: 'GET /v1/public/calculator/categories',
  host: 'https://motir-ai.fly.dev',
  /** UTC, when the estimate request was sent. */
  recordedAt: '2026-10-21T15:16:06Z',
  /** UTC, when the categories request was sent. */
  categoriesRecordedAt: '2026-10-21T15:16:05Z',
  engineVersion: 2,
  profilesVersion: '2026-10-12.1',
  categoryRuleVersion: '2026-10-14.1',
} as const;
