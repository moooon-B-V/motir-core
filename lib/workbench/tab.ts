import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The Workbench tab axis (Story MOTIR-4777 · MOTIR-4782) — a leaf module so the
// page, the tab strip and the tests share ONE definition of what a tab is and
// how it is spelled in a URL.
//
// The selection lives in the URL (`design/workbench/design-notes.md` §"The tab
// strip"): the Workbench itself is To do, and every other tab carries `?tab=`.
// **To do is the DEFAULT and is therefore spelled as the ABSENCE of the param**
// rather than as `?tab=todo` — one canonical URL per tab, so a link to the
// Workbench and a link to To do are the same link. That rule is inherited from
// the two-tab strip this replaces and is the reason the union's first member is
// not addressable.
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

/** Every tab, in strip order. To do leads because it is the default. */
export const WORKBENCH_TABS: readonly WorkbenchTab[] = [
  'todo',
  'in-progress',
  'finished',
  'watching',
  'approvals',
];

/** The `?tab=` spelling of each tab; `null` for the default, which has none. */
const TAB_PARAM: Readonly<Record<WorkbenchTab, string | null>> = {
  todo: null,
  'in-progress': 'in-progress',
  finished: 'finished',
  watching: 'watching',
  approvals: 'approvals',
};

const BY_PARAM = new Map<string, WorkbenchTab>(
  WORKBENCH_TABS.flatMap((tab) => {
    const param = TAB_PARAM[tab];
    return param === null ? [] : [[param, tab] as const];
  }),
);

/**
 * Narrow an untrusted `?tab=` value. Anything that is not a known slug —
 * absent, misspelled, hand-edited, a stale bookmark — is To do, because a
 * landing page should land rather than 404 on a typo in a query param.
 */
export function parseWorkbenchTab(raw: string | string[] | undefined): WorkbenchTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value !== undefined && BY_PARAM.get(value)) || 'todo';
}

/**
 * The canonical URL for a tab, optionally at a given PAGE.
 *
 * ⚠️ PAGE 1 EMITS NO PARAM, for the same reason To do emits no `?tab=`: one
 * canonical URL per view (MOTIR-4853). A link to a tab and a link to its first
 * page are the same link, so nothing has to decide which of two spellings to
 * share, and the pager's own `1` button navigates to the tab's plain href.
 *
 * ⚠️ It took a `cursor` until MOTIR-4852 retired the keyset. The shape is the
 * same and the meaning is not: a cursor was an opaque POSITION that only the
 * read that minted it could interpret, so it could only ever be handed back; a
 * page is a number a person can type, bookmark and share.
 */
export function workbenchTabHref(tab: WorkbenchTab, page?: number | null): string {
  const params = new URLSearchParams();
  const param = TAB_PARAM[tab];
  if (param !== null) params.set('tab', param);
  if (page !== null && page !== undefined && page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `${AUTHED_LANDING_PATH}?${query}` : AUTHED_LANDING_PATH;
}
