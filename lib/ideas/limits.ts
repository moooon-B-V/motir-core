/**
 * The idea store's field limits (Story MOTIR-7662) — ONE set of numbers, read by
 * both the staff service's validation (`ideasAdminService`) and the route body
 * schemas (`lib/ideas/schemas.ts`), so the two can never disagree.
 */
export const IDEA_LIMITS = {
  title: 120,
  pitch: 400,
  longText: 600,
  tags: 6,
  capabilities: 8,
  capability: 300,
  evidence: 10,
  claim: 400,
  sourceName: 200,
  url: 2000,
  tagLabel: 60,
  tagDescription: 400,
  reportMd: 20000,
  areas: 40,
} as const;
