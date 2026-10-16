// The IMPORT SAMPLE fixture's format (Story MOTIR-8240 · MOTIR-8752).
//
// One realistic, vendor-neutral sample project, committed as data, that every
// issue-import proof (Jira MOTIR-8242, Linear MOTIR-8243, Plane MOTIR-8244)
// loads into its own vendor instance and then imports back into Motir. Because
// all three load the SAME project, a difference in what arrives is a difference
// in the importer, not in the test data.
//
// Three committed parts, each typed here:
//   - `project.json`        — the project itself (`FixtureProject`).
//   - `translation.json`    — how every fixture concept is expressed in Jira,
//                              Linear and Plane (`TranslationTable`).
//   - `expected/<vendor>.json` — what Motir should hold after importing it from
//                              that vendor, each fact marked `must_arrive` or
//                              `known_not_read` (`ExpectedResult`).
//
// The field names of `FixtureItem` mirror the connector seam's `SourceIssue`
// (`lib/import/connectors/types.ts`), so a proof can compare field by field:
//   id ⇔ externalId · kind ⇔ type · statusName ⇔ status · parentId ⇔
//   parentExternalId · assigneeId / reporterId ⇔ assignee/reporter email+name
//   (through `people`) · comments[].authorId ⇔ authorEmail/authorName.
// `iterationId` is the ONE concept `SourceIssue` lacks — no shipped connector
// reads a sprint or a cycle — and it is carried so the proofs can show it is lost.
//
// Pure data types: nothing here imports Prisma, `lib/db` or a connector. The
// kind list is NOT re-declared — `FixtureKind` is the matrix's own `IssueType`,
// so the kind-parent rules the check enforces cannot drift from the product's.

import type { IssueType } from '@/lib/issues/parentRules';

/** A work-item kind — exactly the product's five (`lib/issues/parentRules.ts`). */
export type FixtureKind = IssueType;

/** The status CATEGORY an item sits in. `cancelled` is kept apart from `done`
 *  (Motir files both under the done category) so the proofs can assert it. */
export type FixtureStatusCategory = 'todo' | 'in_progress' | 'done' | 'cancelled';

/** Motir's five priority levels; `null` is "no priority" (the importer maps an
 *  unmatched or absent value to `medium`, ADR §2). */
export type FixturePriority = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

/** A fictional person. `id` like `P-1`; `email` on `sample.motir.co`.
 *  `workspaceMember: false` marks the one person the proofs leave OUT of the
 *  Motir workspace, so the importer's unmatched-user choice is exercised. */
export interface FixturePerson {
  id: string;
  name: string;
  email: string;
  workspaceMember: boolean;
}

/** A time-boxed iteration — a Jira sprint, a Linear cycle, a Plane cycle.
 *  `id` like `IT-1`; dates are ISO `YYYY-MM-DD`. */
export interface FixtureIteration {
  id: string;
  name: string;
  state: 'closed' | 'active' | 'future';
  startDate: string;
  endDate: string;
}

/** A comment, by a fixture person (`authorId` → `FixturePerson.id`). */
export interface FixtureComment {
  authorId: string;
  body: string;
  /** ISO-8601 UTC. Strictly increasing within one item. */
  createdAt: string;
}

/** A non-parent relation to another fixture item (`targetId` → `FixtureItem.id`). */
export interface FixtureLink {
  type: 'blocks' | 'is_blocked_by' | 'relates_to' | 'duplicates';
  targetId: string;
}

/** An attachment's metadata. No URL — each vendor loader uploads a file of this
 *  name, type and size and the vendor supplies the URL. */
export interface FixtureAttachment {
  filename: string;
  contentType: string;
  byteSize: number;
}

/** One work item. `id` like `F-1` is the stable fixture id a run is checked by. */
export interface FixtureItem {
  id: string;
  kind: FixtureKind;
  title: string;
  /** Markdown; `""` is an empty body. */
  descriptionMd: string;
  statusCategory: FixtureStatusCategory;
  /** The vendor-neutral state NAME the loader gives the vendor state. */
  statusName: string;
  priority: FixturePriority | null;
  assigneeId: string | null;
  reporterId: string | null;
  labels: string[];
  comments: FixtureComment[];
  attachments: FixtureAttachment[];
  parentId: string | null;
  links: FixtureLink[];
  /** The iteration the item sits in, or null (the backlog / an epic). */
  iterationId: string | null;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC, or null while the item is open. */
  closedAt: string | null;
}

/** The whole project. `items` is a FLAT list with parents by id, so a dangling
 *  id is a plain lookup failure rather than something a nesting hides. */
export interface FixtureProject {
  name: string;
  people: FixturePerson[];
  iterations: FixtureIteration[];
  items: FixtureItem[];
}

/** The three vendors the import proofs load the fixture into. */
export type VendorId = 'jira' | 'linear' | 'plane';

/** A value per vendor — every key REQUIRED, so a missing column is a compile
 *  error rather than a blank a loader has to guess at. */
export type PerVendor<T> = { [V in VendorId]: T };

/** How one fixture concept is expressed in each vendor, and the exact vendor
 *  field the fact is written to. */
export interface TranslationRow {
  /** One of `CONCEPTS`. Typed `string` because the file is data: the check
   *  names a row whose concept is not on the list (`concept-unknown`). */
  concept: string;
  jira: string;
  linear: string;
  plane: string;
  vendorField: PerVendor<string>;
}

export interface TranslationTable {
  concepts: TranslationRow[];
}

/** Whether the shipped connector at `main` reads a fact (`must_arrive`) or is
 *  already known not to (`known_not_read`). */
export type FactArrival = 'must_arrive' | 'known_not_read';

/** One expectation about what Motir holds after importing the fixture. */
export interface ExpectedFact {
  /** `<VENDOR>-<NN>`, unique within its file. */
  id: string;
  /** What the fact is about: `F-n` / `P-n` / `IT-n`, `items:*`, `count:<…>`, or
   *  a concept name. */
  subject: string;
  assertion: string;
  arrival: FactArrival;
  /** Why the mark is what it is; for `known_not_read` it names the connector
   *  field or vendor limit read at `main`. */
  reason: string;
}

export interface ExpectedResult {
  vendor: VendorId;
  facts: ExpectedFact[];
}

/**
 * The CLOSED list of concepts the translation table must cover, one row each.
 * Adding a concept here is what obliges a translation row and an expected fact
 * for it; the check names any concept that has neither.
 */
export const CONCEPTS = [
  'epic',
  'story',
  'task',
  'bug',
  'subtask',
  'orphan',
  'status_todo',
  'status_in_progress',
  'status_done',
  'status_cancelled',
  'priority',
  'no_priority',
  'assignee',
  'non_member_assignee',
  'reporter',
  'label',
  'case_only_label_pair',
  'comment',
  'link_blocks',
  'link_relates_to',
  'link_duplicates',
  'cross_epic_link',
  'attachment',
  'iteration',
  'parent',
  'created_at',
  'closed_at',
] as const;

export type FixtureConcept = (typeof CONCEPTS)[number];
