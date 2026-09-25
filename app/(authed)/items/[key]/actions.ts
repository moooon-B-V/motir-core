'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getGithubTranslator } from '@/lib/i18n/githubTranslator';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { isRelationshipKind, relationshipToLink } from '@/lib/workItems/linkRelationships';
import { linkErrorMessage } from '@/lib/workItems/linkErrorMessages';
import { prLinkErrorMessage } from '@/lib/github/prLinkErrorMessages';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type { ReadinessVerdictDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { PullRequestLinkCandidateDto } from '@/lib/dto/github';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { TestInstructionsError } from '@/lib/testInstructions/errors';
import { howToTestRefusal, type HowToTestRefusalField } from '@/lib/testInstructions/refusal';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { monitorIssueLinkService } from '@/lib/services/monitorIssueLinkService';
import type {
  MonitorIssueLinkOutcome,
  MonitorIssueSearchResultDto,
} from '@/lib/dto/monitorIssueLink';
import {
  MonitorConnectionNotFoundError,
  MonitorIssueAlreadyLinkedError,
  MonitorIssueGoneError,
  MonitorIssueLinkNotFoundError,
  MonitorProviderCallError,
} from '@/lib/monitors/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { HowToTestDraftDTO } from '@/lib/dto/testInstructions';
import { unmappedActionRefusalMessage } from '@/lib/actions/unmappedRefusal';

// Server Actions for the detail-page LINK MANAGEMENT surface (Subtask 2.4.9).
// Transport only: resolve the session + active project, gate the CURRENT item
// to the caller's workspace, call ONE shipped service method
// (linkWorkItems / unlinkWorkItems / listLinkCandidates — Story 1.4 + 2.4.9),
// translate the typed link errors to inline messages, and revalidate the detail
// path so the panel + readiness banner re-render. No business logic, no service
// extension. The five UI relationships map to the directed storage link in
// `lib/workItems/linkRelationships.ts`. The typed-error → inline-message map is
// shared with the create-modal link surface (2.4.10) in `linkErrorMessages.ts`.

/** The bare outcome of a link write — no payload beyond success/failure. */
export type LinkActionResult = { ok: true } | { ok: false; error: string };

/**
 * A How-to-test save's answer (Subtask MOTIR-5455). A refusal carries WHERE it
 * belongs as well as what it says: the design draws each one beside the control
 * it is about, and `null` is the form itself.
 */
export type SaveHowToTestActionResult =
  | { ok: true }
  | { ok: false; field: HowToTestRefusalField; error: string };

/**
 * A RELATIONSHIP write's answer to the panel. MOTIR-4496: `ok` carries the
 * RE-JUDGED readiness verdict, so the panel's banner reconciles off the ACTION
 * rather than off `router.refresh()` — a whole-page re-render whose cost is the
 * `max()` of every unrelated read on the detail page. The refresh still runs
 * and still wins (it is the authority); this is what the banner shows in the
 * meantime.
 */
export type RemoveLinkActionResult =
  | { ok: true; readiness: ReadinessVerdictDto }
  | { ok: false; error: string };

/**
 * The add's answer additionally carries the `work_item_link.id` it created, so
 * the panel's OPTIMISTIC row — inserted at click time from the candidate
 * already in hand, under a temporary id — can take its REAL id as soon as the
 * write answers. Without it the remove button on a just-added row would be
 * armed with an id the server has never heard of until the refresh lands, which
 * is precisely the window this card is about.
 *
 * The row's CONTENT is not echoed back: the client picked the target out of
 * {@link listLinkCandidatesAction}'s own {@link WorkItemSummaryDto} moments
 * earlier, so re-reading it here would buy a round trip to restate what the
 * caller is holding. The refresh is what reconciles any drift.
 */
export type CreateLinkActionResult =
  | { ok: true; readiness: ReadinessVerdictDto; linkId: string }
  | { ok: false; error: string };

/**
 * Candidate target issues for the picker, server-searched by `query` (key +
 * title, 6.9.2 — the picker's Combobox fetches this per keystroke; an empty /
 * short query returns `[]`). Refetches when the relationship changes too — the
 * already-linked exclusion is direction-aware. The current item is gated to the
 * caller's workspace inside the service.
 */
export async function listLinkCandidatesAction(
  currentItemId: string,
  relationship: RelationshipKind,
  query: string,
): Promise<{ ok: true; candidates: WorkItemSummaryDto[] } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.pickProjectFirst') };
  if (!isRelationshipKind(relationship))
    return { ok: false, error: t('actions.unknownRelationship') };

  try {
    const candidates = await workItemsService.listLinkCandidates(
      currentItemId,
      relationship,
      query,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, candidates };
  } catch (err) {
    const msg = linkErrorMessage(err, t);
    if (msg) return { ok: false, error: msg };
    const refused = await unmappedActionRefusalMessage(err, 'listLinkCandidatesAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }
}

/**
 * Add a link of `relationship` from the current item to `targetId`. Gates the
 * current item to the workspace first (a forged cross-tenant id 404s before the
 * write), maps the UI relationship to the directed storage link, and revalidates
 * the detail page (`identifier`) so the new row + re-judged readiness render.
 */
export async function createLinkAction(input: {
  currentItemId: string;
  identifier: string;
  targetId: string;
  relationship: RelationshipKind;
}): Promise<CreateLinkActionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.pickProjectFirst') };
  if (!isRelationshipKind(input.relationship))
    return { ok: false, error: t('actions.unknownRelationship') };
  if (!input.targetId) return { ok: false, error: t('actions.pickIssueToLink') };

  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  let linkId: string;
  let readiness: ReadinessVerdictDto;
  try {
    // Tenant gate on the current item — a forged cross-workspace id 404s here
    // before any write (linkWorkItems only checks from/to are co-located).
    await workItemsService.getWorkItem(input.currentItemId, serviceCtx);
    const link = relationshipToLink(input.relationship, input.currentItemId, input.targetId);
    linkId = (await workItemsService.linkWorkItems(link, serviceCtx)).id;
    // MOTIR-4496: re-judge readiness HERE, so the panel's banner has the new
    // verdict from this response instead of from the whole-page refresh below.
    readiness = await workItemsService.getReadinessVerdict(input.currentItemId, serviceCtx);
  } catch (err) {
    const msg = linkErrorMessage(err, t);
    if (msg) return { ok: false, error: msg };
    const refused = await unmappedActionRefusalMessage(err, 'createLinkAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }

  revalidatePath(`/items/${input.identifier}`);
  return { ok: true, linkId, readiness };
}

/**
 * Remove a link by id. `getLink` gates it to the workspace (404 no-leak) before
 * `unlinkWorkItems` deletes it (+ the reciprocal `relates_to` row). Revalidates
 * the detail page.
 */
export async function removeLinkAction(input: {
  linkId: string;
  /** The item whose panel the row was removed from — the item whose readiness
   *  the caller is showing, and the one re-judged for the response. Tenant-gated
   *  here exactly as `createLinkAction` gates it. */
  currentItemId: string;
  identifier: string;
}): Promise<RemoveLinkActionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.pickProjectFirst') };

  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  let readiness: ReadinessVerdictDto;
  try {
    await workItemsService.getWorkItem(input.currentItemId, serviceCtx); // cross-tenant gate
    await workItemsService.getLink(input.linkId, serviceCtx); // cross-tenant gate
    await workItemsService.unlinkWorkItems(input.linkId, serviceCtx);
    // MOTIR-4496: the banner's new verdict rides THIS response, not the refresh.
    readiness = await workItemsService.getReadinessVerdict(input.currentItemId, serviceCtx);
  } catch (err) {
    const msg = linkErrorMessage(err, t);
    if (msg) return { ok: false, error: msg };
    const refused = await unmappedActionRefusalMessage(err, 'removeLinkAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }

  revalidatePath(`/items/${input.identifier}`);
  return { ok: true, readiness };
}

// ── Explicit item→PR link (Story 7.10 · MOTIR-1596, design/github Panel 5) ──
// The MANUAL override of the MOTIR-892 auto-resolver, on the detail-page
// Development card. Transport only: session + active project, call ONE
// githubPullRequestService method, map its typed errors to the `github`-namespace
// inline message, revalidate. Business logic + workspace validation live in the
// service. The typed-error → inline-message map is shared in `prLinkErrorMessages`.

/**
 * Candidate PRs for the "+ Link pull request" picker, server-searched by `query`
 * (title / repo / number). The Combobox fetches this per debounced keystroke; an
 * empty/short query returns `[]`. A disconnected workspace surfaces as the typed
 * `notConnected` banner. The current item is gated to the workspace in the service.
 */
export async function listPullRequestCandidatesAction(
  currentItemId: string,
  query: string,
): Promise<{ ok: true; candidates: PullRequestLinkCandidateDto[] } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) {
    const te = await getErrorsTranslator();
    return { ok: false, error: te('actions.pickProjectFirst') };
  }
  try {
    const candidates = await githubPullRequestService.searchLinkCandidates(currentItemId, query, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return { ok: true, candidates };
  } catch (err) {
    const tg = await getGithubTranslator();
    const msg = prLinkErrorMessage(err, tg);
    if (msg) return { ok: false, error: msg };
    const refused = await unmappedActionRefusalMessage(err, 'listPullRequestCandidatesAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }
}

/**
 * Link the picked PR to the current item (sets `workItemId` as the manual
 * override). A re-link/takeover from another item is allowed with no confirm.
 * Cross-workspace / unknown PR → the typed `prNotFound` banner. Revalidates the
 * detail page so the server-rendered Development card re-renders with the new row.
 */
export async function linkPullRequestAction(input: {
  currentItemId: string;
  identifier: string;
  pullRequestId: string;
}): Promise<LinkActionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) {
    const te = await getErrorsTranslator();
    return { ok: false, error: te('actions.pickProjectFirst') };
  }
  const tg = await getGithubTranslator();
  if (!input.pullRequestId) return { ok: false, error: tg('development.prNotFound') };
  try {
    await githubPullRequestService.linkPullRequest(input.currentItemId, input.pullRequestId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  } catch (err) {
    const msg = prLinkErrorMessage(err, tg);
    if (msg) return { ok: false, error: msg };
    // The service asserts `work_item:edit` (MOTIR-6318). The door is hidden from
    // an actor without it, so this answers a direct call or a role revoked while
    // the page was open.
    if (err instanceof PermissionDeniedError) return { ok: false, error: err.message };
    const refused = await unmappedActionRefusalMessage(err, 'linkPullRequestAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }

  revalidatePath(`/items/${input.identifier}`);
  return { ok: true };
}

/**
 * UNLINK one delivery from the current item (Story MOTIR-4878 · MOTIR-5005,
 * design `design/github/` Panels 5d–5f) — the mirror of
 * {@link linkPullRequestAction}, and the door a PERSON was missing.
 *
 * ── Why it exists ─────────────────────────────────────────────────────────
 * `githubPullRequestService.unlinkPullRequest` has shipped since MOTIR-3756 with
 * exactly one caller, the MCP tool. So an agent could retract a delivery and a
 * person could not — while `incompleteDeliverySetCommentBody` ends by telling the
 * reader, on the card, *"If one of them does not in fact deliver this item, unlink
 * it."* The only move left was to override the status by hand, which records that
 * somebody disagreed with a gate rather than that a pull request was wrong.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────
 * Touch the pull request. It removes one `(work item, pull request)` delivery row
 * and leaves `github_pull_request` exactly as the webhook last wrote it — which is
 * what the confirm copy promises the reader, so the two must not drift apart.
 *
 * `removed: false` is a SUCCESS: the pull request and the item exist and were
 * simply not linked (a retry, or a correction somebody else already made). The
 * service reserves it for that case and raises on a pull request that is unknown
 * or out of the workspace, which reaches the reader as the typed `prNotFound`
 * banner — the same map the link arm uses.
 */
export async function unlinkPullRequestAction(input: {
  currentItemId: string;
  identifier: string;
  pullRequestId: string;
}): Promise<LinkActionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) {
    const te = await getErrorsTranslator();
    return { ok: false, error: te('actions.pickProjectFirst') };
  }
  const tg = await getGithubTranslator();
  if (!input.pullRequestId) return { ok: false, error: tg('development.prNotFound') };
  try {
    await githubPullRequestService.unlinkPullRequest(input.currentItemId, input.pullRequestId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  } catch (err) {
    const msg = prLinkErrorMessage(err, tg);
    if (msg) return { ok: false, error: msg };
    // The service asserts `work_item:edit` (MOTIR-6318). The door is hidden from
    // an actor without it, so this answers a direct call or a role revoked while
    // the page was open.
    if (err instanceof PermissionDeniedError) return { ok: false, error: err.message };
    const refused = await unmappedActionRefusalMessage(err, 'unlinkPullRequestAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }

  revalidatePath(`/items/${input.identifier}`);
  return { ok: true };
}

/**
 * The DRAFT a person's How-to-test form opens on (Story MOTIR-5450 · Subtask
 * MOTIR-5455, design §24 panels 13a–13b) — the body and the preview path, or
 * `''`/`null` on an item with no record.
 *
 * ⚠️ IT IS READ AT OPEN, not taken from the page's render. Two reasons, and the
 * second is the load-bearing one: the page may have been rendered minutes ago
 * and a run may have published since, so seeding from it would open the form on
 * a version that is no longer current and save over the newer one; and the
 * service read asserts `work_item:edit`, so OPENING the form is itself gated
 * server-side rather than only by whether the host drew the door.
 */
export async function loadHowToTestDraftAction(
  workItemId: string,
): Promise<{ ok: true; draft: HowToTestDraftDTO } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) {
    const te = await getErrorsTranslator();
    return { ok: false, error: te('actions.pickProjectFirst') };
  }
  try {
    const draft = await testInstructionsService.getDraftForWorkItem(workItemId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return { ok: true, draft };
  } catch (err) {
    if (err instanceof PermissionDeniedError || err instanceof TestInstructionsError) {
      return { ok: false, error: err.message };
    }
    const refused = await unmappedActionRefusalMessage(err, 'loadHowToTestDraftAction');
    if (refused) return { ok: false, error: refused };
    throw err;
  }
}

/**
 * SAVE a person's How to test (Story MOTIR-5450 · Subtask MOTIR-5455; ADR
 * `approval-gates.md` §9's 2026-09-17 amendment, point 1).
 *
 * ⚠️ IT IS THE SAME WRITER AN AGENT USES — `testInstructionsService.publish`,
 * with `attributeToRunningDispatch` left FALSE. That flag is the whole of the
 * difference between the two author kinds: false records `dispatchRunId: null`
 * and `publishedById` this person, so a person's save and a run's publish are
 * one row shape in one table, differing only in who is named. There is no
 * person-shaped write path, and adding one is what point 1 forbids.
 *
 * `repos` is not passed at all: the repositories a record covers are DERIVED
 * from the item's linked pull requests (§24, decisions 8 and 8b), and `publish`
 * accepts a body-only record since MOTIR-5689.
 *
 * A REFUSAL IS AN ANSWER, not a throw: it comes back placed — beside the body,
 * beside the preview path, or on the form — so the caller can keep the draft
 * (§24, decision 6) and put the sentence where the reader is looking.
 */
export async function saveHowToTestAction(input: {
  workItemId: string;
  identifier: string;
  bodyMd: string;
  previewPath: string | null;
}): Promise<SaveHowToTestActionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) {
    const te = await getErrorsTranslator();
    return { ok: false, field: null, error: te('actions.pickProjectFirst') };
  }
  try {
    await testInstructionsService.publish(
      {
        workItemId: input.workItemId,
        bodyMd: input.bodyMd,
        previewPath: input.previewPath,
        attributeToRunningDispatch: false,
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
  } catch (err) {
    const refusal = howToTestRefusal(err);
    if (refusal) return { ok: false, field: refusal.field, error: refusal.message };
    if (err instanceof PermissionDeniedError || err instanceof TestInstructionsError) {
      return { ok: false, field: null, error: err.message };
    }
    const refused = await unmappedActionRefusalMessage(err, 'saveHowToTestAction');
    if (refused) return { ok: false, field: null, error: refused };
    throw err;
  }

  // The Development card is server-rendered, so the page read is what re-draws
  // the saved record and its author (`CLAUDE.md`'s page-state contract, case 2).
  // The block is NOT patched optimistically: its author line, its history and
  // its derived sub-blocks all come from that read.
  revalidatePath(`/items/${input.identifier}`);
  return { ok: true };
}

// ── ERROR LINKS by hand (Story MOTIR-4932 · Subtask MOTIR-5731) ─────────────
//
// Three doors onto `monitorIssueLinkService`, in the pull-request link actions'
// shape. ⚠️ THEY RETURN CODES, NOT COPY: every string a person reads — and both
// locales — belongs to the Errors section (MOTIR-5732), which maps each code.

/** Why an error-link action refused. `already_linked` carries the card holding
 *  the issue; `provider_failed` carries the MONITOR's own words (data, not copy),
 *  for the case the monitor itself refused the read a link needs. */
export type MonitorLinkRefusal =
  | { ok: false; code: 'already_linked'; holderIdentifier: string }
  | { ok: false; code: 'issue_gone' }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'forbidden' }
  | { ok: false; code: 'provider_failed'; reason: string };

/** The typed refusals the service raises, as codes; `null` = not ours to map. */
function monitorLinkRefusal(err: unknown): MonitorLinkRefusal | null {
  if (err instanceof MonitorIssueAlreadyLinkedError) {
    return { ok: false, code: 'already_linked', holderIdentifier: err.holderIdentifier };
  }
  if (err instanceof MonitorIssueGoneError) return { ok: false, code: 'issue_gone' };
  if (
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError ||
    err instanceof MonitorConnectionNotFoundError ||
    err instanceof MonitorIssueLinkNotFoundError ||
    (err instanceof ProjectAccessDeniedError && err.kind === 'browse')
  ) {
    return { ok: false, code: 'not_found' };
  }
  if (err instanceof PermissionDeniedError || err instanceof ProjectAccessDeniedError) {
    return { ok: false, code: 'forbidden' };
  }
  if (err instanceof MonitorProviderCallError) {
    return { ok: false, code: 'provider_failed', reason: err.providerReason };
  }
  return null;
}

/** The session's workspace actor, or null when there is no active project. */
async function monitorLinkActor(): Promise<{ userId: string; workspaceId: string } | null> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  return ctx ? { userId: ctx.userId, workspaceId: ctx.workspaceId } : null;
}

/** SEARCH the card's monitored projects for an issue to link. A connection that
 *  failed is inside `result.failures`, never a refusal. */
export async function searchMonitorIssuesAction(input: {
  workItemId: string;
  query: string;
}): Promise<{ ok: true; result: MonitorIssueSearchResultDto } | MonitorLinkRefusal> {
  const actor = await monitorLinkActor();
  if (!actor) return { ok: false, code: 'not_found' };
  try {
    const result = await monitorIssueLinkService.searchCandidates(
      input.workItemId,
      input.query,
      actor,
    );
    return { ok: true, result };
  } catch (err) {
    const refusal = monitorLinkRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
}

/** LINK an issue to the card — or, with `move`, take it from the card that
 *  holds it. Revalidates the item on a write. */
export async function linkMonitorIssueAction(input: {
  workItemId: string;
  identifier: string;
  connectionId: string;
  externalIssueId: string;
  move: boolean;
}): Promise<{ ok: true; outcome: MonitorIssueLinkOutcome } | MonitorLinkRefusal> {
  const actor = await monitorLinkActor();
  if (!actor) return { ok: false, code: 'not_found' };
  try {
    const { outcome } = await monitorIssueLinkService.linkIssue(
      input.workItemId,
      {
        connectionId: input.connectionId,
        externalIssueId: input.externalIssueId,
        move: input.move === true,
      },
      actor,
    );
    revalidatePath(`/items/${input.identifier}`);
    return { ok: true, outcome };
  } catch (err) {
    const refusal = monitorLinkRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
}

/** UNLINK one error from the card. `removed: false` is a success — it was
 *  already gone. */
export async function unlinkMonitorIssueAction(input: {
  workItemId: string;
  identifier: string;
  monitorIssueId: string;
}): Promise<{ ok: true; removed: boolean } | MonitorLinkRefusal> {
  const actor = await monitorLinkActor();
  if (!actor) return { ok: false, code: 'not_found' };
  try {
    const { removed } = await monitorIssueLinkService.unlinkIssue(
      input.workItemId,
      input.monitorIssueId,
      actor,
    );
    if (removed) revalidatePath(`/items/${input.identifier}`);
    return { ok: true, removed };
  } catch (err) {
    const refusal = monitorLinkRefusal(err);
    if (refusal) return refusal;
    throw err;
  }
}
