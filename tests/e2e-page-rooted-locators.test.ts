import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-5037 — the guard that makes a SIXTH duplicate-locator site unwritable.
//
// ── The defect ─────────────────────────────────────────────────────────────
// React keeps the PREVIOUS subtree mounted while the new one streams, and
// Playwright resolves locators BEFORE filtering on visibility. So a locator
// rooted at `page` can match a node the author never knew was there, in three
// distinct mechanisms:
//
//   1. the transient VISIBLE double subtree        (MOTIR-3692)
//   2. the OUTGOING subtree on a navigation        (MOTIR-3725, MOTIR-3737)
//   3. React's hidden `S:0` SSR staging block      (MOTIR-3929)
//
// `getByRole` is immune to all three: the accessibility tree excludes the
// streamed and outgoing copies. `tests/e2e/_helpers/settle.ts` says so in the
// doc comment on `expectSettledVisible`, Playwright prints the role alias in its
// own strict-mode failure text, and `CLAUDE.md` records that of the thirty
// assertions one route-group boundary took down, exactly ZERO used `getByRole`.
//
// ── Why a GUARD and not a sixth fix ────────────────────────────────────────
// Five sites were repaired one at a time — MOTIR-3692, MOTIR-3725, MOTIR-3737,
// MOTIR-3929, MOTIR-4822 — and a sixth landed on 2026-09-10. Every one of those
// fixes was correct, and not one of them changed the odds for the next spec
// anybody writes. MOTIR-3725's own title said so in August ("ANY new `cloud-*`
// spec re-rolls the dice"), and the dice have been re-rolled three times since.
//
// The reason repetition beats memory here is that the shape almost always
// works. It fails only when a page is mid-navigation or mid-stream, so it passes
// in review, passes locally, passes on the pull request — and then loses a
// MERGE-QUEUE slot, where a failure does not present as a failure at all, just
// as a merge that did not happen. An inventory records the debt; only a guard
// stops it growing.
//
// ── ONE PREDICATE, deliberately ────────────────────────────────────────────
// This guard does not re-implement the scan. It runs
// `scripts/enumerate-page-locators.mjs --worktree` — an entry point that script
// grew FOR this guard, because a guard has to rule on the tree it is running
// against (the merge commit CI built, a ref nobody can name in advance). Two
// copies of the predicate is precisely how an inventory and its guard come to
// disagree about what the population is, and then neither can be trusted.
//
// ── The allow-list is NOT the inventory, and that distinction is the ratchet ─
// `tests/helpers/pageLocatorInventory.json` is MOTIR-5035's DATED EVIDENCE, and
// its own note says so: a snapshot, re-run rather than hand-edited.
// `tests/helpers/pageRootedLocatorAllowList.json` is this guard's CONTRACT, and
// it is hand-shrunk. Pointing the guard at the evidence file instead would make
// `node scripts/enumerate-page-locators.mjs --worktree --out …` the one-command
// way to silence it — a ratchet you can re-cut is a rubber stamp.
//
// That separation is not theoretical. Measured while seeding this list: the
// committed inventory was generated at `0cdd700da` and last committed at
// 14:34Z by #2795; `tests/e2e/approval-gate-repaint.spec.ts` arrived at 15:23Z
// with #2814, carrying SIX page-rooted sites. So the evidence file was already
// stale against `main`'s own tree by six rows inside a 49-minute window, through
// nobody's mistake — a file simply landed inside another branch's measurement
// window. Seeded from that file, this guard would have been RED ON `main` the
// day it shipped. It is seeded from a fresh scan of `origin/main` instead, and
// the tree side is re-derived on every run rather than read from a commit.
const ROOT = process.cwd();

interface Row {
  id: string;
  file: string;
  method: string;
  arg: string | null;
  line: number;
  exempt: string | null;
}

interface AlertRow {
  file: string;
  line: number;
  /** The call's argument as written, e.g. `'alert'` — null when the scanner
   *  could not close the call. The failure message prints it, so the locator a
   *  reader has to go and find is the one they actually typed. */
  arg: string | null;
  narrowed: string | null;
  isCount: boolean;
}

interface Scan {
  totals: { rows: number; ruled: number; exempt: number; unresolved: number };
  filesScanned: number;
  rows: Row[];
  alertAudit: { rows: AlertRow[] };
}

/** Run the ONE predicate over the CHECKED-OUT tree — including untracked files,
 *  which is what lets the probe at the bottom of this file drive the real
 *  scanner rather than a re-implementation of it. ~0.15 s over 277 files. */
function scan(): Scan {
  return JSON.parse(
    execFileSync('node', ['scripts/enumerate-page-locators.mjs', '--worktree'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Scan;
}

const ALLOW_LIST = JSON.parse(
  readFileSync(join(ROOT, 'tests/helpers/pageRootedLocatorAllowList.json'), 'utf8'),
) as { ids: string[]; count: number; seededFrom: string };

/** The two halves of "tight in both directions", as PURE functions over a row
 *  list and an id set — so the synthetic cases below drive the identical code
 *  the real assertions run. A control that re-implements the comparison proves
 *  the control works, not the comparison. */
export function unlistedIds(rows: readonly Row[], allowed: ReadonlySet<string>): Row[] {
  return rows.filter((r) => !r.exempt && !allowed.has(r.id));
}

export function staleIds(rows: readonly Row[], allowed: ReadonlySet<string>): string[] {
  const live = new Set(rows.filter((r) => !r.exempt).map((r) => r.id));
  return [...allowed].filter((id) => !live.has(id)).sort();
}

/** A page-rooted `getByRole('alert')` used as a COUNT. Different mechanism,
 *  identical shape: Radix's `Toast.Provider` keeps an EMPTY live region mounted
 *  for the life of the authed shell, so a page-level `toHaveCount(0)` against it
 *  can never pass. A narrowed one (`.filter()`, `.first()`) is not a count. */
export function pageRootedAlertCounts(rows: readonly AlertRow[]): AlertRow[] {
  return rows.filter((r) => r.isCount && !r.narrowed);
}

const REMEDY =
  'Use `page.getByRole(<role>, { name })` — the accessibility tree excludes the streamed and ' +
  'outgoing copies, which is the whole of why this class cannot touch it. Where the node carries ' +
  'no role, scope to the LIVE subtree instead (a dialog, a named region, `page.getByRole("main")`). ' +
  '`.first()` / `.nth()` / `.last()` also resolve to one element and are exempt by name.';

const WHY =
  'A page-rooted strict locator can match a node you never put there: React keeps the PREVIOUS ' +
  'subtree mounted while the new one streams (MOTIR-3692, MOTIR-3725, MOTIR-3737), and its hidden ' +
  '`S:0` SSR staging block is in the DOM too (MOTIR-3929). It passes locally and in review, then ' +
  'loses a MERGE-QUEUE slot — where the failure does not look like a failure, only like a merge ' +
  'that did not happen.';

describe('no NEW page-rooted strict locator enters tests/e2e (MOTIR-5037)', () => {
  const result = scan();
  const allowed = new Set(ALLOW_LIST.ids);

  it('has a non-empty population to rule on — the scan actually read the tree', () => {
    // Without this, every assertion below passes on an empty set, which is how
    // a totality test dies quietly: a scanner that returns nothing agrees with
    // an allow-list that lists nothing.
    expect(result.filesScanned).toBeGreaterThan(200);
    expect(result.totals.rows).toBeGreaterThan(1_000);
    expect(result.totals.unresolved, 'the scanner failed to parse a call').toBe(0);
  });

  it('the allow-list is the standing debt and nothing else — no exempt row was banked', () => {
    // An exempt row is not in the defect class, so listing one would inflate the
    // debt and make the ratchet look like it is shrinking when nothing changed.
    const exemptIds = new Set(result.rows.filter((r) => r.exempt).map((r) => r.id));
    expect([...allowed].filter((id) => exemptIds.has(id))).toEqual([]);
    expect(ALLOW_LIST.count).toBe(ALLOW_LIST.ids.length);
  });

  it('FORWARD — no page-rooted locator exists that the allow-list does not carry', () => {
    const offenders = unlistedIds(result.rows, allowed).map(
      (r) => `${r.file}:${r.line}  page.${r.method}(${r.arg ?? '…'})`,
    );

    expect(
      offenders,
      `These page-rooted strict locators are NEW — they are in tests/e2e and not in the ` +
        `allow-list, so this guard is the first thing to see them.\n\n${WHY}\n\n${REMEDY}\n\n` +
        `Do NOT regenerate tests/helpers/pageRootedLocatorAllowList.json to make this pass: the ` +
        `list is a ratchet and may only shrink. Fix the locator.`,
    ).toEqual([]);
  });

  it('REVERSE — no allow-list entry has stopped describing the tree; the list only shrinks', () => {
    const stale = staleIds(result.rows, allowed);

    expect(
      stale,
      `These allow-list entries no longer match anything in tests/e2e — the site was converted, ` +
        `renamed or deleted. DELETE each line from ` +
        `tests/helpers/pageRootedLocatorAllowList.json. This half is what makes the list a debt ` +
        `somebody eventually empties rather than one that fossilises: a list that merely may not ` +
        `GROW never records the work already done against it.`,
    ).toEqual([]);
  });

  it('no page-rooted getByRole("alert") is used as a COUNT', () => {
    const counts = pageRootedAlertCounts(result.alertAudit.rows).map(
      (r) => `${r.file}:${r.line}  page.getByRole(${r.arg ?? 'alert'}) counted`,
    );

    expect(
      counts,
      `A page-level count against role="alert" can never pass: Radix's Toast.Provider keeps an ` +
        `EMPTY live region mounted for the life of the authed shell, so the count is never zero ` +
        `and never only yours. Scope the count to the container that owns the toast, or assert on ` +
        `the toast's own text inside it. MOTIR-5035 measured this arm at ZERO sites, so this ` +
        `assertion carries no allow-list at all — it is a state to KEEP, not a debt to pay down.`,
    ).toEqual([]);
  });

  it('the seed is recorded, so a reader can re-derive the list', () => {
    expect(ALLOW_LIST.seededFrom).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('the guard BITES — demonstrated against the real scanner, not assumed', () => {
  it('catches a deliberately-bad locator written into tests/e2e', () => {
    // The predicate itself, end to end. `--worktree` reads `git ls-files
    // --others`, so an UNTRACKED probe is in the scanned population exactly as a
    // newly written spec would be.
    //
    // `.probe.ts`, not `.spec.ts`: Playwright's `testDir` is `tests/e2e` and its
    // testMatch only takes `*.spec.ts` / `*.test.ts`, so this file cannot be
    // picked up as a browser test even in the window where it exists. The lane
    // runs `fileParallelism: false`, and the write is undone in a `finally`.
    const probe = join(ROOT, 'tests/e2e/_motir5037-guard.probe.ts');
    try {
      writeFileSync(
        probe,
        [
          '// Written and removed by tests/e2e-page-rooted-locators.test.ts.',
          "await expect(page.getByText('a locator nobody should write')).toBeVisible();",
          "await page.getByTestId('motir-5037-probe').click();",
          "await expect(page.getByRole('alert')).toHaveCount(0);",
          '',
        ].join('\n'),
      );

      // ⚠️ SCOPED TO THE PROBE, deliberately. Asserting that the probe's rows
      // are the ONLY unlisted ones would couple this control to the rest of the
      // tree, so one genuine offender would fail BOTH the assertion that is
      // about it and this one, which is not — and the second failure would send
      // its reader to look for a bug in the control. A control reports on its
      // own fixture; the FORWARD assertion above reports on the tree.
      const isProbe = (f: string) => f.endsWith('_motir5037-guard.probe.ts');
      const sabotaged = scan();
      const caught = unlistedIds(sabotaged.rows, new Set(ALLOW_LIST.ids)).filter((r) =>
        isProbe(r.file),
      );

      expect(caught.map((r) => r.method).sort()).toEqual(['getByTestId', 'getByText']);
      // …and the alert arm fires on the same probe, independently of the list.
      expect(
        pageRootedAlertCounts(sabotaged.alertAudit.rows).filter((r) => isProbe(r.file)),
      ).toHaveLength(1);

      // GREEN again the moment it is gone — the other half of the demonstration,
      // and the half that proves the red was the probe rather than the weather.
      rmSync(probe, { force: true });
      const restored = scan();
      expect(restored.rows.filter((r) => isProbe(r.file))).toEqual([]);
      expect(
        unlistedIds(restored.rows, new Set(ALLOW_LIST.ids)).filter((r) => isProbe(r.file)),
      ).toEqual([]);
      expect(
        pageRootedAlertCounts(restored.alertAudit.rows).filter((r) => isProbe(r.file)),
      ).toEqual([]);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  it('the comparison bites in BOTH directions on synthetic rows', () => {
    // The pure half, driven over a tree that does not exist on disk — so the two
    // assertions above are testing the same functions the real ones run.
    const rows: Row[] = [
      { id: 'a', file: 'x.spec.ts', method: 'getByText', arg: "'a'", line: 1, exempt: null },
      { id: 'b', file: 'x.spec.ts', method: 'getByTestId', arg: "'b'", line: 2, exempt: null },
      { id: 'c', file: 'x.spec.ts', method: 'getByText', arg: "'c'", line: 3, exempt: '.first()' },
    ];

    // FORWARD: `b` is in the tree and not in the list.
    expect(unlistedIds(rows, new Set(['a'])).map((r) => r.id)).toEqual(['b']);
    // An exempt row is never an offender, however absent from the list.
    expect(unlistedIds(rows, new Set(['a', 'b']))).toEqual([]);
    // REVERSE: `z` is in the list and not in the tree.
    expect(staleIds(rows, new Set(['a', 'b', 'z']))).toEqual(['z']);
    // An exempt row does not keep its own allow-list entry alive.
    expect(staleIds(rows, new Set(['a', 'b', 'c']))).toEqual(['c']);
  });

  it('the alert arm distinguishes a COUNT from a narrowed locator', () => {
    const rows: AlertRow[] = [
      { file: 'x.spec.ts', line: 1, arg: "'alert'", narrowed: null, isCount: true },
      {
        file: 'x.spec.ts',
        line: 2,
        arg: "'alert'",
        narrowed: '.filter({ hasText: … })',
        isCount: true,
      },
      { file: 'x.spec.ts', line: 3, arg: "'alert'", narrowed: null, isCount: false },
    ];
    expect(pageRootedAlertCounts(rows).map((r) => r.line)).toEqual([1]);
  });
});
