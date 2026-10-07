import type { IdeaCategory, IdeaKind } from '@/generated/prisma/client';
import type { PlatformPrincipal } from '@/lib/platform/auth';

/**
 * The idea store's service-level types (Story MOTIR-7662).
 *
 * `IdeaActor` is what the ideas gate (`lib/platform/ideasGate.ts`) hands the
 * staff service: the platform principal PLUS the credential that carried the
 * request, so every audit row can name both the person and the credential
 * (`docs/decisions/platform-staff-auth.md` §2, the 2026-10-07 amendment).
 */

/** The credential a staff request arrived with. Never the token's secret. */
export type IdeaCredential = { kind: 'session' } | { kind: 'token'; apiTokenId: string };

/** The acting staff member on an ideas endpoint or console action. */
export interface IdeaActor extends PlatformPrincipal {
  credential: IdeaCredential;
}

/** One sourced claim, as the staff side writes it. `sourceDate` is `YYYY-MM-DD`. */
export interface IdeaEvidenceInput {
  claim: string;
  sourceName: string;
  url: string;
  sourceDate?: string | null;
}

/** One new idea, as a batch add carries it. Tags are EXISTING vocabulary slugs. */
export interface IdeaInput {
  slug: string;
  title: string;
  pitch: string;
  kind: IdeaKind;
  category: IdeaCategory;
  tags?: string[];
  capabilities?: string[];
  evidence?: IdeaEvidenceInput[];
  gap?: string | null;
  whyNow?: string | null;
  whyMotir?: string | null;
  whoElse?: string | null;
}

/**
 * A sparse edit. `evidence` and `tags` REPLACE the list wholesale when given;
 * `reviewed: true` stamps `lastReviewedAt` (the skill's retirement review).
 */
export interface IdeaPatch {
  title?: string;
  pitch?: string;
  kind?: IdeaKind;
  category?: IdeaCategory;
  tags?: string[];
  capabilities?: string[];
  evidence?: IdeaEvidenceInput[];
  gap?: string | null;
  whyNow?: string | null;
  whyMotir?: string | null;
  whoElse?: string | null;
  reviewed?: boolean;
  /** The audit row's reason; defaults to one derived from the credential. */
  reason?: string | null;
}

/** A new vocabulary tag. `description` is the stated reason the tag exists. */
export interface IdeaTagInput {
  slug: string;
  label: string;
  description: string;
}

/** One research run of the `motir-ideas` skill. */
export interface IdeaResearchRunInput {
  areasCovered: string[];
  addedCount: number;
  retiredCount: number;
  reportMd: string;
}

/** The staff list's filters — every status unless one is named. */
export interface StaffIdeaFilters {
  status?: 'active' | 'retired';
  kind?: IdeaKind;
  category?: IdeaCategory;
  tag?: string;
  q?: string;
  cursor?: string | null;
  limit?: number;
}

/** The public list's filters — always active ideas only. */
export interface PublicIdeaFilters {
  category?: string;
  tags?: string[];
  q?: string;
  kind?: string;
}
