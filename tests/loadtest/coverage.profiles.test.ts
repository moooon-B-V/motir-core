import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InvalidProfileError,
  loadProfile,
  parseLoadProfile,
  profilePath,
  profileProblems,
  type LoadProfile,
} from '@/loadtest/profiles/schema';
import {
  SCENARIOS,
  callsPerIteration,
  describeResolved,
  k6Scenarios,
  profileRefusals,
  resolveProfile,
} from '@/loadtest/profiles/resolve';

// The profile schema's and resolver's less-travelled branches (Story MOTIR-8538 ·
// MOTIR-8678): every sense check naming its field, the refusals other than the
// target and the workspace ceiling, and the k6 block of a profile with empty roles.

const ROOT = resolve(__dirname, '../..');
const SMOKE = () =>
  JSON.parse(readFileSync(resolve(ROOT, 'loadtest/profiles/smoke.json'), 'utf8')) as LoadProfile;

function problemsOf(input: unknown, n = 1): string[] {
  try {
    parseLoadProfile(input, n);
  } catch (err) {
    if (err instanceof InvalidProfileError) return err.problems;
    throw err;
  }
  return [];
}

/** Smoke reshaped to agent readers only: no writers, claimers, runners, readers or burst. */
function readsOnly(): LoadProfile {
  const p = SMOKE();
  p.mix = { agents: 1, readers: 0 };
  p.roleSplit = { read: 1, write: 0, claim: 0, run: 0 };
  p.seed.agentRoles.read = 3; // 8 users × 2 workspaces × 3 = 48 ≥ the 40 read VUs
  p.tenancy.agentsPerUser = 6;
  p.burst.agents = 0;
  p.timing.rampDownSeconds = 0;
  return p;
}

describe('the profile schema: sense checks', () => {
  it('refuses a roleSplit that does not sum to 1', () => {
    const p = SMOKE();
    p.roleSplit.run = 0.2;
    expect(problemsOf(p)).toEqual(['roleSplit: read + write + claim + run must sum to 1']);
  });

  it('names each seed-shape problem under seed.', () => {
    const p = SMOKE();
    p.seed.users = 1; // below the 2 workspaces
    p.tenancy.usersPerWorkspace = 1;
    expect(problemsOf(p).join('\n')).toMatch(/seed\.users must be ≥ workspaces/);
  });

  it('rethrows an error from the seed check that is not a seed-shape problem', () => {
    const p = SMOKE();
    const boom = new TypeError('seed exploded');
    Object.defineProperty(p.seed, 'smoke', {
      get() {
        throw boom;
      },
    });
    expect(() => profileProblems(p)).toThrow(boom);
  });

  it('refuses a burst size that is not the seed’s burstSize', () => {
    const p = SMOKE();
    p.burst.size = 5;
    expect(problemsOf(p)).toEqual(["burst.size: 5 is not the seed's burstSize (12)"]);
  });

  it('refuses a role, or the reader routes, whose weights are all 0', () => {
    const p = SMOKE();
    p.toolWeights.write = { update_work_item: 0, transition_status: 0 };
    p.readers.routeWeights = { boards: 0 };
    expect(problemsOf(p)).toEqual([
      'toolWeights.write: at least one weight must be above 0',
      'readers.routeWeights: at least one weight must be above 0',
    ]);
  });

  it('names a wrong-typed field without an unknown-keys suffix, and a non-object as (profile)', () => {
    const p = SMOKE() as unknown as Record<string, unknown>;
    p['clients'] = 'forty';
    const problems = problemsOf(p);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^clients: /);
    expect(problems[0]).not.toMatch(/\(.*\)$/);
    expect(problemsOf(42)[0]).toMatch(/^\(profile\): /);
  });
});

describe('loadProfile', () => {
  it('refuses a file that is not JSON, naming the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loadtest-profile-'));
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json');
    expect(profilePath(path, ROOT)).toBe(path);
    await expect(loadProfile(path, 1, ROOT)).rejects.toThrow(
      new RegExp(`--profile: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not JSON`),
    );
  });

  it('loads a named profile from cwd', async () => {
    const { profile, path } = await loadProfile('smoke', 2, ROOT);
    expect(profile.name).toBe('smoke');
    expect(path).toBe(resolve(ROOT, 'loadtest/profiles/smoke.json'));
  });
});

describe('the resolver refusals', () => {
  it('refuses burst VUs beyond the seeded burst slots', () => {
    const p = SMOKE();
    p.burst.agents = 3;
    expect(profileRefusals(p)).toEqual([
      'burst.agents: 3 burst VUs but the seed has 2 burst slots (seed.burstAgents)',
    ]);
  });

  it('refuses fewer users than reader VUs, naming the instance count', () => {
    const p = SMOKE();
    p.mix = { agents: 0.5, readers: 0.5 };
    expect(profileRefusals(p, 2)).toEqual([
      'seed.users: 16 users, fewer than the 40 reader VUs at 2 instances',
    ]);
  });

  it('refuses a run pool smaller than the busiest project’s run agents', () => {
    const p = SMOKE();
    p.seed.pools.run = 7; // the busiest project holds 8 members × 1 run agent
    expect(profileRefusals(p)).toEqual([
      'seed.pools.run: 7 cards per project, fewer than the 8 run agents of the busiest project',
    ]);
  });

  it('does not ask for run-pool cards when the seed mints no run agents', () => {
    const p = readsOnly();
    p.seed.agentRoles.run = 0;
    p.seed.pools.run = 0;
    expect(profileRefusals(p)).toEqual([]);
  });
});

describe('a profile with empty roles', () => {
  it('counts a write iteration as one call when every write weight is 0', () => {
    const p = SMOKE();
    p.toolWeights.write = { update_work_item: 0 };
    expect(callsPerIteration(p)).toEqual({ read: 1, write: 1, claim: 3 });
  });

  it('resolves to agent reads alone: one scenario, no ramp-down, zero per-token rates elsewhere', () => {
    const r = resolveProfile(readsOnly(), 1);
    expect(r.vus).toMatchObject({ read: 40, write: 0, claim: 0, run: 0, readers: 0, burst: 0 });
    const scenarios = r.k6.options.scenarios;
    expect(Object.keys(scenarios)).toEqual([SCENARIOS.agentReads]);
    expect(scenarios[SCENARIOS.agentReads]!['stages']).toEqual([
      { duration: '60s', target: 40 },
      { duration: '180s', target: 40 },
    ]);
    // read: 1 call / (0.9 s think + 0.2 s latency)
    expect(r.offered.perTokenRps).toEqual({ mcp: 0.91, apiV1: 0 });
    expect(r.offered.readerRps).toBe(0);
    expect(r.offered.readerStreamsPerInstance).toBe(0);
    expect(describeResolved(r)[1]).toMatch(/run 0\), readers 0 \(tab 0 · browse 0\), burst 0/);
  });

  it('k6Scenarios takes the readers in and leaves the agent roles out', () => {
    const p = SMOKE();
    p.mix = { agents: 0, readers: 1 };
    p.burst.agents = 0;
    const s = k6Scenarios(p);
    expect(Object.keys(s).sort()).toEqual([SCENARIOS.readerBrowse, SCENARIOS.readerTab].sort());
  });
});
