// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  compileGlobals,
  resolveDeclarations,
  type UtilityCompiler,
} from '../helpers/tailwindCascade';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import {
  GhostAnchor,
  LevelGroupNode,
  WorkItemNode,
  type WorkItemNodeData,
} from '@/components/planning/WorkItemNode';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// MOTIR-5459 — canvas card titles CLAMP. Plan and roadmap nodes have a fixed
// height designed around a two-line title (one line for the ghost anchor's
// lines), and the clamp is what keeps a long title inside it.
//
// ⚠️ ASSERTED ON WHAT THE CLASS LIST RESOLVES TO, NEVER ON THE CLASS BEING PRESENT.
// Every one of these elements carried `line-clamp-*` while the clamp did nothing:
// each also carried `block`, which Tailwind emits AFTER `line-clamp-*`, so it took
// `display` back from `-webkit-box` and `-webkit-line-clamp` went inert. A
// `className` containing `line-clamp-1` — which `WorkItemNode.test.tsx` asserts —
// was true of the broken element. happy-dom applies no stylesheet, so the
// resolution is folded from the real compiled `app/globals.css`
// (`tests/helpers/tailwindCascade.ts`). The tree-wide half of this is
// `tests/theme/lineClampDisplayOverride.test.ts`.

afterEach(cleanup);

let compiler: UtilityCompiler;
beforeAll(async () => {
  compiler = await compileGlobals();
});

/** The `display` and line clamp an element's own utilities resolve to. */
function clampOf(el: Element | null) {
  expect(el, 'the clamped element rendered').not.toBeNull();
  const tokens = (el!.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const resolved = resolveDeclarations(compiler.build(tokens), tokens);
  return { display: resolved.get('display'), lines: resolved.get('-webkit-line-clamp') };
}

const LONG_TITLE = Array.from(
  { length: 4 },
  () => 'A long, descriptive work item title that keeps going past its line budget',
).join(' ');

function planItem(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: null,
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    parentTrail: [],
    blockedByNodeIds: [],
    blockedByRemovedNodeIds: [],
    committedBlockedBy: [],
    blockerStubs: [],
    identifier: null,
    title: 'A proposed item',
    kind: 'task',
    priority: null,
    type: null,
    descriptionMd: null,
    explanationMd: null,
    explanationSource: null,
    storyPoints: null,
    estimateMinutes: null,
    targetRepo: null,
    targetRepos: [],
    targetRepositories: null,
    targetRepositoryRef: null,
    targetRepoRole: null,
    executor: null,
    planningProvenance: null,
    subject: null,
    status: null,
    statusLabel: null,
    statusCategory: null,
    hasChildren: false,
    changes: [],
    stale: false,
    staleReasons: [],
    revised: false,
    targetMissing: false,
    todos: null,
    proposal: {
      op: 'add',
      identifier: null,
      changedFields: [],
      settableRailFields: [],
      todos: null,
    },
    ...over,
  };
}

const workItem: WorkItemNodeData = {
  id: 'T1',
  identifier: 'MOTIR-1194',
  title: LONG_TITLE,
  kind: 'subtask',
  status: 'in_progress',
  assigneeName: 'Yue',
};

describe('PlanItemNode — the title clamps at two lines', () => {
  it.each(['add', 'remove'] as const)('a long `%s` title is a two-line -webkit-box', (op) => {
    renderWithIntl(<PlanItemNode item={planItem({ op, title: LONG_TITLE })} />);
    expect(clampOf(screen.getByText(LONG_TITLE))).toEqual({ display: '-webkit-box', lines: '2' });
  });
});

describe('WorkItemNode — the title clamps at two lines', () => {
  it('a long title is a two-line -webkit-box', () => {
    const { container } = renderWithIntl(<WorkItemNode item={workItem} />);
    expect(clampOf(container.querySelector('[data-node-title]'))).toEqual({
      display: '-webkit-box',
      lines: '2',
    });
  });

  it('the level group node’s title is a two-line -webkit-box', () => {
    const { container } = renderWithIntl(<LevelGroupNode count={7} />);
    expect(clampOf(container.querySelector('[data-node-title]'))).toEqual({
      display: '-webkit-box',
      lines: '2',
    });
  });
});

describe('GhostAnchor — every text line clamps at one line', () => {
  it.each([
    ['in a parent', { parentTitle: LONG_TITLE }],
    ['out of sprint', { outOfSprint: true }],
    ['elsewhere', {}],
  ] as const)('%s: the title and the where-line are one-line -webkit-boxes', (_label, props) => {
    const { container } = renderWithIntl(
      <GhostAnchor identifier="PROD-42" title={LONG_TITLE} {...props} />,
    );
    const clamped = [...container.querySelectorAll('[class*="line-clamp-"]')];
    expect(clamped).toHaveLength(2);
    for (const el of clamped) expect(clampOf(el)).toEqual({ display: '-webkit-box', lines: '1' });
  });
});
