import type { DerivedPageLink } from '@motir/pages';
import type { DerivedPageLinkRecord } from '@/lib/repositories/pageWorkItemLinkRepository';

// The DIFF a body write's derived links make against a page's stored derived
// rows (Story MOTIR-7565 · MOTIR-7571, `docs/decisions/pages.md` §8.1). Pure,
// so the rule — keep what is still named, delete what is not, add what is new —
// is testable without a database. A kept row keeps its `id`, `created_by_id`
// and `created_at`: `created_by_id` means who FIRST linked it.

export interface DerivedLinkDiff {
  /** Stored rows the body no longer names. */
  deleteIds: string[];
  /** Links the body names that no row holds yet, in the body's order. */
  insert: DerivedPageLink[];
}

const keyOf = (link: { workItemId: string; source: string }): string =>
  `${link.source}:${link.workItemId}`;

export function diffDerivedLinks(
  stored: readonly DerivedPageLinkRecord[],
  named: readonly DerivedPageLink[],
): DerivedLinkDiff {
  const namedKeys = new Set(named.map(keyOf));
  const storedKeys = new Set(stored.map(keyOf));
  const seen = new Set<string>();
  const insert: DerivedPageLink[] = [];
  for (const link of named) {
    const key = keyOf(link);
    if (storedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    insert.push(link);
  }
  return {
    deleteIds: stored.filter((row) => !namedKeys.has(keyOf(row))).map((row) => row.id),
    insert,
  };
}
