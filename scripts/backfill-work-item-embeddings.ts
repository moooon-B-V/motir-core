/**
 * `pnpm db:backfill:embeddings` — backfill plan-tree EMBEDDINGS (Story
 * MOTIR-2694 · Subtask MOTIR-2696) onto the work items that predate them.
 *
 * The write path keeps embeddings current from here on — a create, a
 * content-changing edit, and a materialize each enqueue a job
 * (`docs/decisions/plan-tree-embeddings.md` §6.3.1). Rows written BEFORE that
 * landed have no vector, and an item with no vector is simply not a search
 * candidate: never an error, never a failed read, visible only as the `coverage`
 * figure the search endpoint returns. This is what closes that gap.
 *
 * IDEMPOTENT + SAFE TO RE-RUN, and safe to interrupt. The sweep recomputes each
 * item's content hash and embeds only the rows whose stored hash disagrees — so
 * a second consecutive run makes no provider call at all, and a run killed
 * half-way resumes by simply running again. The reads and writes go through the
 * shipped service under a bound workspace context; no raw Prisma and no raw SQL
 * in this file (4-layer applies to operator tooling too).
 *
 * IT SPENDS REAL CREDITS. Every embedded row is one metered call through
 * motir-ai's gateway onto the tenant's own `CreditLedger`, so `--dry-run` reports
 * the exact number of rows that WOULD be embedded and calls nothing. Run it
 * first.
 *
 * SCOPED TO ONE PROJECT (default `MOTIR`), like the provenance backfill beside
 * it: a database-wide sweep would spend one tenant's credits deciding another
 * tenant's coverage.
 *
 * Usage:
 *   pnpm db:backfill:embeddings --dry-run          # count the stale rows, call nothing
 *   pnpm db:backfill:embeddings                    # apply to MOTIR
 *   pnpm db:backfill:embeddings --project=OTHER
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { workItemEmbeddingRepository } from '@/lib/repositories/workItemEmbeddingRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { composeEmbeddingDocument, hashEmbeddingDocument } from '@/lib/workItems/embeddingDocument';

const TAG = '[backfill-embeddings]';
const DEFAULT_PROJECT_IDENTIFIER = 'MOTIR';
const DRY_RUN_PAGE_SIZE = 500;

interface Args {
  dryRun: boolean;
  projectIdentifier: string;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let projectIdentifier = DEFAULT_PROJECT_IDENTIFIER;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--project=')) projectIdentifier = arg.slice('--project='.length);
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, projectIdentifier };
}

/**
 * Count the rows the real run would embed, WITHOUT calling the provider.
 *
 * It applies the SAME comparison the service does — recompose the document,
 * hash it, compare against the stored hash — over the same paged scan, so the
 * number it prints is the number of metered calls the apply would make, not an
 * estimate of one.
 */
async function countStale(workspaceId: string, projectId: string): Promise<[number, number]> {
  let afterId: string | null = null;
  let scanned = 0;
  let stale = 0;
  for (;;) {
    const page = await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemEmbeddingRepository.listForBackfill(
        { projectId, afterId, limit: DRY_RUN_PAGE_SIZE },
        tx,
      ),
    );
    if (page.length === 0) break;
    scanned += page.length;
    afterId = page[page.length - 1]!.id;
    for (const row of page) {
      const hash = hashEmbeddingDocument(
        composeEmbeddingDocument({ title: row.title, descriptionMd: row.descriptionMd }),
      );
      if (row.contentHash !== hash) stale += 1;
    }
    if (page.length < DRY_RUN_PAGE_SIZE) break;
  }
  return [scanned, stale];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env['MOTIR_AI_URL'] || !process.env['MOTIR_AI_SERVICE_TOKEN']) {
    console.error(
      `${TAG} MOTIR_AI_URL / MOTIR_AI_SERVICE_TOKEN are not set. motir-core stores ` +
        `embeddings and cannot produce them (ADR §6.2) — there is nothing this can do.`,
    );
    process.exitCode = 1;
    return;
  }

  // Resolve the identifier across workspaces, the way the provenance backfill
  // does: `findByIdentifier` is keyed on (workspaceId, identifier) and a script
  // has no active workspace. An ambiguous identifier is an explicit error rather
  // than a silent pick — this spends credits, so it must not guess a tenant.
  const matches = await db.project.findMany({
    where: { identifier: args.projectIdentifier },
    select: { id: true, identifier: true, workspaceId: true },
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
        `(${matches.map((p) => `${p.id} in ${p.workspaceId}`).join('; ')}). Refusing to guess.`,
    );
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    const [scanned, stale] = await countStale(project.workspaceId, project.id);
    console.log(
      `${TAG} ${args.projectIdentifier}: scanned ${scanned} item(s); ` +
        `${stale} would be embedded (one metered call each, batched 64 per request).`,
    );
    return;
  }

  const result = await workItemEmbeddingsService.backfillProject({
    workspaceId: project.workspaceId,
    projectId: project.id,
  });
  console.log(
    `${TAG} ${args.projectIdentifier}: scanned ${result.scanned} item(s), ` +
      `embedded ${result.embedded}` +
      (result.model ? ` with ${result.model}.` : ' (nothing needed work).'),
  );
}

main()
  .catch((err: unknown) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
