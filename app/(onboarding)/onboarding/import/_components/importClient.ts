// Client-side types + fetch helpers for the import wizard (Story 7.16 ·
// MOTIR-942). The wizard is a client island that drives the 7.16.5 API routes —
// it NEVER touches the service layer directly (the 4-layer boundary). Types here
// MIRROR the server DTOs but are declared locally so the client bundle never
// imports a `server-only` engine module.

export type ImportSourceId = 'jira' | 'linear' | 'github' | 'plane' | 'csv';
export const LIVE_SOURCE_IDS: readonly Exclude<ImportSourceId, 'csv'>[] = [
  'jira',
  'linear',
  'github',
  'plane',
];

export type WorkItemKind = 'epic' | 'story' | 'task' | 'bug' | 'subtask';
export type WorkItemPriority = 'lowest' | 'low' | 'medium' | 'high' | 'highest';
export type UnmatchedUserPolicy = 'unassign' | 'importing_user' | 'invite';
export type ImportPlan = 'create' | 'update' | 'skip';

/** Mirror of the server `ImportConnectionConfig` discriminated union — the
 *  wizard-collected fields a connector needs, MINUS the credential (fetched from
 *  the token store server-side; CSV carries its file content). */
export type ConnectionConfig =
  | {
      source: 'csv';
      filename: string;
      content: string;
      columnMap?: Record<string, string>;
      delimiter?: string;
    }
  | { source: 'jira'; baseUrl: string; email?: string; projectKey?: string; jql?: string }
  | { source: 'linear'; teamKey?: string; authScheme?: 'apiKey' | 'bearer'; endpoint?: string }
  | { source: 'github'; owner: string; repo: string; baseUrl?: string }
  | { source: 'plane'; baseUrl?: string; workspaceSlug: string; projectId: string };

/** Mirror of the server `ImportMapping`. Every entry optional — a minimal
 *  mapping still runs; the wizard fills what it discovered + the user's edits. */
export interface Mapping {
  typeToKind?: Record<string, WorkItemKind>;
  defaultKind?: WorkItemKind;
  statusToKey?: Record<string, string>;
  defaultStatusKey?: string | null;
  priorityToPriority?: Record<string, WorkItemPriority>;
  unmatchedUserPolicy?: UnmatchedUserPolicy;
}

export interface Vocabulary {
  types: string[];
  statuses: string[];
  priorities: string[];
  labels: string[];
}

export interface DiscoverResult {
  connect: { sourceRef: string; issueCount: number | null };
  vocabulary: Vocabulary;
}

/** The rendered slice of the server `ImportPlanRow` (payload trimmed to what the
 *  preview table shows). */
export interface PlanRow {
  externalId: string;
  plan: ImportPlan;
  title: string;
  kind: WorkItemKind;
  warnings: string[];
  existingWorkItemId: string | null;
}

export interface PreviewResult {
  rows: PlanRow[];
  counts: { create: number; update: number; skip: number };
}

export type RunProgress =
  | {
      type: 'item';
      externalId: string;
      plan: ImportPlan;
      workItemKey: string | null;
      warnings: string[];
      error?: string;
    }
  | {
      type: 'summary';
      counts: { created: number; updated: number; skipped: number; failed: number };
      status: string;
    };

/** A typed error the wizard can render — carries the server error `code` (e.g.
 *  `IMPORT_SOURCE_NOT_CONNECTED`) so the UI branches without string-matching. */
export class ImportApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'ImportApiError';
  }
}

async function readError(res: Response): Promise<never> {
  let code = 'UNKNOWN';
  try {
    const body = (await res.json()) as { code?: string };
    if (body?.code) code = body.code;
  } catch {
    /* non-JSON body */
  }
  throw new ImportApiError(code, res.status);
}

/** POST /api/import — create a draft import for the project. */
export async function createDraft(
  projectId: string,
  source: ImportSourceId,
): Promise<{ id: string }> {
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, source }),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as { id: string };
}

/** POST /api/import/:id/discover — reachability probe + the field vocabulary. */
export async function discover(
  importId: string,
  connection: ConnectionConfig,
): Promise<DiscoverResult> {
  const res = await fetch(`/api/import/${importId}/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection }),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as DiscoverResult;
}

/** POST /api/import/:id/preview — the dry run (no writes). */
export async function preview(
  importId: string,
  mapping: Mapping,
  connection: ConnectionConfig,
): Promise<PreviewResult> {
  const res = await fetch(`/api/import/${importId}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapping, connection }),
  });
  if (!res.ok) await readError(res);
  const raw = (await res.json()) as {
    rows: {
      externalId: string;
      plan: ImportPlan;
      payload: { title: string; kind: WorkItemKind };
      warnings: string[];
      existingWorkItemId: string | null;
    }[];
    counts: { create: number; update: number; skip: number };
  };
  return {
    counts: raw.counts,
    rows: raw.rows.map((r) => ({
      externalId: r.externalId,
      plan: r.plan,
      title: r.payload.title,
      kind: r.payload.kind,
      warnings: r.warnings,
      existingWorkItemId: r.existingWorkItemId,
    })),
  };
}

/**
 * POST /api/import/:id/run — execute the import, streaming NDJSON progress. Each
 * newline-delimited line is one `RunProgress` event; `onProgress` fires per
 * event as it arrives (the aria-live counts advance from it). A pre-run 4xx is a
 * real status code (the generator is primed before the 200 stream opens), thrown
 * here as an `ImportApiError` BEFORE any streaming begins.
 */
export async function runImport(
  importId: string,
  mapping: Mapping,
  connection: ConnectionConfig,
  onProgress: (event: RunProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/import/${importId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapping, connection }),
    signal,
  });
  if (!res.ok) await readError(res);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) emit(line, onProgress);
      nl = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) emit(tail, onProgress);
}

function emit(line: string, onProgress: (event: RunProgress) => void): void {
  try {
    onProgress(JSON.parse(line) as RunProgress);
  } catch {
    /* ignore a malformed line rather than aborting the whole stream */
  }
}
