import { expect, type Locator } from '@playwright/test';

// The SETTLING assertion — the remedy for the transient double-subtree
// strict-mode class (MOTIR-2033 → MOTIR-3272 → MOTIR-3692).
//
// ── The failure this exists for ──────────────────────────────────────────────
//
// During a client-side navigation React keeps the PREVIOUS subtree mounted while
// the new one streams, and under a production build the two are in the DOM at
// the same instant (CLAUDE.md § *a boundary makes every unscoped locator a
// race*). Playwright resolves a locator BEFORE filtering on visibility, so a
// strict locator matching both copies refuses:
//
//     Error: strict mode violation: getByTestId('ai-planning-settings')
//     resolved to 2 elements:
//       1) … aka locator('#main').getByTestId('ai-planning-settings')
//       2) … aka getByTestId('ai-planning-settings').nth(1)
//
// ⚠️ **Playwright's auto-retry cannot save that assertion.** `toBeVisible()`
// THROWS on the strict-mode violation instead of retrying it, so the expectation
// fails on the attempt AND on the retry — which is why a re-run only rotates
// which spec loses the race rather than clearing it (MOTIR-3692: two attempts,
// four specs, one surface, and a red `billing-cloud` leg that held every
// production deploy for most of a day).
//
// ── Why a settling assertion and not a narrower locator ─────────────────────
//
// MOTIR-2033 scoped its locator to the card that owned it and wrote down the
// escalation to watch for: *"if this recurs, the duplicate shape changed — the
// whole subtree is doubling, and the fix is a settling `toHaveCount`, not more
// scoping."* MOTIR-3692 is that escalation. The whole route SEGMENT mounts
// twice — one copy resolves under `#main` and the other does not — so scoping to
// `#main` narrows the window without closing it, and `.first()` is worse than
// the flake: it asserts against the STALE copy.
//
// `toHaveCount` is the one matcher that retries on the COUNT and never trips
// strict mode, which is exactly the property missing above.
//
// ── Why the whole block is wrapped rather than two statements ───────────────
//
// `toHaveCount(1)` followed by `toBeVisible()` still leaves a window: the count
// can read 1 at the instant the FIRST copy has mounted and the second has not,
// and the doubling then arrives between the two statements. `expect(…).toPass()`
// retries the block, so a strict-mode violation raised inside it is a retry
// rather than a failure — the race is closed rather than narrowed.
//
// ⚠️ It stays NON-TAUTOLOGICAL, which is the property that makes it worth
// having: a panel that genuinely never renders holds the count at 0, no
// iteration passes, and the failure names the count it kept seeing
// (`Expected: 1  Received: 0`). A settling assertion that passed on zero would
// be worse than the flake it replaces.

/** How long to wait for the doubled subtree to unmount. */
const SETTLE_TIMEOUT_MS = 15_000;

/** Each inner assertion's own budget — short, so `toPass` can re-loop. */
const ATTEMPT_TIMEOUT_MS = 1_000;

/**
 * Assert that `locator` resolves to exactly ONE node and that the node is
 * visible, retrying the pair until it holds.
 *
 * Reach for this on any page-level `getByTestId` / `getByText` / `getByLabel`
 * asserted right after a client-side navigation. `getByRole` does not need it —
 * the accessibility tree excludes the hidden copy — and neither does a locator
 * already scoped inside a portalled dialog, which a lingering route-level
 * subtree cannot reach into.
 */
export async function expectSettledVisible(locator: Locator): Promise<void> {
  await expect(async () => {
    await expect(locator).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
    await expect(locator).toBeVisible({ timeout: ATTEMPT_TIMEOUT_MS });
  }).toPass({ timeout: SETTLE_TIMEOUT_MS, intervals: [100, 250, 500, 1_000] });
}
