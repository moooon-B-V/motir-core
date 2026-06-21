'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { isRelationshipKind, relationshipToLink } from '@/lib/workItems/linkRelationships';
import { linkErrorMessage } from '@/lib/workItems/linkErrorMessages';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

// Server Actions for the detail-page LINK MANAGEMENT surface (Subtask 2.4.9).
// Transport only: resolve the session + active project, gate the CURRENT item
// to the caller's workspace, call ONE shipped service method
// (linkWorkItems / unlinkWorkItems / listLinkCandidates — Story 1.4 + 2.4.9),
// translate the typed link errors to inline messages, and revalidate the detail
// path so the panel + readiness banner re-render. No business logic, no service
// extension. The five UI relationships map to the directed storage link in
// `lib/workItems/linkRelationships.ts`. The typed-error → inline-message map is
// shared with the create-modal link surface (2.4.10) in `linkErrorMessages.ts`.

export type LinkActionResult = { ok: true } | { ok: false; error: string };

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
}): Promise<LinkActionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.pickProjectFirst') };
  if (!isRelationshipKind(input.relationship))
    return { ok: false, error: t('actions.unknownRelationship') };
  if (!input.targetId) return { ok: false, error: t('actions.pickIssueToLink') };

  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  try {
    // Tenant gate on the current item — a forged cross-workspace id 404s here
    // before any write (linkWorkItems only checks from/to are co-located).
    await workItemsService.getWorkItem(input.currentItemId, serviceCtx);
    const link = relationshipToLink(input.relationship, input.currentItemId, input.targetId);
    await workItemsService.linkWorkItems(link, serviceCtx);
  } catch (err) {
    const msg = linkErrorMessage(err, t);
    if (msg) return { ok: false, error: msg };
    throw err;
  }

  revalidatePath(`/items/${input.identifier}`);
  return { ok: true };
}

/**
 * Remove a link by id. `getLink` gates it to the workspace (404 no-leak) before
 * `unlinkWorkItems` deletes it (+ the reciprocal `relates_to` row). Revalidates
 * the detail page.
 */
export async function removeLinkAction(input: {
  linkId: string;
  identifier: string;
}): Promise<LinkActionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.pickProjectFirst') };

  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  try {
    await workItemsService.getLink(input.linkId, serviceCtx); // cross-tenant gate
    await workItemsService.unlinkWorkItems(input.linkId, serviceCtx);
  } catch (err) {
    const msg = linkErrorMessage(err, t);
    if (msg) return { ok: false, error: msg };
    throw err;
  }

  revalidatePath(`/items/${input.identifier}`);
  return { ok: true };
}
