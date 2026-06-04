import { ArrowDown, ArrowUp, Minus, type LucideIcon } from 'lucide-react';
import type { PillProps } from '@/components/ui/Pill';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

// The single source of truth for the priority CHIP presentation — the `Pill`
// tone + the direction icon per priority. Sibling of `lib/issues/priority.ts`
// (which owns the labels + order); kept here because it references the Pill +
// lucide. Both the detail page's core-fields panel (2.4.2) and the issue-list
// row (2.5.3) read this so the same priority renders identically in both. AA-safe
// (finding #35) — the colour lives in the Pill's tint, icon is a redundant cue.
export const PRIORITY_META: Record<
  WorkItemPriorityDto,
  { pill: Partial<PillProps>; icon: LucideIcon }
> = {
  highest: { pill: { severity: 'danger' }, icon: ArrowUp },
  high: { pill: { severity: 'warning' }, icon: ArrowUp },
  medium: { pill: { tone: 'neutral' }, icon: Minus },
  low: { pill: { severity: 'info' }, icon: ArrowDown },
  lowest: { pill: { tone: 'neutral' }, icon: ArrowDown },
};
