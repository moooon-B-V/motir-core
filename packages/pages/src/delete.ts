import { PageHoldsFrozenVersionError } from './errors';
import type { PageStore } from './store';

// The DELETE GUARD (Story MOTIR-5761 · MOTIR-7431), `docs/decisions/pages.md`
// AMENDMENT 3: a frozen version is the exact text a person approved for a
// decision, and it outlives every edit — so a page holding one is never
// deleted, only archived. `deletePage` (§7) calls this over the whole set it is
// about to delete, under the locks it already holds.

/**
 * Refuses `PageHoldsFrozenVersionError` when the page — or any page of the set
 * a delete takes — holds a frozen version. Returns otherwise.
 */
export async function assertPageDeletable(
  store: PageStore,
  pageIds: string | readonly string[],
): Promise<void> {
  const ids = typeof pageIds === 'string' ? [pageIds] : pageIds;
  const holder = await store.findPageWithFrozenVersion(ids);
  if (holder !== null) throw new PageHoldsFrozenVersionError(holder);
}
