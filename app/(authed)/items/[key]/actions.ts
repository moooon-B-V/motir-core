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
    throw err;
  }

  revalidatePath(`/items/${input.identifier}`);
  return { ok: true };
}
