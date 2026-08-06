import type { McpToolName } from '../registry';

// The MCP PAYLOAD BRAND (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// `toolOk`'s second parameter used to be `Record<string, unknown>`, which every
// object literal satisfies — so "this tool's payload derives from a shared
// schema" was a property a reviewer had to check, and an absent tool was
// indistinguishable from a covered one.
//
// This module makes it a TYPE. {@link McpPayload} carries a `unique symbol`
// property that no literal can supply, so the ONLY way to produce one is through
// a constructor in `./define` — and each of those requires the tool to be either
// DERIVED from a declared shared schema or listed in the exemption registry.
// A tool in neither column cannot construct an argument for `toolOk` at all.
//
// The same guarantee `TOOL_SCOPES: Record<McpToolName, TokenScope>` gives the
// scope model, applied to payload shape. ADR Amendment 7 Q4 records the choice
// and what was rejected.
//
// ── Why the brand lives in its own zod-free module ──────────────────────────
// `lib/mcp/toolResult.ts` and every tool import this type. The DERIVATION
// modules are on `zod/v4` (Amendment 7 Q3) while the tools' `inputSchema`s are
// classic `zod`, and the two do not interoperate — so the boundary is kept clean
// by making the thing they SHARE carry no zod at all.

declare const MCP_PAYLOAD_BRAND: unique symbol;

/**
 * A tool payload that has passed through the seam.
 *
 * Structurally a JSON object, plus a phantom brand no literal can produce. Build
 * one with `derived`, `exempt` or `unmigrated` from `./define`; there is no
 * fourth way, and that is the point.
 */
export type McpPayload = Record<string, unknown> & {
  readonly [MCP_PAYLOAD_BRAND]: 'mcp-payload';
};

/**
 * Brand a plain object. Module-private by convention — `./define`'s three
 * constructors are the sanctioned entry points, and each enforces its own
 * precondition before calling this.
 *
 * Exported only because `./define` is a sibling module; nothing outside
 * `lib/mcp/payloads/` should import it, and `tests/mcp/payload-totality.test.ts`
 * asserts that no tool does.
 */
export function brandPayload(value: Record<string, unknown>): McpPayload {
  return value as McpPayload;
}

/** A tool name, re-exported so the payload modules need not reach past the seam. */
export type PayloadToolName = McpToolName;
