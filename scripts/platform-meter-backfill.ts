/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { platformMeterReportService } from '@/lib/services/platformMeterReportService';

// `pnpm ops:platform-meter-backfill [--batch=N]` (Story MOTIR-727 · MOTIR-7294) —
// report every settled fleet container and every charged agent-storage day that
// motir-ai's platform usage rollup has not accepted yet, so the console's cost
// history starts with the meter's. Bounded batches; safe to re-run — a second run
// sends nothing already accepted, and retries what failed.

const TAG = '[platform-meter-backfill]';

function parseBatch(argv: string[]): number | undefined {
  let batch: number | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--batch=')) {
      batch = Number(arg.slice('--batch='.length));
      if (!Number.isInteger(batch) || batch < 1 || batch > 1000) {
        throw new Error(`${TAG} --batch must be an integer from 1 to 1000`);
      }
    } else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return batch;
}

async function main(): Promise<void> {
  const batch = parseBatch(process.argv.slice(2));
  const summary = await platformMeterReportService.backfill({ batch });
  console.log(
    `${TAG} containers: ${summary.containers.reported} reported, ${summary.containers.failed} failed`,
  );
  console.log(
    `${TAG} storage days: ${summary.storageDays.reported} reported, ${summary.storageDays.failed} failed`,
  );
  if (summary.containers.failed + summary.storageDays.failed > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
