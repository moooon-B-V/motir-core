// Work-item TYPE presentation metadata (Story 2.7 · Subtask 2.7.4).
//
// The PRODUCT-FACING display layer for the ten-member `WorkItemType` enum —
// the per-TYPE analogue of `issueTypes.ts`'s per-KIND `ISSUE_TYPE_META`. The
// enum itself + the type→executor default map + the leaf-only rule are frozen
// in the 2.7.2 ADR (docs/decisions/work-item-type-taxonomy.md) and encoded in
// `lib/issues/executorDefaults.ts` (the single source for behaviour). This
// module adds ONLY presentation: the lucide glyph + the `--el-type-*` hue
// utility class each type renders with, per the 2.7.1 design
// (design/work-items/type-executor-picker.mock.html + design-notes.md panel 4).
//
// Two deliberate decisions, mirroring `issueTypes.ts`:
//
//  1. A typed in-code map keyed by `WorkItemTypeDto`, so a lookup is TOTAL and
//     type-checked — `WORK_ITEM_TYPE_META[type]` can never miss, and adding an
//     eleventh enum member is a compile error here until its metadata lands.
//  2. The hue is a STATIC, full utility-class string (`text-(--el-type-code)`),
//     never `text-(--el-type-${type})` — a constructed class name is invisible
//     to the Tailwind JIT scanner and would be stripped. Same pattern as
//     `IssueTypeIcon`'s `TYPE_ICON_COLOR`.
//
// `icon` is the lucide component reference (type-safe; renders as `<meta.icon />`),
// matching the `issueTypes.ts` convention. Colour flows through the Tier-3
// `--el-type-*` element tokens added to `app/globals.css` in 2.7.4 (the
// per-component token-growth pattern, notes.html #20) — NEVER a raw `--color-*`.

import {
  ClipboardCheck,
  Code,
  FileText,
  FlaskConical,
  Hand,
  Lightbulb,
  Pencil,
  Rocket,
  Scale,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';

export interface WorkItemTypeMeta {
  /** The type itself, so a meta object is self-describing when passed around. */
  type: WorkItemTypeDto;
  /** lucide-react component reference; render as `<meta.icon />`. */
  icon: LucideIcon;
  /**
   * The full `text-(--el-type-*)` utility class for this type's hue. A complete
   * literal (NOT interpolated) so the Tailwind JIT keeps it; consumed by
   * `WorkItemTypeIcon` for the glyph colour.
   */
  hueClass: string;
  /**
   * The bare `--el-type-*` custom-property name for this type. Consumed by
   * `WorkItemTypeChip` to build the `color-mix(...)` tint BACKGROUND (the chip
   * recipe — the hue lives in the tint, with `--el-text-strong` text, finding
   * #35). A property NAME, used inside an inline `color-mix()`, so it isn't a
   * Tailwind class and needn't be safelisted.
   */
  hueVar: string;
}

/**
 * The single source of truth for work-item-type presentation. Keyed by
 * `WorkItemTypeDto` (total + type-checked), in the canonical 2.7.2 enum order
 * (the "doing" types first, the meta/admin types last) so iterating it yields
 * the design's menu/legend order. Glyphs + hues are the 2.7.1 panel-4 map.
 */
export const WORK_ITEM_TYPE_META: Record<WorkItemTypeDto, WorkItemTypeMeta> = {
  code: { type: 'code', icon: Code, hueClass: 'text-(--el-type-code)', hueVar: '--el-type-code' },
  design: {
    type: 'design',
    icon: Pencil,
    hueClass: 'text-(--el-type-design)',
    hueVar: '--el-type-design',
  },
  test: {
    type: 'test',
    icon: FlaskConical,
    hueClass: 'text-(--el-type-test)',
    hueVar: '--el-type-test',
  },
  content: {
    type: 'content',
    icon: FileText,
    hueClass: 'text-(--el-type-content)',
    hueVar: '--el-type-content',
  },
  research: {
    type: 'research',
    icon: Lightbulb,
    hueClass: 'text-(--el-type-research)',
    hueVar: '--el-type-research',
  },
  review: {
    type: 'review',
    icon: ClipboardCheck,
    hueClass: 'text-(--el-type-review)',
    hueVar: '--el-type-review',
  },
  decision: {
    type: 'decision',
    icon: Scale,
    hueClass: 'text-(--el-type-decision)',
    hueVar: '--el-type-decision',
  },
  deploy: {
    type: 'deploy',
    icon: Rocket,
    hueClass: 'text-(--el-type-deploy)',
    hueVar: '--el-type-deploy',
  },
  manual: {
    type: 'manual',
    icon: Hand,
    hueClass: 'text-(--el-type-manual)',
    hueVar: '--el-type-manual',
  },
  chore: {
    type: 'chore',
    icon: Wrench,
    hueClass: 'text-(--el-type-chore)',
    hueVar: '--el-type-chore',
  },
};

/**
 * The chip tint BACKGROUND for a type — a `color-mix` of the type's saturated
 * hue into the page background, so one `--el-type-*` token yields both the
 * glyph hue and the chip tint (no separate `--el-tint-*` pairs). The two grey
 * meta-types (`manual`, `chore`, `decision` reads near-neutral too) use a
 * slightly higher mix so the near-neutral tint still reads (design panel 4).
 * Returns a CSS value for an inline `backgroundColor` style — it references
 * only `--el-*` tokens, so it stays on the colour swap layer.
 */
export function workItemTypeChipBackground(type: WorkItemTypeDto): string {
  const pct = type === 'manual' || type === 'chore' || type === 'decision' ? 18 : 14;
  return `color-mix(in srgb, var(${WORK_ITEM_TYPE_META[type].hueVar}) ${pct}%, var(--el-page-bg))`;
}
