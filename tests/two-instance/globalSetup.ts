import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import { addressOf, startInstances, type PairAddress } from './harness';

// Starts the two `app` instances ONCE per lane (MOTIR-8616) and hands their
// addresses to every spec through `inject('twoInstanceApp')`. One `next build`
// output, two `next start` processes, one `DATABASE_URL`.
//
// ⚠️ THIS LANE NEEDS REAL LIMITS. It never sets `MOTIR_RATE_LIMIT_STORE=memory`
// or `E2E_DISABLE_RATE_LIMIT`, and it DELETES both from the inherited env, so a
// developer shell that exports either cannot quietly turn the lane's limits
// into per-process ones (or off) — which is the defect it exists to catch.

/** The budgets both servers start with; the limit cases read them from here. */
export const TWO_INSTANCE_BUDGETS = {
  mcp: { limit: 6, windowMs: 60_000 },
  apiV1: { limit: 5, windowMs: 60_000 },
} as const;

declare module 'vitest' {
  export interface ProvidedContext {
    twoInstanceApp: PairAddress;
  }
}

export function appEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    // The production build's test seams (Secure cookies over plain http, the
    // `file` email sink) — the flag every production-build E2E lane sets.
    E2E_PROD_HARNESS: '1',
    EMAIL_PROVIDER: 'file',
    EMAIL_OUTBOX_PATH: process.env['EMAIL_OUTBOX_PATH'] ?? '/tmp/motir-two-instance-emails.jsonl',
    // The budgets `limits.spec.ts` (MOTIR-8617) spends across the pair — small
    // enough to exhaust in a handful of calls, on the shipped 60 s window so a
    // case can buy a guaranteed slice of it (`TWO_INSTANCE_BUDGETS`).
    MOTIR_MCP_RATE_LIMIT: String(TWO_INSTANCE_BUDGETS.mcp.limit),
    MOTIR_MCP_RATE_LIMIT_WINDOW_MS: String(TWO_INSTANCE_BUDGETS.mcp.windowMs),
    MOTIR_API_V1_RATE_LIMIT: String(TWO_INSTANCE_BUDGETS.apiV1.limit),
    MOTIR_API_V1_RATE_LIMIT_WINDOW_MS: String(TWO_INSTANCE_BUDGETS.apiV1.windowMs),
  };
  delete env['E2E_DISABLE_RATE_LIMIT'];
  delete env['MOTIR_RATE_LIMIT_STORE'];
  delete env['PORT'];
  return env;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = resolve(__dirname, '../..');
  if (!existsSync(resolve(root, '.next/BUILD_ID'))) {
    throw new Error(
      'The two-instance lane runs a PRODUCTION build and there is none: run `pnpm exec next build` first ' +
        "(CI downloads the `build` job's `.next/` artifact).",
    );
  }
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is not set.');

  const pair = await startInstances({
    command: [
      process.execPath,
      'node_modules/next/dist/bin/next',
      'start',
      '-p',
      '{port}',
      '-H',
      '127.0.0.1',
    ],
    env: appEnv(),
    readyPath: '/api/health/ready',
    readyTimeoutMs: 180_000,
    announcePattern: /Local:\s+http:\/\/[^\s:]+:(\d+)/,
  });
  project.provide('twoInstanceApp', addressOf(pair));
  return () => pair.stop();
}
