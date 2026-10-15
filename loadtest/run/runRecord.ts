// THE RUN RECORD — `run.json` (Story MOTIR-8538 · MOTIR-8678).
//
// The contract the report reads. Every field is always present: one that could not
// be read is the string `unmeasured`, never omitted, so the report can say exactly
// what a run did not measure. The run command writes it BEFORE every non-zero exit
// from step 2 on (partial if need be), so a refused or interrupted run still has a
// record that says why it is INVALID.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const UNMEASURED = 'unmeasured' as const;
export type Unmeasured = typeof UNMEASURED;
/** A value, or `unmeasured`. */
export type M<T> = T | Unmeasured;

export const RUN_RECORD_FILE = 'run.json';

export interface MachineRecord {
  id: string;
  region: string;
  cpuKind: string;
  cpus: M<number>;
  memoryMb: M<number>;
  imageRef: string;
}

export interface RunRecord {
  runId: string;
  profile: { name: string; path: string; sha256: string };
  instances: number;
  /** False when the `app` machine set changed between step 5 and step 10. */
  instancesHeld: M<boolean>;
  /** Machine ids that appeared or left between the two reads. */
  instancesChanged: string[];
  /** ISO times from the generator's clock. */
  window: {
    startedAt: M<string>;
    rampEndedAt: M<string>;
    steadyEndedAt: M<string>;
    endedAt: M<string>;
  };
  app: { name: string; machines: M<MachineRecord[]> };
  production: M<{ cpuKind: string; cpus: M<number>; memoryMb: M<number> }>;
  candidateSize: boolean;
  /** Which `fly scale count` spelling worked, or `not-needed` when the count was already N. */
  scale: M<'not-needed' | 'groupEquals' | 'groupFlag'>;
  sha: M<string>;
  /** How `sha` was read. */
  shaReadFrom: M<'image_ref tag'>;
  neon: {
    project: string;
    branchId: M<string>;
    copiedAt: M<string>;
    copiedAtField: M<string>;
    endpointHost: M<string>;
  };
  concurrency: M<{ type: string; softLimit: M<number>; hardLimit: M<number> }>;
  requiredConcurrency: { hard: number; soft: number };
  rateLimits: {
    apiV1: M<number | 'default'>;
    mcp: M<number | 'default'>;
    agentWorkspace: M<number | 'default'>;
  };
  offered: {
    rpsUpperBound: number;
    perWorkspaceRps: number;
    perTokenRps: { mcp: number; apiV1: number };
    readerStreamsPerInstance: number;
  };
  pin: { enforced: M<boolean>; via: 'generator'; unknownIdAnswer: M<string> };
  traceRate: M<number>;
  preflightExitCode: M<number>;
  generator: {
    app: string;
    machineId: M<string>;
    region: M<string>;
    cpus: M<number>;
    startedAt: M<string>;
    stoppedAt: M<string>;
  };
  k6: { version: M<string>; extensions: M<string[]>; exitCode: M<number> };
  /** What the run-window recorders captured (MOTIR-8683); the files themselves sit beside run.json. */
  capture: M<{ logLines: number; logGaps: number; logInstances: string[]; dbSamples: number }>;
  /** True once the manifest uploaded to the generator was deleted there. */
  manifestDeleted: M<boolean>;
  /** The baseline run directory (N > 1). */
  baseline: string | null;
  exitCode: number | null;
  reason: string | null;
}

/** A record with nothing measured yet — what step 2 starts from. */
export function newRunRecord(init: {
  runId: string;
  profile: RunRecord['profile'];
  instances: number;
  app: string;
  candidateSize: boolean;
  neonProject: string;
  generatorApp: string;
  requiredConcurrency: RunRecord['requiredConcurrency'];
  offered: RunRecord['offered'];
  baseline: string | null;
}): RunRecord {
  return {
    runId: init.runId,
    profile: init.profile,
    instances: init.instances,
    instancesHeld: UNMEASURED,
    instancesChanged: [],
    window: {
      startedAt: UNMEASURED,
      rampEndedAt: UNMEASURED,
      steadyEndedAt: UNMEASURED,
      endedAt: UNMEASURED,
    },
    app: { name: init.app, machines: UNMEASURED },
    production: UNMEASURED,
    candidateSize: init.candidateSize,
    scale: UNMEASURED,
    sha: UNMEASURED,
    shaReadFrom: UNMEASURED,
    neon: {
      project: init.neonProject,
      branchId: UNMEASURED,
      copiedAt: UNMEASURED,
      copiedAtField: UNMEASURED,
      endpointHost: UNMEASURED,
    },
    concurrency: UNMEASURED,
    requiredConcurrency: init.requiredConcurrency,
    rateLimits: { apiV1: UNMEASURED, mcp: UNMEASURED, agentWorkspace: UNMEASURED },
    offered: init.offered,
    pin: { enforced: UNMEASURED, via: 'generator', unknownIdAnswer: UNMEASURED },
    traceRate: UNMEASURED,
    preflightExitCode: UNMEASURED,
    generator: {
      app: init.generatorApp,
      machineId: UNMEASURED,
      region: UNMEASURED,
      cpus: UNMEASURED,
      startedAt: UNMEASURED,
      stoppedAt: UNMEASURED,
    },
    k6: { version: UNMEASURED, extensions: UNMEASURED, exitCode: UNMEASURED },
    capture: UNMEASURED,
    manifestDeleted: UNMEASURED,
    baseline: init.baseline,
    exitCode: null,
    reason: null,
  };
}

/** Write `run.json` into `dir` (created if need be). Always writes, whatever is filled. */
export async function writeRunRecord(dir: string, record: RunRecord): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, RUN_RECORD_FILE);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** Read a run directory's `run.json` — the reader the report and `--baseline` share. */
export async function readRunRecord(dir: string): Promise<RunRecord> {
  return JSON.parse(await readFile(join(dir, RUN_RECORD_FILE), 'utf8')) as RunRecord;
}

/** The window's ramp and steady ends, from its start and the profile's timing. */
export function windowFrom(
  startedAt: string,
  endedAt: M<string>,
  timing: { rampSeconds: number; steadySeconds: number },
): RunRecord['window'] {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) {
    return { startedAt: UNMEASURED, rampEndedAt: UNMEASURED, steadyEndedAt: UNMEASURED, endedAt };
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    startedAt: iso(start),
    rampEndedAt: iso(start + timing.rampSeconds * 1000),
    steadyEndedAt: iso(start + (timing.rampSeconds + timing.steadySeconds) * 1000),
    endedAt,
  };
}
