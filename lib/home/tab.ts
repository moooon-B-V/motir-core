import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The Home tab axis (Story MOTIR-2649 · Subtask MOTIR-2653) — a leaf module so
// the page, the tab strip and the tests share ONE definition of what a tab is
// and how it is spelled in a URL.
//
// The selection lives in the URL (`design/home/design-notes.md` §"The tab
// strip"): `/home` is My work and `/home?tab=watching` is Watching. My work is
// the default and is therefore SPELLED as the absence of the param rather than
// as `?tab=work` — one canonical URL per tab, so a link to Home and a link to
// My work are the same link.

export type HomeTab = 'work' | 'watching';

/**
 * Narrow an untrusted `?tab=` value. Anything that is not `watching` — absent,
 * misspelled, hand-edited, a stale bookmark — is My work, because a landing
 * page should land rather than 404 on a typo in a query param.
 */
export function parseHomeTab(raw: string | string[] | undefined): HomeTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'watching' ? 'watching' : 'work';
}

/** The canonical URL for a tab, optionally resuming at a page cursor. */
export function homeTabHref(tab: HomeTab, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (tab === 'watching') params.set('tab', 'watching');
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `${AUTHED_LANDING_PATH}?${query}` : AUTHED_LANDING_PATH;
}
