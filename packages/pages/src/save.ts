import { PAGE_BODY_MAX_BYTES, PAGE_SAVE_MAX_BYTES, PAGE_TITLE_MAX_LENGTH } from './constants';
import { applyUpdate, deriveFormats, emptyState } from './document/convert';
import {
  PageBodyTooLargeError,
  PageNotFoundError,
  PageTitleTooLongError,
  PageUpdateMalformedError,
} from './errors';
import { positionBetween } from './position';
import type { Clock, PageRow, PageStore } from './store';
import type { PagePlacement } from './types';
import { recordVersion } from './versions';

// The SAVE procedures (Story MOTIR-5752 · MOTIR-7274), `docs/decisions/pages.md`
// §2–§3 — and, since MOTIR-5754, the version each one leaves (§6, `versions.ts`): what a create, a rename and a save write, decided here and persisted
// through a `PageStore`. The app's service owns the transaction and the
// permission gate; these own the ORDER, which is the part that keeps a save
// from losing an update or storing an oversize body:
//   * the request cap and an empty request are checked BEFORE the lock — a refused
//     request costs no lock; an undecodable one is refused by the merge, before
//     any write;
//   * the page is read THROUGH the lock before the merge — two saves in two
//     transactions serialise in the database and each merges onto the other;
//   * the body cap is checked AFTER the merge and BEFORE any write.

const ROOT: PagePlacement = { kind: 'root' };

/** A title, trimmed and held to the limit. */
function normaliseTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length > PAGE_TITLE_MAX_LENGTH) throw new PageTitleTooLongError(trimmed.length);
  return trimmed;
}

export interface CreatePageInput {
  workspaceId: string;
  projectId: string;
  actorId: string;
  /** Optional; an untitled page stores `''`. */
  title?: string;
}

/**
 * Create an empty page at the project root, LAST among the root's pages. The
 * root sibling set is locked before its last position is read, so two creates
 * mint distinct, creation-ordered keys.
 */
export async function createPage(
  store: PageStore,
  clock: Clock,
  input: CreatePageInput,
): Promise<PageRow> {
  const title = normaliseTitle(input.title ?? '');
  await store.lockSiblings(input.projectId, ROOT);
  const last = await store.lastSiblingPosition(input.projectId, ROOT);
  const state = emptyState();
  const formats = deriveFormats(state);
  const now = clock.now();
  const page = await store.insertPage({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    title,
    parentPageId: null,
    folderId: null,
    position: positionBetween(last, null),
    ancestorPageIds: [],
    body: {
      state,
      ...formats,
      revision: 1,
      updatedById: input.actorId,
      updatedAt: now,
    },
    createdById: input.actorId,
    createdAt: now,
  });
  // A page's history starts with its creation (§6): version 1, the empty body.
  await store.insertVersion({
    pageId: page.id,
    number: 1,
    authorId: input.actorId,
    bodyState: state,
    bodyMarkdown: formats.markdown,
    startedAt: now,
    savedAt: now,
    restoredFromVersionId: null,
    restoredFromNumber: null,
  });
  return page;
}

export interface RenamePageInput {
  pageId: string;
  actorId: string;
  title: string;
}

/** Rename a page: trim, refuse a title over the limit, write it. */
export async function renamePage(store: PageStore, input: RenamePageInput): Promise<PageRow> {
  const title = normaliseTitle(input.title);
  const row = await store.updateTitle(input.pageId, title, input.actorId);
  if (!row) throw new PageNotFoundError(input.pageId);
  return row;
}

export interface SavePageUpdateInput {
  pageId: string;
  actorId: string;
  /** ONE Yjs update, as the editor (or the markdown door) produced it. */
  update: Uint8Array;
}

/**
 * Merge one Yjs update into the stored state, recompute the derived formats and
 * write all of it in one `updateBody`. Returns the new revision.
 */
export async function savePageUpdate(
  store: PageStore,
  clock: Clock,
  input: SavePageUpdateInput,
): Promise<number> {
  if (input.update.byteLength > PAGE_SAVE_MAX_BYTES) {
    throw new PageBodyTooLargeError(PAGE_SAVE_MAX_BYTES, input.update.byteLength);
  }
  // An empty request is refused before the lock, as an oversize one is; an
  // undecodable one is refused by `applyUpdate`, after the lock and before any write.
  if (input.update.byteLength === 0) throw new PageUpdateMalformedError('empty');

  const page = await store.lockPage(input.pageId);
  if (!page) throw new PageNotFoundError(input.pageId);

  const state = applyUpdate(page.bodyState, input.update);
  if (state.byteLength > PAGE_BODY_MAX_BYTES) {
    throw new PageBodyTooLargeError(PAGE_BODY_MAX_BYTES, state.byteLength);
  }

  const revision = page.revision + 1;
  const formats = deriveFormats(state);
  const now = clock.now();
  await store.updateBody(input.pageId, {
    state,
    ...formats,
    revision,
    updatedById: input.actorId,
    updatedAt: now,
  });
  // Every save leaves a version (§6) — extended or new, under the same lock and
  // the same instant as the body write.
  await recordVersion(store, {
    pageId: input.pageId,
    actorId: input.actorId,
    state,
    markdown: formats.markdown,
    now,
  });
  // Link extraction (§8.1) is the linking epic's; the port is called now so the
  // save path's shape is fixed when it lands.
  await store.replaceDerivedLinks(input.pageId, []);
  return revision;
}
