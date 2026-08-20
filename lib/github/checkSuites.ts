// SUPERSEDE BY RUN, NOT BY NAME (MOTIR-3209).
//
// A check row's identity used to be `(pullRequest, commitSha, checkName)`, a key
// that quietly assumes ONE workflow run per commit. `cancel-in-progress`
// (MOTIR-3106) made two runs at one commit ordinary and deliberate — a label
// added seconds after `gh pr create` starts a second run and the first is
// cancelled — and the two runs do not use the same check NAMES. So the loser's
// rows outlived the winner's exactly where the names differ:
//
//   * a matrix job cancelled BEFORE expansion reports the literal template as
//     its name (`Vitest (${{ matrix.shard }}/${{ matrix.total }})`), which the
//     winner's `Vitest (1/3)` can never overwrite — a different key;
//   * `Deploy to Fly` is the same trap from the other side: `cancelled` maps to
//     `failure` in the loser, `skipped` maps to `neutral` in the winner, and a
//     neutral records nothing, so nothing ever clears the stale failure.
//
// Rows now carry the RUN they came from, and this module is the ONE place that
// says which of those runs still gets a vote. Both derivations call it — the
// feedback comment's `deriveCiState` and the Development surface's
// `derivePrCiState` — because two opinions about one commit is precisely what
// MOTIR-2946 removed.
//
// ── WHY THE RULE IS "SHARES A CHECK NAME", NOT "IS THE SAME WORKFLOW" ───────
// Superseding must be per WORKFLOW and never per sha: motir-core runs `ci.yml`
// and `codeql.yml`, GitHub gives each workflow RUN its own check suite, and
// "newest suite at the sha wins" would let a CI re-run hide CodeQL's verdict.
//
// The obvious implementation — group by workflow id — is not available. A
// `check_run` webhook payload carries `check_suite.id` and the App slug and
// NOTHING that names the workflow: both `ci.yml` and `codeql.yml` arrive as the
// same `github-actions` App, and `details_url` names the RUN, not the workflow.
// (Verified against PR #2192's five suites at sha `82d6e346`: two CI runs, two
// CodeQL runs, one advanced-security suite — four of them indistinguishable by
// app slug.)
//
// So the workflow identity is reconstructed from what the rows themselves say: a
// run REPLACES an earlier run when it re-reports a check the earlier one
// reported. Two runs of `ci.yml` share `TypeScript`, `Next.js build`,
// `CI complete`; a CI run and a CodeQL run share nothing. The one residue,
// stated rather than hidden: a run cancelled so early that NONE of its checks
// is re-reported by its replacement is not recognised as superseded — it keeps
// today's behaviour rather than a worse one.
//
// ── WHICH RUN IS "LATER" IS THE PROVIDER'S ORDER, NOT OUR DELIVERY ORDER ────
// Deliberately NOT the row's `createdAt`. That timestamp records when a webhook
// reached us, and a backlog that delays the cancelled run's first delivery past
// the winner's would invert the answer and hand the verdict straight back to the
// run this module exists to retire. A suite id is minted by the host in creation
// order (87626130152 < 87626227873 for the two CI runs above; 87626129473 <
// 87626226092 for the two CodeQL ones), so it says what we actually mean.

/** The row fields the supersession rule reads — a slice both call sites have. */
export interface SuiteScopedCheckRow {
  checkName: string;
  /** The CI run this check belongs to. `''` means NO run identity: a row
   *  written before the column existed, or a provider that reports none (a
   *  legacy commit-`status` event). Such rows form ONE group, which supersedes
   *  nothing and is superseded by nothing unless a real run re-reports one of
   *  their names — i.e. exactly the behaviour those rows had before. */
  checkSuiteId: string;
}

/**
 * The rows at ONE commit that still get a vote — every row whose run has not
 * been replaced by a later run at that commit.
 *
 * Callers must pass rows for a single sha; this rule says nothing about which
 * commit is current (`derivePrCiState` picks that first, and the feedback
 * consumer reads one sha by construction).
 *
 * Order is preserved, so a caller's `orderBy` still holds.
 */
export function liveCheckRows<T extends SuiteScopedCheckRow>(rows: T[]): T[] {
  if (rows.length === 0) return rows;

  const names = new Map<string, Set<string>>();
  for (const row of rows) {
    const known = names.get(row.checkSuiteId);
    if (known) known.add(row.checkName);
    else names.set(row.checkSuiteId, new Set([row.checkName]));
  }
  if (names.size === 1) return rows;

  const ordered = [...names.keys()].sort(compareSuiteIds);
  const superseded = new Set<string>();
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i]!;
    const mine = names.get(id)!;
    for (let j = i + 1; j < ordered.length; j++) {
      if (sharesAName(mine, names.get(ordered[j]!)!)) {
        superseded.add(id);
        break;
      }
    }
  }
  if (superseded.size === 0) return rows;

  return rows.filter((row) => !superseded.has(row.checkSuiteId));
}

/**
 * Oldest run first, as a TOTAL order — every pair is comparable and the result
 * is transitive, so no two runs can retire each other.
 *
 * Three tiers, and only the first two occur in practice. `''` (no run identity)
 * is always OLDEST: those rows are either pre-migration or from a provider that
 * reports no run at all, and in both readings nothing about them is newer than a
 * run that named itself. Then the numeric ids the hosts actually mint, by value.
 * The string tier is a deterministic fallback for an id shape neither host uses
 * today — a repo talks to ONE provider, so a numeric/non-numeric mix cannot
 * arise from the field itself.
 */
function compareSuiteIds(a: string, b: string): number {
  const [tierA, valueA] = suiteRank(a);
  const [tierB, valueB] = suiteRank(b);
  if (tierA !== tierB) return tierA - tierB;
  if (valueA !== valueB) return valueA < valueB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function suiteRank(id: string): [number, number] {
  if (id === '') return [0, 0];
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) ? [1, numeric] : [2, 0];
}

function sharesAName(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const name of small) if (large.has(name)) return true;
  return false;
}
