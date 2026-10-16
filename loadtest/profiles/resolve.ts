// RESOLVING A PROFILE AT N INSTANCES (Story MOTIR-8538 · MOTIR-8678).
//
// `resolveProfile(profile, n)` turns the checked-in profile into everything a run
// needs, and nothing it does not:
//   · the profile at N — every field on `scaleWithN` multiplied by N, no other;
//   · per-scenario VU counts and the k6 `options.scenarios` block (closed model,
//     `ramping-vus`, VUs = clients) — with NO `thresholds` key: k6 has nothing to
//     fail, and the verdict is the report's alone;
//   · the per-scenario options `loadtest/k6/main.js` hands each scenario function;
//   · the scaled `SeedShape` the run command seeds;
//   · the offered-load arithmetic, the per-token and per-workspace rates and the
//     proxy concurrency the held streams require;
//   · every threshold section, passed through unchanged.
//
// PURE: no I/O, no clock. The resolver's refusals (`profileRefusals`) are the same
// function the schema's sense pass calls, so a profile that parses resolves.
//
// ── THE OFFERED LOAD IS COMPUTED, NOT ASSUMED ────────────────────────────────
// A closed-model VU offers `calls per iteration / (think + calls × latency)`
// requests a second. The calls per iteration are read off the scenario code, not
// taken as one: a write agent's `transition_status` is a PAIR of calls
// (`iterations.js` `writeIteration`), a claim agent that takes its card releases it
// in the same iteration (`claimIteration`: claim + update + transition = 3), and a
// run VU's request count comes from the run scenario's own `requestsPerIteration`.
// The claim is counted at 3 (every claim takes its card) so the figure stays an
// UPPER bound. The burst is left out of the steady figure: it is one sequence per
// burst agent at an offset, which the report reads on its own.

import { createHash } from 'node:crypto';
import { AGENT_ROLES, agentCount, type AgentRole, type SeedShape } from '../seed/shape';
import { readerScenarios, readerSplit } from '../k6/lib/readerProfile.js';
import { requestsPerIteration } from '../k6/runs/sequence.js';
import type { LoadProfile, ScalableField } from './schema';

/** `DEFAULT_AGENT_WORKSPACE_RATE_LIMIT` (lib/rateLimit/budgets.ts): 12 000 a minute. */
export const AGENT_WORKSPACE_CEILING_RPS = 200;
/** The share of that ceiling one workspace may be offered. */
export const WORKSPACE_HEADROOM = 0.7;
/** `targetRps` must not exceed the offered load divided by this. */
export const OFFERED_MARGIN = 1.25;
/** The in-flight allowance on top of the held streams. */
export const CONCURRENCY_SLACK = 50;
/** `soft_limit = SOFT_SHARE × hard_limit`. */
export const SOFT_SHARE = 0.8;

/** The k6 scenario names — fixed, so the report and the capture can address them. */
export const SCENARIOS = {
  agentReads: 'agent_reads',
  agentWrites: 'agent_writes',
  agentClaims: 'agent_claims',
  burst: 'burst',
  runs: 'runs',
  readerTab: 'reader_tab',
  readerBrowse: 'reader_browse',
} as const;

/** The function names `loadtest/k6/main.js` exports, one per scenario. */
export const EXEC = {
  agentReads: 'agentReadsExec',
  agentWrites: 'agentWritesExec',
  agentClaims: 'agentClaimsExec',
  burst: 'burstExec',
  runs: 'runsExec',
  readerTab: 'readerTabExec',
  readerBrowse: 'readerBrowseExec',
} as const;

const ROLE_TAG = {
  agentReads: 'agent',
  agentWrites: 'agent',
  agentClaims: 'agent',
  burst: 'agent',
  runs: 'run',
  readerTab: 'reader',
  readerBrowse: 'reader',
} as const;

// ── Scaling ──────────────────────────────────────────────────────────────────

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<Record<string, unknown>>(
    (o, k) => o[k] as Record<string, unknown>,
    obj,
  );
  parent[last] = value;
}

/** The profile at `n` instances: each `scaleWithN` field × n, every other field as is. */
export function scaleProfile(profile: LoadProfile, n: number): LoadProfile {
  if (!Number.isInteger(n) || n < 1) throw new Error(`instances must be an integer ≥ 1, got ${n}`);
  const scaled = structuredClone(profile) as unknown as Record<string, unknown>;
  for (const field of new Set<ScalableField>(profile.scaleWithN)) {
    setPath(scaled, field, (getPath(scaled, field) as number) * n);
  }
  return scaled as unknown as LoadProfile;
}

// ── VUs ──────────────────────────────────────────────────────────────────────

/** Split `total` by `shares` (summing to 1) into integers summing to `total` (largest remainder). */
export function apportion<K extends string>(
  total: number,
  shares: Record<K, number>,
): Record<K, number> {
  const keys = Object.keys(shares) as K[];
  const raw = keys.map((k) => total * shares[k]);
  const out = Object.fromEntries(keys.map((k, i) => [k, Math.floor(raw[i]!)])) as Record<K, number>;
  let left = total - keys.reduce((s, k) => s + out[k], 0);
  const order = keys
    .map((k, i) => ({ k, rem: raw[i]! - Math.floor(raw[i]!), i }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { k } of order) {
    if (left <= 0) break;
    out[k] += 1;
    left -= 1;
  }
  return out;
}

export interface Vus {
  total: number;
  agents: number;
  readers: number;
  read: number;
  write: number;
  claim: number;
  run: number;
  tab: number;
  browse: number;
  /** Burst VUs, on top of `total`: each runs one burst at the offset and stops. */
  burst: number;
}

/** The VU counts of a (scaled) profile. */
export function vusOf(profile: LoadProfile): Vus {
  const { agents, readers } = apportion(profile.clients, profile.mix);
  const roles = apportion(agents, profile.roleSplit);
  const { tabs, browsers } = readerSplit(readers, profile.readers.tabShare);
  return {
    total: profile.clients,
    agents,
    readers,
    ...roles,
    tab: tabs,
    browse: browsers,
    burst: profile.burst.agents,
  };
}

// ── Seeded tenancy ───────────────────────────────────────────────────────────

/** Members of each workspace, by the seed's own rule: user u joins (u + j) mod W, j < perUser. */
export function membersPerWorkspace(seed: SeedShape): number[] {
  const members = new Array<number>(seed.workspaces).fill(0);
  for (let u = 0; u < seed.users; u++) {
    for (let j = 0; j < seed.workspacesPerUser; j++) members[(u + j) % seed.workspaces]! += 1;
  }
  return members;
}

// ── Offered load ─────────────────────────────────────────────────────────────

/** MCP calls one iteration of each non-run agent role makes (see the header). */
export function callsPerIteration(
  profile: LoadProfile,
): Record<'read' | 'write' | 'claim', number> {
  const w = profile.toolWeights.write;
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  const transitionShare = sum > 0 ? (w['transition_status'] ?? 0) / sum : 0;
  return { read: 1, write: 1 + transitionShare, claim: 3 };
}

export interface Offered {
  /** Upper bound of the steady requests a second, per instance. */
  rpsUpperBound: number;
  /** Of it: MCP calls from non-run agents. */
  mcpRps: number;
  /** Of it: `/api/v1` requests from the run VUs. */
  apiV1Rps: number;
  /** Of it: page requests from readers (browse steps and tab landings). */
  readerRps: number;
  /** The busiest workspace's MCP + `/api/v1` rate. */
  perWorkspaceRps: number;
  /** Per credential, the busiest role's rate. */
  perTokenRps: { mcp: number; apiV1: number };
  /** Held `/api/workbench/stream` connections per instance. */
  readerStreamsPerInstance: number;
  /** Run-VU `/api/v1` requests per iteration (`requestsPerIteration`). */
  runRequestsPerIteration: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The offered-load arithmetic of a profile at `n` instances (`scaled` = the profile at n). */
export function offeredLoad(scaled: LoadProfile, n: number): Offered {
  const vus = vusOf(scaled);
  const t = scaled.thinkTimes;
  const latency = t.latencyAssumptionMs / 1000;
  const calls = callsPerIteration(scaled);
  const perVu = (k: 'read' | 'write' | 'claim') =>
    calls[k] / (t.agentThinkSeconds + calls[k] * latency);
  const mcpRps = vus.read * perVu('read') + vus.write * perVu('write') + vus.claim * perVu('claim');

  const runRequests = requestsPerIteration({
    agentSeconds: scaled.runs.agentSeconds,
    recycle: scaled.runs.recycle,
    logEventsPerBeat: scaled.runs.logEventsPerBeat,
  });
  const runPerVu = runRequests / (scaled.runs.agentSeconds + runRequests * latency);
  const apiV1Rps = vus.run * runPerVu;

  const page = t.readerLatencyAssumptionMs / 1000;
  // A tab lands with two requests (`/workbench` and its 307 hop), then holds.
  const tabRps = vus.tab * (2 / (scaled.readers.holdSeconds + 2 * page));
  const browseRps = vus.browse / (t.readerBrowseThinkSeconds + page);
  const readerRps = tabRps + browseRps;

  const members = membersPerWorkspace(scaled.seed);
  const memberships = members.reduce((a, b) => a + b, 0);
  const busiest = Math.max(...members) / memberships;

  return {
    rpsUpperBound: round2((mcpRps + apiV1Rps + readerRps) / n),
    mcpRps: round2(mcpRps / n),
    apiV1Rps: round2(apiV1Rps / n),
    readerRps: round2(readerRps / n),
    perWorkspaceRps: round2((mcpRps + apiV1Rps) * busiest),
    perTokenRps: {
      mcp: round2(
        Math.max(
          vus.read ? perVu('read') : 0,
          vus.write ? perVu('write') : 0,
          vus.claim ? perVu('claim') : 0,
        ),
      ),
      apiV1: round2(vus.run ? runPerVu : 0),
    },
    readerStreamsPerInstance: Math.ceil(vus.tab / n),
    runRequestsPerIteration: runRequests,
  };
}

/** The proxy limits the held streams and the target require per instance. */
export function requiredConcurrency(
  scaled: LoadProfile,
  n: number,
): { hard: number; soft: number } {
  const per = scaled.thresholds.perInstance;
  const streams = Math.ceil(vusOf(scaled).tab / n);
  const hard = streams + Math.ceil(per.targetRps * (per.mutateP95Ms / 1000)) + CONCURRENCY_SLACK;
  return { hard, soft: Math.round(SOFT_SHARE * hard) };
}

// ── Refusals ─────────────────────────────────────────────────────────────────

/**
 * The resolver's three refusals at `n` instances, each naming its field:
 *   1. the seed covers every role — seeded agents ≥ the role's VUs, burst slots ≥
 *      burst VUs, users ≥ reader VUs, and enough run-pool cards per project that
 *      every run agent owns one;
 *   2. `targetRps` ≤ offered / 1.25;
 *   3. no workspace is offered more than 70 % of the `agent:workspace` ceiling.
 */
export function profileRefusals(profile: LoadProfile, n = 1): string[] {
  const scaled = scaleProfile(profile, n);
  const vus = vusOf(scaled);
  const seed = scaled.seed;
  const at = n === 1 ? '' : ` at ${n} instances`;
  const problems: string[] = [];

  for (const role of AGENT_ROLES) {
    const seeded = agentCount(seed, role);
    if (seeded < vus[role]) {
      problems.push(
        `seed.agentRoles.${role}: seeds ${seeded} ${role} agents, fewer than the ${vus[role]} ${role} VUs${at}`,
      );
    }
  }
  if (seed.burstAgents < vus.burst) {
    problems.push(
      `burst.agents: ${vus.burst} burst VUs${at} but the seed has ${seed.burstAgents} burst slots (seed.burstAgents)`,
    );
  }
  if (seed.users < vus.readers) {
    problems.push(`seed.users: ${seed.users} users, fewer than the ${vus.readers} reader VUs${at}`);
  }
  const busiestRunAgents = Math.ceil(
    (Math.max(...membersPerWorkspace(seed)) * seed.agentRoles.run) / seed.projectsPerWorkspace,
  );
  if (seed.agentRoles.run > 0 && seed.pools.run < busiestRunAgents) {
    problems.push(
      `seed.pools.run: ${seed.pools.run} cards per project, fewer than the ${busiestRunAgents} run agents of the busiest project${at}`,
    );
  }
  if (problems.length > 0) return problems;

  const offered = offeredLoad(scaled, n);
  const target = scaled.thresholds.perInstance.targetRps;
  const bound = offered.rpsUpperBound / OFFERED_MARGIN;
  if (target > bound) {
    problems.push(
      `thresholds.perInstance.targetRps: ${target} is above offered / ${OFFERED_MARGIN} (${round2(bound)}; ` +
        `offered ≈ ${offered.rpsUpperBound} req/s per instance) — the VUs cannot reach it`,
    );
  }
  const ceiling = AGENT_WORKSPACE_CEILING_RPS * WORKSPACE_HEADROOM;
  if (offered.perWorkspaceRps > ceiling) {
    problems.push(
      `tenancy.agentWorkspaces: the busiest of ${seed.workspaces} workspaces is offered ` +
        `${offered.perWorkspaceRps} req/s${at}, above ${ceiling} (70 % of the ${AGENT_WORKSPACE_CEILING_RPS} req/s ` +
        'agent:workspace ceiling) — spread the agents over more workspaces',
    );
  }
  return problems;
}

// ── The load hash ────────────────────────────────────────────────────────────

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * sha256 of the canonical JSON of the load-shaping sections — everything but
 * `name`, `notes` and `thresholds` (which holds the report's `bottleneck` and
 * `generator` sections). A threshold edit keeps a baseline valid; a load edit does not.
 */
export function loadHash(profile: LoadProfile): string {
  const { name: _name, notes: _notes, thresholds: _thresholds, ...load } = profile;
  return createHash('sha256')
    .update(JSON.stringify(canonical(load)))
    .digest('hex');
}

// ── k6 ───────────────────────────────────────────────────────────────────────

const secs = (s: number) => `${Math.ceil(s)}s`;

/** The `options.scenarios` block. No scenario carries a threshold, and no `thresholds` key exists. */
export function k6Scenarios(scaled: LoadProfile): Record<string, Record<string, unknown>> {
  const vus = vusOf(scaled);
  const { rampSeconds, steadySeconds, rampDownSeconds } = scaled.timing;
  const stages = (target: number) => [
    { duration: secs(rampSeconds), target },
    { duration: secs(steadySeconds), target },
    ...(rampDownSeconds > 0 ? [{ duration: secs(rampDownSeconds), target: 0 }] : []),
  ];
  const ramping = (key: keyof typeof SCENARIOS, target: number, grace: number) => ({
    executor: 'ramping-vus',
    exec: EXEC[key],
    startVUs: 0,
    stages: stages(target),
    gracefulRampDown: secs(grace),
    gracefulStop: secs(grace),
    tags: { role: ROLE_TAG[key] },
  });

  const out: Record<string, Record<string, unknown>> = {};
  if (vus.read > 0) out[SCENARIOS.agentReads] = ramping('agentReads', vus.read, 30);
  if (vus.write > 0) out[SCENARIOS.agentWrites] = ramping('agentWrites', vus.write, 30);
  if (vus.claim > 0) out[SCENARIOS.agentClaims] = ramping('agentClaims', vus.claim, 30);
  if (vus.run > 0) out[SCENARIOS.runs] = ramping('runs', vus.run, scaled.runs.agentSeconds + 60);
  if (vus.burst > 0) {
    const start = rampSeconds + scaled.burst.offsetSeconds;
    out[SCENARIOS.burst] = {
      executor: 'per-vu-iterations',
      exec: EXEC.burst,
      vus: vus.burst,
      iterations: 1,
      startTime: secs(start),
      maxDuration: secs(Math.max(1, rampSeconds + steadySeconds - start)),
      gracefulStop: '30s',
      tags: { role: ROLE_TAG.burst },
    };
  }
  // The reader card's own fragment decides each side's graceful stop (a tab's hold).
  const readers = readerScenarios({
    readers: vus.readers,
    tabShare: scaled.readers.tabShare,
    rampSeconds,
    durationSeconds: steadySeconds,
    holdSeconds: scaled.readers.holdSeconds,
    exec: { tab: EXEC.readerTab, browse: EXEC.readerBrowse },
  }) as unknown as Record<string, Record<string, unknown>>;
  if (readers['readerTab']) {
    out[SCENARIOS.readerTab] = { ...readers['readerTab'], stages: stages(vus.tab) };
  }
  if (readers['readerBrowse']) {
    out[SCENARIOS.readerBrowse] = { ...readers['readerBrowse'], stages: stages(vus.browse) };
  }
  return out;
}

/** What `main.js` hands each scenario function besides `baseUrl` (which it reads from the manifest). */
export function scenarioOptions(scaled: LoadProfile) {
  const cap = scaled.burst.retryAfterCapSeconds;
  const think = scaled.thinkTimes.agentThinkSeconds;
  return {
    agentReads: {
      weights: scaled.toolWeights.read,
      thinkSeconds: think,
      maxRetryAfterSeconds: cap,
    },
    agentWrites: {
      weights: scaled.toolWeights.write,
      thinkSeconds: think,
      maxRetryAfterSeconds: cap,
    },
    agentClaims: { thinkSeconds: think, maxRetryAfterSeconds: cap },
    burst: { maxRetryAfterSeconds: cap },
    runs: {
      agentSeconds: scaled.runs.agentSeconds,
      logEventsPerBeat: scaled.runs.logEventsPerBeat,
      recycle: scaled.runs.recycle,
      maxRetryAfterSeconds: cap,
    },
    readerTab: {
      holdSeconds: scaled.readers.holdSeconds,
      thinkSeconds: 0,
      maxRetryAfterSeconds: cap,
    },
    readerBrowse: {
      weights: scaled.readers.routeWeights,
      thinkSeconds: scaled.thinkTimes.readerBrowseThinkSeconds,
      itemsPages: scaled.readers.itemsPages,
      maxRetryAfterSeconds: cap,
    },
  };
}

// ── The resolved profile ─────────────────────────────────────────────────────

export interface ResolvedProfile {
  name: string;
  instances: number;
  loadHash: string;
  /** The profile at N (what `scaleWithN` grew). */
  profile: LoadProfile;
  vus: Vus;
  seed: SeedShape;
  offered: Offered;
  requiredConcurrency: { hard: number; soft: number };
  /** Every threshold section, unchanged. k6 receives none of them. */
  thresholds: LoadProfile['thresholds'];
  timing: LoadProfile['timing'] & {
    /** The latest the k6 process can run: stages plus the longest graceful stop. */
    maxSeconds: number;
  };
  k6: {
    options: { scenarios: Record<string, Record<string, unknown>>; summaryTrendStats: string[] };
    scenarioOptions: ReturnType<typeof scenarioOptions>;
  };
}

export class ProfileRefusedError extends Error {
  constructor(readonly problems: string[]) {
    super(`the profile is refused:\n${problems.map((p) => `  · ${p}`).join('\n')}`);
    this.name = 'ProfileRefusedError';
  }
}

/** Resolve `profile` at `n` instances, or throw `ProfileRefusedError` naming each refusal. */
export function resolveProfile(profile: LoadProfile, n: number): ResolvedProfile {
  const refusals = profileRefusals(profile, n);
  if (refusals.length > 0) throw new ProfileRefusedError(refusals);
  const scaled = scaleProfile(profile, n);
  const { rampSeconds, steadySeconds, rampDownSeconds } = scaled.timing;
  const longestGrace = Math.max(scaled.runs.agentSeconds + 60, scaled.readers.holdSeconds + 30, 30);
  return {
    name: profile.name,
    instances: n,
    loadHash: loadHash(profile),
    profile: scaled,
    vus: vusOf(scaled),
    seed: scaled.seed,
    offered: offeredLoad(scaled, n),
    requiredConcurrency: requiredConcurrency(scaled, n),
    thresholds: structuredClone(profile.thresholds),
    timing: {
      rampSeconds,
      steadySeconds,
      rampDownSeconds,
      maxSeconds: Math.ceil(rampSeconds + steadySeconds + rampDownSeconds + longestGrace),
    },
    k6: {
      options: {
        scenarios: k6Scenarios(scaled),
        summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
      },
      scenarioOptions: scenarioOptions(scaled),
    },
  };
}

/** The resolver's printout: what is offered, against what, at which rates. */
export function describeResolved(r: ResolvedProfile): string[] {
  const per = r.thresholds.perInstance;
  return [
    `profile ${r.name} at ${r.instances} instance(s) — load hash ${r.loadHash.slice(0, 12)}`,
    `VUs ${r.vus.total}: agents ${r.vus.agents} (read ${r.vus.read} · write ${r.vus.write} · claim ${r.vus.claim} · run ${r.vus.run}), ` +
      `readers ${r.vus.readers} (tab ${r.vus.tab} · browse ${r.vus.browse}), burst ${r.vus.burst}`,
    `offered ≤ ${r.offered.rpsUpperBound} req/s per instance (MCP ${r.offered.mcpRps} · /api/v1 ${r.offered.apiV1Rps} · readers ${r.offered.readerRps}) ` +
      `against targetRps ${per.targetRps} (bound ${round2(r.offered.rpsUpperBound / OFFERED_MARGIN)})`,
    `per token: MCP ${r.offered.perTokenRps.mcp} req/s · /api/v1 ${r.offered.perTokenRps.apiV1} req/s; ` +
      `busiest workspace ${r.offered.perWorkspaceRps} req/s of ${AGENT_WORKSPACE_CEILING_RPS * WORKSPACE_HEADROOM} allowed`,
    `held streams ${r.offered.readerStreamsPerInstance} per instance → proxy concurrency required: ` +
      `hard ≥ ${r.requiredConcurrency.hard}, soft ≥ ${r.requiredConcurrency.soft} (type requests)`,
  ];
}

export type { AgentRole };
