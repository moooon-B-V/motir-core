import type { IdeaCategory, IdeaKind } from '@/generated/prisma/client';

/**
 * The display label of every idea category (Story MOTIR-7662). A
 * `Record<IdeaCategory, string>`, so adding a value to the Prisma enum without
 * a label here is a compile error rather than a blank chip on motir.co.
 */
export const IDEA_CATEGORY_LABELS: Record<IdeaCategory, string> = {
  legal: 'Legal',
  finance: 'Finance',
  security_compliance: 'Security & compliance',
  customer_support: 'Customer support',
  localization: 'Localization',
  growth_marketing: 'Growth & marketing',
  sales: 'Sales',
  people_hr: 'People & HR',
  operations: 'Operations',
  engineering: 'Engineering',
  ecommerce: 'E-commerce',
  healthcare: 'Healthcare',
  education: 'Education',
  financial_services: 'Financial services',
  real_estate: 'Real estate',
  logistics: 'Logistics',
  construction: 'Construction',
  agriculture: 'Agriculture',
  pets: 'Pets',
  family_care: 'Family care',
  public_sector: 'Public sector',
  personal_growth: 'Personal growth',
  personal_finance: 'Personal finance',
  health_wellness: 'Health & wellness',
  ai_infrastructure: 'AI infrastructure',
};

/** Every category, in the enum's (grouped) order. */
export const IDEA_CATEGORIES = Object.keys(IDEA_CATEGORY_LABELS) as IdeaCategory[];

/** Every kind. `motir_buys` first — the order the public list sorts by. */
export const IDEA_KINDS: readonly IdeaKind[] = ['motir_buys', 'direction'];

export function isIdeaCategory(value: string): value is IdeaCategory {
  return Object.hasOwn(IDEA_CATEGORY_LABELS, value);
}

export function isIdeaKind(value: string): value is IdeaKind {
  return (IDEA_KINDS as readonly string[]).includes(value);
}

/** The slug shape every idea and tag slug takes: lowercase words joined by `-`. */
export const IDEA_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const IDEA_SLUG_MAX = 80;
