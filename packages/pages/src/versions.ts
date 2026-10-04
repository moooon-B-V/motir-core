import { PAGE_BODY_MAX_BYTES, PAGE_VERSION_CAP, PAGE_VERSION_WINDOW_MS } from './constants';
import { applyUpdate, deriveFormats, stateToUpdate } from './document/convert';
import {
  PageArchivedError,
  PageBodyTooLargeError,
  PageNotFoundError,
  PageVersionNotFoundError,
} from './errors';
import type { Clock, PageRow, PageStore, PageVersionRow } from './store';

// A page's VERSIONS (Story MOTIR-5754 · MOTIR-7383), `docs/decisions/pages.md`
// §6, decided here and persisted through the `PageStore`:
//   * a save EXTENDS the latest version when that version has the same author,
//     was saved at most `PAGE_VERSION_WINDOW_MS` ago, is not a restore and is
//     not SEALED (a decision was published at it, MOTIR-7431); otherwise it
//     starts version `latest.number + 1`;
//   * past `PAGE_VERSION_CAP` the oldest UNMARKED versions are deleted, in the
//     same transaction — a sealed or frozen one never is, so a page may keep more
//     than the cap (`pages.md` AMENDMENT 3); the page's current body lives on
//     `page`, so it is never one that can be pruned;
//   * a restore makes an earlier version's content current AS A SAVE and records
//     a NEW version that is never coalesced, so "restored from vN" stays true of
//     exactly that snapshot.
//
// Every write here runs AFTER the caller locked the page (`lockPage`), so two
// concurrent saves serialise on that lock and each sees the other's version row.

/** What a save does to the version history. */
export type VersionWrite =
  | { readonly kind: 'extend'; readonly versionId: string }
  | { readonly kind: 'new'; readonly number: number };

/** Whether a save by `actorId` at `now` extends `latest` or starts a new version. */
export function decideVersionWrite(
  latest: PageVersionRow | null,
  actorId: string,
  now: Date,
): VersionWrite {
  if (
    latest !== null &&
    latest.authorId === actorId &&
    latest.restoredFromNumber === null &&
    latest.sealedAt === null &&
    now.getTime() - latest.savedAt.getTime() <= PAGE_VERSION_WINDOW_MS
  ) {
    return { kind: 'extend', versionId: latest.id };
  }
  return { kind: 'new', number: (latest?.number ?? 0) + 1 };
}

/** Deletes the oldest unmarked versions past the cap. */
async function applyCap(store: PageStore, pageId: string): Promise<void> {
  if ((await store.countVersions(pageId)) > PAGE_VERSION_CAP) {
    await store.deleteOldestUnmarkedVersions(pageId, PAGE_VERSION_CAP);
  }
}

export interface RecordVersionInput {
  /** The page as read under its lock — its id and tenancy. */
  page: Pick<PageRow, 'id' | 'workspaceId' | 'projectId'>;
  actorId: string;
  /** The page's state as just written. */
  state: Uint8Array;
  /** Its markdown, as just derived. */
  markdown: string;
  /** The instant of the save — the same one its body write carries. */
  now: Date;
}

/**
 * Record one save in the page's history: extend the latest version or start a
 * new one, then hold the cap. Every call writes exactly one version row.
 */
export async function recordVersion(store: PageStore, input: RecordVersionInput): Promise<void> {
  const { page } = input;
  const latest = await store.latestVersion(page.id);
  const write = decideVersionWrite(latest, input.actorId, input.now);
  if (write.kind === 'extend') {
    await store.updateVersion(write.versionId, {
      bodyState: input.state,
      bodyMarkdown: input.markdown,
      savedAt: input.now,
    });
    return;
  }
  await store.insertVersion({
    workspaceId: page.workspaceId,
    projectId: page.projectId,
    pageId: page.id,
    number: write.number,
    authorId: input.actorId,
    bodyState: input.state,
    bodyMarkdown: input.markdown,
    startedAt: input.now,
    savedAt: input.now,
    restoredFromVersionId: null,
    restoredFromNumber: null,
  });
  await applyCap(store, page.id);
}

export interface RestorePageVersionInput {
  pageId: string;
  /** The version to restore, by its number. */
  number: number;
  actorId: string;
}

export interface RestorePageVersionResult {
  /** The page's revision after the restore. */
  revision: number;
  /** The version the restore recorded. */
  version: PageVersionRow;
}

/**
 * Make version `number` the page's current content, as a save, and record it as
 * a new version naming its source. Nothing is written when the page or the
 * version is missing, or when the result would pass the body limit.
 */
export async function restorePageVersion(
  store: PageStore,
  clock: Clock,
  input: RestorePageVersionInput,
): Promise<RestorePageVersionResult> {
  const page = await store.lockPage(input.pageId);
  if (!page) throw new PageNotFoundError(input.pageId);
  // An archived page is read-only (§7): its history can be read, not restored.
  if (page.archivedAt !== null) throw new PageArchivedError(input.pageId);

  const source = await store.findVersion(input.pageId, input.number);
  if (!source) throw new PageVersionNotFoundError(input.pageId, input.number);

  const state = applyUpdate(page.bodyState, stateToUpdate(page.bodyState, source.bodyState));
  if (state.byteLength > PAGE_BODY_MAX_BYTES) {
    throw new PageBodyTooLargeError(PAGE_BODY_MAX_BYTES, state.byteLength);
  }

  const now = clock.now();
  const formats = deriveFormats(state);
  const revision = page.revision + 1;
  await store.updateBody(input.pageId, {
    state,
    ...formats,
    revision,
    updatedById: input.actorId,
    updatedAt: now,
  });

  const latest = await store.latestVersion(input.pageId);
  const version = await store.insertVersion({
    workspaceId: page.workspaceId,
    projectId: page.projectId,
    pageId: input.pageId,
    number: (latest?.number ?? 0) + 1,
    authorId: input.actorId,
    bodyState: state,
    bodyMarkdown: formats.markdown,
    startedAt: now,
    savedAt: now,
    restoredFromVersionId: source.id,
    restoredFromNumber: source.number,
  });
  await applyCap(store, input.pageId);
  await store.replaceDerivedLinks(input.pageId, []);
  return { revision, version };
}
