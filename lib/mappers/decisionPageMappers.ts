import type { DecisionPagePublicationDto } from '@/lib/dto/decisionPage';
import type { DecisionPagePublicationRecord } from '@/lib/repositories/decisionPagePublicationRepository';

/** A publication row plus what the service read beside it → the wire shape. */
export function toDecisionPagePublicationDto(
  publication: DecisionPagePublicationRecord,
  extra: {
    workItemKey: string;
    pageTitle: string;
    versionNumber: number;
    sealedAt: Date;
    publishedByName: string | undefined;
    gateId: string | null;
    replayed: boolean;
  },
): DecisionPagePublicationDto {
  return {
    id: publication.id,
    workItemId: publication.workItemId,
    workItemKey: extra.workItemKey,
    pageId: publication.pageId,
    pageTitle: extra.pageTitle,
    versionId: publication.pageVersionId,
    versionNumber: extra.versionNumber,
    sealedAt: extra.sealedAt.toISOString(),
    publishedAt: publication.publishedAt.toISOString(),
    publishedById: publication.publishedById,
    publishedByName: extra.publishedByName ?? '',
    gateId: extra.gateId,
    replayed: extra.replayed,
  };
}
