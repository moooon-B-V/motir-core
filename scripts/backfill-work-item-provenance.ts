/**
 * `pnpm db:backfill:provenance` — backfill work-item PROVENANCE (Story
 * MOTIR-1685 · Subtask MOTIR-1758) onto the rows that predate it.
 *
 * Provenance stamps every write seam today, but only rows written AFTER the
 * story landed carry a value; MOTIR's own tree — authored across ten epics
 * before that — has all six columns NULL, so every long-shipped item's
 * Provenance section renders empty. This repairs that history from evidence
 * ALREADY IN THE DATABASE. It never invents attribution: the harness and model
 * columns are left NULL on every row, and `hosted` is never written (both by
 * design — docs/decisions/work-item-provenance.md).
 *
 * IDEMPOTENT + SAFE TO RE-RUN: it sweeps only rows still missing a source, and
 * every write is a null-guarded `updateMany`, so a row that gained provenance
 * between the sweep and the write is a no-op and a second consecutive run
 * writes nothing. The rules live in `lib/workItems/provenanceBackfill.ts` (a
 * pure, unit-tested decision table) and the reads/writes go through the shipped
 * service + repository under a bound workspace context — no raw Prisma and no
 * raw SQL in this file. 4-layer applies to operator tooling too.
 *
 * SCOPED TO ONE PROJECT (default `MOTIR`), not every project in the database:
 * this is a targeted repair of one tenant's history, and a database-wide sweep
 * would attribute other tenants' data from a boundary derived for this one.
 *
 * Usage:
 *   pnpm db:backfill:provenance --dry-run          # rehearse: decide + print, write nothing
 *   pnpm db:backfill:provenance                    # apply to MOTIR
 *   pnpm db:backfill:provenance --project=OTHER --seed-burst-end=2026-01-02T03:04:05.678Z
 *
 * It runs against the LIVE tenant, so the dry run is not optional — do it
 * first, read the per-rule counts and the boundary it echoes, and only then
 * apply.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { WORKSPACE_ROLE } from '@/lib/workspaces/roles';
import {
  MOTIR_SEED_BURST_END,
  type ProvenanceBackfillBucket,
  type ProvenanceBackfillReport,
} from '@/lib/workItems/provenanceBackfill';

const TAG = '[backfill-provenance]';
const DEFAULT_PROJECT_IDENTIFIER = 'MOTIR';

interface Args {
  dryRun: boolean;
  projectIdentifier: string;
  seedBurstEnd: Date;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let projectIdentifier = DEFAULT_PROJECT_IDENTIFIER;
  let seedBurstEnd = MOTIR_SEED_BURST_END;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--project=')) projectIdentifier = arg.slice('--project='.length);
    else if (arg.startsWith('--seed-burst-end=')) {
      const raw = arg.slice('--seed-burst-end='.length);
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw new Error(`${TAG} not an ISO date: ${raw}`);
      seedBurstEnd = parsed;
    } else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, projectIdentifier, seedBurstEnd };
}

/**
 * The user whose GUCs the writes bind — the workspace OWNER (the creator tier),
 * falling back to any member. Mirrors `backfill-default-boards.ts`: under the
 * dev/CI BYPASSRLS superuser the binding is moot, but binding a real member
 * keeps the path production-correct.
 */
async function resolveActorUserId(workspaceId: string): Promise<string | null> {
  const owner = await db.workspaceMembership.findFirst({
    where: { workspaceId, role: WORKSPACE_ROLE.owner },
    orderBy: { createdAt: 'asc' },
  });
  if (owner) return owner.userId;
  const member = await db.workspaceMembership.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  return member?.userId ?? null;
}

function formatBucket(label: string, bucket: ProvenanceBackfillBucket, dryRun: boolean): string {
  const sample = bucket.sample.length > 0 ? ` e.g. ${bucket.sample.join(', ')}` : '';
  const wrote = dryRun ? 'would write' : `wrote ${bucket.written} of`;
  return `${TAG}   ${label.padEnd(22)} ${wrote} ${bucket.count} row(s).${sample}`;
}

function printReport(report: ProvenanceBackfillReport): void {
  const { dryRun } = report;
  console.log(
    `${TAG} project ${report.projectIdentifier} — ${report.candidates} row(s) missing at least ` +
      `one source (${report.archivedCandidates} archived, included deliberately).`,
  );
  console.log(
    `${TAG} seed-burst boundary ${report.seedBurstEnd.toISOString()} — ` +
      `${report.createdAtOrBeforeBoundary} row(s) at or before it (seed), ` +
      `${report.createdAfterBoundary} after it (MCP).`,
  );
  console.log(
    `${TAG} implemented statuses: ${report.implementedStatusKeys.join(', ') || '(none)'}`,
  );
  console.log(`${TAG} planning:`);
  console.log(formatBucket('manual (seed burst)', report.planning.manual, dryRun));
  console.log(formatBucket('mcp (post-seed)', report.planning.mcp, dryRun));
  console.log(`${TAG} implementation:`);
  console.log(formatBucket('byok (PR or branch)', report.implementation.byok, dryRun));
  console.log(formatBucket('manual (human card)', report.implementation.manual, dryRun));
  console.log(
    `${TAG}   left NULL:` +
      ` ${report.implementationLeftNull.alreadyStamped} already stamped,` +
      ` ${report.implementationLeftNull.notImplementedYet} not implemented yet,` +
      ` ${report.implementationLeftNull.doneWithoutEvidence} done without evidence.`,
  );
  console.log(
    `${TAG} harness + model columns are NEVER written by this script; ` +
      `'hosted' is never written.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // `projectRepository.findByIdentifier` is keyed on the (workspaceId,
  // identifier) compound and a script has no active workspace, so resolve the
  // identifier across workspaces the way `backfill-default-boards.ts` reads its
  // project set — a plain read, and it lets an ambiguous identifier be an
  // explicit error rather than a silent pick.
  const matches = await db.project.findMany({
    where: { identifier: args.projectIdentifier },
    select: { id: true, name: true, identifier: true, workspaceId: true },
    orderBy: { createdAt: 'asc' },
  });
  const project = matches[0];
  if (!project) {
    console.error(`${TAG} no project with identifier ${args.projectIdentifier}.`);
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    console.error(
      `${TAG} identifier ${args.projectIdentifier} matches ${matches.length} projects ` +
        `(${matches.map((p) => `${p.id} in ${p.workspaceId}`).join('; ')}). ` +
        `Refusing to guess — this repair is scoped to ONE tenant.`,
    );
    process.exitCode = 1;
    return;
  }

  const actorUserId = await resolveActorUserId(project.workspaceId);
  if (!actorUserId) {
    console.error(`${TAG} workspace ${project.workspaceId} has no member to act as.`);
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) console.log(`${TAG} DRY RUN — deciding only, nothing will be written.`);

  const report = await workItemsService.backfillProvenanceForProject(project.id, actorUserId, {
    dryRun: args.dryRun,
    seedBurstEnd: args.seedBurstEnd,
  });
  printReport(report);

  const written =
    report.planning.manual.written +
    report.planning.mcp.written +
    report.implementation.byok.written +
    report.implementation.manual.written;
  console.log(
    args.dryRun
      ? `${TAG} done — dry run, 0 rows written. Re-run without --dry-run to apply.`
      : `${TAG} done — ${written} row(s) written.`,
  );
}

main()
  .catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
