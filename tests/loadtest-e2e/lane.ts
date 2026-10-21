// THE LOADTEST END-TO-END LANE'S FIXED NAMES (Story MOTIR-8538 · MOTIR-8682), shared
// by the setup, the specs and (through state.json) the fake CLIs.

export const APPS = {
  /** The run command refuses any --app not ending in -staging; the preflight wants it equal to LOADTEST_STAGING_APP. */
  staging: 'motir-core-e2e-staging',
  /** Production — a read-only fixture: only `machine list --json` may name it. */
  production: 'motir-core',
  generator: 'motir-loadgen',
} as const;

/** 14-hex-character ids, as Fly's are. */
export const MACHINES = {
  app: ['e2a1d4f1c0de01', 'e2a1d4f1c0de02'] as const,
  worker: 'e2a1d4f1c0de09',
  production: ['d0d0d0d0d0d001', 'd0d0d0d0d0d002'] as const,
  generator: '91857e2b4c6d01',
} as const;

export const NEON = {
  projectId: 'e2e-project-000001',
  branchName: 'staging',
  branchId: 'br-e2e-staging-000001',
  endpointId: 'ep-e2e-staging-000001',
  roleName: 'motir_app',
  /** The branch JSON's copied-from time: no refresh.json and no reset key in this lane. */
  parentTimestamp: '2026-10-14T03:00:00Z',
} as const;

export const PRODUCTION_DB_HOST = 'ep-e2e-production-000001.us-east-2.aws.neon.tech';
export const PRODUCTION_SENTRY_PROJECT_ID = '4500000000000001';

/** The report's post-window wait in this lane (the default is 60 s). */
export const SETTLE_SECONDS = 3;

/** The pinned k6 + xk6-sse binary `loadtest/k6/build.sh` writes. */
export const K6_BINARY = 'loadtest/.out/k6';

/**
 * The rate limits both instances (and the fake machines' printenv) run with — far
 * above anything the tiny profile can reach, and above the run command's minimums
 * (the production defaults for MCP and agent:workspace, 1.5 × the run token's rate
 * for /api/v1). NOT the two-instance lane's 6 and 5.
 */
export const LANE_LIMITS = {
  MOTIR_MCP_RATE_LIMIT: 100_000,
  MOTIR_API_V1_RATE_LIMIT: 100_000,
  MOTIR_AGENT_WORKSPACE_RATE_LIMIT: 1_000_000,
  MOTIR_AUTH_RATE_LIMIT: 100_000,
} as const;

export interface LaneContext {
  tmp: string;
  /** The symlinked working copy every command runs in. */
  checkout: string;
  stateDir: string;
  generatorRoot: string;
  fakeBin: string;
  sha: string;
  proxyOrigin: string;
  stubOrigin: string;
  /** The environment `pnpm loadtest:run` is spawned with. */
  commandEnv: Record<string, string>;
  /** Literal values that must never reach stdout or a published file. */
  secrets: {
    authSecret: string;
    flyApiToken: string;
    promToken: string;
    neonApiKey: string;
    databaseUrl: string;
  };
  instances: { machineId: string; pid: number; origin: string }[];
}
