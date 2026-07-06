// The importer ENGINE service (Story 7.16 · MOTIR-1504) — the write-free half.
// 4-layer (`motir-core/CLAUDE.md`): a service that orchestrates the pure
// resolver + idempotency classifier over read-only repositories, and STREAMS a
// dry-run plan. It writes NOTHING.
//
// `classifyIssue` is the SHARED resolve→hash→lookup→classify core; the preview
// (dryRun) yields plan rows from it, and MOTIR-941's real run consumes the
// IDENTICAL `classifyIssue` before persisting — so the run can never diverge
// from the preview. The DB reads are injectable (the `deps` seam, mirroring the
// connectors' `fetchImpl`) so the engine is unit-testable without Postgres,
// while wiring the real repositories by default.

import type { ImportedIssue, ImportSource } from '@prisma/client';
import { db } from '@/lib/db';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { workflowsService } from '@/lib/services/workflowsService';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { importedIssueRepository } from '@/lib/repositories/importedIssueRepository';
import type { IssueSourceConnector, SourceIssue } from '../connectors/types';
import { resolveIssue } from './importResolver';
import { classifyByHash, computeSourceHash } from './importIdempotency';
import type { ImportMapping, ImportPlanRow, ImportResolveContext } from './types';

/** Injectable read seams (default to the real repositories). */
export interface ImportEngineDeps {
  lookupExisting?: (
    projectId: string,
    source: ImportSource,
    externalId: string,
  ) => Promise<ImportedIssue | null>;
  loadStatuses?: (projectId: string, workspaceId: string) => Promise<WorkflowStatusDto[]>;
  loadMembers?: (workspaceId: string) => Promise<Array<{ userId: string; email: string | null }>>;
}

async function defaultLoadMembers(
  workspaceId: string,
): Promise<Array<{ userId: string; email: string | null }>> {
  const members = await db.$transaction((tx) =>
    workspaceMembershipRepository.findMembersByWorkspace(workspaceId, tx),
  );
  return members.map((m) => ({ userId: m.user.id, email: m.user.email }));
}

export const importEngineService = {
  /**
   * Build the per-run resolve context ONCE — the project's valid status keys +
   * initial status, and the workspace members keyed by lowercased email. All
   * read-only.
   */
  async buildResolveContext(
    projectId: string,
    workspaceId: string,
    importingUserId: string,
    deps: ImportEngineDeps = {},
  ): Promise<ImportResolveContext> {
    const statuses = await (
      deps.loadStatuses ?? ((p, w) => workflowsService.listStatusesByProject(p, w))
    )(projectId, workspaceId);
    const members = await (deps.loadMembers ?? defaultLoadMembers)(workspaceId);

    const statusKeys = new Set(statuses.map((s) => s.key));
    const initialStatusKey = statuses.find((s) => s.isInitial)?.key ?? null;
    const membersByEmail = new Map<string, string>();
    for (const m of members) if (m.email) membersByEmail.set(m.email.toLowerCase(), m.userId);

    return {
      projectId,
      workspaceId,
      importingUserId,
      statusKeys,
      initialStatusKey,
      membersByEmail,
    };
  },

  /**
   * The SHARED core: resolve one source issue, hash its source-owned fields,
   * look up its idempotency mapping, and classify CREATE/UPDATE/SKIP. A pure
   * read — no writes. MOTIR-941's run calls this THEN persists.
   */
  async classifyIssue(
    source: ImportSource,
    sourceIssue: SourceIssue,
    mapping: ImportMapping,
    ctx: ImportResolveContext,
    deps: ImportEngineDeps = {},
  ): Promise<ImportPlanRow> {
    const { payload, warnings } = resolveIssue(sourceIssue, mapping, ctx);
    const sourceHash = computeSourceHash(payload);
    const lookup =
      deps.lookupExisting ?? ((p, s, e) => importedIssueRepository.findBySourceId(p, s, e));
    const existing = await lookup(ctx.projectId, source, sourceIssue.externalId);
    const { plan, existingWorkItemId } = classifyByHash(existing, sourceHash);
    return {
      externalId: sourceIssue.externalId,
      plan,
      payload,
      warnings,
      sourceHash,
      existingWorkItemId,
    };
  },

  /**
   * The DRY-RUN preview: stream a plan row per source issue (CREATE/UPDATE/SKIP
   * + resolved payload + warnings), WRITING NOTHING. Streamed (a generator), so
   * a 10k-issue preview is never one giant payload.
   */
  async *previewIssues(
    source: ImportSource,
    sourceIssues: Iterable<SourceIssue> | AsyncIterable<SourceIssue>,
    mapping: ImportMapping,
    ctx: ImportResolveContext,
    deps: ImportEngineDeps = {},
  ): AsyncGenerator<ImportPlanRow> {
    for await (const issue of asAsync(sourceIssues)) {
      yield await this.classifyIssue(source, issue, mapping, ctx, deps);
    }
  },

  /**
   * Drive a paginated CONNECTOR to exhaustion and stream the dry-run plan —
   * pages are fetched lazily (never all-into-memory) and each issue is
   * classified as it arrives.
   */
  async *previewFromConnector(
    connector: IssueSourceConnector,
    mapping: ImportMapping,
    ctx: ImportResolveContext,
    deps: ImportEngineDeps = {},
  ): AsyncGenerator<ImportPlanRow> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const page = await connector.listIssues(cursor);
      for (const issue of page.issues) {
        yield await this.classifyIssue(connector.source, issue, mapping, ctx, deps);
      }
      if (page.nextCursor === null || seen.has(page.nextCursor)) return;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  },

  /** Collect the full preview into an array (small imports / tests). */
  async preview(
    source: ImportSource,
    sourceIssues: SourceIssue[],
    mapping: ImportMapping,
    ctx: ImportResolveContext,
    deps: ImportEngineDeps = {},
  ): Promise<ImportPlanRow[]> {
    const rows: ImportPlanRow[] = [];
    for await (const row of this.previewIssues(source, sourceIssues, mapping, ctx, deps))
      rows.push(row);
    return rows;
  },
};

async function* asAsync<T>(it: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  if (Symbol.asyncIterator in it) {
    yield* it as AsyncIterable<T>;
  } else {
    for (const x of it as Iterable<T>) yield x;
  }
}
