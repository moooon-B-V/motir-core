import { PAGE_BODY_MAX_BYTES, PAGE_SAVE_MAX_BYTES, PAGE_TITLE_MAX_LENGTH } from './constants';
import { applyUpdate, deriveFormats, emptyState } from './document/convert';
import {
  PageBodyTooLargeError,
  PageNotFoundError,
  PageTitleTooLongError,
  PageUpdateMalformedError,
} from './errors';
import { placementColumns, resolvePlacementParent } from './move';
import { positionBetween } from './position';
import type { Clock, PageRow, PageStore } from './store';
import { planPlacement } from './tree';
import type { PagePlacement } from './types';

// The SAVE procedures (Story MOTIR-5752 · MOTIR-7274), `docs/decisions/pages.md`
// §2–§3: what a create, a rename and a save write, decided here and persisted
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
  /** Where the page goes (§4): under a page, in a folder, or at the root (the default). */
  parent?: PagePlacement;
}

/**
 * Create an empty page LAST among its parent's pages — at the project root, in a
 * folder, or under a page. The placement lock is taken before the parent and its
 * last position are read, so two creates mint distinct, creation-ordered keys and
 * a parent cannot move out from under the check. A parent that is missing, in
 * another project, or would put the page past the depth limit is refused before
 * anything is written.
 */
export async function createPage(
  store: PageStore,
  clock: Clock,
  input: CreatePageInput,
): Promise<PageRow> {
  const title = normaliseTitle(input.title ?? '');
  const parent = input.parent ?? ROOT;
  await store.lockSiblings(input.projectId, parent);
  const parentPage = await resolvePlacementParent(store, input.projectId, parent);
  const { ancestorPageIds } = planPlacement({ placement: parent, parent: parentPage });
  const last = await store.lastSiblingPosition(input.projectId, parent);
  const state = emptyState();
  const now = clock.now();
  return store.insertPage({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    title,
    ...placementColumns(parent),
    position: positionBetween(last, null),
    ancestorPageIds,
    body: {
      state,
      ...deriveFormats(state),
      revision: 1,
      updatedById: input.actorId,
      updatedAt: now,
    },
    createdById: input.actorId,
    createdAt: now,
  });
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
  await store.updateBody(input.pageId, {
    state,
    ...deriveFormats(state),
    revision,
    updatedById: input.actorId,
    updatedAt: clock.now(),
  });
  // Link extraction (§8.1) is the linking epic's; the port is called now so the
  // save path's shape is fixed when it lands.
  await store.replaceDerivedLinks(input.pageId, []);
  return revision;
}
