import { z } from 'zod';
import { TEMP_REF_PREFIX, isTempRef } from '@/lib/plans/refs';

// Shared PLAN-PROJECTION plumbing for the MCP tools (Story MOTIR-3093 ·
// Subtask MOTIR-3095), the analogue of `workItemRef.ts` / `sprintRef.ts` for the
// one addressing question every projected call asks: WHICH plan am I projecting?
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 3 (MOTIR-3094) pins the
// answer — Q5, an EXPLICIT `planId` argument, per call, always optional, so a
// call that omits it never reaches `buildProjection` and behaves exactly as it
// did before this story. The implicit "the caller's open plan" was rejected
// because no column could resolve it: `Plan.createdById` is the REQUESTER (null
// for a cadence plan), `decidedById` does not exist until approve, and
// `authorSource` / `authorHarness` / `authorModel` identify a KIND of producer,
// never an instance — so it would have resolved on `(projectId, status)` and
// bound to exactly the abandoned `generating` rows AMENDMENTS 1 and 2 document.
//
// This module is deliberately the SEAM the projected READS extend
// (MOTIR-3096): they take the same field, spelled the same way, described the
// same way. One convention for one idea, which is what MOTIR-3094 exists for.

/**
 * The optional `planId` every projected call shares.
 *
 * OPTIONAL is load-bearing, not politeness: absent means the committed tree,
 * which is what every existing caller gets today.
 */
export const planIdField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. ' +
      'When given, the answer is computed over the project’s live tree ⊕ that plan’s ' +
      'proposals, so an agent can check the tree it is proposing BEFORE anyone reviews ' +
      'it. Omit it for the committed tree — a call without this argument behaves exactly ' +
      'as it did before projection existed. Nothing is created, mutated or persisted ' +
      'either way, and a proposal never becomes a work item except by approving the plan ' +
      'in Motir.',
  );

/** The `planId` a plan-ADDRESSED tool requires (the forest verdict has no other target). */
export const requiredPlanIdField = z
  .string()
  .min(1)
  .describe('The plan id `create_plan` returned (or the id shown on the plan in Motir).');

/**
 * Normalize a validation TARGET that may be either a `<KEY>-<n>` identifier or
 * an intra-plan `planItem:<id>` temp-ref.
 *
 * `normalizeIdentifier` upper-cases, which is right for `motir-42` and WRONG for
 * a temp-ref: `planItem:cmsz…` is a cuid inside a case-sensitive prefix, and
 * upper-casing it turns the one addressing form an authoring agent actually
 * holds into an unknown target. `resolveProjectedRoot` accepts both forms; this
 * is the boundary that keeps both reaching it intact.
 */
export function normalizeProjectedTarget(raw: string): string {
  const trimmed = raw.trim();
  return isTempRef(trimmed) ? trimmed : trimmed.toUpperCase();
}

/** The sentence every projected tool's description carries about temp-refs. */
export const TEMP_REF_HELP =
  `A projected target may be a committed key ("ACME-7") OR a \`${TEMP_REF_PREFIX}<id>\` ` +
  'temp-ref naming an `add` in that same plan — the case an authoring agent usually has, ' +
  'since the card it wants to check has no key until the plan is approved.';
