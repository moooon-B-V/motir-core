'use server';

import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import {
  NotProjectAdminError,
  ProjectNotFoundError,
  ProjectOverviewTooLongError,
  ProjectTaglineTooLongError,
  ProjectTagsInvalidError,
} from '@/lib/projects/errors';

// Server Action for the on-page public Overview editor (Story 6.16 · Subtask
// 6.16.5). Transport only (Server Actions are the route-layer equivalent per
// CLAUDE.md): read the session, call ONE service method, and translate the typed
// error into a discriminated RESULT the client maps to its i18n string. The
// service owns the transaction, the admin gate, and the per-field validation —
// so a non-admin POSTing this directly still 403s server-side (the UI hide is
// presentation; the service is the gate). Unlike the settings-area
// `updateProjectOverviewAction` (which keys off the active-project cookie), this
// keys off the PUBLIC `identifier` in the URL, because an admin can be on
// `/p/<identifier>` while a different project is active.

export type SavePublicOverviewResult =
  | { ok: true }
  | {
      ok: false;
      code: 'TOO_LONG' | 'TAGLINE_TOO_LONG' | 'TAGS_INVALID' | 'NOT_ADMIN' | 'UNKNOWN';
    };

export interface SavePublicOverviewInput {
  /** The full public Overview/README Markdown body; empty clears it. Omit to leave unchanged. */
  publicOverviewMd?: string;
  /** The public hero tagline; empty / null clears it. Omit to leave unchanged. */
  publicTagline?: string | null;
  /** The public hero tags (trimmed/deduped/capped server-side). Omit to leave unchanged. */
  publicTags?: string[];
}

export async function savePublicOverviewAction(
  identifier: string,
  input: SavePublicOverviewInput,
): Promise<SavePublicOverviewResult> {
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;
  try {
    await publicProjectsService.setPublicOverview(identifier, actorUserId, {
      publicOverviewMd: input.publicOverviewMd,
      publicTagline: input.publicTagline,
      publicTags: input.publicTags,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof ProjectOverviewTooLongError) return { ok: false, code: 'TOO_LONG' };
    if (err instanceof ProjectTaglineTooLongError) return { ok: false, code: 'TAGLINE_TOO_LONG' };
    if (err instanceof ProjectTagsInvalidError) return { ok: false, code: 'TAGS_INVALID' };
    if (err instanceof NotProjectAdminError) return { ok: false, code: 'NOT_ADMIN' };
    // A non-public / unknown project resolves to ProjectNotFoundError; the public
    // page only renders the editor for a resolved public project, so this is a
    // race (the project went private) — surface it as the generic failure, never
    // a raw 500.
    if (err instanceof ProjectNotFoundError) return { ok: false, code: 'UNKNOWN' };
    throw err;
  }
}
