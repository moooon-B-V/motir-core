import type { ComponentType } from 'react';
import { CircleCheck, CircleEllipsis, CircleX } from 'lucide-react';
import type { PillProps } from '@/components/ui/Pill';
import type { PrCiState } from '@/lib/github/prCiState';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

// THE ONE CI VOCABULARY (Story MOTIR-5469 · MOTIR-5474).
//
// `CI_STATE_META` lived inside `DevelopmentSection.tsx` while the Development
// block was the only surface that rendered a CI verdict. The board card, the
// `/items` List and Tree rows and the Workbench row now render the same fact, so
// the map moved HERE and every surface imports it. A second map would be a second
// vocabulary for one verdict — the thing `design/work-items/design-notes.md`
// § *The CI badge (MOTIR-5471)* is most explicit about not wanting.
//
// The strings are NOT here: they stay in `messages/*.json` under
// `github.development.ciState.*`, which the badge and the Development pill both
// read, so the copy has one home too.

type PillTone = Pick<PillProps, 'status' | 'severity'>;

/** Glyph + tone per CI verdict — the shipped pairing, unchanged by the move. */
export const CI_STATE_META: Record<
  NonNullable<PrCiState>,
  { icon: ComponentType<{ className?: string }>; pill: PillTone }
> = {
  passing: { icon: CircleCheck, pill: { severity: 'success' } },
  failing: { icon: CircleX, pill: { severity: 'danger' } },
  running: { icon: CircleEllipsis, pill: { severity: 'warning' } },
};

/** What a card-level surface should DRAW — `null` meaning "draw nothing". */
export type CiBadgeState = 'failing' | 'running' | null;

/**
 * WHAT TO DRAW for a work item's stored `ciState`, given its status CATEGORY
 * (design `design/boards/design-notes.md` § *The CI badge (MOTIR-5471)*).
 *
 * TWO rules, and each is a decision rather than a convenience:
 *
 * 1. **`passing` draws nothing.** Green CI is what moves a card to In Review, so
 *    a green badge would restate the column it is sitting in. MOTIR-5470 makes
 *    that exact rather than approximate: the stored column reads `passing`
 *    precisely when the promotion would promote.
 * 2. **A `done`-CATEGORY item draws nothing, whatever its column says.** A done
 *    item's old red is not actionable. The rule is keyed on the CATEGORY and not
 *    on the column, because a board maps statuses to columns many-to-one — and
 *    it is what lets the Workbench's *Recently finished* tab need no special
 *    case at all (`design/workbench/design-notes.md` § *The CI badge*).
 *
 * `null` in ⇒ `null` out: absence of CI is not a state, on every surface.
 *
 * Pure, and shared by the board card, the list/tree row and the Workbench row,
 * so the three cannot drift into three readings of one column.
 */
export function ciBadgeState(
  ciState: string | null | undefined,
  statusCategory: StatusCategoryDto | null | undefined,
): CiBadgeState {
  if (statusCategory === 'done') return null;
  if (ciState === 'failing' || ciState === 'running') return ciState;
  return null;
}
