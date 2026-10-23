#!/usr/bin/env node
/**
 * Put a Fly app back on ONE image before a blue-green deploy (MOTIR-9354).
 *
 * Run it before `flyctl deploy`:
 *
 *   FLY_API_TOKEN=… node scripts/repair-fly-image-set.mjs --app motir-core
 *
 * and, after a failed release, to name the images it left behind:
 *
 *   FLY_API_TOKEN=… node scripts/repair-fly-image-set.mjs --app motir-core --report-only
 *
 * WHAT IT DECIDES, and when it refuses: see `scripts/flyImageSet.mjs`, which
 * holds the whole decision and is the file with the tests. This runner parses
 * arguments and exits, nothing more.
 *
 * EXIT CODES: 0 single image (or repaired, or a report) · 1 refused · 2 usage ·
 * 3 the read was blind.
 */
import { EXIT_BLIND_READ, EXIT_USAGE, repairImageSet } from './flyImageSet.mjs';

function parseArgs(argv) {
  const args = { app: process.env['FLY_APP'] ?? '', reportOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') args.app = argv[++i] ?? '';
    else if (argv[i] === '--report-only') args.reportOnly = true;
    else return { ...args, error: `unknown argument: ${argv[i]}` };
  }
  if (!args.app) return { ...args, error: 'no app named — pass --app <name> or set FLY_APP' };
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`::error::${args.error}`);
    console.error('usage: repair-fly-image-set.mjs --app <name> [--report-only]');
    return EXIT_USAGE;
  }
  const token = process.env['FLY_API_TOKEN'];
  if (!token) {
    console.error('::error::FLY_API_TOKEN is not set — this guard cannot read the platform.');
    return EXIT_BLIND_READ;
  }
  return repairImageSet({ app: args.app, token, reportOnly: args.reportOnly });
}

process.exit(await main());
