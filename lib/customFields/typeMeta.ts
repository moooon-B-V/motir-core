import type { CustomFieldType } from '@prisma/client';
import { Calendar, CircleUserRound, Hash, SquareChevronDown, Type } from 'lucide-react';

// Custom-field type presentation metadata (Story 5.3) — the per-type glyph +
// tint map from design/projects/design-notes.md ("The per-type glyph map"),
// SHARED between the Fields admin page (5.3.6) and the detail-rail value
// cards (5.3.7) so the two surfaces stay in sync. Mirrors the
// ISSUE_TYPE_META convention (lib/issues/issueTypes.ts): a typed in-code map,
// TOTAL over the CustomFieldType enum, with lucide component references (a
// typo is a compile error). The hue lives in the tile BACKGROUND with
// --el-text-strong glyphs (AA-safe, finding #35; palette beyond grey+primary,
// finding #54). Display labels/descriptions are i18n strings
// (settings.customFields.type.* / typeDesc.*), not literals here.

export interface CustomFieldTypeMeta {
  /** Lucide icon component for the type glyph. */
  icon: typeof Type;
  /** Tailwind class putting the type's pastel hue in the tile background. */
  tintClass: string;
}

export const CUSTOM_FIELD_TYPE_META: Record<CustomFieldType, CustomFieldTypeMeta> = {
  text: { icon: Type, tintClass: 'bg-(--el-tint-sky)' },
  number: { icon: Hash, tintClass: 'bg-(--el-tint-peach)' },
  date: { icon: Calendar, tintClass: 'bg-(--el-tint-mint)' },
  select: { icon: SquareChevronDown, tintClass: 'bg-(--el-tint-lavender)' },
  user: { icon: CircleUserRound, tintClass: 'bg-(--el-tint-rose)' },
};

/** The five types in the create-modal picker order (the 5.3.4 mockup's). */
export const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  'text',
  'number',
  'date',
  'select',
  'user',
];
