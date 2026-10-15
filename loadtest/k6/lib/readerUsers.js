// THE READERS, FROM THE SEED'S MANIFEST (Story MOTIR-8538 · MOTIR-8677).
//
// One reader record per seeded user: the session `Cookie` header exactly as the
// seed wrote it (`users[].cookieHeader`, which also pins the reader's workspace),
// and the read plans of the reader's OWN project — a plan from another workspace
// answers 404 (no existence leak) and would count as an error the scenario caused.
// This card never builds a cookie name and never asserts one.
//
// PURE (no k6 import). `./manifest.js` loads it into a k6 SharedArray.

/** The reader records of a manifest: `{ userId, workspaceId, projectId, cookieHeader, readPlanIds }`. */
export function readersFromManifest(manifest) {
  const plansByProject = new Map(
    (manifest.projects ?? []).map((p) => [p.id, Array.isArray(p.readPlanIds) ? p.readPlanIds : []]),
  );
  return (manifest.users ?? []).map((u) => ({
    userId: u.id,
    workspaceId: u.readerWorkspaceId,
    projectId: u.readerProjectId,
    cookieHeader: u.cookieHeader,
    readPlanIds: plansByProject.get(u.readerProjectId) ?? [],
  }));
}

/**
 * The reader a VU holds for the whole run: `__VU` (1-based) modulo the seeded
 * users, so no two VUs share a cookie until there are more VUs than users.
 */
export function readerIndexForVu(vu, readerCount) {
  if (!(readerCount > 0)) throw new Error('the manifest holds no users to read as');
  return (((vu - 1) % readerCount) + readerCount) % readerCount;
}

/** The init-time warning when the profile asks for more readers than seeded users, else null. */
export function readerReuseWarning(readerVus, readerCount) {
  if (!(readerVus > readerCount)) return null;
  return (
    `loadtest: ${readerVus} reader VUs share ${readerCount} seeded users, so some ` +
    'sessions are used by more than one VU. Seed more users for one cookie per reader.'
  );
}

/** `readerBrowse`'s default step weights; the profile overrides them. */
export const DEFAULT_BROWSE_WEIGHTS = Object.freeze({
  boards: 2,
  items: 2,
  items_page: 1,
  plan_get: 2,
  plan_poll: 3,
});

/**
 * The `since` a poll sends for a plan this VU holds no `reviewVersion` for. A
 * read plan is `planned`, and the review only carries a `reviewVersion` while a
 * plan is `generating` (`planReviewService`), so a read plan never hands one back:
 * the poll still takes the server's conditional path (admit, version read, full
 * review), which is what a poll costs, at a size that never drifts.
 */
export const NO_REVIEW_VERSION = '0';

/**
 * The request one browse step makes: `{ route, path, planId? }`. `versions` maps a
 * plan id to the `reviewVersion` its last read returned, which the poll sends back
 * as `?since=`. A plan step for a reader whose project has no read plan falls back
 * to `/items`. `itemsPages` is the highest `/items?page=` a step asks for (default 3).
 */
export function browseTarget(step, reader, versions, r, itemsPages = 3) {
  const plans = reader.readPlanIds ?? [];
  const planId =
    plans.length > 0 ? plans[Math.min(plans.length - 1, Math.floor(r * plans.length))] : null;
  switch (step) {
    case 'boards':
      return { route: 'boards', path: '/boards' };
    case 'items_page': {
      const top = Math.max(2, itemsPages);
      return {
        route: 'items',
        path: `/items?page=${2 + Math.min(top - 2, Math.floor(r * (top - 1)))}`,
      };
    }
    case 'plan_get':
      if (planId === null) return { route: 'items', path: '/items' };
      return { route: 'plan_get', path: `/api/plans/${planId}`, planId };
    case 'plan_poll': {
      if (planId === null) return { route: 'items', path: '/items' };
      const since = typeof versions[planId] === 'string' ? versions[planId] : NO_REVIEW_VERSION;
      return {
        route: 'plan_poll',
        path: `/api/plans/${planId}?since=${encodeURIComponent(since)}`,
        planId,
      };
    }
    case 'items':
    default:
      return { route: 'items', path: '/items' };
  }
}
