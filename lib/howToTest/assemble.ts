// The HOW TO TEST assembly — PURE (Story MOTIR-4906 · Subtask MOTIR-5333).
//
// `howToTestService.getForWorkItem` does the reads; this turns their rows into
// the one derived fact the block still draws beside the record — which sections
// were written for a commit their pull request has since moved past
// (`design/github/design-notes.md` § 25, Panel 12g). Kept pure so the binding and
// the head rule are testable without a database, and so the head rule it shares
// with the Development section's CI pill is visible in one place.
//
// ⚠️ THE PER-REPOSITORY FACTS ARE GONE (MOTIR-5691). This file used to compose a
// fetch line, pick a preview deployment and list the checks at the head, for a
// sub-block § 25 retired. Only the binding and the head survive, because STALE
// is a relation between the RECORD and the pull request and needs both.

import { liveRowsAtLatestSha, type PrCheckRunSlice } from '@/lib/github/prCiState';
import type { TestInstructionsRepoDTO } from '@/lib/dto/testInstructions';
import type { HowToTestStaleDto } from '@/lib/dto/howToTest';

/** The slice of a delivery's pull request the assembly reads. */
export interface HowToTestPullRequestInput {
  id: string;
  repoId: string;
  state: string;
  checkRuns: PrCheckRunSlice[];
}

/**
 * A pull request's HEAD sha by the Development section's own rule — the latest
 * recorded check-row sha, minus superseded runs — or null before any check.
 */
export function liveHeadSha(checkRuns: PrCheckRunSlice[]): string | null {
  return liveRowsAtLatestSha(checkRuns)[0]?.commitSha ?? null;
}

/**
 * Choose the pull request a repository section binds to: the RUN TARGET's own
 * delivery in that repository first (a story run's session pull request is
 * linked to the story), and only then one of its descendants'. Within a tier,
 * an OPEN pull request wins; otherwise the most recently linked.
 */
export function pickPullRequest<T extends { repoId: string; state: string }>(
  repoId: string,
  own: readonly T[],
  descendants: readonly T[],
): T | null {
  for (const tier of [own, descendants]) {
    const inRepo = tier.filter((pr) => pr.repoId === repoId);
    if (inRepo.length === 0) continue;
    return inRepo.find((pr) => pr.state === 'open') ?? inRepo[inRepo.length - 1]!;
  }
  return null;
}

/**
 * The record's sections whose bound pull request has moved past the commit the
 * section was written for, in the record's order.
 *
 * A section with no bound pull request, or whose pull request has no reported
 * head yet, is NOT stale — there is no head to have moved. A section written
 * against an ABBREVIATED sha of the head is not stale either.
 *
 * @param sections     the record's repository sections
 * @param own          the run target's own deliveries
 * @param descendants  its descendants' deliveries
 * @param repoNameOf   `owner/name` for a repository id, for the sentence
 */
export function staleSections(
  sections: readonly TestInstructionsRepoDTO[],
  own: readonly HowToTestPullRequestInput[],
  descendants: readonly HowToTestPullRequestInput[],
  repoNameOf: (repoId: string) => string,
): HowToTestStaleDto[] {
  const out: HowToTestStaleDto[] = [];
  for (const section of sections) {
    const pr = pickPullRequest(section.repoId, own, descendants);
    if (!pr) continue;
    const headSha = liveHeadSha(pr.checkRuns);
    if (headSha === null || headSha.startsWith(section.commitSha)) continue;
    out.push({ repoName: repoNameOf(section.repoId), recordSha: section.commitSha, headSha });
  }
  return out;
}
