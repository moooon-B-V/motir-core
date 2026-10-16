// The import-sample fixture check FAILS on broken data and names the item
// (MOTIR-8757).
//
// `fixtureValidity.test.ts` only ever sees the committed files, so on its own it
// would stay green if a rule stopped checking anything. Each case here breaks a
// `structuredClone` of the loaded data in memory — never a file — and asserts
// the rule fires on the offending record's own id. "Undo" is the untouched
// original validating clean again. Targets are looked up from the data rather
// than hard-coded, so editing the fixture's content does not break this spec.
//
// The last case is the coverage gate: every `FixtureRule` must have fired in
// some case above, so a rule cannot be added to the check without a failing
// case to prove it works.

import { describe, expect, it } from 'vitest';

import { loadExpected, loadProject, loadTranslation } from '../fixtures/importSample';
import type {
  ExpectedResult,
  FixtureItem,
  FixtureProject,
  TranslationTable,
  VendorId,
} from '../fixtures/importSample/types';
import {
  FIXTURE_RULES,
  type FixtureRule,
  type FixtureViolation,
  formatViolations,
  validateExpected,
  validateFixture,
  validateProject,
  validateTranslation,
} from '../fixtures/importSample/validate';

const project = loadProject();
const translation = loadTranslation();
const expected: Record<VendorId, ExpectedResult> = {
  jira: loadExpected('jira'),
  linear: loadExpected('linear'),
  plane: loadExpected('plane'),
};

const rulesSeen = new Set<FixtureRule>();

function breakIt(mutate: (copy: FixtureProject) => void): FixtureViolation[] {
  const copy = structuredClone(project);
  mutate(copy);
  return validateProject(copy);
}

function breakTranslation(mutate: (copy: TranslationTable) => void): FixtureViolation[] {
  const copy = structuredClone(translation);
  mutate(copy);
  return validateTranslation(copy);
}

function breakExpected(mutate: (copy: ExpectedResult) => void): FixtureViolation[] {
  const copy = structuredClone(expected.jira);
  mutate(copy);
  return validateExpected(copy, 'jira', project);
}

/** Asserts a violation of `rule` names `itemId`, and returns it. */
function expectNamed(
  violations: FixtureViolation[],
  rule: FixtureRule,
  itemId: string,
): FixtureViolation {
  const hit = violations.find((v) => v.rule === rule && v.itemId === itemId);
  expect(hit, `no [${rule}] ${itemId} in:\n${formatViolations(violations)}`).toBeDefined();
  expect(hit!.message).toContain(itemId);
  rulesSeen.add(rule);
  return hit!;
}

/** Finds an item in the copy by id (the copy shares the original's ids). */
function itemIn(copy: FixtureProject, id: string): FixtureItem {
  const item = copy.items.find((i) => i.id === id);
  if (!item) throw new Error(`fixture has no item ${id}`);
  return item;
}

/** The first committed item matching `predicate`, guarded so an edit to the content fails loudly. */
function pick(predicate: (item: FixtureItem) => boolean, what: string): FixtureItem {
  const item = project.items.find(predicate);
  expect(item, `the fixture has no ${what} to mutate`).toBeDefined();
  return item!;
}

const byId = new Map(project.items.map((i) => [i.id, i]));
const subtask = pick((i) => i.kind === 'subtask' && i.parentId !== null, 'parented subtask');
const linked = pick((i) => i.links.length > 0, 'item with a link');
const story = pick((i) => i.kind === 'story', 'story');
const inProgress = pick(
  (i) => i.kind !== 'epic' && i.statusCategory === 'in_progress' && i.iterationId !== null,
  'non-epic in-progress item in an iteration',
);
const done = pick((i) => i.statusCategory === 'done', 'done item');
const todo = pick((i) => i.statusCategory === 'todo' && i.kind !== 'epic', 'non-epic todo item');
const epic = pick((i) => i.kind === 'epic', 'epic');
const commented = pick((i) => i.comments.length > 0, 'commented item');

describe('import-sample fixture check — mutations', () => {
  it('1. the committed fixture is clean', () => {
    const violations = validateFixture({ project, translation, expected });
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('2. a broken parent id names the item, and the original still validates after undo', () => {
    const original = subtask.parentId;
    const violations = breakIt((copy) => {
      itemIn(copy, subtask.id).parentId = 'F-999';
    });
    const hit = expectNamed(violations, 'dangling-id', subtask.id);
    expect(hit.message).toContain('parentId');
    expect(hit.message).toContain('F-999');
    expect(hit.message).toContain(subtask.title);

    expect(subtask.parentId).toBe(original);
    expect(validateFixture({ project, translation, expected })).toEqual([]);
  });

  it('3. a dangling link target names the source item', () => {
    const violations = breakIt((copy) => {
      itemIn(copy, linked.id).links[0]!.targetId = 'F-999';
    });
    expect(expectNamed(violations, 'dangling-id', linked.id).message).toContain('F-999');
  });

  it('3b. a link to itself is a self-link', () => {
    const violations = breakIt((copy) => {
      itemIn(copy, linked.id).links[0]!.targetId = linked.id;
    });
    expectNamed(violations, 'self-link', linked.id);
  });

  it('4. an illegal kind-parent pair names the child', () => {
    const violations = breakIt((copy) => {
      itemIn(copy, story.id).parentId = subtask.id;
    });
    expectNamed(violations, 'kind-parent', story.id);
  });

  it('5. a subtask with no parent is a kind-parent violation', () => {
    const violations = breakIt((copy) => {
      itemIn(copy, subtask.id).parentId = null;
    });
    expectNamed(violations, 'kind-parent', subtask.id);
  });

  it('6. a chain five levels deep names the deepest item', () => {
    // epic > story > task > bug > subtask is legal under the matrix at every
    // edge, so only the depth rule can object to it.
    const leaf = pick(
      (i) => i.kind === 'subtask' && byId.get(i.parentId ?? '')?.kind === 'bug',
      'subtask under a bug',
    );
    const bug = byId.get(leaf.parentId!)!;
    const task = pick((i) => i.kind === 'task', 'task');
    const violations = breakIt((copy) => {
      itemIn(copy, bug.id).parentId = task.id;
      itemIn(copy, task.id).parentId = story.id;
      itemIn(copy, story.id).parentId = epic.id;
    });
    expect(expectNamed(violations, 'depth', leaf.id).message).toContain('depth 5');
  });

  it('7. a parent cycle terminates and names the item that closes it', () => {
    const child = pick((i) => i.parentId === epic.id, 'child of the epic');
    const violations = breakIt((copy) => {
      itemIn(copy, epic.id).parentId = child.id;
    });
    expectNamed(violations, 'parent-cycle', epic.id);
  });

  it('8. a person with no email, or one off sample.motir.co, is named with their name', () => {
    const person = project.people[0]!;
    const empty = breakIt((copy) => {
      copy.people[0]!.email = '';
    });
    expect(expectNamed(empty, 'person-email', person.id).message).toContain(person.name);

    const offDomain = breakIt((copy) => {
      copy.people[0]!.email = 'someone@example.com';
    });
    expectNamed(offDomain, 'person-email', person.id);
  });

  it('9. an in-progress item outside any iteration is named; todo items and epics are exempt', () => {
    const violations = breakIt((copy) => {
      itemIn(copy, inProgress.id).iterationId = null;
    });
    expectNamed(violations, 'iteration-expected', inProgress.id);

    const exempt = breakIt((copy) => {
      itemIn(copy, todo.id).iterationId = null;
      itemIn(copy, epic.id).iterationId = null;
    });
    expect(exempt, formatViolations(exempt)).toEqual([]);
  });

  it('10. a duplicate id is named', () => {
    const violations = breakIt((copy) => {
      copy.items[1]!.id = copy.items[0]!.id;
    });
    expectNamed(violations, 'duplicate-id', project.items[0]!.id);
  });

  it('11. a done item with no closedAt, and a todo item with one, are named', () => {
    const missing = breakIt((copy) => {
      itemIn(copy, done.id).closedAt = null;
    });
    expectNamed(missing, 'closed-at', done.id);

    const stray = breakIt((copy) => {
      itemIn(copy, todo.id).closedAt = '2026-10-01T00:00:00Z';
    });
    expectNamed(stray, 'closed-at', todo.id);
  });

  it('12. a parent created after its child is named', () => {
    const parent = byId.get(subtask.parentId!)!;
    const violations = breakIt((copy) => {
      itemIn(copy, parent.id).createdAt = '2030-01-01T00:00:00Z';
    });
    expectNamed(violations, 'parent-created-after', parent.id);
  });

  it.each([
    ['assigneeId', (i: FixtureItem) => (i.assigneeId = 'P-999')],
    ['reporterId', (i: FixtureItem) => (i.reporterId = 'P-999')],
    ['iterationId', (i: FixtureItem) => (i.iterationId = 'IT-999')],
    ['comments[0].authorId', (i: FixtureItem) => (i.comments[0]!.authorId = 'P-999')],
  ])('13. a dangling %s is named with its field', (field, mutate) => {
    const violations = breakIt((copy) => {
      mutate(itemIn(copy, commented.id));
    });
    expect(expectNamed(violations, 'dangling-id', commented.id).message).toContain(field);
  });

  it('14. the translation table: missing, unknown, duplicate rows and empty cells', () => {
    const concept = translation.concepts[0]!.concept;
    expectNamed(
      breakTranslation((copy) => {
        copy.concepts.shift();
      }),
      'concept-missing',
      concept,
    );
    expectNamed(
      breakTranslation((copy) => {
        copy.concepts[0]!.concept = 'sprint_velocity';
      }),
      'concept-unknown',
      'sprint_velocity',
    );
    expectNamed(
      breakTranslation((copy) => {
        copy.concepts.push(structuredClone(copy.concepts[0]!));
      }),
      'concept-duplicate',
      concept,
    );
    const empty = breakTranslation((copy) => {
      copy.concepts[0]!.linear = '';
    });
    expect(expectNamed(empty, 'cell-empty', concept).message).toContain('linear');
  });

  it('15. an expected-result file: wrong vendor, repeated fact id, empty field, dangling subject', () => {
    expectNamed(
      breakExpected((copy) => {
        copy.vendor = 'plane';
      }),
      'expected-vendor',
      'jira',
    );
    const first = expected.jira.facts[0]!.id;
    expectNamed(
      breakExpected((copy) => {
        copy.facts[1]!.id = first;
      }),
      'fact-duplicate-id',
      first,
    );
    expectNamed(
      breakExpected((copy) => {
        copy.facts[0]!.reason = '';
      }),
      'fact-field-empty',
      first,
    );
    const dangling = breakExpected((copy) => {
      copy.facts[0]!.subject = 'F-999';
    });
    expect(expectNamed(dangling, 'fact-subject-dangling', first).message).toContain('F-999');
  });

  it('16. every violation is reported, not only the first', () => {
    const person = project.people[0]!;
    const violations = breakIt((copy) => {
      itemIn(copy, subtask.id).parentId = 'F-999';
      copy.people[0]!.email = '';
    });
    expectNamed(violations, 'dangling-id', subtask.id);
    expectNamed(violations, 'person-email', person.id);
  });

  it('17. every rule in the check fired in some case above', () => {
    expect([...rulesSeen].sort()).toEqual([...FIXTURE_RULES].sort());
  });
});
