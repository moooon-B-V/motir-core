import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { format, resolveConfig } from 'prettier';
import { buildMcpServer } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The MCP tool INPUT-SCHEMA generator (Story MOTIR-3875 · Subtask MOTIR-4389).
//
// It turns ONE input — a live `tools/list` handshake against `buildMcpServer` —
// into ONE artifact: `lib/apiDocs/mcpToolSchemas.ts`, the map the published
// catalogue (`GET /api/docs/mcp-tools.json`) serves as each tool's `inputSchema`.
//
// ── Why a GENERATED artifact and not a direct read ──────────────────────────
// The schemas are declared inside each tool's `registerTool(...)` call, so the
// only way to READ them is to build the server — and building it imports every
// tool module, every service and Prisma. `lib/apiDocs/mcp.ts` may not do that:
// its header states the dependency-graph rule, and
// `tests/api/docs/mcp-tools-route.test.ts` pins it from the route's side too
// (the anonymous handler's imports are asserted to be exactly two). A generated
// leaf is what lets the document carry a value only the registry can produce
// without putting the registry behind an anonymous route.
//
// ⚠️ IT IS NOT A SECOND DECLARATION, and the difference is a guard rather than a
// promise. `tests/mcp/tool-schema-truth.test.ts` recomputes this file from a
// live handshake and compares it BYTE FOR BYTE; a schema edited by hand, or a
// tool whose arguments changed underneath the committed map, is red. That is
// the same shape `tests/cli/generated-api-freshness.test.ts` holds over
// `packages/cli/src/api/`, and a stronger one than the fingerprint gate beside
// it in `tests/mcp/tool-doc-truth.test.ts`: this pins the whole value, not a
// hash of it.
//
// ── No filesystem here ──────────────────────────────────────────────────────
// This module produces the file's CONTENTS in memory and writes nothing;
// `scripts/generate-mcp-tool-schemas.ts` is the half that writes. A module that
// wrote on import could not be called by a guard whose job is to check whether
// writing was needed — `scripts/generateCliApi.ts`'s split, for the same reason.
//
// ── No database ─────────────────────────────────────────────────────────────
// `tools/list` runs no handler and resolves no actor, so the stub context below
// is honest — the same one the fingerprint gate uses. Prisma is CONSTRUCTED at
// import (which is why the runner loads `.env` first) and never queried.

/** Where the generated map lands, relative to the repository root. */
export const MCP_TOOL_SCHEMAS_FILE = join('lib', 'apiDocs', 'mcpToolSchemas.ts');

/** `tools/list` runs no handler and needs no actor, so a stub context is honest. */
const STUB_CONTEXT = { userId: 'generate', workspaceId: 'generate' } as unknown as ServiceContext;

/** One tool as the handshake reports it — only the two fields this script reads. */
interface ListedTool {
  name: string;
  inputSchema: unknown;
}

/**
 * Every tool the server exposes, with the schema `tools/list` serves for it.
 *
 * SORTED by name, because the handshake's order is the registry's registration
 * order and a re-ordering there would otherwise rewrite this file for no change
 * in content. Determinism is what makes the freshness guard a signal instead of
 * a source of churn.
 */
export async function listShippedToolSchemas(): Promise<[string, unknown][]> {
  const server = buildMcpServer(() => STUB_CONTEXT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-tool-schema-generator', version: '0.0.0' });
  await client.connect(clientTransport);
  const listed = (await client.listTools()).tools as ListedTool[];
  await client.close();
  return listed
    .map((tool): [string, unknown] => [tool.name, tool.inputSchema])
    .sort(([a], [b]) => a.localeCompare(b));
}

const HEADER = `// ⚠️ GENERATED — DO NOT EDIT. Run \`pnpm generate:mcp-tool-schemas\`.
//
// Every MCP tool's \`inputSchema\`, exactly as \`tools/list\` serves it
// (Story MOTIR-3875 · Subtask MOTIR-4389). Written by
// \`scripts/generateMcpToolSchemas.ts\` from a live handshake against
// \`buildMcpServer\`, and pinned byte-for-byte against a fresh one by
// \`tests/mcp/tool-schema-truth.test.ts\` — so this file cannot drift from the
// server, and a hand edit is red rather than published.
//
// ── Why the schemas are copied HERE at all ──────────────────────────────────
// \`lib/apiDocs/mcp.ts\` is a LEAF: it imports \`lib/mcp/toolPermissions.ts\` and
// nothing else from \`lib/mcp/\`, so that the anonymous
// \`GET /api/docs/mcp-tools.json\` handler does not pull the tool registry, the
// services and Prisma behind it. The schemas live inside \`registerTool(...)\`
// calls that only the registry can reach. This module is the seam: a value the
// registry produced, in a file that imports nothing at runtime.
//
// The map is TOTAL over the tool set by TYPE — a tool added to the registry
// forces a \`TOOL_PERMISSIONS\` entry, which makes this annotation incomplete and
// this file a compile error until it is regenerated.

import type { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import type { McpToolInputSchema } from './mcpToolSchema';

/** Tool name → the draft-07 JSON Schema of its arguments. */
export const MCP_TOOL_INPUT_SCHEMAS: Record<
  keyof typeof TOOL_PERMISSIONS,
  McpToolInputSchema
> = `;

/**
 * The file's contents, from a live handshake.
 *
 * Prettier-formatted with the repository's OWN resolved configuration rather
 * than `.prettierignore`d: a generated file that `pnpm format:check` cannot read
 * is one more exemption to remember, and formatting it here costs one call and
 * keeps the artifact deterministic under both guards at once.
 *
 * ⚠️ `resolveConfig` is not optional — `format` with only a `filepath` picks
 * prettier's DEFAULTS (double quotes, 80 columns), which `format:check` then
 * rewrites on the first run, and the freshness guard would go red on
 * formatting rather than on staleness. The config must be READ.
 */
export async function generateMcpToolSchemas(): Promise<string> {
  const entries = await listShippedToolSchemas();
  const body = `{\n${entries
    .map(([name, schema]) => `${JSON.stringify(name)}: ${JSON.stringify(schema)},`)
    .join('\n')}\n}`;
  const options = await resolveConfig(MCP_TOOL_SCHEMAS_FILE);
  return format(`${HEADER}${body};\n`, { ...options, filepath: MCP_TOOL_SCHEMAS_FILE });
}

/** What is committed today, or `null` when the file does not exist yet. */
export async function readCommittedMcpToolSchemas(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, MCP_TOOL_SCHEMAS_FILE), 'utf8');
  } catch {
    return null;
  }
}

/**
 * THE PREDICATE, extracted so the counterfactual in the guard can drive the SAME
 * code the real assertion runs: is what is committed what the registry produces?
 */
export function isMcpToolSchemasStale(generated: string, committed: string | null): boolean {
  return committed !== generated;
}
