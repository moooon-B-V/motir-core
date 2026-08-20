#!/usr/bin/env node
/**
 * Detect design results published by a pull request that authored NO design
 * (MOTIR-3215 — the reproducible half of the defect MOTIR-3213 fixed).
 *
 * WHY A SCRIPT AND NOT A QUERY. The signature is not expressible in SQL: it is a
 * fact about GitHub. A `design_evidence` row records the CI run that wrote it
 * (`ci_run_url`); getting from there to "how many files under `design/` did that
 * pull request change" means run -> head branch -> pull request -> file list,
 * three API hops away from the database. So the database half and the GitHub
 * half are joined here.
 *
 * THE TEST, and what it is NOT:
 *   ZERO design files in the publishing pull request  -> a STRAY. Whatever those
 *     assets are, this pull request did not author them.
 *   assets > design files                             -> an OVER-publish.
 *   the card's `type` is not `design`                 -> NOT the test. It both
 *     over- and under-reports: plenty of legitimate publishes come off `code`
 *     cards whose diff touched a mock, and a `design` card can carry a stray.
 *
 * ⚠️ COUNT THE FILES WITH THE PAGINATED REST LIST, NEVER `gh pr view --json
 * files`. That view CAPS its file list at 100 entries, silently. Reading a
 * 138-design-file pull request through it returns 100 and makes a correct
 * publish look like a 38-asset over-publish — which is exactly the false
 * positive MOTIR-3215's own description carried for MOTIR-3122 before this
 * script re-measured it.
 *
 * WITHDRAWN ROWS ARE EXCLUDED by default. A row that has been taken back is
 * already answered for; leaving it in the report would make the sweep look
 * unfinished forever. Pass `--include-withdrawn` to see them.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ THE CREDENTIAL IS PART OF THE ASSERTION (MOTIR-3227)
 * ══════════════════════════════════════════════════════════════════════════
 * `design_evidence` is `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, with a
 * policy keyed on `current_setting('app.workspace_id')`. This script opens a
 * plain `pg` connection and sets no tenant GUC, so under a role WITHOUT
 * `rolbypassrls` every policy matches nothing:
 *
 *   connection                 role            rolbypassrls   rows seen
 *   -------------------------  --------------  ------------   ---------
 *   DATABASE_URL (pooled)      motir_app       false                  0
 *   DATABASE_URL_UNPOOLED      neondb_owner    true                  47
 *
 * The first version of this script's USAGE named the POOLED url, and on
 * 2026-08-20 a production run of it printed `Scanned 0 … No stray or
 * over-published design results. ✓` and exited 0 against 42 live rows. That is
 * why the population count is read FIRST and an empty one exits 3 — the guard
 * is on ABSENCE, not on presence, because the old shape's only failure mode
 * was `flagged.length > 0` and an empty population has zero flagged rows.
 *
 * USAGE
 *   # The credential must be able to READ design_evidence under RLS — i.e. a
 *   # role with rolbypassrls (Neon's `neondb_owner`, reached by the UNPOOLED
 *   # url), NOT the pooled `motir_app` role the app runs as.
 *   DATABASE_URL="$DATABASE_URL_UNPOOLED" GITHUB_TOKEN=<token> \
 *     node scripts/detect-stray-design-results.mjs [--repo owner/name] \
 *                                                  [--include-withdrawn] [--json]
 *
 *   Inside the motir-core Fly machine both urls are already in the environment,
 *   so this is the whole command:
 *     DATABASE_URL="$DATABASE_URL_UNPOOLED" node scripts/detect-stray-design-results.mjs
 *
 *   The pooled url works too IF it carries the tenant context the policy reads,
 *   but it then scans that ONE workspace rather than the table:
 *     DATABASE_URL="$DATABASE_URL&options=-c%20app.workspace_id%3D<workspace-id>"
 *
 * THE GITHUB CREDENTIAL. `GITHUB_TOKEN` may be any token with `repo:read` — but
 * nothing needs to travel to run this in production: the machine already holds
 * `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, and a GitHub **App installation
 * token** minted from them works here and expires in an hour. Mint it with the
 * app JWT (`POST /app/installations/{id}/access_tokens`) and pass the result as
 * `GITHUB_TOKEN`. That is how the 2026-08-20 production run was done.
 *
 * EXIT CODES
 *   0  scanned a non-empty population and found nothing to flag
 *   1  findings — stray or over-published rows are listed
 *   2  usage: a required environment variable is missing
 *   3  BLIND READ — the population was empty, so the scan asserted nothing
 *
 * NOTE ON THE PATH. `prisma/migrations/20260820140100_withdraw_stray_design_
 * results/migration.sql` cites this file as `scripts/design-evidence/detect-
 * stray-design-results.mjs`. There is no `scripts/design-evidence/` directory
 * and never was; the file is, and has always been, `scripts/detect-stray-
 * design-results.mjs`. A merged migration's SQL cannot be edited (Prisma
 * checksums it), so the correction lives here.
 *
 * Read-only. It opens one connection, issues three SELECTs, and writes nothing.
 * The logic is in `scripts/detectStrayDesignResults.mjs` so that it can be
 * tested (`tests/scripts/detect-stray-design-results.test.ts`); this file is
 * the half that owns the connection, stdout and the exit code.
 */

/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */

import { Client } from 'pg';
import { EXIT_USAGE, formatJson, formatResult, scan } from './detectStrayDesignResults.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPO = opt('repo', 'moooon-B-V/motir-core');
const INCLUDE_WITHDRAWN = flag('include-withdrawn');
const AS_JSON = flag('json');
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(EXIT_USAGE);
}
if (!TOKEN) {
  console.error('GITHUB_TOKEN (or GH_TOKEN) is required — the file counts come from the API.');
  process.exit(EXIT_USAGE);
}

const gh = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'motir-detect-stray-design-results',
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
};

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let result;
try {
  result = await scan({
    query: (sql) => client.query(sql),
    gh,
    repo: REPO,
    includeWithdrawn: INCLUDE_WITHDRAWN,
  });
} finally {
  await client.end();
}

console.log(AS_JSON ? formatJson(result) : formatResult(result));

// A flagged row is a finding, not a crash — but the exit code is what lets the
// post-withdrawal re-run be an assertion rather than something somebody reads.
// An EMPTY population is not a clean sweep and exits 3, for the same reason.
process.exit(result.exitCode);
