/**
 * The LOGIC half of `scripts/detect-stray-design-results.mjs` (MOTIR-3227).
 *
 * WHY IT IS SPLIT OUT. Same reason `scripts/generateCliApi.ts` is split from
 * `scripts/generate-cli-api.ts`: the runner opens a Postgres connection, prints
 * to stdout and calls `process.exit`, and a module that does any of those on
 * import cannot be called by a test. The bug this file was carved out for is
 * precisely that the scan's EXIT CODE was never asserted by anything — see the
 * runner's header for the defect.
 *
 * Everything here is pure or injected: `query` is a `(sql) => { rows }` (the
 * shape `pg.Client.query` returns) and `gh` is a `(path) => json`. Nothing in
 * this file reads `process.env`, touches the network, or exits.
 */

/** Exit codes. `1` means FINDINGS; `3` means the instrument could not see. */
export const EXIT_CLEAN = 0;
export const EXIT_FLAGGED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLIND_READ = 3;

/**
 * Who we are connected as, and whether that role can see through RLS.
 *
 * `design_evidence` is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` with a
 * policy keyed on `current_setting('app.workspace_id')`, so a role without
 * `rolbypassrls` that has not set the GUC matches no row at all. That is not an
 * error — it is a successful query over an empty set, which is the whole reason
 * this file exists.
 */
export const CONNECTION_SQL = `
  SELECT current_user AS role,
         COALESCE((SELECT r.rolbypassrls
                     FROM pg_roles r
                    WHERE r.rolname = current_user), false) AS bypasses_rls,
         COALESCE((SELECT c.relforcerowsecurity
                     FROM pg_class c
                    WHERE c.oid = to_regclass('design_evidence')), false) AS rls_forced,
         COALESCE(current_setting('app.workspace_id', true), '') AS workspace_id
`;

/**
 * The DENOMINATOR: every `design_evidence` row this connection can see,
 * withdrawn ones included. It is read through the same RLS the scan is read
 * through, deliberately — a total of 0 is the tell that the scan below saw
 * nothing because it could not, not because there was nothing.
 */
export const POPULATION_SQL = `SELECT count(*)::int AS total FROM design_evidence`;

export const scanSql = (includeWithdrawn) =>
  `SELECT e.id, w.identifier, e.is_current, e.ci_run_url, e.withdrawn_at,
          (SELECT count(*)::int FROM design_asset a WHERE a.design_evidence_id = e.id) AS assets
     FROM design_evidence e
     JOIN work_item w ON w.id = e.work_item_id
    ${includeWithdrawn ? '' : 'WHERE e.withdrawn_at IS NULL'}
    ORDER BY e.created_at`;

export const runIdOf = (ciRunUrl) => {
  const m = /\/actions\/runs\/(\d+)/.exec(ciRunUrl ?? '');
  return m ? m[1] : null;
};

/**
 * Every file of a pull request, following Link pagination to the end.
 *
 * ⚠️ NEVER `gh pr view --json files` — that view caps its file list at 100
 * entries, silently, and the cap then reads as a finding (MOTIR-3220).
 */
export const designFileCount = async (gh, repo, prNumber) => {
  let page = 1;
  let count = 0;
  for (;;) {
    const files = await gh(`/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
    if (files.length === 0) break;
    count += files.filter((f) => f.filename.startsWith('design/')).length;
    if (files.length < 100) break;
    page += 1;
  }
  return count;
};

export const verdictFor = ({ designFiles, assets }) =>
  designFiles === 0 ? 'STRAY' : assets > designFiles ? 'OVER-PUBLISH' : 'ok';

/** Join each database row to its publishing pull request and classify it. */
export const buildReport = async ({ rows, gh, repo }) => {
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
        await gh(`/repos/${repo}/actions/runs/${runId}`)
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
        `/repos/${repo}/pulls?state=all&per_page=1&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`,
      );
      prCache.set(branch, prs[0]?.number ?? null);
    }
    const pr = prCache.get(branch);
    if (!pr) {
      report.push({ ...row, branch, verdict: 'no-pull-request' });
      continue;
    }
    if (!filesCache.has(pr)) filesCache.set(pr, await designFileCount(gh, repo, pr));
    const designFiles = filesCache.get(pr);

    report.push({
      ...row,
      branch,
      pr,
      designFiles,
      verdict: verdictFor({ designFiles, assets: row.assets }),
    });
  }

  return report;
};

/**
 * Run the scan.
 *
 * ⚠️ THE POPULATION IS READ FIRST AND THE SCAN IS ABANDONED WHEN IT IS EMPTY.
 * The guard is on ABSENCE, not on presence: the old shape's only failure mode
 * was `flagged.length > 0`, and an empty population has zero flagged rows, so
 * the connection that could see nothing produced the same `✓` and the same
 * exit 0 as a genuinely clean sweep. No GitHub call is made in that case
 * either, which is why the vacuous run was also the FASTEST one.
 */
export const scan = async ({ query, gh, repo, includeWithdrawn = false }) => {
  const connection = (await query(CONNECTION_SQL)).rows[0] ?? {
    role: 'unknown',
    bypasses_rls: false,
    rls_forced: false,
    workspace_id: '',
  };
  const total = (await query(POPULATION_SQL)).rows[0]?.total ?? 0;

  if (total === 0) {
    return {
      repo,
      blindRead: true,
      connection,
      total: 0,
      scanned: 0,
      report: [],
      flagged: [],
      exitCode: EXIT_BLIND_READ,
    };
  }

  const { rows } = await query(scanSql(includeWithdrawn));
  const report = await buildReport({ rows, gh, repo });
  const flagged = report.filter((r) => r.verdict !== 'ok');

  return {
    repo,
    blindRead: false,
    connection,
    total,
    scanned: report.length,
    report,
    flagged,
    exitCode: flagged.length === 0 ? EXIT_CLEAN : EXIT_FLAGGED,
  };
};

const describeConnection = ({ role, bypasses_rls, rls_forced, workspace_id }) =>
  `Connected as ${role} (bypasses RLS: ${bypasses_rls ? 'yes' : 'no'}` +
  `${rls_forced ? '; design_evidence has FORCE ROW LEVEL SECURITY' : ''}` +
  `${workspace_id ? `; app.workspace_id = ${workspace_id}` : ''}).`;

/**
 * The words the card asked for, verbatim, because they are the ones that stop
 * the next reader treating a green line as a measurement.
 */
export const formatBlindRead = ({ repo, connection }) =>
  [
    `Scanned 0 of 0 design_evidence row(s) against ${repo}.`,
    '',
    'BLIND READ — scanned 0 rows; this is not a clean sweep, it is a connection',
    'that cannot see the table.',
    '',
    describeConnection(connection),
    '',
    connection.bypasses_rls
      ? 'That role DOES bypass RLS, so the table really is empty. An empty population is\n' +
        'still not a sweep worth asserting on: there is nothing here for this instrument to\n' +
        'have checked. Point it at the database that holds the rows.'
      : 'That role does NOT bypass RLS, and no tenant context is set, so every policy on\n' +
        'design_evidence matches nothing. Re-run with a credential that can read the table:\n' +
        '  · DATABASE_URL_UNPOOLED (the owner role, rolbypassrls = true) — what production has, or\n' +
        '  · the same pooled URL carrying the tenant context, which admits that ONE workspace:\n' +
        '      ...&options=-c%20app.workspace_id%3D<workspace-id>',
  ].join('\n');

export const formatResult = (result) => {
  const { repo, blindRead, connection, scanned, total, flagged } = result;
  if (blindRead) return formatBlindRead({ repo, connection });

  const excluded = total - scanned;
  const lines = [
    `Scanned ${scanned} of ${total} design_evidence row(s) against ${repo}` +
      `${excluded > 0 ? ` (${excluded} excluded as withdrawn)` : ''}.`,
    describeConnection(connection),
    '',
  ];

  if (flagged.length === 0) {
    lines.push('No stray or over-published design results. ✓');
  } else {
    for (const r of flagged) {
      lines.push(
        `${r.verdict.padEnd(15)} ${r.id}  ${String(r.identifier).padEnd(11)} ` +
          `PR ${r.pr ? `#${r.pr}` : '—'}  design files: ${r.designFiles ?? '—'}  assets: ${r.assets}` +
          `${r.is_current ? '' : '  (superseded)'}`,
      );
    }
  }
  return lines.join('\n');
};

export const formatJson = (result) =>
  JSON.stringify(
    {
      repo: result.repo,
      blindRead: result.blindRead,
      connection: result.connection,
      scanned: result.scanned,
      total: result.total,
      flagged: result.flagged,
    },
    null,
    2,
  );
