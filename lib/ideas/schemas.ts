import { z } from 'zod';
import type { IdeaCategory } from '@/generated/prisma/client';
import { IDEA_CATEGORIES, IDEA_SLUG_MAX, IDEA_SLUG_PATTERN } from './categories';
import { IDEA_LIMITS } from './limits';

/**
 * The request schemas of the STAFF ideas routes (`app/api/platform/ideas/**`,
 * Story MOTIR-7662 · MOTIR-7675) — the transport-level shape check. The service
 * still validates every rule that needs the database (a taken slug, an unknown
 * tag) and the kind-specific ones; this file refuses a malformed body before a
 * service is called, with the field path that was wrong.
 *
 * `docs/platform-ideas-api.md` is the human contract these encode.
 */

const categoryEnum = z.enum(IDEA_CATEGORIES as [IdeaCategory, ...IdeaCategory[]]);
const kindEnum = z.enum(['motir_buys', 'direction']);
const slug = z
  .string()
  .max(IDEA_SLUG_MAX)
  .regex(IDEA_SLUG_PATTERN, 'must be lower-case words joined by hyphens');
const longText = z.string().max(IDEA_LIMITS.longText).nullable().optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .nullable()
  .optional();

/** At most 2000 characters, the same ceiling the platform audit log allows a reason. */
const REASON_MAX = 2000;

export const ideaEvidenceSchema = z
  .object({
    claim: z.string().min(1).max(IDEA_LIMITS.claim),
    sourceName: z.string().min(1).max(IDEA_LIMITS.sourceName),
    url: z
      .string()
      .max(IDEA_LIMITS.url)
      .url()
      .refine((u) => u.startsWith('https://'), 'must be an https URL'),
    sourceDate: isoDate,
  })
  .strict();

export const ideaInputSchema = z
  .object({
    slug,
    title: z.string().min(1).max(IDEA_LIMITS.title),
    pitch: z.string().min(1).max(IDEA_LIMITS.pitch),
    kind: kindEnum,
    category: categoryEnum,
    tags: z.array(slug).max(IDEA_LIMITS.tags).optional(),
    capabilities: z
      .array(z.string().min(1).max(IDEA_LIMITS.capability))
      .max(IDEA_LIMITS.capabilities)
      .optional(),
    evidence: z.array(ideaEvidenceSchema).max(IDEA_LIMITS.evidence).optional(),
    gap: longText,
    whyNow: longText,
    whyMotir: longText,
    whoElse: longText,
  })
  .strict();

/** `POST /api/platform/ideas` — a batch of 1–20. */
export const addIdeasBodySchema = z
  .object({
    ideas: z.array(ideaInputSchema).min(1).max(20),
    reason: z.string().max(REASON_MAX).optional(),
  })
  .strict();

/** `PATCH /api/platform/ideas/[slug]` — every field optional; lists replace wholesale. */
export const ideaPatchBodySchema = ideaInputSchema
  .omit({ slug: true })
  .partial()
  .extend({
    reviewed: z.boolean().optional(),
    reason: z.string().max(REASON_MAX).nullable().optional(),
  })
  .strict();

/** `POST …/retire` and `DELETE /api/platform/ideas/[slug]` — a stated reason. */
export const reasonBodySchema = z
  .object({ reason: z.string().trim().min(1, 'is required').max(REASON_MAX) })
  .strict();

/** `POST /api/platform/ideas/tags`. A new tag needs a stated purpose. */
export const ideaTagBodySchema = z
  .object({
    slug,
    label: z.string().min(1).max(IDEA_LIMITS.tagLabel),
    description: z.string().trim().min(1, 'is required').max(IDEA_LIMITS.tagDescription),
  })
  .strict();

/** `POST /api/platform/ideas/runs`. */
export const researchRunBodySchema = z
  .object({
    areasCovered: z.array(z.string().min(1).max(200)).max(IDEA_LIMITS.areas),
    addedCount: z.number().int().min(0),
    retiredCount: z.number().int().min(0),
    reportMd: z.string().min(1).max(IDEA_LIMITS.reportMd),
  })
  .strict();

/** `GET /api/platform/ideas` query. */
export const staffIdeaQuerySchema = z.object({
  status: z.enum(['active', 'retired']).optional(),
  kind: kindEnum.optional(),
  category: categoryEnum.optional(),
  tag: z.string().max(IDEA_SLUG_MAX).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** `GET /api/platform/ideas/runs` query. */
export const researchRunQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
