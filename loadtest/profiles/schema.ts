// THE LOAD PROFILE SCHEMA (Story MOTIR-8538 · MOTIR-8678).
//
// The whole experiment as data: how many clients, in what mix, against how many
// seeded tenants, for how long, and every threshold the report judges against. A
// change to a ratio or a threshold is a reviewed diff to `smoke.json` or
// `default.json`, never a flag.
//
// The profile holds NO platform name: the target app comes from `--app` (or
// `LOADTEST_STAGING_APP`) on the run command, so a profile cannot point a run at
// production.
//
// Validation, in two passes, every problem named by its field:
//   1. shape — `LoadProfile` (zod, strict at every level: an unknown field is
//      refused, never ignored);
//   2. sense — the mix and the role split sum to 1, the tenancy section agrees
//      with the seed section it describes, the seed itself passes
//      `validateSeedShape`, and the three resolver refusals
//      (`./resolve.ts` `profileRefusals`): seeded agents and users cover every
//      role's VUs, `targetRps` is reachable from the offered load, and no one
//      workspace is offered more than 70 % of the `agent:workspace` ceiling.

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import {
  AGENT_ROLES,
  InvalidSeedShapeError,
  agentsPerUser,
  validateSeedShape,
  type SeedShape,
} from '../seed/shape';
import { profileRefusals } from './resolve';

/** The two checked-in shapes `--profile` accepts by name. */
export const NAMED_PROFILES = ['smoke', 'default'] as const;

/** The fields a profile may list on `scaleWithN` — every one an integer count. */
export const SCALABLE_FIELDS = [
  'clients',
  'seed.users',
  'seed.workspaces',
  'seed.burstAgents',
  'tenancy.agentWorkspaces',
  'burst.agents',
] as const;
export type ScalableField = (typeof SCALABLE_FIELDS)[number];

/** Sections that do not shape the load: excluded from the profile's load hash. */
export const NON_LOAD_SECTIONS = ['name', 'notes', 'thresholds'] as const;

const count = (min: number) => z.number().int().min(min);
const positive = z.number().positive();
const nonNegative = z.number().min(0);
const fraction = z.number().min(0).max(1);
const weights = z.record(z.string().min(1), nonNegative);

const seedShape = z
  .object({
    smoke: z.boolean(),
    users: count(1),
    workspaces: count(1),
    workspacesPerUser: count(1),
    projectsPerWorkspace: count(1),
    agentRoles: z
      .object({ read: count(0), write: count(0), claim: count(0), run: count(0) })
      .strict(),
    content: z.object({ stories: count(0), subtasksPerStory: count(0) }).strict(),
    pools: z.object({ claim: count(0), run: count(0), write: count(0) }).strict(),
    burstSize: count(1),
    burstAgents: count(0),
    readPlansPerWorkspace: count(0),
    scratchPlans: count(0),
  })
  .strict();

/** A threshold section the report owns (`bottleneck`, `generator`): accepted, passed through. */
const reportSection = z.record(z.string(), z.unknown());

export const LoadProfile = z
  .object({
    name: z.string().min(1),
    /** Every number that is an assumption rather than a reading, named. */
    notes: z.array(z.string().min(1)).min(1),
    /** Concurrent k6 VUs per instance (closed model: VUs = clients). */
    clients: count(1),
    mix: z.object({ agents: fraction, readers: fraction }).strict(),
    roleSplit: z
      .object({ read: fraction, write: fraction, claim: fraction, run: fraction })
      .strict(),
    /** Per-tool weights inside the read and write roles. */
    toolWeights: z.object({ read: weights, write: weights }).strict(),
    thinkTimes: z
      .object({
        /** Non-run agents, between iterations. */
        agentThinkSeconds: nonNegative,
        /** The p50 the offered-load arithmetic assumes for one MCP or /api/v1 call. */
        latencyAssumptionMs: positive,
        /** The p50 it assumes for one page render. */
        readerLatencyAssumptionMs: positive,
        readerBrowseThinkSeconds: nonNegative,
      })
      .strict(),
    tenancy: z
      .object({
        agentsPerUser: count(1),
        workspacesPerUser: count(1),
        usersPerWorkspace: count(1),
        agentWorkspaces: count(1),
      })
      .strict(),
    seed: seedShape,
    readers: z
      .object({
        tabShare: fraction,
        holdSeconds: positive,
        routeWeights: weights,
        itemsPages: count(2),
      })
      .strict(),
    runs: z
      .object({
        agentSeconds: positive,
        logEventsPerBeat: count(0),
        recycle: z.boolean(),
      })
      .strict(),
    burst: z
      .object({
        size: count(1),
        agents: count(0),
        offsetSeconds: nonNegative,
        retryAfterCapSeconds: positive,
      })
      .strict(),
    timing: z
      .object({ rampSeconds: positive, steadySeconds: positive, rampDownSeconds: nonNegative })
      .strict(),
    scaleWithN: z.array(z.enum(SCALABLE_FIELDS)),
    /** The instance counts the story runs this profile at (1, then N). */
    instanceCounts: z.array(count(1)).min(1),
    thresholds: z
      .object({
        perInstance: z
          .object({
            targetRps: positive,
            readP95Ms: positive,
            readP99Ms: positive,
            mutateP95Ms: positive,
            mutateP99Ms: positive,
            errorRate: fraction,
            p2028: count(0),
            streamLost: count(0),
            rateLimitedMax: fraction,
          })
          .strict(),
        scaleOut: z.object({ efficiency: fraction }).strict(),
        bottleneck: reportSection.optional(),
        generator: reportSection.optional(),
      })
      .strict(),
  })
  .strict();

export type LoadProfile = z.infer<typeof LoadProfile>;

export class InvalidProfileError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid load profile:\n${problems.map((p) => `  · ${p}`).join('\n')}`);
    this.name = 'InvalidProfileError';
  }
}

const SUM_TOLERANCE = 1e-9;

function sumsToOne(values: number[]): boolean {
  return Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= SUM_TOLERANCE;
}

/** The tenancy section's numbers as the seed section implies them. */
export function tenancyOf(seed: SeedShape) {
  return {
    agentsPerUser: agentsPerUser(seed),
    workspacesPerUser: seed.workspacesPerUser,
    usersPerWorkspace: Math.round((seed.users * seed.workspacesPerUser) / seed.workspaces),
    agentWorkspaces: seed.workspaces,
  };
}

/**
 * The sense checks over a shape-valid profile at `n` instances: every problem,
 * each naming its field. Empty when the profile is sound.
 */
export function profileProblems(profile: LoadProfile, n = 1): string[] {
  const problems: string[] = [];
  if (!sumsToOne([profile.mix.agents, profile.mix.readers])) {
    problems.push('mix: agents + readers must sum to 1');
  }
  if (!sumsToOne(AGENT_ROLES.map((r) => profile.roleSplit[r]))) {
    problems.push('roleSplit: read + write + claim + run must sum to 1');
  }
  try {
    validateSeedShape(profile.seed);
  } catch (err) {
    if (!(err instanceof InvalidSeedShapeError)) throw err;
    for (const p of err.problems) problems.push(`seed.${p}`);
  }
  const implied = tenancyOf(profile.seed);
  for (const key of Object.keys(implied) as (keyof typeof implied)[]) {
    if (profile.tenancy[key] !== implied[key]) {
      problems.push(
        `tenancy.${key}: ${profile.tenancy[key]} disagrees with the seed section, which gives ${implied[key]}`,
      );
    }
  }
  if (profile.burst.size !== profile.seed.burstSize) {
    problems.push(
      `burst.size: ${profile.burst.size} is not the seed's burstSize (${profile.seed.burstSize})`,
    );
  }
  for (const [role, w] of Object.entries(profile.toolWeights)) {
    if (!Object.values(w).some((v) => v > 0)) {
      problems.push(`toolWeights.${role}: at least one weight must be above 0`);
    }
  }
  if (!Object.values(profile.readers.routeWeights).some((v) => v > 0)) {
    problems.push('readers.routeWeights: at least one weight must be above 0');
  }
  if (problems.length > 0) return problems;
  return profileRefusals(profile, n);
}

/** Parse and check a profile, or throw `InvalidProfileError` naming every problem. */
export function parseLoadProfile(input: unknown, n = 1): LoadProfile {
  const parsed = LoadProfile.safeParse(input);
  if (!parsed.success) {
    throw new InvalidProfileError(
      parsed.error.issues.map((i) => {
        const where = i.path.length > 0 ? i.path.join('.') : '(profile)';
        const unknown =
          i.code === 'unrecognized_keys' ? ` (${(i.keys as string[]).join(', ')})` : '';
        return `${where}: ${i.message}${unknown}`;
      }),
    );
  }
  const problems = profileProblems(parsed.data, n);
  if (problems.length > 0) throw new InvalidProfileError(problems);
  return parsed.data;
}

/** `--profile smoke|default|<path>` → the file it names. */
export function profilePath(arg: string, cwd = process.cwd()): string {
  if ((NAMED_PROFILES as readonly string[]).includes(arg)) {
    return resolvePath(cwd, 'loadtest/profiles', `${arg}.json`);
  }
  return isAbsolute(arg) ? arg : resolvePath(cwd, arg);
}

/** Read, parse and check the profile `--profile` names. */
export async function loadProfile(
  arg: string,
  n = 1,
  cwd = process.cwd(),
): Promise<{ profile: LoadProfile; path: string }> {
  const path = profilePath(arg, cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new InvalidProfileError([`--profile: no profile file at ${path}`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new InvalidProfileError([`--profile: ${path} is not JSON (${(err as Error).message})`]);
  }
  return { profile: parseLoadProfile(json, n), path };
}
