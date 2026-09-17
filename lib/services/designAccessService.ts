import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { signedDownloadUrl } from '@/lib/blob/uploader';
import { DESIGN_APPROVAL_TARGET } from '@/lib/approvalGates/designResultHandler';
import { CANCELLED_STATUS_KEY } from '@/lib/workItems/provenanceBackfill';
import type { DesignEvidenceWithAssets } from '@/lib/mappers/designEvidenceMappers';
import { toApprovedDesignDto } from '@/lib/mappers/designAccessMappers';
import type {
  ApprovedDesignPageDto,
  DesignDownloadLinkDto,
  DesignVerdictDto,
  NoDesignReason,
} from '@/lib/dto/designAccess';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * The APPROVED-DESIGN read (Story MOTIR-5553 · Subtask MOTIR-5557) —
 * `docs/decisions/design-result.md` AMENDMENT 5 Q2–Q6.
 *
 * **The ONE read every design door uses.** The `/api/v1` design operations, the
 * `get_design` / `list_designs` MCP tools, the dispatched prompt's DESIGN
 * REFERENCE section and the CLI's `$MOTIR_DESIGN_DIR` all resolve *which design
 * counts* through this service and nowhere else. That is the whole reason it
 * exists as its own layer: Q2's ladder is subtle, and four independent readings
 * of it would be four chances to hand an agent a version nobody approved.
 *
 * **It exposes nothing and writes nothing.** No permission key is asserted here
 * — the doors assert `project:browse` — beyond the VISIBILITY gate every read
 * owes: a design card the caller may not see reads as not found, never as
 * forbidden, exactly as `attachmentsService.getContentRedirect` authorizes
 * against the owning work item.
 */

/** The `design_evidence` row the Q2 ladder resolved, and which arm found it. */
interface LadderHit {
  row: DesignEvidenceWithAssets;
  /** Which arm answered — carried for tests and for the prompt's provenance. */
  arm: 'gate_subject' | 'pin' | 'current';
}

/**
 * AMENDMENT 5 Q2's LADDER, resolved for a SET of design cards at once.
 *
 * ⚠️ THE ORDER IS THE DECISION, and each arm is the authority for a different
 * path rather than a fallback for the one above failing:
 *
 * 1. **the decided `approved` `design_result` gate's `subjectId`** — the audit
 *    of what a person actually decided. `designResultHandler.resolveSubject`
 *    refuses to re-point a gate at a newer version; this refuses for the same
 *    reason, one read further out.
 * 2. **the newest pinned row** — AMENDMENT 4 Q8's path, where a design card with
 *    an open delivering pull request raises NO `design_result` gate at all
 *    (`currentSubject` returns null on it) and the approve-to-merge gate decides
 *    it instead. `approvalGatesService.decide` pins the current row on EVERY
 *    approving kind, so the pin is what that decision left behind.
 * 3. **the current row** — a `done` design card no gate ever decided.
 *
 * ⚠️ ARM 1 DOES NOT FALL THROUGH WHEN ITS ROW'S BYTES ARE GONE. `decide` pins
 * the row that is CURRENT at decision time rather than the row the gate asked
 * about, and reports the difference as `filesKept: false`; the orphan-GC then
 * reclaims the approved row's attachments. Falling to arm 2 there would hand a
 * run a version nobody approved — the failure Q2 exists to prevent — so the
 * approved version is returned with its assets `unavailable` instead (Q6).
 */
async function resolveLadder(
  designCardIds: string[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, LadderHit>> {
  if (designCardIds.length === 0) return new Map();

  const [gates, pinned, current] = await Promise.all([
    approvalGateRepository.findLatestApprovedByWorkItems(designCardIds, 'design_result', tx),
    designEvidenceRepository.findNewestPinnedByWorkItems(designCardIds, tx),
    designEvidenceRepository.findCurrentByWorkItems(designCardIds, tx),
  ]);

  // Arm 1's subject ids resolve in ONE batched read, not one per card.
  const subjectRows = await designEvidenceRepository.findManyWithAssetsByIds(
    [...gates.values()].map((gate) => gate.subjectId),
    tx,
  );

  const hits = new Map<string, LadderHit>();
  for (const id of designCardIds) {
    const gate = gates.get(id);
    const subject = gate ? subjectRows.get(gate.subjectId) : undefined;
    // ⚠️ THE `workItemId` IS A GUARD, NOT A LOOKUP KEY — the same guard
    // `designEvidenceService.getForGateSubject` carries: a gate and its evidence
    // are joined by convention, so a row belonging to a different card is not
    // this card's approved design.
    if (subject && subject.workItemId === id) {
      hits.set(id, { row: subject, arm: 'gate_subject' });
      continue;
    }
    const pin = pinned.get(id);
    if (pin) {
      hits.set(id, { row: pin, arm: 'pin' });
      continue;
    }
    const head = current.get(id);
    if (head) hits.set(id, { row: head, arm: 'current' });
  }
  return hits;
}

/**
 * The verdict for one design card, given the ladder's answer and the project's
 * resolved status keys. Pure — every read it needs has already happened.
 */
function verdictFor(
  card: WorkItem,
  hit: LadderHit | undefined,
  hasAnyResult: boolean,
  keys: { doneKey: string | null; cancelledKey: string | null },
): DesignVerdictDto {
  const base = { designCardKey: card.identifier, designCardTitle: card.title };

  const noDesign = (reason: NoDesignReason): DesignVerdictDto => ({
    verdict: 'not_approved',
    ...base,
    reason,
  });

  if (card.type !== 'design') return noDesign('not_a_design_card');
  if (keys.cancelledKey !== null && card.status === keys.cancelledKey) return noDesign('cancelled');
  // ⚠️ THE STATUS KEY, NOT THE DONE CATEGORY — `cancelled` sits in that category
  // (AMENDMENT 5 Q2), and `approved` is not enough: it is the state in which the
  // publish window §6c's second amendment left open is still open.
  if (keys.doneKey === null || card.status !== keys.doneKey) return noDesign('not_done');
  if (!hit) return noDesign(hasAnyResult ? 'withdrawn' : 'no_result');
  // Arm 1 can name a row that was later taken back; arms 2 and 3 exclude
  // withdrawn rows in the query, so this only ever fires for the gate subject.
  if (hit.row.withdrawnAt !== null) return noDesign('withdrawn');

  return { verdict: 'approved', ...base, design: toApprovedDesignDto(card, hit.row) };
}

/** The status keys Q2's verdict turns on, resolved once per project. */
async function statusKeysFor(
  projectId: string,
  workspaceId: string,
): Promise<{ doneKey: string | null; cancelledKey: string | null }> {
  const [doneKey, cancelledKey] = await Promise.all([
    // The same intent `designResultHandler` approves into, so *approved* and
    // *what a run may build against* can never mean two different statuses.
    workflowsService.resolveStatusKey(projectId, workspaceId, DESIGN_APPROVAL_TARGET),
    workflowsService.resolveStatusKey(projectId, workspaceId, {
      key: CANCELLED_STATUS_KEY,
      category: 'done',
    }),
  ]);
  return { doneKey, cancelledKey };
}

/**
 * Resolve a work item by key and refuse it as NOT FOUND unless the caller may
 * browse its project — the 404-not-403 contract every design read inherits.
 */
async function readVisibleItem(
  key: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const projectKey = key.slice(0, key.lastIndexOf('-'));
  const project = await projectsService.getByKey(projectKey, ctx).catch(() => null);
  if (!project) throw new WorkItemNotFoundError(key);
  const item = await workItemRepository.findByIdentifier(project.id, key, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(key);
  const caps = await projectAccessService.getAttachmentCapabilities(item.projectId, ctx, tx);
  if (!caps.canBrowse) throw new WorkItemNotFoundError(key);
  return item;
}

export const designAccessService = {
  /**
   * Every design card the given work item is `blocked_by`, with its verdict —
   * AMENDMENT 5 Q4, *what a run is handed by default*.
   *
   * The edge read is the one `dispatchPromptService.resolveBlockerKeys` already
   * makes, so the designs a prompt names and the blockers it lists can never
   * disagree about what this card waits on. Ordered by key.
   *
   * ⚠️ A NON-`design` BLOCKER IS RETURNED AS `not_a_design_card`, NOT FILTERED
   * OUT. A consumer asking *what designs does this card wait on* is entitled to
   * the same answer whichever blocker it names, and a filtered list cannot tell
   * *this blocker is not a design* from *this design has no result*.
   */
  async designsForWorkItem(workItemKey: string, ctx: ServiceContext): Promise<DesignVerdictDto[]> {
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const item = await readVisibleItem(workItemKey, ctx, tx);
      const links = await workItemLinkRepository.findByFromItem(item.id, 'is_blocked_by', tx);
      const blockers = await workItemRepository.findByIds(
        links.map((link) => link.toId),
        tx,
      );
      // Only a `design` card can hold a design result, so the ladder and the
      // has-any read are asked about those alone; a non-design blocker still
      // gets its verdict from the pure function below.
      const designCards = blockers.filter((row) => row.type === 'design');
      const ids = designCards.map((row) => row.id);
      const [hits, withAnyResult, keys] = await Promise.all([
        resolveLadder(ids, tx),
        designEvidenceRepository.findWorkItemIdsWithAnyResult(ids, tx),
        statusKeysFor(item.projectId, ctx.workspaceId),
      ]);
      return blockers
        .slice()
        .sort((a, b) => a.key - b.key)
        .map((card) => verdictFor(card, hits.get(card.id), withAnyResult.has(card.id), keys));
    });
  },

  /** ONE design card's verdict, by its key — AMENDMENT 5 Q6's `get_design` read. */
  async getApprovedDesign(designCardKey: string, ctx: ServiceContext): Promise<DesignVerdictDto> {
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const card = await readVisibleItem(designCardKey, ctx, tx);
      const ids = card.type === 'design' ? [card.id] : [];
      const [hits, withAnyResult, keys] = await Promise.all([
        resolveLadder(ids, tx),
        designEvidenceRepository.findWorkItemIdsWithAnyResult(ids, tx),
        statusKeysFor(card.projectId, ctx.workspaceId),
      ]);
      return verdictFor(card, hits.get(card.id), withAnyResult.has(card.id), keys);
    });
  },

  /**
   * A page of a project's APPROVED designs, newest first — AMENDMENT 5 Q6's
   * `list_designs`. Only approved ones: a design still under review is not
   * something to browse into and build against.
   *
   * `pathPrefix` filters on an asset's `sourcePath`, which is how a delta mock's
   * amended BASE is found (Q6); `query` is a case-insensitive substring of the
   * design card's title.
   *
   * ⚠️ THE CURSOR IS THE CARD's `key`, DESCENDING — stable under concurrent
   * publishes, which a `publishedAt` cursor would not be: a republish moves a
   * card's newest result forward in time and would walk it across page
   * boundaries, showing it twice or not at all. A card's key never moves.
   */
  async listApprovedDesigns(
    projectKey: string,
    opts: { pathPrefix?: string; query?: string; cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<ApprovedDesignPageDto> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const project = await projectsService.getByKey(projectKey, ctx);
      const caps = await projectAccessService.getAttachmentCapabilities(project.id, ctx, tx);
      if (!caps.canBrowse) throw new WorkItemNotFoundError(projectKey);
      const keys = await statusKeysFor(project.id, ctx.workspaceId);
      if (keys.doneKey === null) return { designs: [], nextCursor: null };

      const cursorKey = opts.cursor ? Number(opts.cursor) : null;
      // One page of CANDIDATES — `design` cards at the project's done status.
      // Over-read by one so `nextCursor` reports the truth rather than guessing
      // from a full page.
      const candidates = await workItemRepository.findByProjectTypeAndStatusPage(
        project.id,
        {
          type: 'design',
          statusKey: keys.doneKey,
          ...(cursorKey !== null ? { beforeKey: cursorKey } : {}),
          ...(opts.query ? { titleContains: opts.query } : {}),
        },
        limit + 1,
        tx,
      );

      const page = candidates.slice(0, limit);
      const ids = page.map((row) => row.id);
      const hits = await resolveLadder(ids, tx);

      const designs = page.flatMap((card) => {
        const hit = hits.get(card.id);
        if (!hit || hit.row.withdrawnAt !== null) return [];
        const dto = toApprovedDesignDto(card, hit.row);
        if (opts.pathPrefix && !dto.assets.some((a) => a.sourcePath.startsWith(opts.pathPrefix!))) {
          return [];
        }
        return [dto];
      });

      // ⚠️ THE CURSOR ADVANCES OVER CANDIDATES, NOT OVER RESULTS. A `done`
      // design card with no approved design, or one every asset filter dropped,
      // is still a card this page CONSUMED — resuming from the last card
      // RETURNED would re-walk it for ever when a whole page filters out.
      const last = page[page.length - 1];
      const nextCursor = candidates.length > limit && last ? String(last.key) : null;
      return { designs, nextCursor };
    });
  },

  /**
   * Short-lived download links for one approved version's assets — AMENDMENT 5
   * Q6. `signedDownloadUrl`'s 300-second presign, the same one the attachment
   * content route mints.
   *
   * ⚠️ AN `unavailable` ASSET GETS NO LINK AND NO ENTRY, rather than a link that
   * 404s. It is already reported `unavailable` on the design itself (Q6), so the
   * absence here is legible; a signed URL to a reclaimed object is not.
   *
   * Authorized against the OWNING design card, so an evidence id from another
   * workspace or a card the caller cannot browse reads as not found.
   */
  async downloadLinks(evidenceId: string, ctx: ServiceContext): Promise<DesignDownloadLinkDto[]> {
    const assets = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const rows = await designEvidenceRepository.findManyWithAssetsByIds([evidenceId], tx);
      const row = rows.get(evidenceId);
      if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(evidenceId);
      const card = await workItemRepository.findById(row.workItemId, tx);
      if (!card) throw new WorkItemNotFoundError(evidenceId);
      const caps = await projectAccessService.getAttachmentCapabilities(card.projectId, ctx, tx);
      if (!caps.canBrowse) throw new WorkItemNotFoundError(evidenceId);
      return row.assets;
    });

    // The presigns happen OUTSIDE the transaction: they are network calls to the
    // object store, and the one-method-one-transaction rule yields to the
    // no-network-inside-an-open-transaction rule exactly as `attachmentsService`
    // documents for its upload path.
    const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString();
    const links: DesignDownloadLinkDto[] = [];
    for (const asset of assets) {
      if (!asset.attachment) continue;
      links.push({
        sourcePath: asset.sourcePath,
        fileName: basenameOf(asset.sourcePath),
        url: await signedDownloadUrl(asset.attachment.blobPathname, { download: true }),
        expiresAt,
      });
    }
    return links;
  },
};

/** The presign's lifetime, as `signedDownloadUrl` mints it (ADR §5). */
const DOWNLOAD_TTL_SECONDS = 300;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** `design/work-items/detail.mock.html` → `detail.mock.html`. */
export function basenameOf(sourcePath: string): string {
  return sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
}
