// The Activity-section tab (Story 5.5 · Subtask 5.5.4) — URL-driven via
// `?activity=all|comments|history` (the 2.5.8 `?view=` house pattern), so a
// tab choice is shareable and the server renders the active tab's first page.
// The DEFAULT tab is Comments (the verified Jira default); the default keeps
// a clean URL (no param).

export const ACTIVITY_TABS = ['all', 'comments', 'history'] as const;

export type ActivityTab = (typeof ACTIVITY_TABS)[number];

export const DEFAULT_ACTIVITY_TAB: ActivityTab = 'comments';

/** Parse `?activity=` — anything unknown falls back to the default tab. */
export function parseActivityTab(value: string | undefined): ActivityTab {
  return (ACTIVITY_TABS as readonly string[]).includes(value ?? '')
    ? (value as ActivityTab)
    : DEFAULT_ACTIVITY_TAB;
}
