import type { Prisma, WorkItem } from '@/generated/prisma/client';
import type { ApprovalGateKindDTO, ApprovalGateRecordDTO } from '@/lib/dto/approvalGate';
import { toApprovalGateDecisionDto } from '@/lib/mappers/approvalGateMappers';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE TOKEN-AUTHED GATE READ (Bug MOTIR-6191) — one work item, one gate kind,
// the DECISION RECORD a programmatic caller gets back.
//
// ── The defect this closes ──────────────────────────────────────────────────
// `ApprovalGate.noteMd` is *"why they said yes, or what they sent back"*
// (`approval-gates.md` §6a). Every door onto it was SESSION-authed: the overlay's
// `GET /api/work-items/approval-gate` resolves `getActiveProject()` on its first
// line, the item page's `readDecisionGate` is a server component inside
// `(authed)`, `/api/v1` had no gate route at all and the MCP surface had no gate
// tool. So an agent holding a workspace PAT — or the narrower CLI grant — could
// not read the answer to the question it had been asked, and the asymmetry landed
// exactly where it hurts most: `decision_approval` is raised ONLY on a
// `type: decision` + `executor: coding_agent` card (§8's FIFTH AMENDMENT), so the
// one gate kind whose author is always an agent was the one kind whose refusal an
// agent could not read. The silent failure mode is the expensive one — an agent
// that cannot read WHY changes were requested acts on what it expects the
// reviewer objected to, and on a decision record or a design that produces a
// confident second wrong version with nothing anywhere going red.
//
// ── ⚠️ A READ. DECIDING IS UNCHANGED AND STAYS SESSION-ONLY ─────────────────
// Two questions live one sentence apart in the ADR and must not be merged. §2's
// *"the decide route is session-authed and no MCP tool or `/api/v1` operation
// asserts the key"* is about DECIDING, and it stays true verbatim: nothing here
// asserts `approval:decide_any`, nothing here writes a gate, and there is still
// no agent path to approving — *"and there is not meant to be"* (§1), because an
// agent-written approval would put a decision nobody made into the one table an
// audit trusts. READING a decision a person already made is the opposite
// question: it leaks no authority, and it is gated on the same `project:browse`
// the overlay's own read asserts.
//
// ── Why a separate access service ───────────────────────────────────────────
// `designAccessService` is the precedent, shape for shape (`design-result.md`
// AMENDMENT 5 Q6): ONE key-addressed method that BOTH agent doors call — the v1
// route and the MCP tool — so the two surfaces cannot drift on what a key means,
// on which gate wins, or on the 404-not-403 answer. It could not go on
// `approvalGatesService` itself: resolving a key needs `projectsService`, and
// `workItemsService` already imports `approvalGatesService`, so the composition
// has to sit ABOVE the gate engine rather than inside it.
//
// No `db`, no `$transaction` beyond the workspace binding, and no second
// derivation of anything: the gate is read through `getForWorkItem`, the frame's
// own read, and projected by the mapper.

/**
 * Resolve a `MOTIR-<n>` key to the work item, refusing anything this reader may
 * not see — with ONE answer for all four ways that happens.
 *
 * A malformed key, a project that does not exist, a project outside the token's
 * workspace and a project this reader may not browse are the SAME
 * `WorkItemNotFoundError`. That is the no-existence-leak contract the overlay's
 * route and `designAccessService.readVisibleItem` both state: a 403 would answer
 * *"it exists but you cannot see it"*, which is the one thing a read must not say.
 *
 * ⚠️ THE BROWSE GATE IS `projectsService.getByKey`'s, and it is the only one
 * needed. That call runs `projectAccessService.assertCanBrowse` on the project the
 * key names, and the item is then resolved WITHIN that project — so there is no
 * reachable path to an item in a project the reader was not gated on. A second
 * assertion here would be an arm no fixture can enter, and an unenterable arm in
 * an access check is worse than none: it reads as the protection while proving
 * nothing. The inventory row names the gate where it actually runs.
 */
async function readVisibleItem(
  key: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const dash = key.lastIndexOf('-');
  if (dash <= 0) throw new WorkItemNotFoundError(key);
  const project = await projectsService.getByKey(key.slice(0, dash), ctx).catch(() => null);
  if (!project) throw new WorkItemNotFoundError(key);
  const item = await workItemRepository.findByIdentifier(project.id, key, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(key);
  return item;
}

export const approvalGateAccessService = {
  /**
   * ONE gate's decision record, by the work item's key and the gate's kind.
   *
   * ⚠️ `gate: null` IS AN ANSWER: this card has no gate of that kind, so nothing
   * is waiting and nothing was decided. It is NOT a 404 — the card resolved, and
   * collapsing the two would tell a caller its key was wrong when the truth is
   * that the question it asked about has never been raised.
   *
   * ⚠️ WHICH gate, when a card holds several of one kind, is the repository's
   * ordering and not this service's choice — a LIVE question wins over a decided
   * one, and among decided ones the newest (`findLatestByWorkItem`). That is the
   * same gate the approval frame shows, which is the property that makes this
   * door's answer checkable against the page a person is looking at.
   */
  async getGateRecord(
    input: { key: string; kind: ApprovalGateKindDTO },
    ctx: ServiceContext,
  ): Promise<ApprovalGateRecordDTO> {
    const item = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      readVisibleItem(normalizeKey(input.key), ctx, tx),
    );
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: input.kind },
      ctx,
    );
    return {
      workItemKey: item.identifier,
      workItemTitle: item.title,
      kind: input.kind,
      gate: read.gate ? toApprovalGateDecisionDto(read.gate) : null,
      routedToLabel: read.routedToLabel,
    };
  },
};

/** The canonical upper-case form, so `motir-6157` and `MOTIR-6157` are one key. */
function normalizeKey(raw: string): string {
  return raw.trim().toUpperCase();
}
