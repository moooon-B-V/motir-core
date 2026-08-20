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
 * USAGE
 *   DATABASE_URL=<postgres url> GITHUB_TOKEN=<repo:read token> \
 *     node scripts/detect-stray-design-results.mjs [--repo owner/name] \
 *                                                  [--include-withdrawn] [--json]
 *
 * Read-only. It opens one connection, issues one SELECT, and writes nothing.
 */

/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */

import { Client } from 'pg';

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
  process.exit(2);
}
if (!TOKEN) {
  console.error('GITHUB_TOKEN (or GH_TOKEN) is required — the file counts come from the API.');
  process.exit(2);
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

/** Every file of a pull request, following Link pagination to the end. */
const designFileCount = async (prNumber) => {
  let page = 1;
  let count = 0;
  for (;;) {
    const files = await gh(`/repos/${REPO}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (files.length === 0) break;
    count += files.filter((f) => f.filename.startsWith('design/')).length;
    if (files.length < 100) break;
    page += 1;
  }
  return count;
};

const runIdOf = (ciRunUrl) => {
  const m = /\/actions\/runs\/(\d+)/.exec(ciRunUrl ?? '');
  return m ? m[1] : null;
};

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  `SELECT e.id, w.identifier, e.is_current, e.ci_run_url, e.withdrawn_at,
          (SELECT count(*)::int FROM design_asset a WHERE a.design_evidence_id = e.id) AS assets
     FROM design_evidence e
     JOIN work_item w ON w.id = e.work_item_id
    ${INCLUDE_WITHDRAWN ? '' : 'WHERE e.withdrawn_at IS NULL'}
    ORDER BY e.created_at`,
);
await client.end();

const branchCache = new Map();
const prCache = new Map();
const filesCache = new Map();
const report = [];

for (const row of rows) {
  const runId = runIdOf(row.ci_run_url);
  if (!runId) {
    report.push({ ...row, verdict: 'no-run-url' });
    continue;
  }
  if (!branchCache.has(runId)) {
    branchCache.set(
      runId,
      await gh(`/repos/${REPO}/actions/runs/${runId}`)
        .then((r) => r.head_branch)
        .catch(() => null),
    );
  }
  const branch = branchCache.get(runId);
  if (!branch) {
    report.push({ ...row, verdict: 'run-gone' });
    continue;
  }
  if (!prCache.has(branch)) {
    const prs = await gh(
      `/repos/${REPO}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${REPO.split('/')[0]}:${branch}`)}`,
    );
    prCache.set(branch, prs[0]?.number ?? null);
  }
  const pr = prCache.get(branch);
  if (!pr) {
    report.push({ ...row, branch, verdict: 'no-pull-request' });
    continue;
  }
  if (!filesCache.has(pr)) filesCache.set(pr, await designFileCount(pr));
  const designFiles = filesCache.get(pr);

  const verdict = designFiles === 0 ? 'STRAY' : row.assets > designFiles ? 'OVER-PUBLISH' : 'ok';
  report.push({ ...row, branch, pr, designFiles, verdict });
}

const flagged = report.filter((r) => r.verdict !== 'ok');

if (AS_JSON) {
  console.log(JSON.stringify({ repo: REPO, scanned: report.length, flagged }, null, 2));
} else {
  console.log(`Scanned ${report.length} design_evidence row(s) against ${REPO}.\n`);
  if (flagged.length === 0) {
    console.log('No stray or over-published design results. ✓');
  } else {
    for (const r of flagged) {
      console.log(
        `${r.verdict.padEnd(15)} ${r.id}  ${String(r.identifier).padEnd(11)} ` +
          `PR ${r.pr ? `#${r.pr}` : '—'}  design files: ${r.designFiles ?? '—'}  assets: ${r.assets}` +
          `${r.is_current ? '' : '  (superseded)'}`,
      );
    }
  }
}

// A flagged row is a finding, not a crash — but the exit code is what lets the
// post-withdrawal re-run be an assertion rather than something somebody reads.
process.exit(flagged.length === 0 ? 0 : 1);
