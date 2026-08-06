import type { ReauditResultDTO } from '@/lib/dto/codeHealth';

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
  stored: ReauditResultDTO | null,
  queued: ReauditResultDTO['repos'],
): ReauditResultDTO {
  const byRepo = new Map<string | null, ReauditResultDTO['repos'][number]>();
  for (const entry of stored?.repos ?? []) byRepo.set(entry.repoKey, entry);
  for (const entry of queued) byRepo.set(entry.repoKey, entry);
  return { repos: [...byRepo.values()] };
}
