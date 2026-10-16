// pg_stat_statements BEFORE AND AFTER THE LOAD (Story MOTIR-8538 · MOTIR-8683).
//
// Two snapshots through the shipped read (`readTopStatements`,
// scripts/pgTopStatementsQuery.ts, MOTIR-8552): its top-200 rankings by total
// time, mean time and calls, with `answeredBy` and `coverage.statsReset`, written
// as-is — a non-`ok` state included. Nothing clears the counters (that would be a
// write); the report diffs the two snapshots instead.
//
// ⚠️ Top-N lists, not the whole table, and no `queryid`. A statement that enters or
// leaves the top 200 between the snapshots has no matching row: the report diffs
// only statements present in both (by normalised text) and lists the rest apart.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_LIMIT, type TopStatementsResult } from '../../scripts/pgTopStatements';
import { readTopStatements } from '../../scripts/pgTopStatementsQuery';
import { redact } from './redact';

export type PgssSnapshot = 'pgss-before' | 'pgss-after';

export type ReadTopStatements = (url: string, limit: number) => Promise<TopStatementsResult>;

/** Take one snapshot into `<name>.json`; a failure is written there and in `<name>.state.json`. */
export async function snapshotPgss(opts: {
  name: PgssSnapshot;
  directUrl: string | null;
  outDir: string;
  read?: ReadTopStatements;
  unreadReason?: string;
}): Promise<TopStatementsResult | { state: 'failed'; reason: string }> {
  const file = join(opts.outDir, `${opts.name}.json`);
  let result: TopStatementsResult | { state: 'failed'; reason: string };
  if (!opts.directUrl) {
    result = { state: 'failed', reason: opts.unreadReason ?? 'no direct connection string' };
  } else {
    try {
      result = await (opts.read ?? readTopStatements)(opts.directUrl, MAX_LIMIT);
    } catch (err) {
      result = { state: 'failed', reason: redact((err as Error).message, [opts.directUrl]) };
    }
  }
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  if (result.state === 'failed') {
    await writeFile(
      join(opts.outDir, `${opts.name}.state.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return result;
}
