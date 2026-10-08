import type { IdeaCategory, IdeaKind, IdeaStatus } from '@/generated/prisma/client';

/**
 * The idea store's DTOs (Story MOTIR-7662) — two contracts in one file, kept
 * apart on purpose:
 *
 *  - the PUBLIC contract (`PublicIdea*Dto`) is what `/api/public/ideas` serves
 *    anonymously and what motir.co builds against. It carries NO status, no
 *    retirement reason, no ids and no audit field — asserted by
 *    `tests/ideas/ideasPublicService.test.ts`. Change it additively only.
 *  - the STAFF contract (`StaffIdea*Dto` and friends) is what the console and the
 *    `motir-ideas` skill read over `/api/platform/ideas`: every status, the
 *    retirement record, the review stamp.
 */

/** A category with its display label. */
export interface IdeaCategoryRefDto {
  slug: IdeaCategory;
  label: string;
}

/** A tag with its display label. */
export interface IdeaTagRefDto {
  slug: string;
  label: string;
}

/** One sourced claim. `sourceDate` is `YYYY-MM-DD`, or null when the source has none. */
export interface IdeaEvidenceDto {
  claim: string;
  sourceName: string;
  url: string;
  sourceDate: string | null;
}

// ── PUBLIC ──────────────────────────────────────────────────────────────────

export interface PublicIdeaDto {
  slug: string;
  title: string;
  pitch: string;
  kind: IdeaKind;
  category: IdeaCategoryRefDto;
  tags: IdeaTagRefDto[];
  capabilities: string[];
  evidence: IdeaEvidenceDto[];
  gap: string | null;
  whyNow: string | null;
  whyMotir: string | null;
  whoElse: string | null;
  addedAt: string;
  lastReviewedAt: string | null;
}

export interface PublicIdeaCategoryCountDto extends IdeaCategoryRefDto {
  count: number;
}

export interface PublicIdeaListDto {
  items: PublicIdeaDto[];
  /** Counts over every filter EXCEPT `category`, so the chips stay choosable. */
  categories: PublicIdeaCategoryCountDto[];
  total: number;
}

export interface PublicIdeaTagDto extends IdeaTagRefDto {
  /** How many ACTIVE ideas carry the tag. */
  count: number;
}

// ── STAFF ───────────────────────────────────────────────────────────────────

export interface StaffIdeaDto extends Omit<PublicIdeaDto, 'addedAt'> {
  id: string;
  status: IdeaStatus;
  retiredReason: string | null;
  retiredAt: string | null;
  addedAt: string;
  updatedAt: string;
}

export interface StaffIdeaListDto {
  items: StaffIdeaDto[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

export interface StaffIdeaTagDto extends IdeaTagRefDto {
  description: string | null;
  /** Ideas of ANY status carrying the tag. */
  count: number;
}

export interface IdeaResearchRunDto {
  id: string;
  ranAt: string;
  actorUserId: string;
  areasCovered: string[];
  addedCount: number;
  retiredCount: number;
  reportMd: string;
}

export interface AddIdeasResultDto {
  slugs: string[];
}
