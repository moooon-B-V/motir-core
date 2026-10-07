import type { IdeaResearchRun } from '@/generated/prisma/client';
import type {
  IdeaEvidenceDto,
  IdeaResearchRunDto,
  IdeaTagRefDto,
  PublicIdeaDto,
  StaffIdeaDto,
  StaffIdeaTagDto,
} from '@/lib/dto/ideas';
import { IDEA_CATEGORY_LABELS } from '@/lib/ideas/categories';
import type { IdeaWithRelations } from '@/lib/repositories/ideaRepository';
import type { IdeaTagWithCount } from '@/lib/repositories/ideaTagRepository';

/**
 * Prisma rows → the idea store's DTOs (Story MOTIR-7662). The PUBLIC mapper
 * builds its object field by field rather than spreading the row, so a column
 * added to `idea` later can never reach an anonymous reader by accident.
 */

/** A `@db.Date` value as `YYYY-MM-DD` — the date the source names, no time zone. */
export function toIsoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toEvidenceDtos(row: IdeaWithRelations): IdeaEvidenceDto[] {
  return row.evidence.map((e) => ({
    claim: e.claim,
    sourceName: e.sourceName,
    url: e.url,
    sourceDate: toIsoDate(e.sourceDate),
  }));
}

function toTagRefs(row: IdeaWithRelations): IdeaTagRefDto[] {
  return row.tags
    .map((a) => ({ slug: a.tag.slug, label: a.tag.label }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function toPublicIdeaDto(row: IdeaWithRelations): PublicIdeaDto {
  return {
    slug: row.slug,
    title: row.title,
    pitch: row.pitch,
    kind: row.kind,
    category: { slug: row.category, label: IDEA_CATEGORY_LABELS[row.category] },
    tags: toTagRefs(row),
    capabilities: [...row.capabilities],
    evidence: toEvidenceDtos(row),
    gap: row.gap,
    whyNow: row.whyNow,
    whyMotir: row.whyMotir,
    whoElse: row.whoElse,
    addedAt: row.addedAt.toISOString(),
    lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
  };
}

export function toStaffIdeaDto(row: IdeaWithRelations): StaffIdeaDto {
  return {
    ...toPublicIdeaDto(row),
    id: row.id,
    status: row.status,
    retiredReason: row.retiredReason,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toStaffIdeaTagDto(row: IdeaTagWithCount): StaffIdeaTagDto {
  return {
    slug: row.slug,
    label: row.label,
    description: row.description,
    count: row._count.assignments,
  };
}

export function toIdeaResearchRunDto(row: IdeaResearchRun): IdeaResearchRunDto {
  return {
    id: row.id,
    ranAt: row.ranAt.toISOString(),
    actorUserId: row.actorUserId,
    areasCovered: [...row.areasCovered],
    addedCount: row.addedCount,
    retiredCount: row.retiredCount,
    reportMd: row.reportMd,
  };
}
