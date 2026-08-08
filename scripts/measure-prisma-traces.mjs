#!/usr/bin/env node
// Count how many of the build's traced server functions carry the Prisma client.
//
// WHY THIS EXISTS (MOTIR-2381). Next traces every server function's file
// closure into `.next/server/**/*.nft.json`; `copyTracedFiles` ships exactly
// that union. So "does this route carry a database client" is not a question
// about imports you can answer by reading source — a route inherits everything
// its ROOT layout reaches, and the manifest is the only place that shows it.
//
// Read the manifest, never the config: `outputFileTracingExcludes` /
// `outputFileTracingIncludes` are INERT under Turbopack (Next 16's default
// bundler) because `build/index.js` guards `collect-build-traces.js` with
// `bundler !== Bundler.Turbopack` — a dead exclusion reads exactly like a
// solved size problem. Measured, not asserted, is the whole point.
//
// Usage:
//   next build && node scripts/measure-prisma-traces.mjs [--json] [--list]
//
// Exit code is 0 whenever the manifests could be read; this reports, it does
// not gate. The regression guard on the ROOT layout's own imports lives in
// tests/build/root-layout-db-imports.test.ts and needs no build.

/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const TRACE_ROOT = join(process.cwd(), '.next', 'server');

/** A traced path counts as the Prisma client itself, not merely a name match. */
const PRISMA_MARKERS = ['node_modules/@prisma/client/', 'node_modules/.prisma/client/'];

function findTraces(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTraces(full));
    else if (entry.name.endsWith('.nft.json')) out.push(full);
  }
  return out;
}

const traces = findTraces(TRACE_ROOT);
if (traces.length === 0) {
  console.error(
    `No .nft.json manifests under ${relative(process.cwd(), TRACE_ROOT)} — run \`next build\` first.`,
  );
  process.exit(1);
}

const carriers = [];
const clean = [];

for (const trace of traces) {
  const name = relative(TRACE_ROOT, trace).replace(/\.nft\.json$/, '');
  const { files = [] } = JSON.parse(readFileSync(trace, 'utf8'));
  // Trace entries are relative to the manifest's own directory and full of
  // `../` hops, so normalise to a forward-slash suffix match on the marker.
  const carries = files.some((file) =>
    PRISMA_MARKERS.some((marker) => file.replace(/\\/g, '/').includes(marker)),
  );
  (carries ? carriers : clean).push(name);
}

carriers.sort();
clean.sort();

const summary = {
  total: traces.length,
  carryingPrismaClient: carriers.length,
  clean: clean.length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ...summary, carriers, cleanFunctions: clean }, null, 2));
} else {
  console.log(
    `${summary.carryingPrismaClient} of ${summary.total} traced functions carry @prisma/client`,
  );
  console.log(`\nThe ${clean.length} that do NOT:`);
  for (const name of clean) console.log(`  ${name}`);
  if (process.argv.includes('--list')) {
    console.log(`\nThe ${carriers.length} that DO:`);
    for (const name of carriers) console.log(`  PRISMA  ${name}`);
  }
}

// Touch statSync so a manifest that vanished mid-read fails loudly rather than
// being silently counted as clean.
for (const trace of traces) statSync(trace);
