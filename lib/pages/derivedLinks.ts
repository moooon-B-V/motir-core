import type { DerivedPageLink } from '@motir/pages';
import type {
  DerivedPageLinkRecord,
  ItemDerivedPageLinkRecord,
  ItemDerivedPageLinkSourceValue,
} from '@/lib/repositories/pageWorkItemLinkRepository';

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

// ── The work item's side (Story MOTIR-7694 · MOTIR-7696) ────────────────────
//
// The same rule keyed the other way: a work item's Description / Explanation
// name PAGES, and the stored item-derived rows are diffed against them. A kept
// row keeps its `id`, `created_by_id` and `created_at`.

/** One page a work item's body tags, under the field that tags it. */
export interface ItemDerivedPageLink {
  pageId: string;
  source: ItemDerivedPageLinkSourceValue;
}

export interface ItemDerivedLinkDiff {
  /** Stored rows the bodies no longer name. */
  deleteIds: string[];
  /** Links the bodies name that no row holds yet, in body order. */
  insert: ItemDerivedPageLink[];
}

const itemKeyOf = (link: { pageId: string; source: string }): string =>
  `${link.source}:${link.pageId}`;

/**
 * Diff `named` against `stored`, considering ONLY the sources in `sources` — a
 * save that supplied just one body leaves the other field's rows as they are.
 */
export function diffItemDerivedLinks(
  stored: readonly ItemDerivedPageLinkRecord[],
  named: readonly ItemDerivedPageLink[],
  sources: ReadonlySet<ItemDerivedPageLinkSourceValue>,
): ItemDerivedLinkDiff {
  const inScope = stored.filter((row) => sources.has(row.source));
  const namedKeys = new Set(named.filter((l) => sources.has(l.source)).map(itemKeyOf));
  const storedKeys = new Set(inScope.map(itemKeyOf));
  const seen = new Set<string>();
  const insert: ItemDerivedPageLink[] = [];
  for (const link of named) {
    if (!sources.has(link.source)) continue;
    const key = itemKeyOf(link);
    if (storedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    insert.push(link);
  }
  return {
    deleteIds: inScope.filter((row) => !namedKeys.has(itemKeyOf(row))).map((row) => row.id),
    insert,
  };
}
