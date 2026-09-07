import type { Page, Response } from '@playwright/test';

// The AUTHORITATIVE-SIGNAL waits — `CLAUDE.md` § *E2E tests wait on the
// AUTHORITATIVE signal*, made reusable.
//
// ── Why this module exists ──────────────────────────────────────────────────
//
// MOTIR-3694 wrote these two waits inside `activity.spec.ts` to close a racing
// assertion there, and bounded its own sweep at that one file. Six weeks later
// the identical shape surfaced in `issue-detail-flow.spec.ts` — everything
// needed to fix the sibling already existed, and nothing pointed from the fixed
// file to the unfixed one. MOTIR-4399 swept the whole suite for the shape; this
// module is where the remedy now lives so the next spec that needs it can
// import it instead of re-deriving it.
//
// ⚠️ **REACH FOR THESE ONLY WHEN THE ASSERTION ACTUALLY NEEDS ONE.** The sweep's
// finding was that most `click → expect` pairs in this suite are NOT racing,
// because the asserted node is rendered from the write's OWN response — a
// toast, a returned DTO applied in place, a `revalidatePath` payload. There the
// assertion cannot resolve before the write does, so it IS the wait, and arming
// one in front of it buys nothing. `docs/e2e/mutation-assert-sweep.md` carries
// the four dispositions and the census.
//
// The case that DOES need one: the asserted node arrives on a SEPARATE request —
// a client island's `router.refresh()` — whose latency stacks on top of the
// write's inside one 5 s expect budget.

/**
 * Resolve when the Server Action whose arguments contain `marker` answers.
 *
 * ⚠️ ARM IT BEFORE THE ACTION — a response that has already arrived can never
 * be waited for:
 *
 *     const write = actionWrite(page, `/items/${key}`, 'blocked_by');
 *     await page.getByRole('button', { name: 'Add' }).click();
 *     expect((await write).status()).toBe(200);
 *
 * ⚠️ THE URL CANNOT BE THE PREDICATE. Next transports every Server Action as a
 * POST to the CURRENT page URL carrying a `next-action` header, so a page's
 * edits, transitions, searches and adds are all one url + method and are
 * indistinguishable by them. The discriminator has to be the request BODY,
 * which encodes the action's own arguments — and note that a shared literal
 * (a relationship name, a status key) is often carried by BOTH the search and
 * the write, so pick a marker only the write can hold, such as the target's id.
 *
 * The predicate deliberately does NOT test the status. A write that 500s would
 * then match nothing and hang to the test timeout; matching the request here
 * and asserting the status at the call site fails in seconds and names the code
 * it actually got.
 */
export function actionWrite(page: Page, pathname: string, marker: string): Promise<Response> {
  return page.waitForResponse((res) => {
    const req = res.request();
    return (
      req.method() === 'POST' &&
      req.headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === pathname &&
      (req.postData() ?? '').includes(marker)
    );
  });
}

/**
 * Resolve when a client island's `router.refresh()` re-render lands — the RSC
 * GET of the page's OWN route.
 *
 * The 200 from a write is not the whole signal for anything the page renders
 * from the SERVER and does not patch in place. Those are repainted by THIS
 * request, not by the action's response, so its latency stacks on top of the
 * write's inside the assertion's single budget — which is the whole of the
 * defect this module exists for.
 *
 * A page does not prefetch itself, so a `_rsc` GET of its own route is the
 * refresh.
 *
 * ⚠️ ONLY for a surface that legitimately cannot patch in place — one whose
 * asserted value is SERVER-DERIVED and could not be recomputed in the browser
 * (a remaining-renames cap, a verification status the platform owns). Where the
 * value IS computable from the write's own result and the surface still waits
 * for a whole-page refresh, the surface owes an in-place update (the page-state
 * contract, case 3) and arming this wait would retire the only detector that
 * defect has — MOTIR-4496, and disposition (d) in the sweep doc.
 */
export function pageRefresh(page: Page, pathname: string): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === pathname &&
      (res.request().headers()['rsc'] !== undefined || res.url().includes('_rsc=')),
  );
}
