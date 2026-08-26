#!/usr/bin/env node
/**
 * Assert that a Fly app's machine pool matches the SHAPE `fly.toml` declares
 * (MOTIR-3570) — the deploy job's post-release verification.
 *
 * Run it after `flyctl deploy`:
 *
 *   FLY_API_TOKEN=… node scripts/assert-machine-pool.mjs --app motir-core
 *
 * WHAT IT ASSERTS, and why it is not a count: see `scripts/machinePool.mjs`,
 * which holds the whole derivation and is the file with the tests. This runner
 * does three things only — read the config, read the platform, print — so that
 * the part with a decision in it is callable without a network or a `process.exit`.
 *
 * ⚠️ THE EXPECTATION COMES FROM `fly.toml`; THE OBSERVATION NEVER DOES. That
 * split is MOTIR-2102's whole lesson and it is preserved here: every number
 * compared against the file is read from `GET /v1/apps/<app>/machines`.
 *
 * EXIT CODES: 0 clean · 1 drift · 2 usage · 3 the read was blind.
 */
/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */
import { readFileSync } from 'node:fs';
import { EXIT_BLIND_READ, EXIT_USAGE, assertPool, formatResult } from './machinePool.mjs';

function parseArgs(argv) {
  const args = { app: process.env['FLY_APP'] ?? '', config: 'fly.toml' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') args.app = argv[++i] ?? '';
    else if (argv[i] === '--config') args.config = argv[++i] ?? '';
    else return { ...args, error: `unknown argument: ${argv[i]}` };
  }
  if (!args.app) return { ...args, error: 'no app named — pass --app <name> or set FLY_APP' };
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`::error::${args.error}`);
    console.error('usage: assert-machine-pool.mjs --app <name> [--config fly.toml]');
    return EXIT_USAGE;
  }

  const token = process.env['FLY_API_TOKEN'];
  if (!token) {
    console.error('::error::FLY_API_TOKEN is not set — this guard cannot read the platform.');
    return EXIT_BLIND_READ;
  }

  let machines;
  try {
    const res = await fetch(`https://api.machines.dev/v1/apps/${args.app}/machines`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      // Fly answers not-found, never forbidden, for an app a token cannot see —
      // so a 404 here is "unreachable OR out of scope", and saying only the
      // first would send the reader to the wrong place.
      console.error(
        `::error::Fly's API answered ${res.status} for ${args.app} — the app is unreachable, ` +
          'or the token cannot see it (Fly answers not-found, never forbidden).',
      );
      return EXIT_BLIND_READ;
    }
    machines = await res.json();
  } catch (error) {
    console.error(`::error::Could not read Fly's machine list for ${args.app}: ${error}`);
    return EXIT_BLIND_READ;
  }

  const result = assertPool(readFileSync(args.config, 'utf8'), machines);
  console.log(formatResult(args.app, result));
  return result.code;
}

process.exit(await main());
