import type { OrgUsageDTO } from '@/lib/dto/aiUsage';

// Pure view-model for TRANSLATION SPEND on the usage dashboard (Story MOTIR-7735
// · MOTIR-8117) — `searchUsage.ts`'s twin, beside it and for the same reason:
// every drawn state is provable without mounting the page.
//
// It derives presentation only. Both figures come verbatim from
// `OrgUsageDTO.translation`, which `aiUsageService` carries across the 7.1
// boundary from motir-ai. The figure is ORG-LEVEL: it does not narrow when the
// reader drills to a workspace or project, and the card says so with the same
// scope tag the search total wears.

export type TranslationUsageVariant =
  /** Something was spent on translation, this month or ever. */
  | 'spend'
  /** Nothing spent on translation — the block was reported, and it is zero. */
  | 'none'
  /** The boundary reported no `translation` block (a rolling deploy). Never zero. */
  | 'unavailable';

export interface TranslationUsageFigures {
  variant: TranslationUsageVariant;
  /** Org-level, this month. `null` when unavailable. */
  monthSpend: number | null;
  /** Org-level, all time. `null` when unavailable. */
  totalSpend: number | null;
}

export function translationUsageFigures(data: OrgUsageDTO): TranslationUsageFigures {
  // ⚠️ Checked FIRST, with `== null` so an omitted key (`undefined` off the JSON
  // wire) reads the same as a reported absence — and neither falls into zero.
  if (data.translation == null) {
    return { variant: 'unavailable', monthSpend: null, totalSpend: null };
  }
  const { monthSpend, totalSpend } = data.translation;
  return {
    variant: monthSpend === 0 && totalSpend === 0 ? 'none' : 'spend',
    monthSpend,
    totalSpend,
  };
}
