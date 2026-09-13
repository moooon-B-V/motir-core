import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The Workbench tab axis (Story MOTIR-4777 · MOTIR-4782) — a leaf module so the
// page, the tab strip and the tests share ONE definition of what a tab is and
// how it is spelled in a URL.
//
// The selection lives in the URL (`design/workbench/design-notes.md` §"The tab
// strip", amended by § 21). The rule is ONE CANONICAL URL PER TAB, and since
// MOTIR-5218 it is TOTAL: every tab — To do and To approve included — is
// spelled `?tab=<slug>`, and no tab is spelled as the bare path.
//
// ⚠️ IT USED TO BE SPECIAL-CASED, AND WHY THAT HAD TO GO. The default tab (To
// do) was spelled as the ABSENCE of the param, so a link to the Workbench and a
// link to To do were the same link. That implementation assumed the default was
// FIXED. The landing now CASCADES (§ 21) — a bare `/workbench` resolves to
// To approve, else In progress, else To do, per reader and per day — so the bare
// path cannot be any one tab's spelling: it would name a different view for
// every reader, the very ambiguity the one-URL rule forbids. So the rule is kept
// by making it total, and the bare path is an ENTRANCE, not a view. The resolver
// that decides where it forwards is MOTIR-5221's.
//
// ⚠️ THE LABEL AND THE SLUG ARE DIFFERENT WORDS ON PURPOSE, on two of the five.
// A slug names the SET and a label says what the tab is FOR: `finished` is
// addressed by the noun and read as *Recently finished*, and `approvals` is
// addressed by the noun and read as **To approve** — the other four tabs name a
// state a work item is IN, and that one names something the READER must do,
// which is the whole reason it sits apart from them. An address is a noun
// somebody pastes; a label is what they read on the strip; neither owes the
// other a transliteration (`design-notes.md` § The tab strip).

export type WorkbenchTab = 'todo' | 'in-progress' | 'finished' | 'watching' | 'approvals';

/**
 * Every tab, in strip order — the DESIGN's order (`design-notes.md` § 21,
 * MOTIR-5216): what is waiting on you, what is moving, what to start, what just
 * landed, what you follow.
 *
 * ⚠️ The order says NOTHING about which tab a bare `/workbench` shows. Nothing
 * reads the first member as a default: `BY_PARAM` is built order-independently,
 * and what a paramless request gets is decided in `parseWorkbenchTab` below.
 */
export const WORKBENCH_TABS: readonly WorkbenchTab[] = [
  'approvals',
  'in-progress',
  'todo',
  'finished',
  'watching',
];

/**
 * The `?tab=` spelling of each tab. ⚠️ `string`, never `string | null`: the type
 * is what refuses a future paramless tab — a sixth tab added without a slug is a
 * compile error, not a test failure somebody has to notice.
 */
const TAB_PARAM: Readonly<Record<WorkbenchTab, string>> = {
  approvals: 'approvals',
  'in-progress': 'in-progress',
  todo: 'todo',
  finished: 'finished',
  watching: 'watching',
};

const BY_PARAM = new Map<string, WorkbenchTab>(
  WORKBENCH_TABS.map((tab) => [TAB_PARAM[tab], tab] as const),
);

/**
 * Narrow an untrusted `?tab=` value. Anything that is not a known slug —
 * absent, misspelled, hand-edited, a stale bookmark — LANDS rather than 404s,
 * because this is the page a reader sees first after signing in.
 *
 * ⚠️ THE FALLBACK IS AN INTERIM, and it is To approve (MOTIR-5218). With every
 * tab addressable, a request naming no known tab is no longer "To do" by
 * definition, and the design leads with what is waiting on the reader. The
 * resolver card (MOTIR-5221) RETIRES this fallback: the parse becomes strict and
 * a request with no known tab runs the cascade instead of taking a fixed tab.
 */
export function parseWorkbenchTab(raw: string | string[] | undefined): WorkbenchTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value !== undefined && BY_PARAM.get(value)) || 'approvals';
}

/**
 * The canonical URL for a tab, optionally at a given PAGE.
 *
 * Every tab carries its `?tab=` (MOTIR-5218), so this is the ONE builder of a
 * Workbench tab link: code that wants a tab reaches for this, never for the
 * bare landing path, which names no tab.
 *
 * ⚠️ PAGE 1 EMITS NO PARAM: one canonical URL per view (MOTIR-4853). A link to
 * a tab and a link to its first page are the same link, so nothing has to decide
 * which of two spellings to share, and the pager's own `1` button navigates to
 * the tab's plain href.
 *
 * ⚠️ It took a `cursor` until MOTIR-4852 retired the keyset. The shape is the
 * same and the meaning is not: a cursor was an opaque POSITION that only the
 * read that minted it could interpret, so it could only ever be handed back; a
 * page is a number a person can type, bookmark and share.
 */
export function workbenchTabHref(tab: WorkbenchTab, page?: number | null): string {
  const params = new URLSearchParams();
  params.set('tab', TAB_PARAM[tab]);
  if (page !== null && page !== undefined && page > 1) params.set('page', String(page));
  return `${AUTHED_LANDING_PATH}?${params.toString()}`;
}
