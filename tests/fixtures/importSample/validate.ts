// The import-sample fixture's rules, as pure functions (MOTIR-8756).
//
// `validateFixture` returns EVERY violation rather than throwing on the first,
// so one CI run names every broken record at once. Each violation carries the
// offending record's own id (`F-n`, `P-n`, `IT-n`, a concept name or a fact id)
// and a message that repeats that id — and, for an item, its title — so the log
// line alone says what to fix.
//
// The kind-parent matrix is the product's own (`lib/issues/parentRules.ts`),
// imported rather than copied, so the fixture cannot drift from what Motir
// accepts. Nothing here reads a file or touches a database: the loaders in
// `index.ts` read the JSON, and the mutation suite hands in broken copies.

import { ALLOWED_CHILD_TYPES, TYPES_REQUIRING_PARENT } from '@/lib/issues/parentRules';

import {
  CONCEPTS,
  type ExpectedResult,
  type FixtureItem,
  type FixtureProject,
  type TranslationTable,
  type VendorId,
} from './types';

export const FIXTURE_RULES = [
  'duplicate-id',
  'kind-parent',
  'depth',
  'parent-cycle',
  'dangling-id',
  'self-link',
  'person-email',
  'iteration-expected',
  'closed-at',
  'parent-created-after',
  'concept-missing',
  'concept-unknown',
  'concept-duplicate',
  'cell-empty',
  'expected-vendor',
  'fact-duplicate-id',
  'fact-field-empty',
  'fact-subject-dangling',
] as const;

export type FixtureRule = (typeof FIXTURE_RULES)[number];

export interface FixtureViolation {
  rule: FixtureRule;
  itemId: string;
  message: string;
}

/** The deepest chain allowed, counting the item itself as level 1. */
const MAX_DEPTH = 4;
const EMAIL_DOMAIN = 'sample.motir.co';
const VENDORS: readonly VendorId[] = ['jira', 'linear', 'plane'];
const RECORD_ID = /^(?:F|P|IT)-\d+$/;

type ItemIndex = ReadonlyMap<string, FixtureItem>;

function violation(rule: FixtureRule, itemId: string, message: string): FixtureViolation {
  return { rule, itemId, message };
}

function label(item: FixtureItem): string {
  return `${item.id} "${item.title}"`;
}

function indexItems(project: FixtureProject): ItemIndex {
  const index = new Map<string, FixtureItem>();
  for (const item of project.items) if (!index.has(item.id)) index.set(item.id, item);
  return index;
}

// ── Project rules ────────────────────────────────────────────────────────────

function checkDuplicateIds(project: FixtureProject): FixtureViolation[] {
  const lists: Array<[string, ReadonlyArray<{ id: string }>]> = [
    ['item', project.items],
    ['person', project.people],
    ['iteration', project.iterations],
  ];
  const out: FixtureViolation[] = [];
  for (const [kind, records] of lists) {
    const seen = new Set<string>();
    for (const { id } of records) {
      if (seen.has(id)) out.push(violation('duplicate-id', id, `${kind} id ${id} is used twice`));
      seen.add(id);
    }
  }
  return out;
}

function checkKindParent(project: FixtureProject, items: ItemIndex): FixtureViolation[] {
  const out: FixtureViolation[] = [];
  for (const item of project.items) {
    if (item.parentId === null) {
      if (TYPES_REQUIRING_PARENT.has(item.kind)) {
        out.push(
          violation('kind-parent', item.id, `${label(item)} is a ${item.kind} with no parent`),
        );
      }
      continue;
    }
    const parent = items.get(item.parentId);
    if (parent && !ALLOWED_CHILD_TYPES[parent.kind].includes(item.kind)) {
      out.push(
        violation(
          'kind-parent',
          item.id,
          `${label(item)} is a ${item.kind} under ${parent.kind} ${parent.id}, which may not hold one`,
        ),
      );
    }
  }
  return out;
}

/** Walks one item up to its root; reports a cycle instead of looping. */
function checkChain(item: FixtureItem, items: ItemIndex): FixtureViolation | null {
  const visited = new Set<string>([item.id]);
  let depth = 1;
  let current = item;
  while (current.parentId !== null) {
    const parent = items.get(current.parentId);
    if (!parent) return null; // dangling — reported by checkDanglingIds
    if (visited.has(parent.id)) {
      return violation(
        'parent-cycle',
        item.id,
        `${label(item)} is in a parent cycle closed at ${current.id} -> ${parent.id}`,
      );
    }
    visited.add(parent.id);
    depth += 1;
    current = parent;
  }
  if (depth <= MAX_DEPTH) return null;
  return violation(
    'depth',
    item.id,
    `${label(item)} sits at depth ${depth}, deeper than ${MAX_DEPTH}`,
  );
}

function checkDepth(project: FixtureProject, items: ItemIndex): FixtureViolation[] {
  return project.items.flatMap((item) => checkChain(item, items) ?? []);
}

interface IdSet {
  has(id: string): boolean;
}

/** One reference an item makes: the field, the id it names, and the set it must be in. */
type Reference = [field: string, ref: string | null, known: IdSet];

function referencesOf(
  item: FixtureItem,
  ids: { items: IdSet; people: IdSet; iterations: IdSet },
): Reference[] {
  return [
    ['parentId', item.parentId, ids.items],
    ['assigneeId', item.assigneeId, ids.people],
    ['reporterId', item.reporterId, ids.people],
    ['iterationId', item.iterationId, ids.iterations],
    ...item.links.map((l, i): Reference => [`links[${i}].targetId`, l.targetId, ids.items]),
    ...item.comments.map((c, i): Reference => [`comments[${i}].authorId`, c.authorId, ids.people]),
  ];
}

function checkDanglingIds(project: FixtureProject, items: ItemIndex): FixtureViolation[] {
  const ids = {
    items,
    people: new Set(project.people.map((p) => p.id)),
    iterations: new Set(project.iterations.map((it) => it.id)),
  };
  const out: FixtureViolation[] = [];
  for (const item of project.items) {
    for (const [field, ref, known] of referencesOf(item, ids)) {
      if (ref !== null && !known.has(ref)) {
        out.push(
          violation(
            'dangling-id',
            item.id,
            `${label(item)} ${field} names ${ref}, which does not exist`,
          ),
        );
      }
    }
  }
  return out;
}

function checkSelfLinks(project: FixtureProject): FixtureViolation[] {
  return project.items.flatMap((item) =>
    item.links
      .filter((link) => link.targetId === item.id)
      .map((link) =>
        violation('self-link', item.id, `${label(item)} has a ${link.type} link to itself`),
      ),
  );
}

function checkPersonEmails(project: FixtureProject): FixtureViolation[] {
  const shape = /^[^\s@]+@([^\s@]+)$/;
  return project.people.flatMap((person) => {
    const domain = shape.exec(person.email)?.[1];
    if (domain === EMAIL_DOMAIN) return [];
    const why = domain ? `is not on ${EMAIL_DOMAIN}` : 'is empty or not shaped local@domain';
    return [
      violation(
        'person-email',
        person.id,
        `${person.id} "${person.name}" email "${person.email}" ${why}`,
      ),
    ];
  });
}

function checkIterationExpected(project: FixtureProject): FixtureViolation[] {
  return project.items
    .filter(
      (item) => item.kind !== 'epic' && item.statusCategory !== 'todo' && item.iterationId === null,
    )
    .map((item) =>
      violation(
        'iteration-expected',
        item.id,
        `${label(item)} is ${item.statusCategory} but sits in no iteration`,
      ),
    );
}

function closedAtProblem(item: FixtureItem): string | null {
  const closed = item.statusCategory === 'done' || item.statusCategory === 'cancelled';
  if (closed && item.closedAt === null) return `is ${item.statusCategory} with no closedAt`;
  if (!closed && item.closedAt !== null)
    return `is ${item.statusCategory} but has closedAt ${item.closedAt}`;
  if (item.closedAt !== null && Date.parse(item.closedAt) < Date.parse(item.createdAt)) {
    return `closedAt ${item.closedAt} is earlier than createdAt ${item.createdAt}`;
  }
  return null;
}

function checkClosedAt(project: FixtureProject): FixtureViolation[] {
  return project.items.flatMap((item) => {
    const problem = closedAtProblem(item);
    return problem ? [violation('closed-at', item.id, `${label(item)} ${problem}`)] : [];
  });
}

function checkParentCreatedAfter(project: FixtureProject, items: ItemIndex): FixtureViolation[] {
  return project.items.flatMap((item) => {
    const parent = item.parentId === null ? undefined : items.get(item.parentId);
    if (!parent || Date.parse(parent.createdAt) <= Date.parse(item.createdAt)) return [];
    return [
      violation(
        'parent-created-after',
        parent.id,
        `${label(parent)} was created at ${parent.createdAt}, after its child ${item.id} (${item.createdAt})`,
      ),
    ];
  });
}

export function validateProject(project: FixtureProject): FixtureViolation[] {
  const items = indexItems(project);
  return [
    ...checkDuplicateIds(project),
    ...checkKindParent(project, items),
    ...checkDepth(project, items),
    ...checkDanglingIds(project, items),
    ...checkSelfLinks(project),
    ...checkPersonEmails(project),
    ...checkIterationExpected(project),
    ...checkClosedAt(project),
    ...checkParentCreatedAfter(project, items),
  ];
}

// ── Translation rules ────────────────────────────────────────────────────────

function emptyCells(row: TranslationTable['concepts'][number]): string[] {
  const empty: string[] = [];
  for (const vendor of VENDORS) {
    if (!row[vendor]?.trim()) empty.push(vendor);
    if (!row.vendorField?.[vendor]?.trim()) empty.push(`vendorField.${vendor}`);
  }
  return empty;
}

export function validateTranslation(table: TranslationTable): FixtureViolation[] {
  const known = new Set<string>(CONCEPTS);
  const seen = new Set<string>();
  const out: FixtureViolation[] = [];
  for (const row of table.concepts) {
    const id = row.concept;
    if (!known.has(id))
      out.push(violation('concept-unknown', id, `row ${id} is not a fixture concept`));
    if (seen.has(id))
      out.push(violation('concept-duplicate', id, `concept ${id} has more than one row`));
    seen.add(id);
    const empty = emptyCells(row);
    if (empty.length > 0) {
      out.push(violation('cell-empty', id, `concept ${id} has empty cells: ${empty.join(', ')}`));
    }
  }
  for (const concept of CONCEPTS) {
    if (!seen.has(concept))
      out.push(violation('concept-missing', concept, `concept ${concept} has no row`));
  }
  return out;
}

// ── Expected-result rules ────────────────────────────────────────────────────

function projectRecordIds(project: FixtureProject): Set<string> {
  return new Set([
    ...project.items.map((i) => i.id),
    ...project.people.map((p) => p.id),
    ...project.iterations.map((it) => it.id),
  ]);
}

export function validateExpected(
  expected: ExpectedResult,
  file: VendorId,
  project: FixtureProject,
): FixtureViolation[] {
  const out: FixtureViolation[] = [];
  if (expected.vendor !== file) {
    out.push(
      violation(
        'expected-vendor',
        file,
        `expected/${file}.json declares vendor "${expected.vendor}"`,
      ),
    );
  }
  const records = projectRecordIds(project);
  const seen = new Set<string>();
  expected.facts.forEach((fact, index) => {
    const id = fact.id?.trim() ? fact.id : `${file}#${index}`;
    if (seen.has(id))
      out.push(violation('fact-duplicate-id', id, `${file} fact id ${id} is used twice`));
    seen.add(id);
    const empty = (['id', 'subject', 'assertion', 'reason'] as const).filter(
      (k) => !fact[k]?.trim(),
    );
    if (empty.length > 0) {
      out.push(
        violation('fact-field-empty', id, `${file} fact ${id} has empty ${empty.join(', ')}`),
      );
    }
    if (RECORD_ID.test(fact.subject) && !records.has(fact.subject)) {
      out.push(
        violation(
          'fact-subject-dangling',
          id,
          `${file} fact ${id} names ${fact.subject}, which is not in the project`,
        ),
      );
    }
  });
  return out;
}

export function validateFixture(input: {
  project: FixtureProject;
  translation: TranslationTable;
  expected: Record<VendorId, ExpectedResult>;
}): FixtureViolation[] {
  return [
    ...validateProject(input.project),
    ...validateTranslation(input.translation),
    ...VENDORS.flatMap((vendor) => validateExpected(input.expected[vendor], vendor, input.project)),
  ];
}

/** One line per violation, as the CI log prints it. */
export function formatViolations(violations: readonly FixtureViolation[]): string {
  return violations.map((v) => `[${v.rule}] ${v.itemId}: ${v.message}`).join('\n');
}
