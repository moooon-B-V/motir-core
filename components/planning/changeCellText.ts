import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import { isWorkItemDifficulty } from '@/lib/issues/difficulty';

/**
 * One SIDE of a `modify`'s change row, as the reader's word (story MOTIR-6095 ·
 * MOTIR-6137, `design/ai-planning/design-notes.md` Part XX §20.5).
 *
 * The producer (`planReviewService.buildChanges`) emits WIRE words, locale-free.
 * A DIFFICULTY cell is rendered as the item page's own LABEL
 * (`labels.difficulty.*`), so the reviewer reads `Low → High` — the same word
 * they find on the card after approving — in their own locale, never the wire's
 * `low → high`. Every other field's cell is returned unchanged. `null` stays
 * `null`: an empty FROM is not drawn and an empty TO reads `—`, the shipped rule
 * for every field.
 *
 * `tLabels` is `useTranslations('labels')`, passed in so this stays a plain
 * function both surfaces (the canvas's `DiffLine`, the list's `ChangeLines`) call.
 */
export function changeCellText(
  field: string,
  value: string | null,
  tLabels: (key: `difficulty.${WorkItemDifficultyDto}`) => string,
): string | null {
  if (value == null) return null;
  if (field === 'difficulty' && isWorkItemDifficulty(value)) {
    return tLabels(`difficulty.${value}`);
  }
  return value;
}
