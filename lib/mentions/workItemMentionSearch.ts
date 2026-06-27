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
function deriveStatus(
  statusKey: string,
): { label: string; tone: WorkItemMentionStatusTone } | null {
  if (!statusKey) return null;
  const def = STATUS_BY_KEY.get(statusKey);
  if (!def) return { label: humanizeStatusKey(statusKey), tone: 'neutral' };
  if (statusKey === 'blocked') return { label: def.label, tone: 'warning' };
  if (statusKey === 'cancelled') return { label: def.label, tone: 'neutral' };
  return { label: def.label, tone: TONE_BY_CATEGORY[def.category] ?? 'neutral' };
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
 */
export async function searchWorkItemMentions(query: string): Promise<WorkItemMentionCandidate[]> {
  const res = await fetch(`/api/work-items/mention-search?q=${encodeURIComponent(query)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as WorkItemSummaryDto[];
  return rows.map(toWorkItemMentionCandidate);
}
