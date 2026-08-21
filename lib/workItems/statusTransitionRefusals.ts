import {
  ContainerHasOpenChildrenError,
  IllegalTransitionError,
  MissingArtifactEvidenceError,
  UnknownStatusError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// THE REFUSAL SET of `workItemsService.applyStatusTransition` (MOTIR-3364).
//
// ── What it is ──────────────────────────────────────────────────────────────
// That method is the ONE authority every status write passes through, and it can
// end in two very different ways. A **refusal** is a business rule declining a
// move the caller asked for — the workflow has no such edge, the release recorded
// no artifact, the container's children are not built. A **fault** is the code or
// the data being wrong: the row vanished, a constraint blew up, the connection
// died. The two need opposite handling in a background caller, and every consumer
// that drives a status from a merge has to tell them apart.
//
// ── Why it is a LIST and not an `instanceof` chain at each call site ────────
// It was a chain at each call site, and the chains disagreed. MOTIR-2709 added
// the artifact-evidence gate to `applyStatusTransition` on 2026-08-17 and updated
// NEITHER of the two merge-driven consumers; MOTIR-3229 added the container gate
// three days later and updated one of them. The result was a merged pull request
// that threw out of the webhook, returned a 500 for a successful delivery, and
// left the card at In Review with no note on it — for a hold the system had
// decided, correctly, to apply. Nothing could see the omission until production
// did, because "the set of refusals" existed only as two hand-maintained `if`
// ladders that happened to be written on different days.
//
// ⚠️ **ADDING A GATE TO `applyStatusTransition` MEANS ADDING ITS ERROR HERE.**
// `tests/workItems/statusTransitionRefusals.test.ts` scans that method's own
// source for its `throw new …Error(` sites and fails when one is neither in this
// list nor in the test's explicit FAULTS allow-list — so the next gate is caught
// by a red build rather than by a card that silently stops moving.
//
// ── The membership rule, so the next entry is decided rather than guessed ───
// A class belongs here when a HUMAN could clear it by changing the tree or the
// card, and the answer would then be different. `WorkItemNotFoundError` is
// deliberately ABSENT: every consumer resolved that row moments earlier in the
// same flow, so its disappearance is a fault worth a 500 and a retry, not a
// condition anyone is expected to act on.
export const STATUS_TRANSITION_REFUSALS = [
  IllegalTransitionError,
  UnknownStatusError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  MissingArtifactEvidenceError,
  ContainerHasOpenChildrenError,
] as const;

/** An error `applyStatusTransition` raises as a REFUSAL — see the list above. */
export type StatusTransitionRefusal = InstanceType<(typeof STATUS_TRANSITION_REFUSALS)[number]>;

/**
 * Whether an error is a status-transition REFUSAL (a business rule declining the
 * move) rather than a FAULT.
 *
 * A caller that reports refusals and rethrows faults gets both behaviours right
 * by construction, and inherits the next gate without an edit.
 */
export function isStatusTransitionRefusal(err: unknown): err is StatusTransitionRefusal {
  return STATUS_TRANSITION_REFUSALS.some((ErrorClass) => err instanceof ErrorClass);
}
