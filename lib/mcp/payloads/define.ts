import type { z } from 'zod/v4';
import { brandPayload, type McpPayload } from './brand';
import type { ExemptToolName } from './exemptions';
import type { SharedResourceName } from './sharedResources';

// The payload SEAM (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// Three constructors, and there is no fourth way to build an `McpPayload`:
//
//   derived(definition, value)  — the payload is a declared schema's output, and
//                                 the definition says which SHARED resources it
//                                 contains and where.
//   exempt(toolName, value)     — the tool has no shared resource to derive from
//                                 (`EXEMPT_TOOLS`, with a written reason).
//
// (A third constructor, `unmigrated`, staged tools between 11.6.2 and 11.6.5.
// MOTIR-2231 deleted it with the last entry of its map.)
//
// A tool in none of those three cannot call `toolOk` — the totality property,
// enforced by the type system rather than by review. ADR Amendment 7 Q4.
//
// ── WHAT IS FROZEN AND WHAT IS FREE ─────────────────────────────────────────
// This seam freezes the DATA SHAPE and nothing else. A tool's NAME, its
// `tools/list` DESCRIPTION, its ARGUMENT names and its SCOPE are MCP's own and
// SHOULD churn — rewording a description is how an agent's behaviour gets tuned,
// and the whole architecture rests on that staying free (only agents read them).
// If a red check ever seems to forbid rewording a description, it is being
// misread: nothing here touches prose. Data shape is the half with a SECOND
// consumer, and it is the only half this constrains.

/**
 * Where a shared resource appears inside a payload.
 *
 * A function selector rather than a path string: it is typed against the
 * payload, it survives a rename, and it can reach a nested or repeated position
 * (`p => p.children`) without a path mini-language nobody else uses.
 */
export interface ResourceProbe<T> {
  /** The v1 component this part must validate against. */
  readonly resource: SharedResourceName;
  /** Every occurrence of that resource in a payload. Empty is legitimate. */
  readonly select: (payload: T) => readonly unknown[];
}

/**
 * A tool payload's declared shape, plus the map of which SHARED resources it
 * carries and where.
 *
 * The ENVELOPE (`{ items, nextCursor }`, the detail aggregate's
 * `{ item, parent, children, … }`) stays MCP's own — it is transport shape, not
 * resource shape, and it is built for how an agent reads a result. The probes
 * are what 11.6.6's drift guard walks: for each one it pulls the parts out and
 * asserts they satisfy the v1 schema, so a field added on one surface and
 * forgotten on the other fails the build. ADR Amendment 7 Q6.
 */
export interface PayloadDefinition<T extends Record<string, unknown>> {
  /** The declared payload schema — a v1 resource schema, or a `.extend` /
   *  `.pick` / `.omit` derivation of one. Never a hand-authored look-alike. */
  readonly schema: z.ZodType<T>;
  /** Where the shared resources sit inside it. */
  readonly probes: readonly ResourceProbe<T>[];
}

/**
 * Declare a payload shape.
 *
 * An identity function whose job is to apply {@link PayloadDefinition}'s type at
 * the declaration site — the same reason `defineOperation` exists on the v1 side
 * and `lib/mcp/scopes.ts` annotates its map instead of letting inference widen
 * it.
 */
export function definePayload<T extends Record<string, unknown>>(
  definition: PayloadDefinition<T>,
): PayloadDefinition<T> {
  return definition;
}

/**
 * Build a payload from a declared schema.
 *
 * PARSES rather than casts, so a mapper that drifts from its own declaration
 * fails at the tool instead of reaching an agent. The parse is against the
 * payload's OWN schema (the widening), never the bare v1 schema — parsing
 * against the base would strip the agent-facing extras the widening exists to
 * carry.
 */
export function derived<T extends Record<string, unknown>>(
  definition: PayloadDefinition<T>,
  value: T,
): McpPayload {
  return brandPayload(definition.schema.parse(value) as Record<string, unknown>);
}

/**
 * Build a payload for a tool with NO shared resource to derive from.
 *
 * The parameter is typed to {@link ExemptToolName}, so passing a tool that is
 * not in `EXEMPT_TOOLS` is a compile error — the exemption has to be WRITTEN,
 * with its reason, before it can be used.
 */
export function exempt(_toolName: ExemptToolName, value: Record<string, unknown>): McpPayload {
  return brandPayload(value);
}

// ⚠️ The `unmigrated(toolName, value)` constructor was DELETED by MOTIR-2231
// (11.6.5) together with the `MIGRATING_TOOLS` map it read. Every registered
// tool is now DERIVED or EXEMPT, and there is deliberately no third way to build
// an `McpPayload` — which is what makes the guard's silence mean something.
