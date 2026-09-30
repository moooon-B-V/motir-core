// The SHAPE of one MCP tool's arguments, as the published catalogue carries it
// (Story MOTIR-3875 · Subtask MOTIR-4389).
//
// This module is hand-written and holds only the type; the VALUES live in
// `mcpToolSchemas.ts`, which is generated. The split is the same one
// `packages/cli/src/api/` uses: a generator owns a whole file or none of it, so
// a type nobody generated does not sit inside a file a script rewrites.
//
// ── It is a JSON Schema, verbatim ───────────────────────────────────────────
// Not a flattened parameter list. The MCP protocol's `tools/list` answers a
// draft-07 JSON Schema per tool — that is how every MCP client renders
// arguments — and the published document carries exactly that value, with
// nothing dropped and nothing re-shaped. A flattened list would be cheaper for
// one consumer to render and would silently lose `anyOf`, nested objects,
// arrays and item schemas; the route's header comment states the choice and its
// reason where a reader of the artifact will meet it.
//
// The consumer decides how DEEP to render. This side's contract is that the
// value is the schema the server serves.

/**
 * One tool's `inputSchema`, as `tools/list` serves it: a draft-07 JSON Schema
 * object.
 *
 * The three keys named below are the ones every tool carries and the ones a
 * renderer needs — a property's type, and whether it is required. The index
 * signature keeps the rest (`$schema`, `additionalProperties`, and whatever the
 * SDK's zod conversion emits next) without this type having to be edited each
 * time, which is what lets the generator write a value it did not have to
 * negotiate with a hand-written interface.
 */
export interface McpToolInputSchema {
  /** Always `'object'` — an MCP tool takes named arguments or none. */
  type: 'object';
  /** Argument name → its own schema. `{}` for a tool that takes none. */
  properties?: Record<string, unknown>;
  /** The argument names that MUST be supplied. Absent when none are. */
  required?: string[];
  /** Whatever else the conversion emits — carried, never interpreted here. */
  [key: string]: unknown;
}

// ── A tool's HINTS (Story MOTIR-6974 · Subtask MOTIR-7002) ──────────────────
// The `annotations` object `tools/list` serves for a tool, as the catalogue
// carries it. The shape is `lib/mcp/toolAnnotations.ts`'s row type, RE-DECLARED
// here rather than imported, so the catalogue's modules keep their rule of
// reaching nothing in `lib/mcp/` beyond `toolPermissions.ts`. That the VALUES
// agree with the server is `tests/mcp/tool-schema-truth.test.ts`'s guard, over a
// live handshake — a drift in the shape would surface there as a value mismatch.

/** A tool whose handler performs no write. */
export interface McpToolReadHints {
  readOnlyHint: true;
  openWorldHint: boolean;
}

/** A tool whose handler writes — every write hint is always present. */
export interface McpToolWriteHints {
  readOnlyHint: false;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** One tool's `annotations`, exactly as `tools/list` serves it. */
export type McpToolHints = McpToolReadHints | McpToolWriteHints;
