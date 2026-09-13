/**
 * `pnpm ops:agent-meter-rehearsal` — boot ONE stand-in container under the
 * `hosted_agent` workload, meter it through the seam, and print what it cost.
 * (Story MOTIR-4336 · MOTIR-4713)
 *
 * The run itself is `rehearseHostedAgentMeter.ts`; this is argument parsing and a
 * `console.log`. See that file for the stand-in and the gate.
 *
 * Usage:
 *   pnpm ops:agent-meter-rehearsal --org=<organizationId> --workspace=<workspaceId> \
 *     --project=<projectId> --repo=<owner/name>
 *
 * Needs `DATABASE_URL`, `MOTIR_CLOUD=true` and the fleet's configuration. Off-cloud
 * it prints that the meter is disabled and provisions nothing.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { rehearseHostedAgentMeter } from './rehearseHostedAgentMeter';

const TAG = '[agent-meter-rehearsal]';

const FLAGS = {
  '--org=': 'organizationId',
  '--workspace=': 'workspaceId',
  '--project=': 'projectId',
  '--repo=': 'repoFullName',
} as const;

function parseArgs(argv: string[]) {
  const parsed: Partial<Record<(typeof FLAGS)[keyof typeof FLAGS], string>> = {};
  for (const arg of argv) {
    const flag = (Object.keys(FLAGS) as (keyof typeof FLAGS)[]).find((f) => arg.startsWith(f));
    if (!flag) throw new Error(`${TAG} unknown argument: ${arg}`);
    parsed[FLAGS[flag]] = arg.slice(flag.length);
  }
  const missing = Object.entries(FLAGS)
    .filter(([, key]) => !parsed[key])
    .map(([flag]) => `${flag}<value>`);
  if (missing.length > 0) throw new Error(`${TAG} missing: ${missing.join(' ')}`);
  return parsed as Record<(typeof FLAGS)[keyof typeof FLAGS], string>;
}

async function main(): Promise<void> {
  const { text } = await rehearseHostedAgentMeter(parseArgs(process.argv.slice(2)));
  console.log(text);
}

main()
  .catch((err: unknown) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
