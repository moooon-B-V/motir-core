// THE RESET COMMAND (Story MOTIR-8538 · MOTIR-8673).
//
//   pnpm loadtest:seed:reset [--manifest <path>]
//
// Puts the seeded pools back without re-seeding: claimed or run cards go back to
// `todo` and are unassigned, burst cards return to their first parent, and scratch
// plans that grew are declined and replaced with fresh `generating` plans (read plans
// are left alone). Users, sessions and tokens are kept, and the manifest is rewritten
// to match.
//
// It reads the EXISTING manifest to learn the ids. A lost manifest cannot be
// recovered here — token plaintext is shown once and only its hash is stored — so a
// missing one exits non-zero before any write and names the re-seed as the recovery.
//
// Environment: the same as `pnpm loadtest:seed` (see loadtest/seed/seed.ts), checked
// the same way, before any write.

import { assertSeedTarget, missingSeedEnv } from './guard';
import {
  DEFAULT_MANIFEST_PATH,
  ManifestMissingError,
  readManifest,
  writeManifest,
} from './manifest';
import { argValue } from './seed';

/** The CLI's options, exported so the runbook's guard test reads flags without parsing text. */
export const OPTIONS = {
  manifest: {
    flag: '--manifest',
    required: false,
    description:
      'the manifest the seed wrote (default loadtest/.out/manifest.json); rewritten in place',
  },
} as const;

export async function runReset(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): Promise<number> {
  const missing = missingSeedEnv(env);
  if (missing.length > 0) {
    log(`refused: missing environment — ${missing.join(', ')}`);
    return 2;
  }
  let host: string;
  try {
    host = assertSeedTarget(env);
  } catch (err) {
    log(`refused: ${(err as Error).message}`);
    return 2;
  }
  const path = argValue(argv, OPTIONS.manifest.flag) ?? DEFAULT_MANIFEST_PATH;
  let manifest;
  try {
    manifest = await readManifest(path);
  } catch (err) {
    if (err instanceof ManifestMissingError) {
      log(`refused: ${err.message}`);
      return 3;
    }
    throw err;
  }
  if (manifest.databaseHost !== host) {
    log(
      `refused: the manifest was seeded into ${manifest.databaseHost}, but this target is ${host}`,
    );
    return 2;
  }
  log(`resetting tag "${manifest.runTag}" in ${host}`);
  const { resetPools } = await import('./tenants');
  await writeManifest(await resetPools(manifest, log), path);
  log(`manifest rewritten at ${path}`);
  return 0;
}

/* v8 ignore start -- the process entry over `runReset`, which tests/loadtest/seed.test.ts drives. */
if (/seed[\\/]reset\.ts$/.test(process.argv[1] ?? '')) {
  runReset(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
/* v8 ignore stop */
