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
  TransitionList:
    'The list of legal transition targets is published by `GET …/transitions`. On MCP it is ' +
    'not a payload at all: `transition_status` names the allowed targets inside an ERROR ' +
    'message (`IllegalTransitionError`, enriched at the tool), so there is no success ' +
    'structuredContent for the guard to compare.',
};
