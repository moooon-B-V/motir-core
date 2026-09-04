import './_loadEnv';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateMcpToolSchemas, MCP_TOOL_SCHEMAS_FILE } from './generateMcpToolSchemas';

// `pnpm generate:mcp-tool-schemas` — the RUNNER for the MCP tool input-schema
// generator (Story MOTIR-3875 · Subtask MOTIR-4389).
//
// All the work is in `scripts/generateMcpToolSchemas.ts`, which produces the
// file's contents in memory and touches no filesystem. This file is the half
// that writes, kept separate for one reason:
// `tests/mcp/tool-schema-truth.test.ts` calls the generator and compares, and a
// module that writes on import cannot be called by a guard whose whole job is to
// check whether writing was needed. `scripts/generate-cli-api.ts` is the same
// split for the same reason.
//
// `./_loadEnv` comes FIRST and is not decoration: the generator's import graph
// reaches `@/lib/db`, which constructs the Prisma client at module load and
// throws when `DATABASE_URL` is unset. Nothing here queries it —
// `tools/list` runs no handler — but it must be constructible.

async function main(): Promise<void> {
  const contents = await generateMcpToolSchemas();
  await writeFile(join(process.cwd(), MCP_TOOL_SCHEMAS_FILE), contents);
  process.stdout.write(`generated ${MCP_TOOL_SCHEMAS_FILE}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
