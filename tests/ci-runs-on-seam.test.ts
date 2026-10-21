import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOTIR_RUNNER_LABEL, MOTIR_RUNNER_VARIABLE } from '@/lib/ciFleet/config';

// EVERY motir-core JOB REQUESTS THE RUNNER SEAM (Story MOTIR-8699 · MOTIR-8704).
//
// A job's `runs-on` is what moves it onto the fleet: the platform switch writes
// the `MOTIR_RUNNER` org variable on `moooon-B-V`, and only a job that asks for
// `${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` follows it. A job added later
// with a bare `ubuntu-latest` would silently opt out of the switch, so this
// guard reads every workflow and names the file and job that does.

const WORKFLOWS = path.join(process.cwd(), '.github', 'workflows');
const SEAM = `\${{ vars.${MOTIR_RUNNER_VARIABLE} || 'ubuntu-latest' }}`;

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation. (A local copy of the helper in
 * `ci-complete-gate.test.ts` — see that file for why the CI guards each carry
 * their own rather than share one.)
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

/** The job's own `runs-on` value (its direct key, four spaces in), ignoring
 *  comments; null for a reusable-workflow call or a job without one. */
function runsOnOf(body: string): string | null {
  for (const line of body.split('\n')) {
    const m = /^ {4}runs-on:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/\s+#.*$/, '');
  }
  return null;
}

/** Every job that requests a bare GitHub-hosted `ubuntu-latest`, as `file:job`. */
function offenders(files: Array<{ name: string; source: string }>): string[] {
  const found: string[] = [];
  for (const { name, source } of files) {
    for (const [job, body] of jobsOf(source)) {
      const runsOn = runsOnOf(body);
      if (runsOn !== null && /^['"]?ubuntu-latest['"]?$/.test(runsOn)) {
        found.push(`${name}:${job}`);
      }
    }
  }
  return found;
}

function workflowFiles(): Array<{ name: string; source: string }> {
  return readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((name) => ({ name, source: readFileSync(path.join(WORKFLOWS, name), 'utf8') }));
}

describe('the runs-on seam', () => {
  it('the predicate names a bare ubuntu-latest job, and passes a seam job and a uses: job', () => {
    const fixture = [
      'on: push',
      'jobs:',
      '  bare:',
      '    runs-on: ubuntu-latest',
      '    steps: []',
      '  quoted:',
      "    runs-on: 'ubuntu-latest'",
      '  seam:',
      `    runs-on: ${SEAM}`,
      '  called:',
      '    uses: ./.github/workflows/other.yml',
      '  # a comment that says runs-on: ubuntu-latest is not a job',
      '',
    ].join('\n');
    expect(offenders([{ name: 'fixture.yml', source: fixture }])).toEqual([
      'fixture.yml:bare',
      'fixture.yml:quoted',
    ]);
  });

  it('finds workflows to check, so it can never pass over nothing', () => {
    const files = workflowFiles();
    expect(files.length).toBeGreaterThan(0);
    const seamJobs = files.flatMap(({ source }) =>
      [...jobsOf(source).values()].filter((body) => runsOnOf(body) === SEAM),
    );
    expect(seamJobs.length).toBeGreaterThan(0);
  });

  it('no motir-core job requests a bare ubuntu-latest', () => {
    const found = offenders(workflowFiles());
    expect(
      found,
      `these jobs request a bare ubuntu-latest and so ignore the fleet switch; use \`runs-on: ${SEAM}\``,
    ).toEqual([]);
  });

  it('the seam names the variable and never hard-codes the fleet label', () => {
    expect(SEAM).toBe("${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}");
    for (const { name, source } of workflowFiles()) {
      expect(source.includes(MOTIR_RUNNER_LABEL), `${name} names ${MOTIR_RUNNER_LABEL}`).toBe(
        false,
      );
    }
  });
});
