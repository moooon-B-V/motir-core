import type { ComponentProps } from 'react';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';
import { WORK_ITEM_TYPE_META } from '@/lib/issues/workItemTypeMeta';
import { cn } from '@/lib/utils/cn';

// The single place the work-item TYPE → colour mapping is applied (Story 2.7 ·
// Subtask 2.7.4) — the per-TYPE analogue of `IssueTypeIcon` (per-KIND). Renders
// a type's lucide glyph in its own hue via the `--el-type-*` element tokens
// (finding #54), so the type picker, the detail chip, and any later type-icon
// surface show the palette's type colours consistently instead of collapsing to
// grey. Decorative (`aria-hidden`); callers render the type label alongside for
// the accessible name. Extra lucide props (e.g. `strokeWidth`) pass through.

export interface WorkItemTypeIconProps extends Omit<ComponentProps<'svg'>, 'ref' | 'type'> {
  type: WorkItemTypeDto;
}

export function WorkItemTypeIcon({ type, className, ...rest }: WorkItemTypeIconProps) {
  const meta = WORK_ITEM_TYPE_META[type];
  const Icon = meta.icon;
  return <Icon className={cn(meta.hueClass, className)} aria-hidden {...rest} />;
}
