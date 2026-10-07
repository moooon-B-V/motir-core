import type {
  WorkItemMentionCandidate,
  WorkItemMentionStatusTone,
} from '@/components/ui/markdownEditorMentions';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';

// The client-side fetcher behind the unified `@` picker's "Work items" section
// (Story 5.8 · Subtask 5.8.5). It calls the workspace-scoped candidate read
// `GET /api/work-items/mention-search?q=<text>` (5.8.4 — a thin transport over
// `workItemsService.quickSearch`, browsable-project scoped, capped) and maps the
// returned `WorkItemSummaryDto` rows into the picker's row shape. The session /
// active-workspace scope is implicit (same-origin cookies), so the SAME fetcher
// serves every host surface (the description / edit-form editors + the comment
// composer) — the data source stays out of the editor primitive.

const STATUS_BY_KEY = new Map(DEFAULT_STATUSES.map((s) => [s.key, s] as const));

const TONE_BY_CATEGORY: Record<string, WorkItemMentionStatusTone> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

/** Title-case a custom status key (`my_status` → `My Status`) for the Pill. */
function humanizeStatusKey(key: string): string {
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The picker Pill (label + tone) for a raw `work_item.status` key. The summary
 * carries only the status key (no workflow), so we resolve the well-known
 * default-workflow keys to their label + tone — mirroring `statusColor.ts`'s
 * key-then-category resolution (un-collapsing `blocked` to warning and the
 * terminal `cancelled` to a neutral chip) — and humanize any custom key under a
 * neutral chip.
 */
function deriveStatus(statusKey: string): WorkItemMentionCandidate['status'] {
  if (!statusKey) return null;
  const def = STATUS_BY_KEY.get(statusKey);
  if (!def) return { label: humanizeStatusKey(statusKey), tone: 'neutral' };
  // The category rides along for the page editor's chip (MOTIR-7574), whose dot
  // reads it until the page is read again; a custom key has none to give.
  const { category } = def;
  if (statusKey === 'blocked') return { label: def.label, tone: 'warning', category };
  if (statusKey === 'cancelled') return { label: def.label, tone: 'neutral', category };
  return { label: def.label, tone: TONE_BY_CATEGORY[category] ?? 'neutral', category };
}

/** Map one summary row into the picker candidate (type icon · key · title · Pill). */
export function toWorkItemMentionCandidate(row: WorkItemSummaryDto): WorkItemMentionCandidate {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    kind: row.kind,
    status: deriveStatus(row.status),
  };
}

/**
 * The shared, ready-to-wire work-item search for `MarkdownEditor.workItemSearch`.
 * A short/empty query is short-circuited server-side to `[]` (the service's
 * MIN_QUERY_LENGTH guard) — and the picker also gates on the same minimum, so a
 * sub-threshold query never hits the network. A non-OK response resolves to `[]`
 * (the picker surfaces a no-results state rather than throwing into the editor).
 * `opts.projectId` narrows the search to one project (MOTIR-7572 — the page
 * editor's picker); without it the search spans every browsable project.
 * `opts.throwOnError` rejects on a non-OK response instead (MOTIR-7574).
 */
export async function searchWorkItemMentions(
  query: string,
  opts: { projectId?: string; throwOnError?: boolean } = {},
): Promise<WorkItemMentionCandidate[]> {
  const project = opts.projectId ? `&projectId=${encodeURIComponent(opts.projectId)}` : '';
  const res = await fetch(
    `/api/work-items/mention-search?q=${encodeURIComponent(query)}${project}`,
    {
      headers: { accept: 'application/json' },
    },
  );
  if (!res.ok) {
    // `throwOnError` (the page editor, MOTIR-7574) lets a refused search reach
    // the picker's "search failed" state; the other hosts keep "no results".
    if (opts.throwOnError) throw new Error(`Work-item search failed with HTTP ${res.status}`);
    return [];
  }
  const rows = (await res.json()) as WorkItemSummaryDto[];
  return rows.map(toWorkItemMentionCandidate);
}
