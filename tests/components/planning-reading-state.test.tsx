// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  PlanningReadingState,
  substrateHasSomethingToName,
} from '@/components/planning/PlanningReadingState';
import {
  ONBOARDING_SUBSTRATE_ITEM_CAP,
  type OnboardingSubstrate,
} from '@/lib/dto/onboardingSubstrate';

// THE READING STATE (Story MOTIR-4753 · MOTIR-4768) — what the plan window says
// while a session decides whether this project can be planned at all.
//
// ⚠️ WHAT IS ACTUALLY BEING GUARDED HERE IS THE COPY, and that is not a soft
// property. The card's whole argument is that a surface saying *reading
// acme/widgets and 214 work items* has demonstrated, in one sentence, the thing
// the story is for — while a spinner has demonstrated nothing. So the assertions
// are about which words reach the screen, in which of the two substrates, and
// about the two ways this surface could lie: by drawing a progress bar it cannot
// honour, and by reporting a capped count as an exact one.

const substrate = (over: Partial<OnboardingSubstrate> = {}): OnboardingSubstrate => ({
  itemCount: 0,
  itemCountTruncated: false,
  repositories: [],
  repositoryConnected: false,
  repositoryIndexed: false,
  ...over,
});

const RICH = substrate({
  itemCount: 214,
  repositories: [
    { ref: 'acme/widgets', indexed: true },
    { ref: 'acme/widgets-api', indexed: true },
  ],
  repositoryConnected: true,
  repositoryIndexed: true,
});

afterEach(cleanup);

describe('AC1 · it NAMES what it is reading', () => {
  it('names every connected repository and the committed work-item count', () => {
    render(<PlanningReadingState substrate={RICH} />);
    expect(screen.getByText('acme/widgets')).toBeTruthy();
    expect(screen.getByText('acme/widgets-api')).toBeTruthy();
    expect(screen.getByText('214 work items')).toBeTruthy();
    // The heading commits to the act, not to a duration.
    expect(screen.getByRole('heading', { name: 'Reading your project' })).toBeTruthy();
  });

  it('a CONNECTED but unindexed repository is still named, with a different sub-line', () => {
    // It is a thing Motir is reading, not a thing it is missing — so the row is
    // drawn either way and only the sub-line moves.
    render(
      <PlanningReadingState
        substrate={substrate({
          repositories: [{ ref: 'acme/widgets', indexed: false }],
          repositoryConnected: true,
        })}
      />,
    );
    expect(screen.getByText('acme/widgets')).toBeTruthy();
    expect(screen.getByText('Building the code graph')).toBeTruthy();
    expect(screen.queryByText('Code graph ready')).toBeNull();
  });

  it('a repository with NO work items yet draws the repository row and no item row', () => {
    // The row this story is for: a project with an indexed repository and an
    // empty backlog is not a thin project, and it must not read as one.
    render(
      <PlanningReadingState
        substrate={substrate({
          repositories: [{ ref: 'acme/widgets', indexed: true }],
          repositoryConnected: true,
          repositoryIndexed: true,
        })}
      />,
    );
    expect(screen.getByText('acme/widgets')).toBeTruthy();
    expect(screen.queryByText(/work items/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Reading your project' })).toBeTruthy();
  });
});

describe('AC2 · the THIN substrate is a SENTENCE, never an empty list', () => {
  it('says what is here, and says it is normal', () => {
    render(<PlanningReadingState substrate={substrate()} />);
    // A different heading, because there is nothing to read.
    expect(screen.getByRole('heading', { name: 'Having a look at your project' })).toBeTruthy();
    expect(screen.getByText(/no repository connected here yet, and no work items/i)).toBeTruthy();
    // …and the clause a list cannot carry.
    expect(screen.getByText(/normal for a new project/i)).toBeTruthy();
  });

  it('renders NO list at all — not an empty one, and not rows saying "none"', () => {
    // Three rows with `none` beside each is a report card, handed to a user in
    // the seconds before they are moved somewhere — which turns the move into a
    // verdict on them.
    const { container } = render(<PlanningReadingState substrate={substrate()} />);
    expect(container.querySelector('ul')).toBeNull();
    expect(container.querySelector('li')).toBeNull();
    expect(screen.queryByText('Reading')).toBeNull();
  });

  it('`substrateHasSomethingToName` is the branch, and it is two PRESENCE checks', () => {
    // Not a threshold in disguise: whether the substrate is ENOUGH is the
    // planner's judgement one repository over (MOTIR-4767). This only asks
    // whether there is anything to put on screen.
    expect(substrateHasSomethingToName(substrate())).toBe(false);
    expect(substrateHasSomethingToName(substrate({ itemCount: 1 }))).toBe(true);
    expect(
      substrateHasSomethingToName(substrate({ repositories: [{ ref: 'a/b', indexed: false }] })),
    ).toBe(true);
  });
});

describe('AC7 · the CAP is drawn honestly, in BOTH directions at the boundary', () => {
  it('at the cap with truncation reads `200+`, never an exact `200`', () => {
    render(
      <PlanningReadingState
        substrate={substrate({
          itemCount: ONBOARDING_SUBSTRATE_ITEM_CAP,
          itemCountTruncated: true,
        })}
      />,
    );
    expect(screen.getByText('200+ work items')).toBeTruthy();
    expect(screen.queryByText('200 work items')).toBeNull();
    // …and the sub-line says WHY, so the `+` is not a decoration.
    expect(screen.getByText('Reading the most recent 200')).toBeTruthy();
  });

  it('at exactly the cap with NO truncation reads the exact count', () => {
    // The other direction, and it is the half that makes the first meaningful: a
    // project with exactly two hundred items has two hundred, and saying `200+`
    // there would be its own small lie.
    render(
      <PlanningReadingState
        substrate={substrate({
          itemCount: ONBOARDING_SUBSTRATE_ITEM_CAP,
          itemCountTruncated: false,
        })}
      />,
    );
    expect(screen.getByText('200 work items')).toBeTruthy();
    expect(screen.queryByText('200+ work items')).toBeNull();
    expect(screen.getByText('Everything in your backlog')).toBeTruthy();
  });
});

describe('it is a STATEMENT OF ACTIVITY, not a progress bar', () => {
  it('renders no progressbar, no meter and no percentage', () => {
    // The constraint is the card's own: nothing on this path knows a duration.
    // A bar has a track, a fill and therefore a claim about how far along it is,
    // and it would have to keep that claim while a model call sits in the middle
    // of it.
    const { container } = render(<PlanningReadingState substrate={RICH} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container.querySelector('progress')).toBeNull();
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\s?%/);
  });

  it('announces POLITELY — what changes here is a statement', () => {
    const { container } = render(<PlanningReadingState substrate={RICH} />);
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it('promises only what is true', () => {
    render(<PlanningReadingState substrate={RICH} />);
    expect(screen.getByText('This usually takes a few seconds.')).toBeTruthy();
  });
});

describe('AC3 · it composes the design’s tokens, and invents no colour or shape', () => {
  // The tree-wide ink and shape guards already sweep `components/**`; this is the
  // narrower claim they cannot make, because they rule on what IS there rather
  // than on what a single new file may not contain.
  const source = readFileSync(
    join(process.cwd(), 'components/planning/PlanningReadingState.tsx'),
    'utf8',
  );
  /**
   * COMMENTS STRIPPED — the file DISCUSSES the traps at length (that
   * `--el-text-muted` fails AA on `--el-surface-soft` is the reason the row's
   * sub-line reads as it does), and the property is about what RENDERS.
   */
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('no raw hex, no rgb/hsl literal', () => {
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(rgb|hsl)a?\(/);
  });

  it('no Tier-0 `--color-*` and none of its generated utilities', () => {
    expect(src).not.toMatch(/--color-/);
    expect(src).not.toMatch(
      /\b(text-foreground|bg-surface|text-muted-foreground|border-border|bg-primary)\b/,
    );
  });

  it('no raw radius / padding / height on a surface’s own box', () => {
    // `(?<![-\w])` so the token NAMES themselves — `--radius-card`,
    // `--shadow-subtle` — are not read as raw utilities.
    expect(src).not.toMatch(/(?<![-\w])rounded-(?!\()/);
    expect(src).not.toMatch(/(?<![-\w])shadow-(?!\()/);
    // `p-`/`px-`/`py-` must all point at a shape token.
    for (const m of src.match(/\bp[xy]?-[^\s'"]+/g) ?? []) {
      expect(m, `raw padding: ${m}`).toMatch(/^p[xy]?-\(--spacing-/);
    }
  });

  it('the muted-ink trap is avoided on the tinted row', () => {
    // `--el-text-muted` is 4.34:1 on `--el-surface-soft` and fails AA; the row's
    // sub-line sits on exactly that surface.
    expect(src).not.toMatch(/--el-text-muted/);
    expect(src).not.toMatch(/--el-text-faint/);
  });
});
