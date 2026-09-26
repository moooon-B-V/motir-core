// THE WIRE SHAPES of motir-ai's organization-lifecycle routes (Story MOTIR-6306),
// recorded from the motir-ai source that defines them, so motir-core's gate stubs
// motir-ai at its HTTP seam with what motir-ai actually answers rather than a guess.
//
//   POST   /v1/orgs/:coreOrganizationId/closing        body { dueAt }  → ClosingResult
//   DELETE /v1/orgs/:coreOrganizationId/closing                         → ClosingResult
//     motir-ai `src/app.ts` (the `/closing` routes, MOTIR-6392) ·
//     `src/services/orgClosingService.ts` `ClosingResult { changed, closing }`
//   POST   /v1/orgs/:coreOrganizationId/offboard                        → OffboardOrgResult
//     motir-ai `src/app.ts` (MOTIR-6393) · `src/services/orgOffboardingService.ts`
//     `OffboardOrgResult`
//   POST   /v1/orgs/:coreOrganizationId/purge-retained                  → { purged }
//     motir-ai `src/app.ts` (MOTIR-6394) · `src/services/orgOffboardingService.ts`
//     `purgeRetained` → `{ purged: boolean }`
//
// Every route is idempotent and answers 200; an unknown org is `changed: false` /
// `erased: false` / `purged: false`, never a 404. A 409 `org_not_erased` is the one
// refusal, and only on purge-retained.

export const CLOSING_OPENED = { changed: true, closing: true } as const;
export const CLOSING_REOPENED = { changed: true, closing: false } as const;

export const OFFBOARD_ERASED = {
  erased: true,
  subscriptionsCancelled: 1,
  codeGraph: { snapshotObjectsDeleted: 0, localRootRemoved: false, coordinationRowsDeleted: 0 },
  projectsDeleted: 2,
  indexAllowanceRowsDeleted: 0,
  indexRunVerdictsDeleted: 0,
  agentRunsDeleted: 0,
} as const;

export const PURGE_RETAINED = { purged: true } as const;

export type MotirAiLifecycleCall = { method: string; path: string; body: unknown };

/**
 * A `fetch` stand-in for motir-ai's lifecycle routes. Records every call; answers
 * with the recorded shapes above. `failOffboard` makes the offboard route answer a
 * 503 problem, as an unreachable motir-ai would.
 */
export function motirAiLifecycleFetch(opts: { failOffboard?: () => boolean } = {}) {
  const calls: MotirAiLifecycleCall[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, body });
    if (/\/v1\/orgs\/[^/]+\/closing$/.test(url.pathname)) {
      return json(method === 'DELETE' ? CLOSING_REOPENED : CLOSING_OPENED);
    }
    if (/\/v1\/orgs\/[^/]+\/offboard$/.test(url.pathname)) {
      if (opts.failOffboard?.()) {
        return json(
          { type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'unavailable' },
          503,
        );
      }
      return json(OFFBOARD_ERASED);
    }
    if (/\/v1\/orgs\/[^/]+\/purge-retained$/.test(url.pathname)) return json(PURGE_RETAINED);
    return json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404);
  };
  return { calls, fetchImpl };
}
