import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_API_DIR, generateCliApi } from './generateCliApi';

// `pnpm generate:cli-api` — the RUNNER for the `@motir/cli` v1 client generator.
//
// All the work is in `scripts/generateCliApi.ts`, which produces the artifacts in
// memory and touches no filesystem. This file is the half that writes them, kept
// separate for one reason: `tests/cli/generated-api-freshness.test.ts` calls the
// generator and compares, and a module that writes on import cannot be called by
// a guard whose whole job is to check whether writing was needed.

async function main(): Promise<void> {
  const artifacts = await generateCliApi();
  const outDir = join(process.cwd(), CLI_API_DIR);
  await mkdir(outDir, { recursive: true });
  for (const [name, contents] of Object.entries(artifacts)) {
    await writeFile(join(outDir, name), contents);
  }
  process.stdout.write(
    `generated ${Object.keys(artifacts).length} artifacts into ${CLI_API_DIR}/\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
