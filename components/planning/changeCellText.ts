import type { WorkItemDifficultyDto, WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { isWorkItemDifficulty } from '@/lib/issues/difficulty';
import { OBSOLESCENCE_CURRENT } from '@/lib/dto/planReview';
import { firstLine } from '@/lib/workItems/obsolescenceNote';

const OBSOLESCENCE_MARKS: readonly string[] = ['outdated', 'deprecated'];

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
 * The OBSOLESCENCE mark (Story MOTIR-6577 · MOTIR-6632, Part XXIV §24.3) is the
 * same shape: `outdated` / `deprecated` render as the item page's labels
 * (`labels.obsolescence.*`), and the wire word `current` — "no mark", which IS a
 * value on this row — as `current` (`planReview.obsolescenceCurrent`). The NOTE
 * renders its FIRST LINE (§24.6): the cell is one line, and the peek carries the
 * whole note.
 *
 * `tLabels` is `useTranslations('labels')`, passed in so this stays a plain
 * function both surfaces (the canvas's `DiffLine`, the list's `ChangeLines`) call.
 */
export function changeCellText(
  field: string,
  value: string | null,
  tLabels: (
    key: `difficulty.${WorkItemDifficultyDto}` | `obsolescence.${WorkItemObsolescenceDto}`,
  ) => string,
  current?: string,
): string | null {
  if (value == null) return null;
  if (field === 'difficulty' && isWorkItemDifficulty(value)) {
    return tLabels(`difficulty.${value}`);
  }
  if (field === 'obsolescence') {
    if (value === OBSOLESCENCE_CURRENT && current !== undefined) return current;
    if (OBSOLESCENCE_MARKS.includes(value)) {
      return tLabels(`obsolescence.${value as WorkItemObsolescenceDto}`);
    }
  }
  if (field === 'obsolescenceNote') return firstLine(value);
  return value;
}
