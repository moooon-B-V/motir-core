// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { contrast } from '../theme/colorMetrics';
import {
  AA,
  MUTED_INK,
  findInkContrastFailures,
  formatRenderedFinding,
  ratio,
  surfacesUnderAA,
} from '../helpers/renderedInkContrast';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { QuickViewData } from '@/app/(authed)/items/_components/IssueQuickViewPanel';

// MOTIR-4196 — the ink guard for the quick view's RAIL, at the tier the static
// one cannot reach.
//
// ── Why this exists beside `tests/theme/inkContrastLint.test.ts` ────────────
// That guard's muted arm walks the source tree and resolves each ink's surface
// from the module it is written in. It says so in its own header: an element
// whose background is painted by a `<Card>`, a `<Popover.Content>` or a layout
// in ANOTHER module reads as "no surface found here" and the rule ABSTAINS — it
// does not rule the site safe, it declines to rule at all, because resolving
// that needs the import graph.
//
// `QuickViewRail` (`components/workItems/QuickViewSurface.tsx`) paints
// `bg-(--el-surface-soft)`, and the components it MOUNTS — `RepositorySetField`,
// `issueCellPrimitives`, `ParentPicker`, the panel's own custom-field rows —
// paint no background of their own. Every one of them is in the abstention. So
// the lane was green with the rail's empty values at 4.34:1, under AA.
//
// A RENDER resolves what a static walk cannot: the composed DOM already carries
// the answer the import graph would have to reconstruct. That is the whole
// reason this guard is component-level rather than a widening of the other one —
// MOTIR-4196's fix direction #3 says the abstention is documented and deliberate
// and is NOT this card's to widen.
//
// ── The measurement it enforces (MOTIR-2455's table, both themes) ───────────
//   LIGHT (the binding theme)              DARK
//   --el-text-muted     #787671            --el-text-muted     #a4a097
//   --el-text-secondary #5d5b54            --el-text-secondary #a4a097
//
//   ink        on --el-page-bg/--el-card   --el-surface  --el-surface-soft  --el-muted
//   muted      4.54 PASS (by 0.04)         4.17 FAIL     4.34 FAIL          4.12 FAIL
//   secondary  6.80 PASS                   6.24 PASS     6.51 PASS          6.18 PASS
//
// In DARK both tokens resolve to the SAME hex (`--color-slate` and
// `--color-muted-foreground` are both `#a4a097`), so every pairing is 6.67–7.35
// and the change is a no-op there. Light is the theme that decides.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(''),
}));

vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';

afterEach(() => {
  push.mockReset();
  cleanup();
});

// ⚠️ MOTIR-4251 — THE RESOLVER THAT USED TO LIVE HERE IS NOW SHARED.
//
// This file was the prototype: it carried its own `surfaceUnder` ancestor walk,
// its own `carriesText` exemption test, and a hand-written table of five
// resolved hexes. All three now live in `tests/helpers/renderedInkContrast.ts`,
// which four surfaces consume — and the surface set is resolved out of
// `theme.css` rather than transcribed, so an ALIAS of a failing colour
// (MOTIR-3693's `--el-sidebar-bg`) cannot hide in a list somebody typed.
//
// The assertions below are UNCHANGED in substance. What changed is that the
// shared resolver is wider than the transcription was: it measures every
// `--el-*` background the token layer declares, not the five this file knew
// about, so a rail row moved onto `--el-tint-lavender` is now ruled on too.

/**
 * The resolved Tier-0 values MOTIR-4196 measured, kept as LITERALS on purpose.
 *
 * Everything else reads the token layer; this table does not, so it is the arm
 * that fails when a palette edit moves one of these hexes. Reading the values
 * from `theme.css` on both sides of the comparison would make the first test
 * below assert `x === x` and pass through any change at all.
 */
const INK = { muted: '#787671', secondary: '#5d5b54' } as const;
const SURFACE = {
  '--el-page-bg': '#ffffff',
  '--el-card': '#ffffff',
  '--el-surface': '#f6f5f4',
  '--el-surface-soft': '#fafaf9',
  '--el-muted': '#f3f4f6',
} as const;

const classesOf = (el: Element) => el.getAttribute('class') ?? '';

/** The rail itself: the one element painting `--el-surface-soft` in the peek. */
function railOf(container: HTMLElement): HTMLElement {
  const rail = Array.from(container.querySelectorAll('dl')).find((el) =>
    classesOf(el).includes('bg-(--el-surface-soft)'),
  );
  if (!rail) throw new Error('QuickViewRail not found — it should paint bg-(--el-surface-soft)');
  return rail as HTMLElement;
}

/**
 * One unset custom field per supported type. `value: null` is what the panel's
 * own empty value is reached for, and it is also what puts the row behind the
 * `N more fields` disclosure — so the tests below OPEN that disclosure rather
 * than faking a valued-but-empty payload the server never sends.
 */
const UNSET_CUSTOM_FIELDS: CustomFieldWithValueDto[] = (
  ['text', 'number', 'date', 'select', 'user'] as const
).map((fieldType, i) => ({
  id: `cf${i + 1}`,
  key: `cf_${fieldType}`,
  label: fieldType.toUpperCase(),
  fieldType,
  description: null,
  options: [],
  value: null,
}));

/** Reveal the unset custom-field rows — they ship collapsed. */
function openMoreFields(): void {
  fireEvent.click(screen.getByRole('button', { name: /more field/i }));
}

// An EMPTY peek: every rail row that has an empty state is IN one, which is the
// population `--el-text-muted` was reached for. `repoDelivery: []` renders
// `RepositorySetField`'s `None`; the unset custom fields render the panel's own
// empty value once per supported field type.
const EMPTY: QuickViewData = {
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  descriptionMd: 'Sign in with email and password.',
  // MOTIR-4183 — the peek payload carries the WHY, so proposal mode can render
  // it inline. `/items` still defers it to the full page.
  explanationMd: null,
  type: null,
  executor: null,
  assigneeName: null,
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: UNSET_CUSTOM_FIELDS,
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  parent: null,
  readiness: null,
  archived: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  id: 'cmqvitem00000000000000p7',
  status: 'todo',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: true,
  },
};

describe('MOTIR-4196 · the quick view rail resolves its own ink', () => {
  it('the measured table the rule is built on — muted fails on every tint, secondary passes on all four', () => {
    // Ratios first, so a token whose Tier-0 value moves fails HERE, naming the
    // number, rather than silently relaxing the rule below. These are LITERALS
    // on both sides deliberately (see the note above the table).
    expect(contrast(INK.muted, SURFACE['--el-surface-soft'])).toBeCloseTo(4.34, 2);
    expect(contrast(INK.secondary, SURFACE['--el-surface-soft'])).toBeCloseTo(6.51, 2);
    // And the same measurement taken through the SHARED resolver, off
    // `theme.css` — the two agreeing is what says the helper models the token
    // layer the way this card measured it by hand (MOTIR-4251).
    expect(ratio('light', MUTED_INK, '--el-surface-soft')).toBeCloseTo(4.34, 2);
    // The rail's own surface is one of the surfaces the muted ink fails on.
    expect(surfacesUnderAA('light', MUTED_INK)).toContain('--el-surface-soft');
    // And the ink this card sends those sites to is legal on every surface,
    // which is why the fix does not have to know where the field lands.
    for (const token of Object.keys(SURFACE) as (keyof typeof SURFACE)[]) {
      expect(contrast(INK.secondary, SURFACE[token])).toBeGreaterThanOrEqual(AA);
    }
  });

  it('no EMPTY VALUE in the rendered rail carries --el-text-muted', () => {
    const { container } = render(<IssueQuickViewPanel state="ready" data={EMPTY} />);
    openMoreFields();
    const rail = railOf(container);

    // The rail really is in its empty state — otherwise this test passes by
    // rendering nothing worth ruling on. Two independent empty values are in
    // front of it: `RepositorySetField`'s and the panel's custom-field one.
    expect(rail.textContent).toContain('None');
    expect(rail.querySelectorAll('dt')).not.toHaveLength(0);

    // Unchanged in substance: every element in the rail carrying the muted ink,
    // minus the 1.4.3 exemptions. `railOf` above already threw if the rail did
    // not paint `--el-surface-soft`, so the sweep below has a tint to rule on —
    // what changed is that the tint is RESOLVED rather than assumed.
    expect(
      findInkContrastFailures(rail, { theme: 'light', inks: [MUTED_INK] }).map(
        formatRenderedFinding,
      ),
      'the rail paints --el-surface-soft, where --el-text-muted is 4.34:1 — under AA',
    ).toEqual([]);
  });

  it('no TEXT anywhere in the peek carries --el-text-muted over a tinted surface', () => {
    // The generalisation, and the reason this guard is worth more than two
    // assertions: it resolves each site's REAL surface from the composed DOM,
    // so a row moved into the rail by a later card is ruled on the day it moves.
    const { container } = render(<IssueQuickViewPanel state="ready" data={EMPTY} />);
    openMoreFields();

    expect(
      findInkContrastFailures(container, { theme: 'light', inks: [MUTED_INK] }).map(
        formatRenderedFinding,
      ),
      'muted ink over a tint is under AA',
    ).toEqual([]);
  });
});
