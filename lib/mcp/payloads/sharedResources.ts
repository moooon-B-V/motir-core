import type { z } from 'zod/v4';
import { V1_RESOURCE_COMPONENTS } from '@/lib/api/v1/openapi/registry';

// The SHARED-RESOURCE set (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// "Which resources do BOTH surfaces expose?" is DERIVED here, never listed. The
// source is `V1_RESOURCE_COMPONENTS` — the merged component map
// `lib/api/v1/openapi/registry.ts` assembles from the per-resource
// `operations.ts` modules — so a resource added later joins this set at the
// moment it is registered for the OpenAPI document, with no second list for
// anyone to remember.
//
// That reuse is deliberate. ADR Amendment 4 Q2 created the registry so exactly
// ONE value knows the whole set; a hand-written mirror of it here would be this
// story's own defect one level up — a guard reporting success over a set nobody
// defined. ADR Amendment 7 Q4 records it.

/** Every resource name `/api/v1` publishes a component schema for. */
export type SharedResourceName = keyof typeof V1_RESOURCE_COMPONENTS;

/** The derived set, as a value. Order follows the registry's resource order. */
export const SHARED_RESOURCE_NAMES = Object.keys(
  V1_RESOURCE_COMPONENTS,
) as readonly SharedResourceName[];

/** The v1 schema a shared resource is described by — what a payload's matching
 *  part must validate against.
 *
 *  The non-null assertion is safe by construction and required only by
 *  `noUncheckedIndexedAccess`: `SharedResourceName` IS `keyof` the map, so the
 *  lookup cannot miss. */
export function sharedResourceSchema(name: SharedResourceName): z.ZodType {
  return V1_RESOURCE_COMPONENTS[name]!;
}

/** Membership test usable on an untrusted string. */
export function isSharedResourceName(value: string): value is SharedResourceName {
  return value in V1_RESOURCE_COMPONENTS;
}

/**
 * Shared resources NO MCP tool returns, each with the reason.
 *
 * The coverage rule (11.6.6's guard) is that every name in
 * {@link SHARED_RESOURCE_NAMES} is either PROBED by at least one tool's payload
 * definition or listed here — so "this resource has no MCP check" is a written
 * claim rather than an absence, which is the same discipline
 * `EXEMPT_TOOLS` applies one level down.
 *
 * Entries are added as the family cards discover them; 11.6.6 is where the rule
 * becomes a failing assertion.
 */
export const MCP_UNREACHABLE_RESOURCES: Partial<Record<SharedResourceName, string>> = {
  WorkItemSummary:
    'The `search_work_items` row is a declared NARROWING (`.omit({ createdAt })`). The flat List ' +
    'projection that tool reads does not carry `createdAt`; v1’s collection route sources it from ' +
    'the KEYSET read’s cursor position, which is part of that endpoint’s page addressing and has ' +
    'no equivalent here. Everything else on the row IS the shared schema, `dependencies` included ' +
    '— the block whose absence on `get_work_item` started this story. ⚠️ This is the one entry ' +
    'that is a candidate for CLOSING rather than a permanent difference: if a client ever needs a ' +
    'created timestamp from the MCP search, the fix is a card against the owning story to widen ' +
    'the projection, NOT relaxing the guard.',
  WorkItemDetail:
    '`get_work_item` returns the ISSUE-DETAIL AGGREGATE — `{ item, ancestors, parent, children, ' +
    'blockedBy, …, readiness, workflow, watcherCount }` — because that is the shape an agent reads ' +
    'a card from. v1’s `WorkItemDetail` is the FLAT single-resource form, shaped for a different ' +
    'caller. The envelope stays MCP’s own (ADR Amendment 7 Q6 rule 3); what derives is its ' +
    'resource-valued part, the CHILD rows, which probe `WorkItemRef`.',
  WorkItemLinkGroups:
    'The aggregate publishes the five edge groups as TOP-LEVEL arrays of link DTOs carrying the ' +
    '`work_item_link` row id, which the CLI’s relationship rendering reads. v1 groups bare refs ' +
    'under `links`. No MCP payload returns that grouping, so there is nothing to compare.',
  CommentThread:
    '`add_comment` returns the ONE comment it created, which by definition has no replies — it ' +
    'derives from `commentSchema`, the thread resource’s base. No MCP tool returns a root comment ' +
    'WITH its reply thread: `get_work_item_activity` pages an activity stream whose envelope is ' +
    'MCP’s own.',
  WorkItemCount:
    'ADR Amendment 12 made COUNTING a filtered set its own v1 operation, and the MCP surface has ' +
    'no counterpart: `search_work_items` still reports a `total` on the page itself, which is the ' +
    'shape that amendment moved AWAY from for v1 and deliberately left alone for MCP (an agent ' +
    'reading a page usually wants the number with it). So there is no MCP payload to compare — ' +
    'not a narrowing, an absence. ⚠️ If the MCP search ever drops its `total`, this entry closes ' +
    'and the count becomes a tool that probes this resource.',
  Me:
    '`whoami` answers a different question. v1’s `/me` describes the TOKEN — its `workspaceId` ' +
    'and granted `scopes`; `whoami` returns the RESOLVED user and workspace objects an agent ' +
    'prints. Each PART derives (see `mcpWhoamiSchema`), but neither payload is the other resource.',
  WorkspaceSummary:
    'The workspace `whoami` resolves is a `WorkspaceSummaryDTO` — `{ id, name, slug }` — while ' +
    'v1’s strict schema also requires `createdAt`, which that read does not fetch. It is therefore ' +
    'a declared NARROWING and cannot satisfy the base; adding the column would mean a read this ' +
    'tool has never made.',
  Plan:
    '`get_plan` is a declared NARROWING (see `mcpPlanSchema`): v1’s `proposals` carry a ' +
    '`workItemKey` resolved through a `keyOfId` lookup the v1 route performs and this tool does ' +
    'not. Publishing it here would mean adding that read, or emitting `null` for every proposal ' +
    'that HAS a work item — a field that lies. The divergence is declared rather than hidden.',
  ActivityEntry:
    'The activity page’s ENVELOPE stays MCP’s own, including the `all` view’s OPAQUE composite ' +
    'cursor over two sources. Its entries are the activity DTOs the web surface renders; v1’s ' +
    '`ActivityEntry` is the narrowed wire form. Aligning them is a widening of a paged read that ' +
    'no client has asked for — a card against 11.7 if one ever does, not a divergence to keep quiet.',
  TransitionList:
    'The list of legal transition targets is published by `GET …/transitions`. On MCP it is ' +
    'not a payload at all: `transition_status` names the allowed targets inside an ERROR ' +
    'message (`IllegalTransitionError`, enriched at the tool), so there is no success ' +
    'structuredContent for the guard to compare.',
};
