import { createHash } from 'node:crypto';
import type { PlanItem, Prisma } from '@/generated/prisma/client';
import type { StampInputs } from '@/lib/approvalGates/stamp';
import { planItemRepository } from '@/lib/repositories/planItemRepository';

// THE PLAN GATE'S SUBJECT VERSION — a digest of the PROPOSAL SET (Story MOTIR-6012 ·
// Subtask MOTIR-6035; ADR `docs/decisions/approval-gates.md` §11.3).
//
// ⚠️ THE ONLY DEFINITION IN THE REPO, and it sits beside `stamp.ts` for the reason that
// file gives for itself: the render read (`approvalGatesService.getForPlan`) and the
// decide door (through `planApprovalGateHandler.subjectVersion`) both call it, and two
// implementations would be two answers to *did this change?*.
//
// ⚠️ ITS INPUTS ARE ENUMERATED BY §11.3 AND NOTHING ELSE. Every `PlanItem` of the plan,
// sorted by id (byte order), each as exactly `{ id, op, workItemId, parentRef,
// blockedByRefs, proposedFields, patch, baseRevision }`. The CONTENT is hashed because a
// deepen or a correction rewrites a proposal in place — an id-only digest would not move
// over a corrected proposal, which is the case the stamp exists to catch. EXCLUDED on
// purpose: `createdAt`, `workspaceId`, `planId`, and the plan's `title`, `summary` and
// `status` (the status is a precondition the handler refuses on, not content).
//
// ⚠️ DERIVED, NEVER STORED. A revision leaves the plan `planned` and the gate `awaiting`
// (§11.5c), so the version moves IN PLACE: it is recomputed each time it is asked for.

/** The version prefix — a later change to the inputs is `plan.v2.`, never a silent edit. */
export const PLAN_DIGEST_PREFIX = 'plan.v1.';

/** The columns of a proposal the digest reads — exactly §11.3's list. */
export type PlanDigestRow = Pick<
  PlanItem,
  | 'id'
  | 'op'
  | 'workItemId'
  | 'parentRef'
  | 'blockedByRefs'
  | 'proposedFields'
  | 'patch'
  | 'baseRevision'
>;

/**
 * `JSON.stringify` over a copy in which every OBJECT's keys are sorted by UTF-16 code
 * unit order, recursively, with no whitespace. `null` stays `null` (a database NULL is
 * never an omitted key) and array order is kept as stored.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalCopy(value));
}

function canonicalCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCopy);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // `Array.prototype.sort` with no comparator orders by UTF-16 code units.
    for (const key of Object.keys(source).sort()) out[key] = canonicalCopy(source[key]);
    return out;
  }
  return value;
}

/** Byte-string order of two ids (UTF-8), as §11.3 names it — not locale order. */
function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** THE DIGEST of one plan's proposal set — pure, so a golden fixture can pin it. */
export function planProposalDigest(rows: readonly PlanDigestRow[]): string {
  const proposals = [...rows]
    .sort((a, b) => byBytes(a.id, b.id))
    .map((row) => ({
      id: row.id,
      op: row.op,
      workItemId: row.workItemId ?? null,
      parentRef: row.parentRef ?? null,
      blockedByRefs: row.blockedByRefs,
      proposedFields: row.proposedFields ?? null,
      patch: row.patch ?? null,
      baseRevision: row.baseRevision ?? null,
    }));
  return (
    PLAN_DIGEST_PREFIX + createHash('sha256').update(canonicalJson({ proposals })).digest('hex')
  );
}

/** The plan's CURRENT subject version, read in the caller's transaction. */
export async function planSubjectVersion(
  planId: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  return planProposalDigest(await planItemRepository.findByPlan(planId, tx));
}

/**
 * The stamp's inputs for a plan gate (§11.3): the digest as the subject, and nothing
 * else — a plan gate has no companion merge gate and no card body.
 */
export function planGateStampInputs(subjectVersion: string | null): StampInputs {
  return { subjectVersion, companionSubjectVersion: null, descriptionMd: null };
}
