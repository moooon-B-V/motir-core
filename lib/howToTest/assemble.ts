// The HOW TO TEST assembly — PURE (Story MOTIR-4906 · Subtask MOTIR-5333).
//
// `howToTestService.getForWorkItem` does the reads; this turns their rows into
// one repository section of the run target's block. Kept pure so every arm — and every "why a path is
// missing" — is testable without a database, and so the one head-sha rule it
// shares with the Development section's CI pill is visible in one place.

import { liveRowsAtLatestSha, type PrCheckRunSlice } from '@/lib/github/prCiState';
import { DEPLOYMENT_STATES } from '@/lib/git/types';
import type { TestInstructionsRepoDTO } from '@/lib/dto/testInstructions';
import type {
  HowToTestCheckConclusion,
  HowToTestCheckDto,
  HowToTestDeploymentState,
  HowToTestPreviewDto,
  HowToTestRepoDto,
} from '@/lib/dto/howToTest';

/** The slice of a delivery's pull request the assembly reads. */
export interface HowToTestPullRequestInput {
  id: string;
  repoId: string;
  headRef: string;
  state: string;
  merged: boolean;
  checkRuns: Array<PrCheckRunSlice & { checkName: string }>;
}

/** The slice of a stored deployment the assembly reads. */
export interface HowToTestDeploymentInput {
  repoId: string;
  commitSha: string;
  ref: string;
  environment: string;
  state: string;
  environmentUrl: string | null;
  occurredAt: Date;
}

const CHECK_CONCLUSIONS: readonly Exclude<HowToTestCheckConclusion, 'unknown'>[] = [
  'success',
  'failure',
  'pending',
  'neutral',
];

/**
 * A stored state as the closed union. A value no member names maps to the
 * `unknown` arm WITH its raw value — never to a plausible member, which would
 * render a state nobody reported.
 */
export function toDeploymentState(raw: string): {
  state: HowToTestDeploymentState;
  rawState: string | null;
} {
  return (DEPLOYMENT_STATES as readonly string[]).includes(raw)
    ? { state: raw as HowToTestDeploymentState, rawState: null }
    : { state: 'unknown', rawState: raw };
}

export function toCheckConclusion(raw: string): {
  conclusion: HowToTestCheckConclusion;
  rawConclusion: string | null;
} {
  return (CHECK_CONCLUSIONS as readonly string[]).includes(raw)
    ? { conclusion: raw as HowToTestCheckConclusion, rawConclusion: null }
    : { conclusion: 'unknown', rawConclusion: raw };
}

/**
 * Quote a value for a POSIX shell. A plain ref (`feat/MOTIR-7-change`) is left
 * bare so the copied block reads naturally; anything carrying a character the
 * shell would interpret is single-quoted with embedded quotes escaped, so a
 * hostile or merely unusual branch name can never become a different command.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._\/@%+=:,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A pull request's HEAD sha by the Development section's own rule — the latest
 * recorded check-row sha, minus superseded runs — or null before any check.
 */
export function liveHeadSha(checkRuns: PrCheckRunSlice[]): string | null {
  return liveRowsAtLatestSha(checkRuns)[0]?.commitSha ?? null;
}

/** The fetch line the read composes — never the agent. */
export function fetchCommandFor(headRef: string): string {
  const ref = shellQuote(headRef);
  return `git fetch origin ${ref} && git checkout ${ref}`;
}

/** Join a deployment URL and a record's `previewPath` without doubling the slash. */
export function joinPreviewUrl(url: string, previewPath: string | null): string {
  if (!previewPath) return url;
  return `${url.replace(/\/+$/, '')}${previewPath}`;
}

/**
 * Pick the deployment to show among one pull request's candidates: a `success`
 * that has a URL wins (newest first); otherwise the newest of any state.
 */
export function pickDeployment<T extends HowToTestDeploymentInput>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  const newestFirst = [...candidates].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );
  return (
    newestFirst.find((d) => d.state === 'success' && d.environmentUrl !== null) ?? newestFirst[0]!
  );
}

function previewFor(
  deployment: HowToTestDeploymentInput | null,
  previewPath: string | null,
): HowToTestPreviewDto {
  if (!deployment) return { status: 'no_deployment_reported' };
  if (deployment.state === 'success' && deployment.environmentUrl !== null) {
    return {
      status: 'available',
      url: joinPreviewUrl(deployment.environmentUrl, previewPath),
      environment: deployment.environment,
      state: 'success',
      deployedSha: deployment.commitSha,
    };
  }
  // A `success` with no URL is a deployment with nothing to open: it is
  // reported as not-ready rather than as "no deployment", because one exists.
  const { state, rawState } = toDeploymentState(deployment.state);
  return { status: 'deployment_not_ready', state, rawState, environment: deployment.environment };
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
 * Assemble ONE repository section of the run target's block.
 *
 * @param section      the record's section for this repository
 * @param repoName     `owner/name`, for the sub-heading
 * @param pr           the pull request {@link pickPullRequest} bound, or null
 * @param deployments  every latest-per-environment deployment read for the block —
 *                     matched here on the head sha, or on the head REF when no
 *                     check has reported a head yet
 * @param previewPath  the record's `previewPath` (one for the run)
 */
export function assembleHowToTestRepo(
  section: TestInstructionsRepoDTO,
  repoName: string,
  pr: HowToTestPullRequestInput | null,
  deployments: HowToTestDeploymentInput[],
  previewPath: string | null,
): HowToTestRepoDto {
  if (!pr) {
    return {
      repoId: section.repoId,
      repoName,
      commitSha: section.commitSha,
      pullRequest: null,
      stale: false,
      local: { status: 'no_pull_request' },
      // Without a branch there is neither a head to match a preview on nor checks.
      preview: { status: 'no_deployment_reported' },
      ci: { status: 'no_checks_reported' },
    };
  }

  // THE head, by the rule the Development section's CI pill uses — one helper,
  // so "what CI proved" and the pill can never name different commits.
  const atHead = liveRowsAtLatestSha(pr.checkRuns);
  const headSha = atHead[0]?.commitSha ?? null;

  const candidates = deployments.filter(
    (d) =>
      d.repoId === pr.repoId && (headSha !== null ? d.commitSha === headSha : d.ref === pr.headRef),
  );

  const checks: HowToTestCheckDto[] = atHead
    .map((row) => ({ name: row.checkName, ...toCheckConclusion(row.conclusion) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    repoId: section.repoId,
    repoName,
    commitSha: section.commitSha,
    pullRequest: {
      id: pr.id,
      headRef: pr.headRef,
      headSha,
      state: pr.state === 'open' ? 'open' : 'closed',
      merged: pr.merged,
    },
    // A section written against an ABBREVIATED sha of the head is not stale.
    stale: headSha !== null && !headSha.startsWith(section.commitSha),
    local: {
      status: 'available',
      fetchCommand: fetchCommandFor(pr.headRef),
      setupCommands: section.setupCommands,
    },
    preview: previewFor(pickDeployment(candidates), previewPath),
    ci: checks.length > 0 ? { status: 'available', checks } : { status: 'no_checks_reported' },
  };
}
