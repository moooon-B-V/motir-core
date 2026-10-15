// THE DATABASE THAT ANSWERS, AND ITS DATE (Story MOTIR-8538 · MOTIR-8678).
//
// `neonctl branches get <branch> --project-id <project> --output json` gives the
// branch id and the copied-from time; `neonctl connection-string <branch>
// --project-id <project> --role-name motir_app` gives its endpoint (the branch is
// POSITIONAL — there is no `--branch` flag; the DIRECT host by default, `--pooled`
// adds `-pooler`; Neon CLI reference, read 2026-10-15). Hosts are compared after
// `endpointHost`, so a pooled host matches its direct one. No URL is returned or
// printed — only hosts.
//
// ── WHICH TIME IS "COPIED FROM" ──────────────────────────────────────────────
// In this order, and `run.json` names the one that answered (`copiedAtField`):
//   1. `refreshedAt` in loadtest/.out/refresh.json — the refresh step's own
//      completion time (UTC);
//   2. a reset-time key on the branch JSON (`last_reset_at`; the CLI's reset output
//      prints "Last Reset At", the JSON key is NOT documented — a hypothesis until
//      a real branch is read);
//   3. `parent_timestamp` (the Neon API branch object);
//   4. `created_at`.
// ⚠️ The fixtures follow the documented API branch object. No neonctl was reachable
// where this was written (MOTIR-8678's recorded discrepancy).

import { endpointHost } from '../lib/endpointHost';
import { PlatformReadError, type Exec } from './fly';

/** The branch-JSON keys tried for the reset time, in order. */
export const RESET_TIME_KEYS = ['last_reset_at', 'reset_at', 'lastResetAt'] as const;

export type CopiedAtField =
  | 'refresh.json'
  | (typeof RESET_TIME_KEYS)[number]
  | 'parent_timestamp'
  | 'created_at';

export interface NeonBranch {
  branchId: string;
  copiedAt: string;
  copiedAtField: CopiedAtField;
}

type Json = Record<string, unknown>;

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Pick the copied-from time. `refresh` is the parsed refresh.json (or null);
 * `branchJson` is `neonctl branches get --output json` (a branch, or `{ branch }`).
 */
export function copiedFrom(refresh: unknown, branchJson: unknown): NeonBranch {
  const top = (branchJson && typeof branchJson === 'object' ? branchJson : {}) as Json;
  const branch = (top['branch'] && typeof top['branch'] === 'object' ? top['branch'] : top) as Json;
  const id = branch['id'];
  if (typeof id !== 'string' || !id) throw new PlatformReadError('the Neon branch JSON has no id');
  const refreshedAt = (refresh as Json | null)?.['refreshedAt'];
  if (isTime(refreshedAt))
    return { branchId: id, copiedAt: refreshedAt, copiedAtField: 'refresh.json' };
  for (const key of RESET_TIME_KEYS) {
    if (isTime(branch[key])) return { branchId: id, copiedAt: branch[key], copiedAtField: key };
  }
  for (const key of ['parent_timestamp', 'created_at'] as const) {
    if (isTime(branch[key])) return { branchId: id, copiedAt: branch[key], copiedAtField: key };
  }
  throw new PlatformReadError('the Neon branch JSON carries none of the copied-from times');
}

/** `neonctl branches get`, parsed. */
export async function readBranch(exec: Exec, project: string, branch: string): Promise<unknown> {
  const r = await exec('neonctl', [
    'branches',
    'get',
    branch,
    '--project-id',
    project,
    '--output',
    'json',
  ]);
  if (r.code !== 0) throw new PlatformReadError(`neonctl branches get exited ${r.code}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new PlatformReadError('neonctl branches get did not return JSON');
  }
}

/** The branch's endpoint host (`neonctl connection-string`), the URL itself discarded. */
export async function readBranchHost(exec: Exec, project: string, branch: string): Promise<string> {
  const r = await exec('neonctl', [
    'connection-string',
    branch,
    '--project-id',
    project,
    '--role-name',
    'motir_app',
  ]);
  if (r.code !== 0) throw new PlatformReadError(`neonctl connection-string exited ${r.code}`);
  const host = endpointHost(r.stdout.trim().split('\n').pop());
  if (!host) throw new PlatformReadError('neonctl connection-string returned no readable host');
  return host;
}
