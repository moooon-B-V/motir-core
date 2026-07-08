// DTOs for the issue-importer RUN surface (Story 7.16 · MOTIR-941). The `Import`
// row as it crosses the API boundary, plus the per-source CONNECTION config the
// preview/run routes accept (the wizard-collected fields a connector needs,
// MINUS the credential — that comes from the `ImportSourceIdentity` token store
// for live sources; CSV carries its file content and needs none).

import type { ImportSource, ImportStatus } from '@prisma/client';
import type { CsvColumnMap } from '@/lib/import/connectors/csvConnector';
import type { ImportMapping } from '@/lib/import/engine/types';

/** A single `Import` run row for the wizard (status + counts, for progress/resume). */
export interface ImportDto {
  id: string;
  source: ImportSource;
  sourceRef: string | null;
  status: ImportStatus;
  mapping: ImportMapping | null;
  counts: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * The per-source connection config a connector is built from (ADR §1). A
 * discriminated union on `source`. The credential for a LIVE source is NOT here
 * — it is fetched-and-decrypted from the acting member's `ImportSourceIdentity`
 * (MOTIR-1653) at build time; CSV carries the uploaded file content and needs no
 * credential.
 */
export type ImportConnectionConfig =
  | {
      source: 'csv';
      filename: string;
      content: string;
      columnMap?: CsvColumnMap;
      delimiter?: string;
    }
  | { source: 'jira'; baseUrl: string; email?: string; projectKey?: string; jql?: string }
  | { source: 'linear'; teamKey?: string; authScheme?: 'apiKey' | 'bearer'; endpoint?: string }
  | { source: 'github'; owner: string; repo: string; baseUrl?: string }
  | { source: 'plane'; baseUrl?: string; workspaceSlug: string; projectId: string };
