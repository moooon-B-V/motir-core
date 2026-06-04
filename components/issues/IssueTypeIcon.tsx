import type { ComponentProps } from 'react';
import type { IssueType } from '@/lib/issues/parentRules';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { cn } from '@/lib/utils/cn';

// The single place the work-item kind → colour mapping is applied: renders an
// issue type's lucide icon in its own hue via the `--el-type-*` element tokens
// (finding #54). Use everywhere a type icon appears — detail header, parent
// breadcrumb, child list, type/parent pickers, the edit form — so the palette's
// type colours show consistently instead of collapsing to grey. Decorative
// (`aria-hidden`); callers render the type label / identifier alongside for the
// accessible name. Extra lucide props (e.g. `strokeWidth`) pass through.

const TYPE_ICON_COLOR: Record<IssueType, string> = {
  epic: 'text-(--el-type-epic)',
  story: 'text-(--el-type-story)',
  task: 'text-(--el-type-task)',
  bug: 'text-(--el-type-bug)',
  subtask: 'text-(--el-type-subtask)',
};

export interface IssueTypeIconProps extends Omit<ComponentProps<'svg'>, 'ref'> {
  type: IssueType;
}

export function IssueTypeIcon({ type, className, ...rest }: IssueTypeIconProps) {
  const Icon = ISSUE_TYPE_META[type].icon;
  return <Icon className={cn(TYPE_ICON_COLOR[type], className)} aria-hidden {...rest} />;
}
