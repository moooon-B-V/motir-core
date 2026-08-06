import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod/v4';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import type {
  ExecutorDto,
  IssueDetailDto,
  WorkItemImplementationSourceDto,
  WorkItemKindDto,
  WorkItemDependencyEdgesDto,
  WorkItemPlanningSourceDto,
  WorkItemPriorityDto,
  WorkItemSummaryDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';

// The v1 WORK-ITEM resource, declared once (Story 11.2 · Subtask 11.2.2 —
// MOTIR-2040). Every sibling endpoint — list, detail, create, update,
// transition, archive, links — returns a shape defined HERE.
//
// ── A v1 response is a SCHEMA's output, never a service DTO ──────────────────
// Pinned by the ADR's Amendment 2. `IssueDetailDto` / `WorkItemListItemDto` are
// the web app's internal shapes and change whenever a page needs them to; ADR §8's
// additive-only promise cannot ride something nobody promised to keep still. The
// mappers below are that seam, and they shape FIELD BY FIELD — never a spread.
// `app/api/v1/me/route.ts` already refuses to spread a Prisma row for exactly this
// reason ("a public API must never leak one"); the same hazard applies one layer
// up, where a column a later migration adds would otherwise become public API by
// accident.
//
// ── Identifiers on the wire ─────────────────────────────────────────────────
// ADR §7: a WORK ITEM is named by its `MOTIR-<n>` key, never by its internal
// cuid. That holds absolutely here — not as `id`, not as a parent pointer, not
// as a link target. A cuid in a response body freezes the primary key as
// contract exactly as it would in a path.
//
// Three identifiers on this resource are NOT work items and so are NOT covered
// by that rule; each is a deliberate, recorded exception rather than a leak:
//   • `assigneeId` / `reporterId` — a USER has no `MOTIR-<n>` key, and its id is
//     the value `PATCH` accepts back (the shipped `UpdateWorkItemInput` takes
//     `assigneeId`). Omitting it would make assignment unreachable over the API.
//   • `sprintId` — likewise keyless; 11.3 owns the sprint resource.
// The guard in `tests/api/v1/story-gate.test.ts` asserts no WORK-ITEM cuid
// appears anywhere in a v1 body, which is the precise form of §7's rule.
//
// ── What is deliberately NOT here ───────────────────────────────────────────
// The card sketched `assignee`/`reporter` as `{ id, name }` objects. The shipped
// DTOs carry ids only (`WorkItemDto.assigneeId`, `WorkItemListItemDto.reporterId`
// — no joined name), so serving `{ id, name }` would require projecting a new
// field through the repository and service. That is precisely what this story's
// Scope BOUNDARY ("it changes no service, repository or DTO") and the ADR's
// Amendment 1 ("no new response field") forbid. Ids ship now; adding
// `assignee: { id, name }` later is ADDITIVE under §8 and therefore safe, whereas
// shipping a shape the data cannot fill is not.

// ─────────────────────────────────────────────────────────────────────────────
// Field vocabularies
// ─────────────────────────────────────────────────────────────────────────────

/** A `MOTIR-<n>` work-item key, as it appears in every reference on the wire. */
export const workItemKeySchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);

/** An ISO-8601 instant. The mappers emit strings; a `Date` is a schema failure. */
const isoDateTimeSchema = z.string().datetime();

// ── The closed vocabularies, kept TOTAL over their DTO unions ────────────────
//
// `z.enum` needs a literal tuple, so each set is spelled out — which is exactly
// the hand-maintained duplication that lets a wire vocabulary silently fall
// behind its source (MOTIR-2044's lesson, one layer down). Two guards per set
// close it, and both are COMPILE errors rather than test failures:
//
//   • `satisfies readonly <Dto>[]` — no member that is not a real DTO value.
//   • `AssertTotal<…>` — no DTO value missing from the tuple.
//
// A value added to a DTO union therefore breaks the build HERE, at the seam that
// decides what the public API says, instead of shipping as a response the schema
// rejects at runtime.

/** `true` only when `Union` is fully covered by `Covered`; otherwise `never`. */
type AssertTotal<Union, Covered> = [Exclude<Union, Covered>] extends [never] ? true : never;

const WORK_ITEM_KINDS = [
  'epic',
  'story',
  'task',
  'subtask',
  'bug',
] as const satisfies readonly WorkItemKindDto[];
const _kindsTotal: AssertTotal<WorkItemKindDto, (typeof WORK_ITEM_KINDS)[number]> = true;

const WORK_ITEM_PRIORITIES = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
] as const satisfies readonly WorkItemPriorityDto[];
const _prioritiesTotal: AssertTotal<WorkItemPriorityDto, (typeof WORK_ITEM_PRIORITIES)[number]> =
  true;

const WORK_ITEM_TYPES = [
  'code',
  'design',
  'test',
  'content',
  'research',
  'review',
  'decision',
  'deploy',
  'manual',
  'chore',
] as const satisfies readonly WorkItemTypeDto[];
const _typesTotal: AssertTotal<WorkItemTypeDto, (typeof WORK_ITEM_TYPES)[number]> = true;

const EXECUTORS = ['coding_agent', 'human'] as const satisfies readonly ExecutorDto[];
const _executorsTotal: AssertTotal<ExecutorDto, (typeof EXECUTORS)[number]> = true;

const PLANNING_SOURCES = [
  'native',
  'mcp',
  'manual',
  'api',
] as const satisfies readonly WorkItemPlanningSourceDto[];
const _planningTotal: AssertTotal<WorkItemPlanningSourceDto, (typeof PLANNING_SOURCES)[number]> =
  true;

const IMPLEMENTATION_SOURCES = [
  'hosted',
  'byok',
  'manual',
] as const satisfies readonly WorkItemImplementationSourceDto[];
const _implementationTotal: AssertTotal<
  WorkItemImplementationSourceDto,
  (typeof IMPLEMENTATION_SOURCES)[number]
> = true;

// The guards are type-level; reference them so `noUnusedLocals` stays happy and
// a reader can see they are load-bearing rather than leftovers.
void [
  _kindsTotal,
  _prioritiesTotal,
  _typesTotal,
  _executorsTotal,
  _planningTotal,
  _implementationTotal,
];

const kindSchema = z.enum(WORK_ITEM_KINDS);
const prioritySchema = z.enum(WORK_ITEM_PRIORITIES);
const typeSchema = z.enum(WORK_ITEM_TYPES);
const executorSchema = z.enum(EXECUTORS);
const planningSourceSchema = z.enum(PLANNING_SOURCES);
const implementationSourceSchema = z.enum(IMPLEMENTATION_SOURCES);

/**
 * The relationship vocabulary on the wire — the shipped `work_item_link` set.
 * `blocked_by` is the edge the ready set reads.
 */
export const relationshipSchema = z.enum([
  'blocked_by',
  'blocks',
  'relates_to',
  'duplicates',
  'clones',
]);
export type V1Relationship = z.infer<typeof relationshipSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The resource shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A REFERENCE to a work item — what a nested position renders: an ancestor, a
 * child, a link target, an open blocker.
 *
 * Deliberately thinner than {@link workItemSummarySchema}, because the shipped
 * DTO behind it genuinely is: `WorkItemSummaryDto` carries no `type`, no
 * `reporterId`, no timestamps. Declaring one fat shape and emitting nulls into
 * it would be a schema that lies about what a read can know. Two shapes, each
 * honest about its source.
 */
export const workItemRefSchema = z.object({
  key: workItemKeySchema,
  kind: kindSchema,
  title: z.string(),
  status: z.string(),
  priority: prioritySchema,
  assigneeId: z.string().nullable(),
  estimateMinutes: z.number().int().nullable(),
  storyPoints: z.number().nullable(),
  parentKey: workItemKeySchema.nullable(),
  archived: z.boolean(),
});
export type WorkItemRef = z.infer<typeof workItemRefSchema>;

/**
 * One end of a dependency edge — the far item, named by its key.
 *
 * Declared HERE and imported by `lib/api/v1/ready/schema.ts`, which had its own
 * structurally identical copy: one declaration, so the ready row and the
 * work-item rows cannot drift — the same reason {@link workItemLinkSchema} is
 * shared between `GET …/links` and the detail aggregate (11.2.9).
 */
export const dependencyEdgeSchema = z.object({
  key: workItemKeySchema,
  title: z.string(),
  /** The far end's raw workflow status key. */
  status: z.string(),
});

/**
 * A row's dependency edges, in both directions (ADR Amendment 6 Q4).
 *
 * TOTAL by construction: a row with no edges gets two EMPTY arrays, never a
 * missing key, so a typed client never branches on presence. The key names match
 * `lib/mcp/dependencyEdges.ts` exactly — the two transports attach the same block
 * so one renderer can read both, which is the property `assignChildWaves` and
 * `renderSprintItems` depend on.
 */
export const dependencyEdgesSchema = z.object({
  blockedBy: z.array(dependencyEdgeSchema),
  blocks: z.array(dependencyEdgeSchema),
});
export type V1DependencyEdges = z.infer<typeof dependencyEdgesSchema>;

/**
 * The fields a work item carries wherever it is returned WHOLE — shared by the
 * collection row and the detail resource.
 *
 * Extracted so {@link workItemSummarySchema} can carry `dependencies` without
 * {@link workItemDetailSchema} inheriting it. The detail already publishes the
 * item's own edges as `links.blockedBy` / `links.blocks` — richer refs, and the
 * five groups rather than two — so a second block there would be a redundant
 * field a client has to pick between. The detail's edge projection lands on its
 * CHILDREN ({@link workItemChildSchema}), which is the sub-graph nothing else
 * carries.
 */
const workItemFieldsSchema = z.object({
  key: workItemKeySchema,
  kind: kindSchema,
  type: typeSchema.nullable(),
  title: z.string(),
  status: z.string(),
  priority: prioritySchema,
  assigneeId: z.string().nullable(),
  reporterId: z.string(),
  dueDate: isoDateTimeSchema.nullable(),
  estimateMinutes: z.number().int().nullable(),
  storyPoints: z.number().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * The row every COLLECTION returns. Sourced from the flat List projection plus
 * the keyset read's `createdAt` — the position the cursor encodes, so it is part
 * of the page addressing rather than a new field on an existing read.
 *
 * `dependencies` is a §8 ADDITION (ADR Amendment 6 Q4), attached by a BOUNDED
 * page-level projection: one `getDependencyEdgesForItems` call for the whole
 * page, never one per row.
 */
export const workItemSummarySchema = workItemFieldsSchema.extend({
  dependencies: dependencyEdgesSchema,
});
export type WorkItemSummary = z.infer<typeof workItemSummarySchema>;

/** One dependency / relationship edge, as both `GET …/links` and the detail
 *  aggregate render it — ONE declaration, so the two cannot drift (11.2.9). */
export const workItemLinkSchema = z.object({
  relationship: relationshipSchema,
  item: workItemRefSchema,
});
export type WorkItemLink = z.infer<typeof workItemLinkSchema>;

/** All five edge groups. An empty group is `[]`, never an absent key — to a
 *  typed client those are different things. */
export const workItemLinkGroupsSchema = z.object({
  blockedBy: z.array(workItemRefSchema),
  blocks: z.array(workItemRefSchema),
  relatesTo: z.array(workItemRefSchema),
  duplicates: z.array(workItemRefSchema),
  clones: z.array(workItemRefSchema),
});
export type WorkItemLinkGroups = z.infer<typeof workItemLinkGroupsSchema>;

/**
 * The readiness verdict — whether every `blocked_by` blocker is terminal.
 *
 * `blockedByAncestorTitle` is a §8 ADDITION (ADR Amendment 6 Q4) and a pure
 * WIDENING: `IssueDetailDto.readiness.blockedByAncestor` is a full
 * `WorkItemSummaryDto` the mapper already holds and was discarding down to its
 * identifier. Nothing new is read. `blockedByAncestorKey` is published API and
 * stays exactly as it is — the title arrives ALONGSIDE it, never instead of it,
 * because the CLI's `renderReadinessLine` prints `blocked by ancestor <key> —
 * <title>` and needs both.
 *
 * The two are null together: there is no state in which an ancestor blocks the
 * item and its title is unknown.
 */
export const readinessSchema = z.object({
  ready: z.boolean(),
  openBlockers: z.array(workItemRefSchema),
  blockedByAncestorKey: workItemKeySchema.nullable(),
  blockedByAncestorTitle: z.string().nullable(),
});

// A label and a component are named by their NAME, not their cuid: the name is
// what the FilterAST's `lbl` / `cmp` facets match on, so it is the value a client
// can actually do something with. Their ids are internal and stay internal.
const labelSchema = z.object({ name: z.string() });
const componentSchema = z.object({ name: z.string() });

/**
 * A CHILD of the detail aggregate — a reference plus that child's own dependency
 * edges (ADR Amendment 6 Q4).
 *
 * The block rides the CHILD rows and not {@link workItemRefSchema} itself, which
 * is also an ancestor / link target / open blocker: widening the reference would
 * oblige every one of those positions to carry edges nothing reads, and force an
 * edge read on routes that have no use for one. The sibling sub-graph is what
 * makes the children's build ORDER derivable from this one call — the property
 * `packages/cli/src/render.ts`'s `assignChildWaves` computes its wave view from —
 * and it is exactly where `lib/mcp/tools/getWorkItem.ts` attaches it too.
 */
export const workItemChildSchema = workItemRefSchema.extend({
  dependencies: dependencyEdgesSchema,
});
export type WorkItemChild = z.infer<typeof workItemChildSchema>;

/** The single-item READ: the work item's fields plus everything a detail adds. */
export const workItemDetailSchema = workItemFieldsSchema.extend({
  descriptionMd: z.string().nullable(),
  parentKey: workItemKeySchema.nullable(),
  ancestorKeys: z.array(workItemKeySchema),
  children: z.array(workItemChildSchema),
  links: workItemLinkGroupsSchema,
  readiness: readinessSchema,
  labels: z.array(labelSchema),
  components: z.array(componentSchema),
  commentCount: z.number().int(),
  sprintId: z.string().nullable(),
  targetRepo: z.string().nullable(),
  executor: executorSchema.nullable(),
  planningSource: planningSourceSchema.nullable(),
  planningHarness: z.string().nullable(),
  planningModel: z.string().nullable(),
  implementationSource: implementationSourceSchema.nullable(),
  implementationHarness: z.string().nullable(),
  implementationModel: z.string().nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
});
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The mappers — field by field, never a spread
// ─────────────────────────────────────────────────────────────────────────────

/** What {@link presentWorkItemSummary} reads. Declared in the v1 layer rather
 *  than imported from `lib/dto`, so a change to an internal DTO is a COMPILE
 *  error at the seam instead of a silent change to the public contract. */
export interface WorkItemSummarySource {
  identifier: string;
  kind: WorkItemKindDto;
  type: WorkItemTypeDto | null;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  dueDate: string | null;
  estimateMinutes: number | null;
  storyPoints: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Map one row's dependency edges to the wire — field by field, never a spread.
 *
 * TOTAL: an id the batched read returned no entry for still gets two EMPTY
 * arrays. `getDependencyEdgesForItems` pre-seeds every id it is asked about, so
 * `undefined` is unreachable through the routes — the default is what makes the
 * promise hold at the SCHEMA rather than at each call site, which is the same
 * discipline `lib/mcp/dependencyEdges.ts`'s `attachEdges` applies to the MCP
 * transport.
 */
export function presentDependencyEdges(
  edges: WorkItemDependencyEdgesDto | undefined,
): V1DependencyEdges {
  return {
    blockedBy: (edges?.blockedBy ?? []).map((edge) => ({
      key: edge.key,
      title: edge.title,
      status: edge.status,
    })),
    blocks: (edges?.blocks ?? []).map((edge) => ({
      key: edge.key,
      title: edge.title,
      status: edge.status,
    })),
  };
}

/** The fields shared by the collection row and the detail resource. */
function presentWorkItemFields(
  source: WorkItemSummarySource,
): z.infer<typeof workItemFieldsSchema> {
  return {
    key: source.identifier,
    kind: source.kind,
    type: source.type,
    title: source.title,
    status: source.status,
    priority: source.priority,
    assigneeId: source.assigneeId,
    reporterId: source.reporterId,
    dueDate: source.dueDate,
    estimateMinutes: source.estimateMinutes,
    storyPoints: source.storyPoints,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

/**
 * Map a collection row to its wire shape.
 *
 * `edges` comes from the page's BATCHED projection — one call for the whole
 * page — and is a REQUIRED parameter so a caller cannot forget it and silently
 * publish "this row has no dependencies" for every row.
 */
export function presentWorkItemSummary(
  source: WorkItemSummarySource,
  edges: WorkItemDependencyEdgesDto | undefined,
): WorkItemSummary {
  return {
    ...presentWorkItemFields(source),
    dependencies: presentDependencyEdges(edges),
  };
}

/**
 * Map a nested work-item summary to a REFERENCE.
 *
 * `parentKey` needs the parent's KEY, but `WorkItemSummaryDto` carries only the
 * internal `parentId` — so the caller passes a resolver built from the ids it
 * already read. An id it cannot resolve becomes `null` rather than leaking the
 * cuid: an unresolvable parent is one outside what this read fetched, and §7
 * forbids naming it by cuid whatever the reason.
 */
export function presentWorkItemRef(
  source: WorkItemSummaryDto,
  keyOfId: (id: string) => string | undefined = () => undefined,
): WorkItemRef {
  return {
    key: source.identifier,
    kind: source.kind,
    title: source.title,
    status: source.status,
    priority: source.priority,
    assigneeId: source.assigneeId,
    estimateMinutes: source.estimateMinutes,
    storyPoints: source.storyPoints,
    parentKey: source.parentId === null ? null : (keyOfId(source.parentId) ?? null),
    archived: source.archivedAt !== null,
  };
}

/**
 * Map the detail aggregate to the wire resource.
 *
 * `commentCount` is passed in rather than read from the DTO: it is deliberately
 * NOT on `IssueDetailDto` (`lib/mcp/commentCounts.ts` records why — widening the
 * aggregate would break every exact-`toEqual` route-shape test that reads it
 * back), so the route reads it from `commentsService` and hands it here.
 *
 * `childEdges` arrives the same way and for the same reason — the CHILDREN's
 * dependency edges are not on `IssueDetailDto.children` either. It is keyed by
 * the child's internal id, exactly as `workItemsService.getDependencyEdgesForItems`
 * returns it, and REQUIRED so a route cannot forget the projection and publish an
 * edge-free sub-graph. Pass `{}` where the caller genuinely has no children to
 * describe (a create, or the links-only presenter).
 */
export function presentWorkItemDetail(
  detail: IssueDetailDto,
  commentCount: number,
  childEdges: Readonly<Record<string, WorkItemDependencyEdgesDto>>,
): WorkItemDetail {
  const { item } = detail;

  // Every work item this read already resolved, so a `parentId` can be named by
  // its KEY. Built once and shared by every nested position.
  const keyById = new Map<string, string>([[item.id, item.identifier]]);
  for (const row of [
    ...detail.ancestors,
    ...detail.children,
    ...detail.readiness.openBlockers,
    ...[
      ...detail.blockedBy,
      ...detail.blocks,
      ...detail.relatesTo,
      ...detail.duplicates,
      ...detail.clones,
    ].map((link) => link.item),
  ]) {
    keyById.set(row.id, row.identifier);
  }
  const keyOfId = (id: string): string | undefined => keyById.get(id);
  const ref = (source: WorkItemSummaryDto): WorkItemRef => presentWorkItemRef(source, keyOfId);

  return {
    ...presentWorkItemFields({
      identifier: item.identifier,
      kind: item.kind,
      type: item.type,
      title: item.title,
      status: item.status,
      priority: item.priority,
      assigneeId: item.assigneeId,
      reporterId: item.reporterId,
      dueDate: item.dueDate,
      estimateMinutes: item.estimateMinutes,
      storyPoints: item.storyPoints,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }),
    descriptionMd: item.descriptionMd,
    parentKey: detail.parent === null ? null : detail.parent.identifier,
    ancestorKeys: detail.ancestors.map((a) => a.identifier),
    children: detail.children.map((child) => ({
      ...ref(child),
      dependencies: presentDependencyEdges(childEdges[child.id]),
    })),
    links: {
      blockedBy: detail.blockedBy.map((link) => ref(link.item)),
      blocks: detail.blocks.map((link) => ref(link.item)),
      relatesTo: detail.relatesTo.map((link) => ref(link.item)),
      duplicates: detail.duplicates.map((link) => ref(link.item)),
      clones: detail.clones.map((link) => ref(link.item)),
    },
    readiness: {
      ready: detail.readiness.ready,
      openBlockers: detail.readiness.openBlockers.map(ref),
      blockedByAncestorKey: detail.readiness.blockedByAncestor?.identifier ?? null,
      blockedByAncestorTitle: detail.readiness.blockedByAncestor?.title ?? null,
    },
    labels: detail.labels.map((label) => ({ name: label.name })),
    components: detail.components.map((component) => ({ name: component.name })),
    commentCount,
    sprintId: item.sprintId,
    targetRepo: item.targetRepo,
    executor: item.executor,
    planningSource: item.planningSource,
    planningHarness: item.planningHarness,
    planningModel: item.planningModel,
    implementationSource: item.implementationSource,
    implementationHarness: item.implementationHarness,
    implementationModel: item.implementationModel,
    archivedAt: item.archivedAt,
  };
}

/** Present the five edge groups on their own — the `GET …/links` body (11.2.9),
 *  reusing the SAME declaration the detail resource nests. */
export function presentWorkItemLinkGroups(detail: IssueDetailDto): WorkItemLinkGroups {
  // No child edges: `links` is the item's OWN five edge groups and reads nothing
  // from the children, so this presenter owes no projection.
  return presentWorkItemDetail(detail, 0, {}).links;
}

// ─────────────────────────────────────────────────────────────────────────────
// The ETag — one function owns BOTH directions
// ─────────────────────────────────────────────────────────────────────────────
//
// The detail read issues an `ETag`; `PATCH` accepts it back as `If-Match` and
// passes it to `updateWorkItem`'s shipped `expectedUpdatedAt` precondition
// (11.2.6). A validator produced by one card and parsed by another IS a
// contract, so it lives with the resource rather than being re-invented at the
// write.
//
// ⚠️ ENCRYPTED, not merely encoded. The requirement is that a client cannot read
// `updatedAt` back out of it — base64 of a JSON payload (the cursor's idiom)
// would be opaque to read but trivially decodable, which is a different and
// weaker property. AES-256-GCM gives BOTH directions from one secret plus
// tamper-evidence for free: a modified validator fails its auth tag and is
// rejected outright rather than decoding to a plausible-but-wrong instant.

const ETAG_ALGORITHM = 'aes-256-gcm';
const ETAG_IV_BYTES = 12;
const ETAG_TAG_BYTES = 16;

function etagKey(): Buffer {
  // Derived from the app secret, so a validator issued by one deployment is not
  // valid against another — the same containment `signingKey()` gives cursors.
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');
  return createHash('sha256').update(`${secret}:api-v1-work-item-etag`).digest();
}

/**
 * The opaque `ETag` for a work item at a given version.
 *
 * Quoted, per RFC 9110 — an `ETag` is a quoted-string and `If-Match` compares it
 * verbatim. A fresh random IV per call means the same `updatedAt` produces a
 * DIFFERENT validator each time, which is deliberate: it removes the last way a
 * client could correlate two validators and infer that a row had not moved.
 */
export function encodeWorkItemETag(updatedAt: string): string {
  const iv = randomBytes(ETAG_IV_BYTES);
  const cipher = createCipheriv(ETAG_ALGORITHM, etagKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(updatedAt, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return `"${payload.toString('base64url')}"`;
}

/**
 * Decode an `If-Match` validator back to the instant it pins.
 *
 * Throws a 422 for anything that is not a validator we issued — malformed,
 * truncated, tampered, or from another deployment. It never degrades to
 * "no precondition": silently ignoring an `If-Match` a client sent would drop
 * the exact guarantee the client asked for, which is worse than refusing it.
 */
export function decodeWorkItemETag(raw: string): Date {
  const invalid = () =>
    new InvalidRequestError('INVALID_IF_MATCH', 'The `If-Match` header is not a valid ETag.');

  const unquoted = raw
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
  let payload: Buffer;
  try {
    payload = Buffer.from(unquoted, 'base64url');
  } catch {
    throw invalid();
  }
  if (payload.length <= ETAG_IV_BYTES + ETAG_TAG_BYTES) throw invalid();

  const iv = payload.subarray(0, ETAG_IV_BYTES);
  const tag = payload.subarray(ETAG_IV_BYTES, ETAG_IV_BYTES + ETAG_TAG_BYTES);
  const ciphertext = payload.subarray(ETAG_IV_BYTES + ETAG_TAG_BYTES);

  let plaintext: string;
  try {
    const decipher = createDecipheriv(ETAG_ALGORITHM, etagKey(), iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw invalid();
  }

  const parsed = new Date(plaintext);
  if (Number.isNaN(parsed.getTime())) throw invalid();
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST schemas (Story 11.2 · Subtask 11.2.6 — MOTIR-2046)
// ─────────────────────────────────────────────────────────────────────────────
//
// These live beside the RESPONSE schemas deliberately: Story 11.4 emits the
// OpenAPI operations from this module, and an operation is a request shape AND a
// response shape. Splitting them would put half an operation in each of two
// places.
//
// ⚠️ ABSENT vs NULL is the commonest PATCH defect, so it is spelled out rather
// than left to zod's defaults: a field that is ABSENT is untouched; a field
// explicitly set to `null` CLEARS the column. `.optional()` models the first and
// `.nullable()` the second, and the pairing is what makes them distinguishable —
// `updateWorkItemBodySchema.parse({})` yields `{}`, not a patch full of nulls.

/** A story-point value, mirroring the shipped `validateStoryPoints` bounds. */
const storyPointsSchema = z.number().min(0).max(9999.99).nullable();
const estimateMinutesSchema = z.number().int().min(0).nullable();

/** `POST /api/v1/projects/{projectKey}/work-items`. */
export const createWorkItemBodySchema = z
  .object({
    kind: kindSchema,
    title: z.string().min(1),
    // A `MOTIR-<n>` key, never a cuid (ADR §7) — the route resolves it to the
    // internal parent id.
    parentKey: workItemKeySchema.nullish(),
    descriptionMd: z.string().nullish(),
    priority: prioritySchema.optional(),
    type: typeSchema.nullish(),
    executor: executorSchema.nullish(),
    storyPoints: storyPointsSchema.optional(),
    estimateMinutes: estimateMinutesSchema.optional(),
    targetRepo: z.string().nullish(),
    assigneeId: z.string().nullish(),
    dueDate: z.string().datetime().nullish(),
  })
  .strict();
export type CreateWorkItemBody = z.infer<typeof createWorkItemBodySchema>;

/**
 * `PATCH /api/v1/work-items/{key}` — the shipped `UpdateWorkItemInput` PATCH
 * keys, plus `parentKey` (re-file) and `kind` (re-classify), both of which the
 * ONE service method already validates against the kind-parent matrix.
 *
 * `.strict()` on both: an unknown property is a 422, not a silent no-op. A
 * client that misspells a field name has a bug, and telling them beats
 * pretending the write succeeded.
 */
export const updateWorkItemBodySchema = z
  .object({
    kind: kindSchema.optional(),
    title: z.string().min(1).optional(),
    descriptionMd: z.string().nullish(),
    explanationMd: z.string().nullish(),
    parentKey: workItemKeySchema.nullish(),
    priority: prioritySchema.optional(),
    type: typeSchema.nullish(),
    executor: executorSchema.nullish(),
    storyPoints: storyPointsSchema.optional(),
    estimateMinutes: estimateMinutesSchema.optional(),
    targetRepo: z.string().nullish(),
    assigneeId: z.string().nullish(),
    dueDate: z.string().datetime().nullish(),
  })
  .strict();
export type UpdateWorkItemBody = z.infer<typeof updateWorkItemBodySchema>;

/**
 * Parse a request body against a schema, or raise the v1 422.
 *
 * Centralised so every write endpoint reports a validation failure with the
 * SAME code and the same envelope — the ADR's "two error shapes means every
 * client writes two parsers", applied to the request side.
 */
export async function parseV1Body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new InvalidRequestError('INVALID_BODY', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.length ? ` at \`${first.path.join('.')}\`` : '';
    throw new InvalidRequestError(
      'INVALID_BODY',
      `The request body is invalid${at}: ${first?.message ?? 'validation failed'}.`,
    );
  }
  return parsed.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// The TRANSITIONS sub-resource (Story 11.2 · Subtask 11.2.7 — MOTIR-2048)
// ─────────────────────────────────────────────────────────────────────────────

/** One status a work item may move to from where it is now. */
export const transitionTargetSchema = z.object({
  key: z.string(),
  label: z.string(),
  category: z.enum(['todo', 'in_progress', 'done']),
});
export type TransitionTarget = z.infer<typeof transitionTargetSchema>;

/** The `GET …/transitions` body. */
export const transitionListSchema = z.object({ transitions: z.array(transitionTargetSchema) });

/**
 * The refusal body for an illegal move: the pinned `{ code, error }` PLUS an
 * additive `allowedTransitions` array.
 *
 * ⚠️ The allowed targets are DATA, not prose. `transition_status` appends them to
 * its human message because an agent reads English; a machine client must not be
 * reduced to parsing a sentence. A new field on a response object is explicitly
 * allowed under ADR §8, and declaring its shape HERE is what lets `GET …/transitions`
 * and this refusal be proven to agree.
 */
export const illegalTransitionSchema = z.object({
  code: z.literal('ILLEGAL_TRANSITION'),
  error: z.string(),
  allowedTransitions: z.array(transitionTargetSchema),
});

/**
 * The MINIMAL ACTOR a v1 collection row embeds (Amendment 9 Q1).
 *
 * Two fields and no more: the id a client acts on (it is what 11.2's PATCH takes
 * back) and the name a client displays. Deliberately NOT a user resource — it
 * has no endpoint, no collection, no expansion and cannot be queried — which is
 * the distinction the pre-Amendment-9 rationale collapsed.
 *
 * Declared HERE, beside the other cross-resource shapes, because two resource
 * modules now use it: the ready row (Amendment 9 Q1) and the comment author
 * (11.5.14). `ready/schema.ts` already imports from this module, so declaring it
 * there and importing back would invert the dependency.
 */
export const actorRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/**
 * The statuses legal FROM `fromStatusKey`, presented from a project's workflow.
 *
 * ONE function, used by BOTH the `GET` and the refusal path, so the two surfaces
 * cannot disagree about what is legal — the property 11.2.11's seam test asserts
 * end to end.
 */
export function presentTransitionTargets(
  workflow: {
    statuses: ReadonlyArray<{ id: string; key: string; label: string; category: string }>;
    transitions: ReadonlyArray<{ fromStatusId: string; toStatusId: string }>;
    policyMode: string;
  },
  fromStatusKey: string,
): TransitionTarget[] {
  const byId = new Map(workflow.statuses.map((s) => [s.id, s]));
  const from = workflow.statuses.find((s) => s.key === fromStatusKey);

  // An `open` policy project permits ANY move, so every other status is a legal
  // target — read off the policy rather than off the edge list, which is empty
  // in that mode and would otherwise report "nowhere to go".
  const targets =
    workflow.policyMode === 'open'
      ? workflow.statuses.filter((s) => s.key !== fromStatusKey)
      : workflow.transitions
          .filter((t) => from !== undefined && t.fromStatusId === from.id)
          .map((t) => byId.get(t.toStatusId))
          .filter((s): s is NonNullable<typeof s> => s !== undefined);

  return targets.map((s) => ({
    key: s.key,
    label: s.label,
    category: s.category as TransitionTarget['category'],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The COMMENTS sub-resource (Story 11.2 · Subtask 11.2.8 — MOTIR-2049)
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ A comment's cuid IS its identifier on the wire, and that is a DECISION, not
// a leak. ADR §7's key-only rule governs WORK-ITEM references: a work item has a
// `MOTIR-<n>` key, so naming it by cuid would freeze the primary key as contract
// when a stable public name already exists. A comment has no such key — there is
// nothing else to call it, and a client that cannot name a comment cannot reply
// to one. The same reasoning covers a user id and a sprint id.

// Exported (MOTIR-2229) so `lib/mcp/payloads/` can DERIVE the MCP comment
// payload from this exact declaration rather than re-authoring a look-alike.
// An added export, not a shape change: no field, name or nullability moves.
export const commentSchema = z.object({
  id: z.string(),
  parentCommentId: z.string().nullable(),
  /**
   * The author's id — KEPT beside `author`, not replaced by it. Removing a
   * shipped field is a §8 violation, and it stays the cheaper read for a client
   * that only routes on identity. `author.id` is the same value; a test asserts
   * they cannot diverge.
   */
  authorId: z.string(),
  /** Who wrote it, for a client that renders a name (Amendment 9 Q1). */
  author: actorRefSchema,
  bodyMd: z.string(),
  createdAt: isoDateTimeSchema,
  editedAt: isoDateTimeSchema.nullable(),
  mentionedUserIds: z.array(z.string()),
});
export type V1Comment = z.infer<typeof commentSchema>;

/** A root comment with its single-level thread, as the service returns it. */
export const commentThreadSchema = commentSchema.extend({
  replies: z.array(commentSchema),
});
export type V1CommentThread = z.infer<typeof commentThreadSchema>;

/** What {@link presentComment} reads — the shipped `CommentDTO` fields it maps. */
export interface CommentSource {
  id: string;
  parentCommentId: string | null;
  author: { id: string; name: string };
  bodyMd: string;
  createdAt: string;
  editedAt: string | null;
  mentionedUserIds: string[];
}

/** Map one comment to the wire, field by field — never a spread. */
export function presentComment(source: CommentSource): V1Comment {
  return {
    id: source.id,
    parentCommentId: source.parentCommentId,
    // The author's ID and NAME. The name arrived with ADR Amendment 9 Q1
    // (MOTIR-2283), which overturned the rationale this comment used to state —
    // "a public API must not acquire a second, accidental user resource".
    // That fear is right about a user RESOURCE and wrong about an embedded,
    // minimal, read-only actor: it has no endpoint, no collection, no expansion
    // and cannot be queried. Without it no client can render a comment thread
    // showing who wrote what, because v1 has no user endpoint to resolve an id
    // against — and both mirror products embed one. `avatarUrl` stays off.
    authorId: source.author.id,
    author: { id: source.author.id, name: source.author.name },
    bodyMd: source.bodyMd,
    createdAt: source.createdAt,
    editedAt: source.editedAt,
    mentionedUserIds: source.mentionedUserIds,
  };
}

/** Map a root comment and its replies. */
export function presentCommentThread(
  source: CommentSource & { replies: CommentSource[] },
): V1CommentThread {
  return { ...presentComment(source), replies: source.replies.map(presentComment) };
}

/**
 * The comment count for one item, from the batch a route already read.
 *
 * `commentsService.getCommentCountsForItems` SEEDS every requested id with `0`
 * before it reads, so a miss here is unreachable — but `noUncheckedIndexedAccess`
 * still demands a fallback, and a bare `!` would assert something the type system
 * cannot see. Owned in ONE place so the five endpoints that present a detail do
 * not each carry the same untestable branch.
 */
export function commentCountFor(counts: Record<string, number>, itemId: string): number {
  /* v8 ignore next -- the service pre-seeds every requested id, so the fallback is unreachable */
  return counts[itemId] ?? 0;
}
