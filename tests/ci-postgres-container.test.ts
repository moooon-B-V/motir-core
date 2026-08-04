import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-1742: a GitHub Actions `services:` container is pulled during
// `Initialize containers`, which runs BEFORE `actions/checkout` and has no retry
// hook — so a transient Docker Hub outage killed whole jobs with zero tests run
// (six occurrences in ~24h). Postgres now comes from `.github/actions/postgres`,
// which pulls mirror-first and retries. These assertions keep a future job from
// silently reintroducing the flaky path, which no other test would catch: the
// workflow files are not type-checked, linted, or executed by any suite.

const WORKFLOWS_DIR = join(process.cwd(), '.github/workflows');
const ACTION_PATH = join(process.cwd(), '.github/actions/postgres/action.yml');
const ACTION_REF = 'uses: ./.github/actions/postgres';

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));

/**
 * Split a workflow's `jobs:` mapping into { jobId → body } without a YAML
 * dependency (the repo has none). Job ids sit at exactly two spaces of
 * indentation; everything in a job body is indented further.
 */
function jobsOf(source: string): Map<string, string> {
  const lines = source.split('\n');
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
    // A non-indented, non-blank line means we've dedented out of `jobs:`.
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    body.push(line);
  }
  if (current) jobs.set(current, body.join('\n'));
  return jobs;
}

/** Every job across every workflow, as [file, jobId, body] triples. */
const allJobs = workflowFiles.flatMap((file) => {
  const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
  return [...jobsOf(source)].map(([id, body]) => ({ file, id, body }));
});

/** Jobs that talk to Postgres — the ones that used to declare the service. */
const dbJobs = allJobs.filter((j) => j.body.includes('DATABASE_URL: postgresql://'));

describe('CI Postgres container (MOTIR-1742)', () => {
  it('finds the workflow jobs it is meant to guard', () => {
    // A parser regression (or a wholesale workflow restructure) would otherwise
    // make every assertion below pass vacuously.
    expect(allJobs.length).toBeGreaterThan(5);
    expect(dbJobs.map((j) => `${j.file}:${j.id}`).sort()).toEqual([
      // The acceptance-video lane, lifted out of the `e2e` matrix into its own
      // `paths:`-filtered workflow by MOTIR-1949.
      'acceptance-video.yml:acceptance',
      'ci.yml:build',
      'ci.yml:e2e',
      'ci.yml:test',
    ]);
  });

  it.each(workflowFiles)('%s declares no Postgres service container', (file) => {
    const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
    // `image: postgres:...` under a `services:` block is exactly the pull that
    // `Initialize containers` performs with no in-repo resilience.
    expect(source).not.toMatch(/^\s*image:\s*postgres/m);
  });

  it.each(dbJobs.map((j) => [`${j.file}:${j.id}`, j.body] as const))(
    '%s starts Postgres through the retrying composite action',
    (_label, body) => {
      expect(body).toContain(ACTION_REF);
    },
  );

  it.each(dbJobs.map((j) => [`${j.file}:${j.id}`, j.body] as const))(
    '%s starts Postgres before it runs any command',
    (_label, body) => {
      const lines = body.split('\n');
      const actionAt = lines.findIndex((l) => l.includes(ACTION_REF));
      const firstRunAt = lines.findIndex((l) => /^\s+-?\s*run:/.test(l));
      expect(actionAt).toBeGreaterThanOrEqual(0);
      // A step that shells out before the DB is up (pnpm install → prisma
      // migrate deploy) would fail on a cold connection instead of waiting.
      expect(firstRunAt === -1 || actionAt < firstRunAt).toBe(true);
    },
  );
});

describe('the postgres composite action', () => {
  const action = readFileSync(ACTION_PATH, 'utf8');

  it('is a composite action', () => {
    expect(action).toMatch(/using:\s*composite/);
  });

  it('tries at least two mirrors before Docker Hub', () => {
    const sources = [...action.matchAll(/^\s*"([^"]*postgres:\$\{IMAGE_TAG\})"$/gm)].map(
      (m) => m[1]!,
    );
    expect(sources).toEqual([
      'public.ecr.aws/docker/library/postgres:${IMAGE_TAG}',
      'mirror.gcr.io/library/postgres:${IMAGE_TAG}',
      'postgres:${IMAGE_TAG}',
    ]);
    // Docker Hub — the registry that went unreachable — must be the LAST
    // resort, not the first thing tried.
    expect(sources.at(-1)).toBe('postgres:${IMAGE_TAG}');
  });

  it('retries the pull beyond the runner built-in 3 attempts', () => {
    // 3 sources × 3 rounds = 9 pull attempts, vs. the runner's 3 against a
    // single registry.
    expect(action).toMatch(/for attempt in 1 2 3/);
    expect(action).toMatch(/sleep "\$\{backoff\}"/);
    expect(action).toMatch(/::error::Could not pull postgres/);
  });

  it('waits for the container to report healthy before yielding', () => {
    expect(action).toMatch(/--health-cmd "pg_isready/);
    expect(action).toMatch(/State\.Health\.Status/);
    expect(action).toMatch(/did not become healthy/);
  });
});
