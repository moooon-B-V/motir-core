// The preamble every non-zero ratchet in `tests/rls/` puts at the TOP of its
// failure message (MOTIR-2941).
//
// ── Why a shared function and not seven copies of a paragraph ───────────────
// MOTIR-2939 wrote this paragraph once, by hand, into the `tests/e2e/**`
// ceiling's message, because that is the ratchet that had just failed. Copying
// it into the other six is the obvious next move and it is the wrong one: seven
// copies is seven things to keep in step, and the copy that decays is always the
// one nobody was failing against. The whole file is four lines of string; the
// reason it is a module is that `ratchet-staleness-guard.test.ts` can then
// assert every ratchet REACHES it, which a paragraph cannot be asserted about.
//
// ── What it is for ─────────────────────────────────────────────────────────
// A ratchet constant is a measurement of a POPULATION taken at one commit, and
// that commit is a branch tip. Between the measurement and the merge, siblings
// merge their own work; if any of it touches the counted population, the
// constant now describes a tree that no longer exists. The guard then fires
// CORRECTLY — the count really did move — and its message accuses whoever is
// standing there. That accusation is the defect. See
// `docs/decisions/ratchet-constant-staleness.md` for the decision this
// implements and the two alternatives it rejects.

/**
 * The re-measure-first preamble for `name`, to be concatenated at the FRONT of
 * a ratchet assertion's failure message.
 *
 * Required on every ratchet whose value is non-zero. A ratchet of exactly 0 is
 * exempt and does not need it: a count cannot fall below zero and a floor of
 * zero cannot fail, so nothing a sibling merges can move it. That exemption is
 * enforced (not merely documented) by `ratchet-staleness-guard.test.ts`, so a
 * ratchet that later moves OFF zero starts failing the meta-guard until this is
 * added — which is the moment it becomes exposed.
 */
export function remeasureFirst(name: string): string {
  return (
    `⚠️ FIRST, CHECK WHETHER IT MOVED AT ALL — THIS MAY NOT BE YOUR CHANGE (MOTIR-2941).\n\n` +
    `\`${name}\` is a constant measured on somebody's BRANCH. A sibling merging beneath it ` +
    `moves the counted population without touching the constant, so this guard fails on a ` +
    `composed tree that nobody ever measured — which is precisely how ` +
    `\`UNCONVERTED_E2E_CEILING\` failed on its OWN merge commit the day it landed, taking ` +
    `every open PR red with it (MOTIR-2939). Only a value of 0 is immune.\n\n` +
    `So re-measure at \`origin/main\` BEFORE looking for a culprit:\n\n` +
    `    git fetch origin && git worktree add ../recheck origin/main\n` +
    `    cd ../recheck && pnpm install --frozen-lockfile && pnpm vitest run tests/rls/\n\n` +
    `If it already fails there, \`${name}\` is STALE and the fix is to RE-MEASURE it — ` +
    `recording the commits that moved it, the way the comment block above the constant does — ` +
    `not to hunt for a change that did not happen. Only if \`origin/main\` is green did your ` +
    `branch move it, and only then does the rest of this message apply to you.\n\n`
  );
}
