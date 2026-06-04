// The single source of truth for work-item priority presentation. The priority
// ENUM lives in the schema (Story 1.4) and its wire type is `WorkItemPriorityDto`;
// this module owns the human LABELS and the canonical display ORDER (highest →
// lowest) so the create modal (2.3.3), the edit form (2.3.6), and the detail
// fields panel (2.4.2) all read one list instead of re-declaring it three times.

import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

/** Human-facing label per priority value. Total over the enum (type-checked). */
export const PRIORITY_LABELS: Record<WorkItemPriorityDto, string> = {
  highest: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
};

/**
 * Priority options in canonical display order (highest first) — the shape the
 * `<select>` / picker UIs render directly.
 */
export const PRIORITY_OPTIONS: ReadonlyArray<{ value: WorkItemPriorityDto; label: string }> = [
  { value: 'highest', label: PRIORITY_LABELS.highest },
  { value: 'high', label: PRIORITY_LABELS.high },
  { value: 'medium', label: PRIORITY_LABELS.medium },
  { value: 'low', label: PRIORITY_LABELS.low },
  { value: 'lowest', label: PRIORITY_LABELS.lowest },
];
