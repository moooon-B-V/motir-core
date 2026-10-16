// THE SEED COMMAND (Story MOTIR-8538 · MOTIR-8673).
//
//   pnpm loadtest:seed [--shape <file.json>] [--tag <runTag>] [--out <manifest path>]
//
// Fills a STAGING database with synthetic tenants — signed-in users in real
// workspaces, many agents (personal access tokens) per user and per workspace, a
// content backlog, resettable pools and scratch plans — through the shipped services,
// and writes the manifest every k6 scenario reads (`loadtest/.out/manifest.json`,
// mode 0600). With no `--shape` it seeds the smoke shape.
//
// Environment (every missing one is named at once, before any write):
//   DATABASE_URL                 the staging branch's pooled `motir_app` URL
//   DATABASE_URL_UNPOOLED        the same branch, direct
//   BETTER_AUTH_SECRET           the STAGING APP's own value, so the cookies minted here
//                                verify there (Fly secrets are write-only: the operator
//                                keeps the value the provisioning card generated)
//   GOOGLE_CLIENT_ID/_SECRET     placeholders suffice; lib/auth requires them at load
//   MOTIR_BASE_URL               staging's own `http://…flycast` origin — it decides the
//                                session cookie's NAME
//   NODE_ENV=production          as the staging app runs
//   LOADTEST_ALLOWED_DB_HOST     the staging branch's endpoint host
//   LOADTEST_PRODUCTION_DB_HOSTS production's endpoint hosts — MANDATORY, the guard
//                                fails closed without it
//
// ⚠️ RE-RUNNING WITH THE SAME --tag reuses the users, workspaces, projects, cards and
// plans it finds, DELETES the tag's previous tokens and MINTS NEW tokens and cookies,
// then writes a fresh manifest — an earlier token's plaintext cannot be recovered.
// It never prints a token or a cookie.

import { readFile } from 'node:fs/promises';
import { assertSeedTarget, missingSeedEnv } from './guard';
import { DEFAULT_MANIFEST_PATH, writeManifest } from './manifest';
import { SMOKE_SHAPE, validateSeedShape, type SeedShape } from './shape';

/** The CLI's options, exported so the runbook's guard test reads flags without parsing text. */
export const OPTIONS = {
  shape: {
    flag: '--shape',
    required: false,
    description: 'a JSON SeedShape (the profile’s seed section); the smoke shape when omitted',
  },
  tag: {
    flag: '--tag',
    required: false,
    description: 'the run tag naming every synthetic row; re-seeding a tag reuses its tenants',
  },
  out: {
    flag: '--out',
    required: false,
    description: 'where to write the manifest (default loadtest/.out/manifest.json)',
  },
} as const;

export const DEFAULT_RUN_TAG = 'lt';

export function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

/** A run tag is part of emails, names and labels: keep it short and plain. */
export function validRunTag(tag: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,23}$/.test(tag);
}

export async function loadShape(path: string | undefined): Promise<SeedShape> {
  if (!path) return SMOKE_SHAPE;
  return validateSeedShape(JSON.parse(await readFile(path, 'utf8')));
}

/**
 * The whole command over explicit inputs. Returns the exit code; every refusal
 * happens before `./tenants` is imported, so before any database connection.
 */
export async function runSeed(
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
  const tag = argValue(argv, OPTIONS.tag.flag) ?? DEFAULT_RUN_TAG;
  if (!validRunTag(tag)) {
    log(`refused: --tag must match [a-z0-9][a-z0-9-]{0,23}, got ${tag}`);
    return 2;
  }
  const shape = await loadShape(argValue(argv, OPTIONS.shape.flag));
  const out = argValue(argv, OPTIONS.out.flag) ?? DEFAULT_MANIFEST_PATH;

  log(`seeding tag "${tag}" (${shape.smoke ? 'smoke' : 'custom'} shape) into ${host}`);
  log(
    're-seeding a tag reuses its users, workspaces and projects, deletes its previous tokens ' +
      'and mints new tokens and cookies',
  );
  const { seedTenants } = await import('./tenants');
  const manifest = await seedTenants(shape, { runTag: tag, databaseHost: host, log });
  await writeManifest(manifest, out);
  log(`manifest written to ${out} (mode 0600; it holds credentials — never commit or print it)`);
  return 0;
}

/* v8 ignore start -- the process entry over `runSeed`, which tests/loadtest/seed.test.ts drives. */
if (/seed[\\/]seed\.ts$/.test(process.argv[1] ?? '')) {
  runSeed(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
/* v8 ignore stop */
