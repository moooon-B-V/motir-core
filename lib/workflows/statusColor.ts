import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// The swap-layer colour for a workflow status dot/glyph (MOTIR-1273 · 1266.2).
//
// Single source of truth for the status-dot hue, replacing the four duplicated
// inline `STATUS_CATEGORY_EL` maps (StatusPicker, IssueFilterBar,
// AdvancedFilterValueEditor, AutomationParts) that mapped only by lifecycle
// CATEGORY — so `in_review` was indistinguishable from `in_progress`, and
// `blocked` / `cancelled` inherited the wrong category hue.
//
// Resolution order:
//   1. a per-status hex `color` override (custom workflow status) wins verbatim;
//   2. else the default-workflow status KEY → its dedicated `--el-status-*` token
//      (un-collapses in_review / blocked / cancelled);
//   3. else the lifecycle CATEGORY → the matching `--el-status-*` token (a custom
//      status with a non-default key still gets its category's hue);
//   4. else `--el-status-todo` (the neutral fallback).
//
// Returns a CSS value ready for `style={{ backgroundColor }}`/`color`: either the
// raw hex override or a `var(--el-status-*)` reference (full strength — the dot
// uses the hue at full strength per design/design-system/design-notes.md §A).

const STATUS_KEY_EL: Record<string, string> = {
  todo: '--el-status-todo',
  blocked: '--el-status-blocked',
  in_progress: '--el-status-in-progress',
  in_review: '--el-status-in-review',
  done: '--el-status-done',
  cancelled: '--el-status-cancelled',
};

const STATUS_CATEGORY_EL: Record<string, string> = {
  todo: '--el-status-todo',
  in_progress: '--el-status-in-progress',
  done: '--el-status-done',
};

/** The `--el-status-*` CSS variable NAME for a status (no `var()` wrapper). */
export function statusElVar(status: Pick<WorkflowStatusDto, 'key' | 'category'>): string {
  return STATUS_KEY_EL[status.key] ?? STATUS_CATEGORY_EL[status.category] ?? '--el-status-todo';
}

/** The resolved dot/glyph colour for a status — a hex override or a `var(--el-status-*)`. */
export function statusDotColor(
  status: Pick<WorkflowStatusDto, 'key' | 'category' | 'color'>,
): string {
  return status.color ?? `var(${statusElVar(status)})`;
}
