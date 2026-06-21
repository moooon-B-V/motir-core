import type { ArchivedWorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto, WorkflowDto, WorkflowStatusDto } from '@/lib/dto/workflows';
import { formatDate } from '@/lib/utils/datetime';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';

// Pure view-shaping for the archived work items view (Story 2.9 · Subtask
// 2.9.3) — turn an `ArchivedWorkItemDto` page into the serializable, flat row
// model the client island renders. Mirrors `issueRows.ts` (the active List's
// shaper): resolving the status (key → label + category for the Pill tone)
// happens HERE, on the server, against the project workflow the page already
// loads, so the client receives plain strings and no workflow table crosses the
// boundary. The archived view drops the planning columns, so a row carries only
// identity + archive provenance (who/when). Kept Prisma-free and React-free so
// it unit-tests in isolation.

/** The row payload the archived list cells render. Fully serializable. */
export interface ArchivedRowData {
  /** The work-item id — the target of the `unarchiveWorkItem` restore call. */
  id: string;
  /** The `PROD-N` key — the row link, the Restore `aria-label`, the React key. */
  identifier: string;
  title: string;
  /** Drives the type-hued `IssueTypeIcon`. */
  kind: WorkItemKindDto;
  /** Human status label (workflow label, or the raw key as a fallback). */
  statusLabel: string;
  /**
   * The status's lifecycle category → the Pill tone. `null` when the project's
   * bundled workflow can't classify the key (defensive → neutral Pill showing
   * the raw key), mirroring the active List.
   */
  statusCategory: StatusCategoryDto | null;
  /** Who archived it (latest `'archived'` revision), or null if unresolved. */
  archivedByName: string | null;
  /** Pre-formatted archived date ("Jun 15, 2026"), the list's sort key. */
  archivedAtLabel: string;
}

/**
 * Shape an archived page's items into `ArchivedRowData[]`, preserving the
 * read's order (the DB ordered by `archivedAt DESC` — no JS re-sorting).
 * `workflow` classifies each item's status key; the archived-by actor + stamp
 * are already resolved on the DTO. The status lookup is built once (O(n)).
 */
export function toArchivedRows(
  items: ArchivedWorkItemDto[],
  workflow: WorkflowDto,
  locale: Locale = defaultLocale,
): ArchivedRowData[] {
  const statusByKey = new Map<string, WorkflowStatusDto>(workflow.statuses.map((s) => [s.key, s]));
  return items.map((item) => {
    const status = statusByKey.get(item.status);
    return {
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      kind: item.kind,
      statusLabel: status?.label ?? item.status,
      statusCategory: status?.category ?? null,
      archivedByName: item.archivedBy?.name ?? null,
      archivedAtLabel: formatDate(item.archivedAt, locale),
    };
  });
}
