// The issue-importer DOMAIN service (Story 7.16 · MOTIR-941) — the ONE service
// the import API routes call (the 4-layer rule: a route calls a single service
// method, never Prisma). It owns the `Import` lifecycle (create draft → preview
// → run), builds the per-source connector from the connection config + the
// acting member's stored credential, and delegates:
//   • classify/preview → `importEngineService` (the write-free SLICE-A engine)
//   • persist/run      → `importPersistService` (the write-enabled engine)
// The persist/classify engines own their own transactions; this service owns the
// `Import`-row transactions.

import { db } from '@/lib/db';
import type { ImportSource } from '@prisma/client';
import { importRepository } from '@/lib/repositories/importRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ImportConnectionConfig, ImportDiscoverResult, ImportDto } from '@/lib/dto/import';
import { toImportDto } from '@/lib/mappers/importMappers';
import type { ImportMapping, ImportPlanRow } from '@/lib/import/engine/types';
import { importEngineService } from '@/lib/import/engine/importEngineService';
import {
  importPersistService,
  type ImportRunProgress,
} from '@/lib/import/engine/importPersistService';
import {
  CsvConnector,
  GithubConnector,
  JiraConnector,
  LinearConnector,
  PlaneConnector,
  type IssueSourceConnector,
} from '@/lib/import/connectors';
import {
  ImportConnectionConfigError,
  ImportNotFoundError,
  ImportSourceNotConnectedError,
} from '@/lib/import/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';

export interface CreateImportInput {
  projectId: string;
  source: ImportSource;
  sourceRef?: string | null;
}

export interface PreviewResult {
  rows: ImportPlanRow[];
  counts: { create: number; update: number; skip: number };
}

export const importService = {
  /** Create a DRAFT import for a project (POST /api/import). Gated by project
   *  edit access; the reporter/owner is the acting user. */
  async createDraft(input: CreateImportInput, ctx: ServiceContext): Promise<ImportDto> {
    const project = await projectRepository.findById(input.projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(input.projectId);
    }
    await projectAccessService.assertCanEdit(input.projectId, ctx);

    const row = await db.$transaction((tx) =>
      importRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId: input.projectId,
          source: input.source,
          sourceRef: input.sourceRef ?? null,
          createdById: ctx.userId,
        },
        tx,
      ),
    );
    return toImportDto(row);
  },

  /** Read one import's status + counts (GET /api/import/:id). Tenant-scoped: a
   *  cross-workspace id is a 404, never a leak. */
  async getImport(importId: string, ctx: ServiceContext): Promise<ImportDto> {
    const row = await this.requireImport(importId, ctx);
    return toImportDto(row);
  },

  /**
   * CONNECT-step probe (POST /api/import/:id/discover) — build the per-source
   * connector from the wizard's connection config (+ the acting member's stored
   * credential for a live source) and return BOTH the reachability/issue-count
   * probe AND the source field vocabulary the mapping step maps from. Read-only:
   * no writes, no `Import` mutation (unlike `preview`, which persists the mapping).
   * This is the thin route over 7.16.4's connector `connect()` + `discoverFields()`
   * that 7.16.5's API set (MOTIR-941) did not expose.
   */
  async discoverFields(
    importId: string,
    args: { connection: ImportConnectionConfig },
    ctx: ServiceContext,
  ): Promise<ImportDiscoverResult> {
    const imp = await this.requireImport(importId, ctx);
    await projectAccessService.assertCanEdit(imp.projectId, ctx);

    const connector = await this.buildConnector(imp.source, args.connection, ctx);
    // Sequential (not Promise.all): `connect()` validates reachability + auth, so
    // a bad token / unreachable source surfaces as its typed error BEFORE we page
    // for the field vocabulary.
    const connect = await connector.connect();
    const vocabulary = await connector.discoverFields();
    return {
      connect: { sourceRef: connect.sourceRef, issueCount: connect.issueCount },
      vocabulary,
    };
  },

  /**
   * DRY-RUN preview (POST /api/import/:id/preview) — classify every source issue
   * (CREATE/UPDATE/SKIP + resolved payload + warnings) with NO writes, via the
   * SLICE-A engine. Stores the confirmed mapping + a `previewed` status on the
   * `Import` so a subsequent run reuses them.
   */
  async preview(
    importId: string,
    args: { mapping: ImportMapping; connection: ImportConnectionConfig },
    ctx: ServiceContext,
  ): Promise<PreviewResult> {
    const imp = await this.requireImport(importId, ctx);
    await projectAccessService.assertCanEdit(imp.projectId, ctx);

    const connector = await this.buildConnector(imp.source, args.connection, ctx);
    const resolveCtx = await importEngineService.buildResolveContext(
      imp.projectId,
      ctx.workspaceId,
      ctx.userId,
    );

    const rows: ImportPlanRow[] = [];
    const counts = { create: 0, update: 0, skip: 0 };
    for await (const row of importEngineService.previewFromConnector(
      connector,
      args.mapping,
      resolveCtx,
    )) {
      rows.push(row);
      counts[row.plan] += 1;
    }

    // Resolve the human-facing source ref OUTSIDE the transaction (it may hit the
    // source / re-parse a file — never inside a tx).
    const sourceRef = imp.sourceRef ?? (await connectorSourceRef(connector));
    await db.$transaction((tx) =>
      importRepository.update(
        importId,
        { mapping: args.mapping as object, sourceRef, status: 'previewed' },
        tx,
      ),
    );
    return { rows, counts };
  },

  /**
   * Execute the import (POST /api/import/:id/run) — the SLICE-A engine with
   * writes ON. Loads + gates + builds the connector up front (so a 4xx is thrown
   * before streaming), then returns the persist engine's streamed progress
   * generator; the route serialises it to the HTTP response.
   */
  async run(
    importId: string,
    args: { mapping?: ImportMapping; connection: ImportConnectionConfig },
    ctx: ServiceContext,
  ): Promise<AsyncGenerator<ImportRunProgress>> {
    const imp = await this.requireImport(importId, ctx);
    await projectAccessService.assertCanEdit(imp.projectId, ctx);

    const mapping = args.mapping ?? (imp.mapping as ImportMapping | null);
    if (!mapping) {
      throw new ImportConnectionConfigError('no mapping supplied and none stored on the import');
    }

    const connector = await this.buildConnector(imp.source, args.connection, ctx);
    const resolveCtx = await importEngineService.buildResolveContext(
      imp.projectId,
      ctx.workspaceId,
      ctx.userId,
    );

    return importPersistService.runImport({ importId, connector, mapping, ctx: resolveCtx });
  },

  /** Load an import in the acting workspace or throw a 404. */
  async requireImport(importId: string, ctx: ServiceContext) {
    const row = await importRepository.findById(importId);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new ImportNotFoundError(importId);
    return row;
  },

  /** Build the per-source connector from the connection config + (for live
   *  sources) the acting member's decrypted credential. CSV needs none. */
  async buildConnector(
    source: ImportSource,
    connection: ImportConnectionConfig,
    ctx: ServiceContext,
  ): Promise<IssueSourceConnector> {
    if (connection.source !== source) {
      throw new ImportConnectionConfigError(
        `connection is for "${connection.source}" but the import is "${source}"`,
      );
    }

    if (connection.source === 'csv') {
      return new CsvConnector({
        filename: connection.filename,
        content: connection.content,
        columnMap: connection.columnMap,
        delimiter: connection.delimiter,
      });
    }

    // Live sources — fetch-and-decrypt the acting member's token.
    const token = await importSourceIdentityService.getLiveToken({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      source,
    });
    if (!token) throw new ImportSourceNotConnectedError(source);

    switch (connection.source) {
      case 'jira':
        return new JiraConnector({
          baseUrl: connection.baseUrl,
          apiToken: token.accessToken,
          email: connection.email,
          projectKey: connection.projectKey,
          jql: connection.jql,
        });
      case 'linear':
        return new LinearConnector({
          apiKey: token.accessToken,
          authScheme: connection.authScheme,
          teamKey: connection.teamKey,
          endpoint: connection.endpoint,
        });
      case 'github':
        return new GithubConnector({
          token: token.accessToken,
          owner: connection.owner,
          repo: connection.repo,
          baseUrl: connection.baseUrl,
        });
      case 'plane':
        return new PlaneConnector({
          apiKey: token.accessToken,
          baseUrl: connection.baseUrl,
          workspaceSlug: connection.workspaceSlug,
          projectId: connection.projectId,
        });
    }
  },
};

/** The connector's human-facing source ref (Jira project key / `owner/repo` /
 *  filename) for `Import.sourceRef`, best-effort. */
async function connectorSourceRef(connector: IssueSourceConnector): Promise<string | null> {
  try {
    const result = await connector.connect();
    return result.sourceRef;
  } catch {
    return null;
  }
}
