import { designAccessService } from '@/lib/services/designAccessService';
import type { ApprovedDesignDto, DesignVerdictDto } from '@/lib/dto/designAccess';
import type { V1ApprovedDesign, V1DesignVerdict } from '@/lib/api/v1/workItems/schema';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Presenting a design verdict on `/api/v1` (Story MOTIR-5553 · Subtask
// MOTIR-5560).
//
// ⚠️ TWO presenters, and the difference between them is a DECISION rather than
// an oversight: a SINGLE-design read carries download links and a LIST does not.
// A presign lives 300 seconds, so a page of twenty-five designs would mint
// seventy-five links that begin expiring before the caller has read the page,
// almost none of which were wanted. The list is for FINDING a design; the single
// read is for fetching one.

/** One approved design WITHOUT links — the shape a list row carries. */
export function presentApprovedDesign(design: ApprovedDesignDto): V1ApprovedDesign {
  return {
    designCardKey: design.designCardKey,
    designCardTitle: design.designCardTitle,
    evidenceId: design.evidenceId,
    publishedAt: design.publishedAt,
    commitSha: design.commitSha,
    assets: design.assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      fileName: asset.fileName,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      state: asset.state,
    })),
  };
}

/**
 * One verdict, with a short-lived link on every `available` asset of an
 * `approved` verdict.
 *
 * ⚠️ `url` and `expiresAt` are OMITTED rather than nulled on an `unavailable`
 * asset. A null URL is a field a client has to special-case at the point of use;
 * an absent one is caught by the type. The asset still appears, with
 * `state: 'unavailable'` — an approved version whose bytes the orphan-GC
 * reclaimed is a real answer, and hiding the file would make it look as though
 * the design had never held one.
 */
export async function presentDesignVerdict(
  verdict: DesignVerdictDto,
  ctx: ServiceContext,
): Promise<V1DesignVerdict> {
  if (verdict.verdict !== 'approved') {
    return {
      verdict: 'not_approved',
      designCardKey: verdict.designCardKey,
      designCardTitle: verdict.designCardTitle,
      reason: verdict.reason,
    };
  }

  const links = await designAccessService.downloadLinks(verdict.design.evidenceId, ctx);
  const bySourcePath = new Map(links.map((link) => [link.sourcePath, link]));
  const base = presentApprovedDesign(verdict.design);

  return {
    verdict: 'approved',
    designCardKey: verdict.designCardKey,
    designCardTitle: verdict.designCardTitle,
    design: {
      ...base,
      assets: base.assets.map((asset) => {
        const link = asset.state === 'available' ? bySourcePath.get(asset.sourcePath) : undefined;
        return link ? { ...asset, url: link.url, expiresAt: link.expiresAt } : asset;
      }),
    },
  };
}
