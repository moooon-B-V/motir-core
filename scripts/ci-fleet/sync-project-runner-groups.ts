/**
 * Sync one project's runner groups in every org — the provisioning org and each
 * connected org with the provisioning App installed (Story MOTIR-8699 ·
 * MOTIR-8712). Prints one line per org; exits 1 when any org is `sync_pending`.
 *
 *   DATABASE_URL='<url>' pnpm tsx --tsconfig tsconfig.node.json \
 *     scripts/ci-fleet/sync-project-runner-groups.ts --project MOTIR
 *
 *   DATABASE_URL='<url>' pnpm tsx --tsconfig tsconfig.node.json \
 *     scripts/ci-fleet/sync-project-runner-groups.ts --project-id <project id>
 *
 * `--project <KEY>` resolves the key across every workspace and refuses when
 * none or more than one project carries it; the refusal lists each candidate as
 * a `--project-id <id>  (workspace <id>)` line. A key is unique per workspace
 * only, so `--project-id` is the unambiguous form (MOTIR-8814). Give exactly
 * one of the two.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import '../_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { runSyncProjectRunnerGroups } from './syncProjectRunnerGroups';

const TAG = '[sync-project-runner-groups]';

runSyncProjectRunnerGroups(process.argv.slice(2))
  .then(async ({ exitCode, lines }) => {
    for (const line of lines) console.log(TAG, line);
    await db.$disconnect();
    process.exit(exitCode);
  })
  .catch(async (err: unknown) => {
    console.error(TAG, 'failed', err);
    await db.$disconnect();
    process.exit(1);
  });
