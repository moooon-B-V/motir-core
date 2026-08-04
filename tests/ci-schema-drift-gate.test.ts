import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-1960: CI must FAIL when `schema.prisma` and the migration
// history disagree.
//
// The drift this card fixed — a hand-written partial index whose column list
// collided with an `@@index`, so `migrate diff` reported a permanent spurious
// index RENAME — sat on `main` unnoticed because NOTHING looked. It is invisible
// to `migrate status` (which only reads the history table), invisible to the
// Vitest suite (which runs against a database built from those same
// migrations), and surfaces only as a stray `ALTER INDEX` at the top of the next
// person's `migrate dev` — where committing it verbatim destroys one of the two
// indexes. The `attachment.uploader_user_id` FK drift before it hid the same
// way, for longer.
//
// So the gate is one `prisma migrate diff --exit-code` step, and this test is
// what keeps it there. Three things must hold, and nothing else in the repo
// would notice if one stopped: workflow files are not type-checked, linted, or
// executed by any suite.
//
//   1. The step EXISTS and carries `--exit-code`. Without that flag `migrate
//      diff` PRINTS the difference and exits 0 — a green step over a red
//      database, the most expensive way to fail.
//   2. It lives in a job that first builds the database by REPLAYING the
//      migrations from empty. Diffing the schema against a database built any
//      other way proves nothing about the history.
//   3. Its exit status is the STEP's — not piped into anything. A pipeline
//      reports the last command's status, which is how an assertion like this
//      silently stops asserting.
//
// Same mould (and the same no-YAML-dependency constraint — the repo has no YAML
// parser) as `tests/ci-complete-gate.test.ts`, `tests/ci-postgres-container.test.ts`
// and `tests/ci-acceptance-lane.test.ts`.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const DRIFT_JOB = 'build';

const ci = readFileSync(CI_PATH, 'utf8');

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further. (A local copy of the helper in `ci-complete-gate.test.ts` — see that
 * file for why the CI guards each carry their own rather than share one.)
 */
function jobsOf(yaml: string): Map<string, string> {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map<string, string>();
  if (jobsAt === -1) return jobs;
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) jobs.set(current, body.join('\n'));
      current = header[1]!;
      body = [];
      continue;
    }
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    body.push(line);
  }
  if (current) jobs.set(current, body.join('\n'));
  return jobs;
}

/**
 * The same text with whole-line comments dropped. Every assertion about what a
 * job DOES runs through this: the parser above attributes a job's leading
 * comment block to the job before it, and these files describe each other in
 * prose — this job's own comments spell out the very command being asserted.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const jobs = jobsOf(ci);
const driftJobCode = codeOf(jobs.get(DRIFT_JOB) ?? '');

/** The `migrate diff` invocation, as written in the workflow. */
const diffCommand = (/^\s*run:\s*(.*prisma migrate diff.*)$/m.exec(driftJobCode)?.[1] ?? '').trim();

describe('CI gates schema-vs-migrations drift (MOTIR-1960)', () => {
  it('runs `prisma migrate diff` somewhere in ci.yml', () => {
    // Scoped to the whole file first, so a step MOVED to another job reports as
    // "it is in `foo`, not `build`" rather than as "the gate is gone".
    const owners = [...jobs].filter(([, body]) => /prisma migrate diff/.test(codeOf(body)));
    expect(owners.map(([id]) => id)).toContain(DRIFT_JOB);
  });

  it('diffs the DATAMODEL against the migration-built database', () => {
    // Direction matters: `--from-schema` is the datamodel, `--to-config-datasource`
    // is the database this job migrated. Flipping either side silently changes
    // what is being asserted.
    expect(diffCommand).toContain('--from-schema prisma/schema.prisma');
    expect(diffCommand).toContain('--to-config-datasource');
  });

  it('FAILS the job on a difference — `--exit-code`, and not swallowed by a pipe', () => {
    // Without `--exit-code`, `migrate diff` prints the drift and exits 0.
    expect(diffCommand).toContain('--exit-code');
    // A pipeline reports the LAST command's status, so `… | tee` or `… | grep`
    // would report the pipe's success and never fail the step.
    expect(diffCommand).not.toMatch(/[|]/);
    // Likewise anything that swallows the status outright.
    expect(diffCommand).not.toMatch(/\|\||true\s*$/);
  });

  it('gates a database REPLAYED from empty, in a job that runs on every PR', () => {
    // The job's Postgres is an ephemeral service container started per run, and
    // `pnpm build` runs `prisma migrate deploy` into it — so the database the
    // diff reads is a full replay of the ordered history, which is the only
    // thing worth diffing the datamodel against.
    expect(driftJobCode).toContain('uses: ./.github/actions/postgres');
    const buildAt = driftJobCode.indexOf('run: pnpm build');
    const diffAt = driftJobCode.indexOf('prisma migrate diff');
    expect(buildAt).toBeGreaterThan(-1);
    expect(diffAt).toBeGreaterThan(buildAt);

    // And no branch-prefix `if:` — a `docs/`/`design/`/`seed/` PR can still edit
    // prisma/**, and this is the one gate that would notice.
    expect(driftJobCode).not.toMatch(/^\s{4}if:/m);
  });
});
