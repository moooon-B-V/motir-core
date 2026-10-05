import type { ReauditRepoJobsDTO } from '@/lib/dto/codeHealth';

/**
 * One queued repo AS THE BROWSER RECORDS IT: the trigger's answer plus the
 * moment this browser queued it (MOTIR-7620). `queuedAt` is what a resumed run
 * times its deriving row from — the job read carries no timestamp, and the
 * repo's previous audit is the wrong clock. Optional because a record written
 * before it existed has none; such a row falls back to "just started".
 */
export type StoredReauditRepo = ReauditRepoJobsDTO & { queuedAt?: string };

export interface StoredReauditRun {
  repos: StoredReauditRepo[];
}

// The in-flight re-audit RECORD's merge rule (MOTIR-2249), kept out of the
// island so it can be reasoned about and tested on its own.
//
// The record is what a later mount resumes from (MOTIR-2223). Once a run can be
// SCOPED to a subset of repos, "write what I just queued" stops being safe: a
// whole-set run still deriving five repos, followed by a one-repo re-audit that
// overwrote the record, would leave the other four finishing with nothing
// watching them — and the next visitor would be invited to start them again,
// which is exactly the duplicate-fan-out defect MOTIR-2223 removed.
//
// So a run may only ever ADD to what is being watched: union by `repoKey`, with
// the newest entry winning for a repo that appears in both. A narrower run can
// never narrow the record.
export function mergeReauditRun(
  stored: StoredReauditRun | null,
  queued: StoredReauditRepo[],
): StoredReauditRun {
  const byRepo = new Map<string | null, StoredReauditRepo>();
  for (const entry of stored?.repos ?? []) byRepo.set(entry.repoKey, entry);
  for (const entry of queued) byRepo.set(entry.repoKey, entry);
  return { repos: [...byRepo.values()] };
}
