import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InvalidProfileError,
  loadProfile,
  parseLoadProfile,
  profilePath,
  type LoadProfile,
} from '@/loadtest/profiles/schema';
import {
  EXEC,
  ProfileRefusedError,
  SCENARIOS,
  apportion,
  loadHash,
  membersPerWorkspace,
  resolveProfile,
  scaleProfile,
} from '@/loadtest/profiles/resolve';
import { requestsPerIteration } from '@/loadtest/k6/runs/sequence.js';

// The checked-in load profile and its resolver (Story MOTIR-8538 · MOTIR-8678).
// Pure: no platform, no k6 — the two shapes, the arithmetic and the refusals.

const ROOT = resolve(__dirname, '../..');
const read = (name: string) =>
  JSON.parse(readFileSync(resolve(ROOT, `loadtest/profiles/${name}.json`), 'utf8')) as LoadProfile;
const DEFAULT = () => read('default');
const SMOKE = () => read('smoke');

function problemsOf(input: unknown, n = 1): string[] {
  try {
    parseLoadProfile(input, n);
  } catch (err) {
    if (err instanceof InvalidProfileError) return err.problems;
    throw err;
  }
  return [];
}

/** Every leaf path whose value differs between two objects. */
function diffPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) =>
      diffPaths(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        prefix ? `${prefix}.${k}` : k,
      ),
    );
  }
  return a === b ? [] : [prefix];
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((v) => hasKeyDeep(v, key));
}

describe('the checked-in profiles', () => {
  it('smoke and default parse with LoadProfile', () => {
    expect(problemsOf(DEFAULT())).toEqual([]);
    expect(problemsOf(SMOKE())).toEqual([]);
    expect(DEFAULT().name).toBe('default');
    expect(SMOKE().name).toBe('smoke');
  });

  it('both parse at every instance count they declare', () => {
    for (const p of [DEFAULT(), SMOKE()]) {
      for (const n of p.instanceCounts) expect(problemsOf(p, n)).toEqual([]);
    }
  });

  it('every profile carries notes naming its assumptions', () => {
    for (const p of [DEFAULT(), SMOKE()]) {
      expect(p.notes.some((n) => n.startsWith('ASSUMPTION'))).toBe(true);
    }
    expect(SMOKE().notes.join(' ')).toMatch(/agentSeconds 30/);
    expect(SMOKE().notes.join(' ')).toMatch(/targetRps 13/);
  });

  it('refuses an unknown field, naming it', () => {
    const p = { ...DEFAULT(), surprise: 1 };
    expect(problemsOf(p).join('\n')).toMatch(/surprise/);
    const nested = DEFAULT();
    (nested.runs as Record<string, unknown>)['agentSecs'] = 5;
    expect(problemsOf(nested).join('\n')).toMatch(/runs.*agentSecs/);
  });

  it('refuses a mix that does not sum to 1', () => {
    const p = DEFAULT();
    p.mix.readers = 0.3;
    expect(problemsOf(p)).toEqual(['mix: agents + readers must sum to 1']);
  });

  it('refuses seeded agents fewer than a role’s VUs, naming the role', () => {
    const p = DEFAULT();
    p.seed.agentRoles.read = 0;
    p.tenancy.agentsPerUser = 3;
    expect(problemsOf(p).join('\n')).toMatch(
      /seed\.agentRoles\.read: seeds 0 read agents, fewer than the 400 read VUs/,
    );
  });

  it('refuses a tenancy section that disagrees with the seed', () => {
    const p = DEFAULT();
    p.tenancy.agentWorkspaces = 7;
    expect(problemsOf(p).join('\n')).toMatch(/tenancy\.agentWorkspaces: 7 disagrees/);
  });

  it('--profile accepts a name or a path to a profile file', async () => {
    expect(profilePath('smoke', ROOT)).toBe(resolve(ROOT, 'loadtest/profiles/smoke.json'));
    expect(profilePath('loadtest/profiles/default.json', ROOT)).toBe(
      resolve(ROOT, 'loadtest/profiles/default.json'),
    );
    const byPath = await loadProfile(resolve(ROOT, 'loadtest/profiles/smoke.json'), 1, ROOT);
    expect(byPath.profile.name).toBe('smoke');
    await expect(loadProfile('nope.json', 1, ROOT)).rejects.toThrow(/no profile file/);
  });
});

describe('resolveProfile', () => {
  it('default at 1: 1000 VUs, 800 agents / 200 readers, the role split, 6 workspaces', () => {
    const r = resolveProfile(DEFAULT(), 1);
    expect(r.vus).toMatchObject({
      total: 1000,
      agents: 800,
      readers: 200,
      read: 400,
      write: 200,
      claim: 120,
      run: 80,
      tab: 150,
      browse: 50,
    });
    expect(r.profile.tenancy.agentWorkspaces).toBe(6);
    expect(r.requiredConcurrency).toEqual({ hard: 1200, soft: 960 });
    expect(r.offered.readerStreamsPerInstance).toBe(150);
  });

  it('computes the offered load from the scenario code, and prints the rates', () => {
    const r = resolveProfile(DEFAULT(), 1);
    // read 400 × 1/1.1 · write 200 × 1.111/1.122 · claim 120 × 3/1.5 — see resolve.ts's header.
    const mcp = 400 / 1.1 + 200 * ((1 + 1 / 9) / (0.9 + (1 + 1 / 9) * 0.2)) + 120 * 2;
    const reqs = requestsPerIteration({ agentSeconds: 120, recycle: true, logEventsPerBeat: 3 });
    const v1 = 80 * (reqs / (120 + reqs * 0.2));
    const readers = 150 * (2 / (300 + 0.6)) + 50 / 5.3;
    expect(r.offered.mcpRps).toBeCloseTo(mcp, 1);
    expect(r.offered.apiV1Rps).toBeCloseTo(v1, 1);
    expect(r.offered.rpsUpperBound).toBeCloseTo(mcp + v1 + readers, 1);
    expect(r.offered.perTokenRps.mcp).toBe(2);
    // The busiest workspace holds 68 of the 400 memberships (users 0–199 over 6, two each).
    expect(Math.max(...membersPerWorkspace(r.seed))).toBe(68);
    expect(r.offered.perWorkspaceRps).toBeCloseTo((mcp + v1) * (68 / 400), 1);
    expect(r.offered.perWorkspaceRps).toBeLessThanOrEqual(140);
  });

  it('a shorter agentSeconds raises the run VUs’ /api/v1 rate', () => {
    const p = DEFAULT();
    const at120 = resolveProfile(p, 1).offered.apiV1Rps;
    p.runs.agentSeconds = 60;
    expect(resolveProfile(p, 1).offered.apiV1Rps).toBeGreaterThan(at120);
  });

  it('default at 2 doubles exactly the scaleWithN fields and no other', () => {
    const p = DEFAULT();
    const at2 = resolveProfile(p, 2);
    expect(diffPaths(p, at2.profile).sort()).toEqual([...p.scaleWithN].sort());
    expect(at2.vus.total).toBe(2000);
    expect(at2.offered.rpsUpperBound).toBe(resolveProfile(p, 1).offered.rpsUpperBound);
    expect(at2.requiredConcurrency).toEqual({ hard: 1200, soft: 960 });
  });

  it('passes every threshold section through unchanged, and gives k6 none', () => {
    const p = DEFAULT();
    p.thresholds.bottleneck = { predicates: ['db_pool'] };
    p.thresholds.generator = { cpuMax: 0.8 };
    const r = resolveProfile(p, 2);
    expect(r.thresholds).toEqual(p.thresholds);
    expect(hasKeyDeep(r.k6, 'thresholds')).toBe(false);
    expect(hasKeyDeep(r.k6.options, 'thresholds')).toBe(false);
  });

  it('builds the fixed scenario names, each tagged with its role, closed model', () => {
    const s = resolveProfile(DEFAULT(), 1).k6.options.scenarios;
    expect(Object.keys(s).sort()).toEqual(Object.values(SCENARIOS).sort());
    const role = (k: string) => (s[k]!['tags'] as { role: string }).role;
    expect(role('agent_reads')).toBe('agent');
    expect(role('burst')).toBe('agent');
    expect(role('runs')).toBe('run');
    expect(role('reader_tab')).toBe('reader');
    expect(role('reader_browse')).toBe('reader');
    for (const [name, sc] of Object.entries(s)) {
      if (name !== 'burst') expect(sc['executor']).toBe('ramping-vus');
      expect(Object.values(EXEC)).toContain(sc['exec']);
    }
    expect(s['burst']).toMatchObject({
      executor: 'per-vu-iterations',
      vus: 2,
      iterations: 1,
      startTime: '300s',
    });
    const stages = s['agent_reads']!['stages'] as { duration: string; target: number }[];
    expect(stages).toEqual([
      { duration: '180s', target: 400 },
      { duration: '600s', target: 400 },
      { duration: '30s', target: 0 },
    ]);
  });

  it('refuses a targetRps above offered / 1.25, naming the field', () => {
    const p = DEFAULT();
    p.thresholds.perInstance.targetRps = 700;
    expect(() => resolveProfile(p, 1)).toThrow(ProfileRefusedError);
    expect(problemsOf(p).join('\n')).toMatch(
      /thresholds\.perInstance\.targetRps: 700 is above offered/,
    );
  });

  it('refuses a seed shape with too few workspaces (one above 140 req/s), naming the field', () => {
    const p = DEFAULT();
    p.seed.smoke = true; // lets the seed validator accept fewer than 6
    p.seed.workspaces = 4;
    p.tenancy.agentWorkspaces = 4;
    p.tenancy.usersPerWorkspace = 100;
    p.seed.pools.run = 200;
    expect(problemsOf(p).join('\n')).toMatch(
      /tenancy\.agentWorkspaces: the busiest of 4 workspaces is offered .* above 140/,
    );
  });

  it('smoke resolves with targetRps 13', () => {
    const r = resolveProfile(SMOKE(), 1);
    expect(r.thresholds.perInstance.targetRps).toBe(13);
    expect(r.vus).toMatchObject({
      total: 40,
      read: 16,
      write: 8,
      claim: 5,
      run: 3,
      tab: 6,
      browse: 2,
    });
    expect(r.offered.rpsUpperBound / 1.25).toBeGreaterThan(13);
  });

  it('scaleProfile refuses a non-integer instance count', () => {
    expect(() => scaleProfile(DEFAULT(), 0)).toThrow(/integer ≥ 1/);
  });

  it('apportion keeps the total exact', () => {
    expect(apportion(32, { read: 0.5, write: 0.25, claim: 0.15, run: 0.1 })).toEqual({
      read: 16,
      write: 8,
      claim: 5,
      run: 3,
    });
  });
});

describe('the load hash', () => {
  it('ignores notes, thresholds and the report’s bottleneck / generator sections', () => {
    const base = loadHash(DEFAULT());
    const p = DEFAULT();
    p.notes = ['different'];
    p.thresholds.perInstance.readP95Ms = 1;
    p.thresholds.scaleOut.efficiency = 0.5;
    p.thresholds.bottleneck = { x: 1 };
    p.thresholds.generator = { y: 2 };
    p.name = 'renamed';
    expect(loadHash(p)).toBe(base);
  });

  it('changes when clients or a think time changes', () => {
    const base = loadHash(DEFAULT());
    const a = DEFAULT();
    a.clients = 999;
    expect(loadHash(a)).not.toBe(base);
    const b = DEFAULT();
    b.thinkTimes.agentThinkSeconds = 1;
    expect(loadHash(b)).not.toBe(base);
  });

  it('does not depend on key order', () => {
    const p = DEFAULT();
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as LoadProfile;
    expect(loadHash(reordered)).toBe(loadHash(p));
  });
});
