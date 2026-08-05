/**
 * Fixed-window alignment for the `/api/v1` rate-limit tests.
 *
 * ── Why any of this is needed ────────────────────────────────────────────────
 * `consumeRateLimit` (`lib/api/v1/rateLimit.ts`) buckets on a grid aligned to
 * the EPOCH:
 *
 *     const windowStart = Math.floor(now / windowMs) * windowMs;
 *
 * The window therefore does **not** open at the first request — it opens
 * whenever the wall clock crosses a multiple of `windowMs`. A test that fires
 * several requests and asserts on their ACCUMULATED count is correct only if no
 * grid boundary falls between them; when one does, the counter resets mid-test
 * and the request expected to be refused is served instead.
 *
 * The odds are roughly `elapsed / windowMs`, and `elapsed` is milliseconds even
 * when nothing is wrong — each call runs the real route handler against real
 * Postgres. So the failure needs unlucky PHASE, not a slow runner: it is
 * invisible locally, it clears on `rerun --failed` every single time, and it
 * gets mis-diagnosed as "CI was loaded". **Widening the window only lowers the
 * probability; it never removes the class.** Aligning does.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Any test that sets a budget and then issues MORE THAN ONE request whose
 * outcome depends on the accumulated count must `await waitForWindowBoundary()`
 * first — after its fixture setup, immediately before the first counted
 * request, so the assertion owns a whole window instead of whatever was left of
 * a randomly-phased one. A test that issues a single counted request, or that
 * only reads `rateLimitBudget()` config, needs nothing.
 *
 * ── ⚠️ Do not copy this expression ──────────────────────────────────────────
 * MOTIR-2101 fixed this class in `rate-limit.test.ts` and the sweep stopped at
 * that file, so it kept firing from `story-gate.test.ts` (MOTIR-2224) — the
 * same defect, re-diagnosed from scratch, paid for twice. This module is the
 * ONE definition; import it rather than re-deriving the arithmetic. A guard
 * test (`tests/api/v1/rate-limit-window-alignment.guard.test.ts`) fails if a
 * second copy appears anywhere under `tests/`.
 */

/** Sleep for `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The window an accumulating test should budget against, paired with
 * `waitForWindowBoundary`.
 *
 * It is NOT the shipped 60 s default, for one reason: aligning costs up to a
 * whole window, so a test that aligned against 60 s would sleep ~30 s on
 * average. Nothing in these tests asserts the window's LENGTH — only the
 * accumulated count and the headers — so the window is free to be small enough
 * that the wait is affordable, and the alignment is what removes the race.
 *
 * Sized from measurement (MOTIR-2224, 2026-08-05): the heaviest counted section
 * in these suites is the 12-way concurrent batch at **19 ms** worst-of-20
 * (`p50` 5 ms); the 10×401-then-3 loop is 10 ms and the reported trio is 11 ms.
 * 2 s is a ~105× margin over the worst of those. That changes the failure mode
 * qualitatively rather than just making it rarer: the old one needed unlucky
 * PHASE (probability ≈ elapsed/window — which is why it fired every few days
 * across unrelated PRs), the remaining one would need a runner 105× slower than
 * measured, which is a broken machine and deserves to be a red test.
 */
export const ALIGNED_WINDOW_MS = 2_000;

/**
 * How far PAST the boundary to land. `setTimeout` may fire a hair early on a
 * coarse timer, and `Date.now()` is only millisecond-precise, so a wait that
 * aimed exactly at the boundary could still land in the outgoing cell — which
 * would leave the test with ~0 ms of window, the worst case of the very thing
 * this helper exists to prevent.
 */
export const BOUNDARY_OVERSHOOT_MS = 5;

/**
 * Sleep to just past the next fixed-window boundary of `windowMs`, handing the
 * caller a whole window for its assertion.
 *
 * Costs at most `windowMs`, and on average half of it — so keep the window a
 * test aligns against no larger than it needs to be.
 */
export function waitForWindowBoundary(windowMs: number): Promise<void> {
  return sleep(windowMs - (Date.now() % windowMs) + BOUNDARY_OVERSHOOT_MS);
}
