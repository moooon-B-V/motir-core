import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// WHAT A SETTLED WORKBENCH LANDING LOOKS LIKE (Story MOTIR-5213 · MOTIR-5221).
//
// The bare `/workbench` is a RESOLVER now: it reads the reader's counts and
// forwards to To approve, else In progress, else To do (`lib/workbench/landing.ts`,
// `design/workbench/design-notes.md` § 21). So "the reader landed on the
// Workbench" no longer means "the address is `/workbench`" — that address is the
// entrance, and a URL reading it has not finished arriving. The landing is SETTLED
// once the address names a TAB.
//
// ⚠️ WHY A PREDICATE AND NOT THE OLD `'**/workbench'` GLOB. A Playwright glob
// matches the WHOLE url, query included, so it stopped matching the day the landing
// gained a `?tab=` — about fifty waits across the suite at once. Matching the
// pathname alone would have been the cheap repair and the wrong one: it is true of
// the entrance too, so it would settle on an address the resolver has not answered
// yet. This asks for the thing that proves the resolver ran.
//
// No side effects on import — unlike `shell-session.ts`, which loads the job
// registry — so any spec can use it.

/** The three tabs the cascade can land on; `?tab=` on a landing names one of them. */
const LANDING_TABS = ['approvals', 'in-progress', 'todo'] as const;

/** True once a landing on the Workbench has RESOLVED to one of its tabs. */
export function isLandedWorkbenchUrl(url: URL): boolean {
  const tab = url.searchParams.get('tab');
  return (
    url.pathname === AUTHED_LANDING_PATH &&
    tab !== null &&
    (LANDING_TABS as readonly string[]).includes(tab)
  );
}

/** The same, for `toHaveURL`: a bare landing that resolved, with nothing else on it. */
export const LANDED_WORKBENCH_URL = new RegExp(
  `${AUTHED_LANDING_PATH}\\?tab=(${LANDING_TABS.join('|')})$`,
);
