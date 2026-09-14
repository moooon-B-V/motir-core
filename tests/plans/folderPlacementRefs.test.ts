import { describe, expect, it } from 'vitest';
import {
  assertFolderPlacementsLegal,
  assertProposalSetSelfConsistent,
  assertReparentLegal,
  collectReferencedFolderIds,
  collectReferencedWorkItemIds,
  validatePlanProposals,
  type LiveFolderState,
  type LiveWorkItemState,
  type ProposalNode,
} from '@/lib/plans/validateProposals';
import { PlanGrammarError, PlanRefGraphError } from '@/lib/plans/errors';
import {
  FOLDER_REF_PREFIX,
  folderRefId,
  folderRefsOf,
  isFolderRef,
  isWorkItemRef,
} from '@/lib/plans/refs';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';

// Story MOTIR-5310 · Subtask MOTIR-5414 — a plan proposal may NAME A FOLDER as
// the place a card hangs (`folder:<id>` in `parentRef`). These pin the PURE
// verdict; `tests/mcp/author-plan-folder-refs.test.ts` proves the doors refuse
// at the append on real Postgres.

const PLAN_PROJECT = 'proj_plan';
const OTHER_PROJECT = 'proj_other';
const FOLDER = 'fold_backlog';
const FOREIGN_FOLDER = 'fold_foreign';
const TARGET = 'wi_target';

const folderRef = (id: string) => `${FOLDER_REF_PREFIX}${id}`;

function folders(...rows: LiveFolderState[]): Map<string, LiveFolderState> {
  return new Map(rows.map((r) => [r.id, r]));
}

const DEFAULT_FOLDERS = folders(
  { id: FOLDER, projectId: PLAN_PROJECT, name: 'Backlog ideas' },
  { id: FOREIGN_FOLDER, projectId: OTHER_PROJECT, name: 'Elsewhere' },
);

function live(overrides: Partial<LiveWorkItemState> & { id: string }): LiveWorkItemState {
  return {
    kind: 'task',
    status: 'todo',
    projectId: PLAN_PROJECT,
    key: `MOTIR-${overrides.id}`,
    title: `The ${overrides.id} card`,
    ...overrides,
  };
}

function add(id: string, overrides: Partial<ProposalNode> = {}): ProposalNode {
  return {
    id,
    op: 'add',
    workItemId: null,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: { kind: 'task' },
    patch: null,
    ...overrides,
  };
}

function modify(id: string, patch: ProposalNode['patch']): ProposalNode {
  return {
    id,
    op: 'modify',
    workItemId: TARGET,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: null,
    patch,
  };
}

function validate(
  items: ProposalNode[],
  opts: {
    liveById?: Map<string, LiveWorkItemState>;
    folderById?: Map<string, LiveFolderState> | undefined;
    omitFolders?: boolean;
  } = {},
): void {
  validatePlanProposals({
    items,
    liveById: opts.liveById ?? new Map([[TARGET, live({ id: TARGET })]]),
    terminalStatusKeys: new Set(['done', 'cancelled']),
    planProjectId: PLAN_PROJECT,
    ancestorIdsById: new Map(),
    existingBlockedByEdges: [],
    ...(opts.omitFolders ? {} : { folderById: opts.folderById ?? DEFAULT_FOLDERS }),
  });
}

describe('refs — the `folder:` prefix', () => {
  it('parses a folder ref and tells it apart from a temp-ref and a work-item id', () => {
    expect(isFolderRef('folder:abc')).toBe(true);
    expect(folderRefId('folder:abc')).toBe('abc');
    expect(isFolderRef('planItem:abc')).toBe(false);
    expect(isWorkItemRef('cmabc123')).toBe(true);
    expect(isWorkItemRef('folder:abc')).toBe(false);
    expect(isWorkItemRef('planItem:abc')).toBe(false);
  });

  it('folderRefsOf returns only the two PARENT sites', () => {
    expect(
      folderRefsOf({
        label: 'p',
        parentRef: 'folder:a',
        blockedByRefs: ['folder:b'],
        patch: { parentRef: 'folder:c', blockedByAdd: ['folder:d'] },
      }),
    ).toEqual([
      { ref: 'folder:a', where: 'parentRef' },
      { ref: 'folder:c', where: 'patch.parentRef' },
    ]);
    expect(folderRefsOf({ label: 'p', parentRef: 'cmx', patch: null })).toEqual([]);
  });
});

describe('collectors — folder ids and work-item ids stay apart', () => {
  it('collects folder ids from both parent sites and never as a work-item id', () => {
    const items = [
      add('a1', { parentRef: folderRef(FOLDER) }),
      modify('m1', { parentRef: folderRef('fold_two') }),
      add('a2', { parentRef: 'wi_real' }),
    ];
    expect(collectReferencedFolderIds(items).sort()).toEqual([FOLDER, 'fold_two'].sort());
    expect(collectReferencedWorkItemIds(items).sort()).toEqual([TARGET, 'wi_real'].sort());
  });

  it("ignores a `remove`'s and an `add`'s patch, and a null parent", () => {
    expect(
      collectReferencedFolderIds([add('a1'), add('a2', { patch: { parentRef: 'folder:x' } })]),
    ).toEqual([]);
  });
});

describe('an `add` filed into a folder', () => {
  it('appends for EVERY kind — a folder admits `subtask` too', () => {
    for (const kind of ISSUE_TYPES) {
      expect(() =>
        validate([add('a1', { parentRef: folderRef(FOLDER), proposedFields: { kind } })]),
      ).not.toThrow();
    }
  });

  it('still refuses the same `subtask` at the project root', () => {
    expect(() => validate([add('a1', { proposedFields: { kind: 'subtask' } })])).toThrow(
      PlanGrammarError,
    );
  });

  it('a `planItem:` child of a filed `add` validates as under any other `add`', () => {
    const items = [
      add('story', { parentRef: folderRef(FOLDER), proposedFields: { kind: 'story' } }),
      add('sub', { parentRef: 'planItem:story', proposedFields: { kind: 'subtask' } }),
    ];
    expect(() => validate(items)).not.toThrow();
    // …and the matrix still binds that child: an epic may not hang under a story.
    const bad = [
      items[0]!,
      add('epic', { parentRef: 'planItem:story', proposedFields: { kind: 'epic' } }),
    ];
    expect(() => validate(bad)).toThrow(PlanGrammarError);
  });

  it('refuses an UNKNOWN folder, naming the ref', () => {
    const run = () => validate([add('a1', { parentRef: folderRef('fold_gone') })]);
    expect(run).toThrow(PlanRefGraphError);
    expect(run).toThrow(/folder:fold_gone.*names no folder/);
  });

  it('refuses every folder ref when the caller resolved no folders — the SAFE default', () => {
    expect(() =>
      validate([add('a1', { parentRef: folderRef(FOLDER) })], { omitFolders: true }),
    ).toThrow(/names no folder/);
  });

  it("refuses ANOTHER project's folder, naming it", () => {
    const run = () => validate([add('a1', { parentRef: folderRef(FOREIGN_FOLDER) })]);
    expect(run).toThrow(PlanGrammarError);
    expect(run).toThrow(/Elsewhere.*DIFFERENT project/);
  });
});

describe('a folder at a BLOCKER site is refused — a folder blocks nothing', () => {
  it.each([
    ['blockedByRefs', add('a1', { blockedByRefs: [folderRef(FOLDER)] })],
    ['patch.blockedByAdd', modify('m1', { blockedByAdd: [folderRef(FOLDER)] })],
    ['patch.blockedByRemove', modify('m1', { blockedByRemove: [folderRef(FOLDER)] })],
  ])('%s', (where, item) => {
    // The PURE pass — the one the append runs before a single read.
    const run = () => assertProposalSetSelfConsistent([item]);
    expect(run).toThrow(PlanRefGraphError);
    expect(run).toThrow(
      new RegExp(`${where.replace('.', '\\.')} "folder:${FOLDER}" names a folder`),
    );
    // …and the full gate agrees.
    expect(() => validate([item])).toThrow(PlanRefGraphError);
  });
});

describe('a `modify` that FILES a committed item into a folder', () => {
  it('appends — including a subtask target, which has no legal root placement', () => {
    expect(() => validate([modify('m1', { parentRef: folderRef(FOLDER) })])).not.toThrow();
    expect(() =>
      validate([modify('m1', { parentRef: folderRef(FOLDER) })], {
        liveById: new Map([[TARGET, live({ id: TARGET, kind: 'subtask' })]]),
      }),
    ).not.toThrow();
  });

  it('refuses an unknown folder and another project’s folder', () => {
    expect(() => validate([modify('m1', { parentRef: folderRef('fold_gone') })])).toThrow(
      PlanRefGraphError,
    );
    expect(() => validate([modify('m1', { parentRef: folderRef(FOREIGN_FOLDER) })])).toThrow(
      PlanGrammarError,
    );
  });

  it('assertReparentLegal alone — the append calls it directly', () => {
    const liveById = new Map([[TARGET, live({ id: TARGET })]]);
    const call = (ref: string, folderById?: Map<string, LiveFolderState>) =>
      assertReparentLegal(
        modify('m1', { parentRef: ref }),
        liveById,
        new Map(),
        new Set(['done']),
        PLAN_PROJECT,
        folderById,
      );
    expect(() => call(folderRef(FOLDER), DEFAULT_FOLDERS)).not.toThrow();
    // No folder map at all — the default — refuses rather than passes.
    expect(() => call(folderRef(FOLDER))).toThrow(PlanRefGraphError);
    expect(() => call(folderRef(FOREIGN_FOLDER), DEFAULT_FOLDERS)).toThrow(PlanGrammarError);
  });
});

describe('assertFolderPlacementsLegal — the append-time check', () => {
  it('passes a plan that files nothing, and a plan whose folders resolve in-project', () => {
    expect(() => assertFolderPlacementsLegal([add('a1')], new Map(), PLAN_PROJECT)).not.toThrow();
    expect(() =>
      assertFolderPlacementsLegal(
        [
          add('a1', { parentRef: folderRef(FOLDER) }),
          modify('m1', { parentRef: folderRef(FOLDER) }),
        ],
        DEFAULT_FOLDERS,
        PLAN_PROJECT,
      ),
    ).not.toThrow();
  });

  it('refuses unknown and cross-project folders on both parent sites', () => {
    expect(() =>
      assertFolderPlacementsLegal(
        [add('a1', { parentRef: folderRef('nope') })],
        DEFAULT_FOLDERS,
        PLAN_PROJECT,
      ),
    ).toThrow(PlanRefGraphError);
    expect(() =>
      assertFolderPlacementsLegal(
        [modify('m1', { parentRef: folderRef(FOREIGN_FOLDER) })],
        DEFAULT_FOLDERS,
        PLAN_PROJECT,
      ),
    ).toThrow(PlanGrammarError);
  });

  it("does not read an `add`'s stray patch or a work-item parent", () => {
    expect(() =>
      assertFolderPlacementsLegal(
        [add('a1', { parentRef: 'wi_real', patch: { parentRef: folderRef('nope') } })],
        DEFAULT_FOLDERS,
        PLAN_PROJECT,
      ),
    ).not.toThrow();
  });
});
