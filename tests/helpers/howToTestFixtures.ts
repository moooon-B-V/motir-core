import type { LinkedPullRequestDto } from '@/lib/dto/github';
import type { HowToTestDto, HowToTestRepoDto } from '@/lib/dto/howToTest';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// Fixtures for the Development block (MOTIR-5336) — the design board's own
// `ACME-n` shapes (design/github §20, Panels 12a–12o), so they link to nothing.

export const CORE_PR: LinkedPullRequestDto = {
  id: 'pr-core-131',
  title: 'Rate-limit the public API per key',
  repo: 'moooon/motir-core',
  number: 131,
  state: 'open',
  ci: 'passing',
  url: 'https://github.com/moooon/motir-core/pull/131',
};

export const GATEWAY_PR: LinkedPullRequestDto = {
  id: 'pr-gateway-57',
  title: 'Throttle burst traffic on /v1',
  repo: 'moooon/motir-gateway',
  number: 57,
  state: 'open',
  ci: 'running',
  url: 'https://github.com/moooon/motir-gateway/pull/57',
};

export const CORE_FETCH =
  "git fetch origin 'acme-31-rate-limit' && git checkout 'acme-31-rate-limit'";
export const GATEWAY_FETCH =
  "git fetch origin 'acme-12-gateway-throttle' && git checkout 'acme-12-gateway-throttle'";

export const SECTIONED_BODY = [
  '## Precondition',
  '',
  'The seed creates **ada@acme.test**, a workspace admin.',
  '',
  '## Set up',
  '',
  '```bash',
  'pnpm install --frozen-lockfile && pnpm db:seed',
  '```',
  '',
  '```sh',
  'pnpm dev',
  '```',
  '',
  '## Click-path',
  '',
  '1. Sign in as **ada@acme.test**.',
  '2. Send 61 requests — the 61st answers `429`.',
].join('\n');

export function coreRepo(over: Partial<HowToTestRepoDto> = {}): HowToTestRepoDto {
  return {
    repoId: 'repo-core',
    repoName: 'moooon/motir-core',
    commitSha: '3f2a91c0000000000000000000000000000000aa',
    pullRequest: {
      id: CORE_PR.id,
      headRef: 'acme-31-rate-limit',
      headSha: '3f2a91c0000000000000000000000000000000aa',
      state: 'open',
      merged: false,
    },
    stale: false,
    fetchCommand: CORE_FETCH,
    preview: {
      status: 'available',
      url: 'https://pr-131.motir-core.preview.moooon.dev/settings/api-keys',
      environment: 'preview',
      state: 'success',
      deployedSha: '3f2a91c0000000000000000000000000000000aa',
    },
    ci: {
      status: 'available',
      checks: [
        { name: 'build', conclusion: 'success', rawConclusion: null },
        { name: 'lint', conclusion: 'success', rawConclusion: null },
      ],
    },
    ...over,
  };
}

export function gatewayRepo(over: Partial<HowToTestRepoDto> = {}): HowToTestRepoDto {
  return {
    repoId: 'repo-gateway',
    repoName: 'moooon/motir-gateway',
    commitSha: 'aa11bb2000000000000000000000000000000000',
    pullRequest: {
      id: GATEWAY_PR.id,
      headRef: 'acme-12-gateway-throttle',
      headSha: 'aa11bb2000000000000000000000000000000000',
      state: 'open',
      merged: false,
    },
    stale: false,
    fetchCommand: GATEWAY_FETCH,
    preview: { status: 'no_deployment_reported' },
    ci: { status: 'no_checks_reported' },
    ...over,
  };
}

export function recordDto(over: Partial<HowToTestDto> = {}): HowToTestDto {
  return {
    state: 'record',
    runTarget: null,
    owedBy: null,
    record: {
      id: 'rec-1',
      run: { runId: 'run-318', label: 'Parent run #318' },
      createdAt: '2026-09-13T14:05:00.000Z',
      bodyMd: SECTIONED_BODY,
      previewPath: '/settings/api-keys',
    },
    repos: [coreRepo()],
    history: [],
    ...over,
  };
}

export const AWAITING_MERGE_GATE: ApprovalGateDTO = {
  id: 'gate-merge-1',
  workItemId: 'wi-acme-12',
  kind: 'pull_request_approval',
  subjectId: 'delivery-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  subjectVersion: null,
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  createdAt: '2026-09-13T14:10:00.000Z',
  updatedAt: '2026-09-13T14:10:00.000Z',
};
