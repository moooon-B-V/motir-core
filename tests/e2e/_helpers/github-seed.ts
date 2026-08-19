// GitHub-integration E2E seed + signed-webhook helpers (Story 7.10 · MOTIR-897).
//
// The spec simulates GitHub two ways, both landing on REAL shipped paths:
//
//   * The App INSTALLATION is seeded through `githubInstallationService
//     .persistInstallation` — the exact function the post-install setup flow
//     (MOTIR-1588) and the webhook grant-mirror both call — because the real
//     binding round-trip runs on GitHub's servers (App JWT → installation-token
//     → repo fetch) and cannot execute against a synthetic installation. This
//     is the sanctioned server-side service import the other seed helpers use
//     (see work-item-setup.ts's projectsService precedent).
//
//   * PR / CI deliveries are POSTed to the REAL `/api/github/webhook` route as
//     SIGNED payloads (HMAC-SHA256 over the raw body with the same
//     GITHUB_WEBHOOK_SECRET playwright.config.ts hands the dev server), so the
//     7.10.4 signature gate + the full service path run end-to-end — the
//     assertion is on Motir's observable behavior, not on GitHub.

import { createHmac } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import type { GithubInstallationDTO } from '@/lib/dto/github';
import {
  E2E_GITHUB_USER,
  E2E_GITHUB_WEBHOOK_SECRET,
  E2E_INSTALLATION_ACCOUNT,
  E2E_INSTALLATION_ID,
  E2E_REPO,
} from './github-const';

/** Bind the synthetic App installation (+ its one selected repo) to a
 *  workspace — the state the real setup redirect leaves behind. Idempotent. */
export async function seedGithubInstallation(
  workspaceId: string,
  /** Extra repositories to mirror onto the same installation (MOTIR-2730). The
   *  default keeps every existing caller byte-identical — a multi-repo fixture
   *  is opt-in, so no shipped spec's connected set changes underneath it. */
  extraRepos: readonly {
    providerRepoId: string;
    owner: string;
    name: string;
    defaultBranch: string;
    archived: boolean;
  }[] = [],
): Promise<GithubInstallationDTO> {
  return githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId: E2E_INSTALLATION_ID,
      accountLogin: E2E_INSTALLATION_ACCOUNT.login,
      accountType: E2E_INSTALLATION_ACCOUNT.type,
    },
    repos: [{ ...E2E_REPO }, ...extraRepos.map((r) => ({ ...r }))],
  });
}

/** GitHub's `X-Hub-Signature-256` over the exact raw body. */
export function signWebhook(rawBody: string): string {
  return `sha256=${createHmac('sha256', E2E_GITHUB_WEBHOOK_SECRET).update(rawBody).digest('hex')}`;
}

let deliverySeq = 0;

/** POST one signed delivery to the real webhook route. `payload` is serialized
 *  ONCE and the signature is computed over those exact bytes (a re-serialized
 *  body would not match the HMAC). Returns the raw response; callers assert
 *  status + the `result` body (the authoritative completion signal — the route
 *  awaits the full service handling before responding). */
export async function postSignedWebhook(
  request: Page['request'] | APIRequestContext,
  event: string,
  payload: unknown,
): Promise<APIResponse> {
  const rawBody = JSON.stringify(payload);
  return request.post('/api/github/webhook', {
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': signWebhook(rawBody),
      'x-github-delivery': `e2e-delivery-${++deliverySeq}`,
    },
    data: rawBody,
  });
}

/** A minimal `pull_request` delivery carrying every field the provider seam's
 *  `parseChangeRequestEvent` + the webhook service read (installation id, repo
 *  id, PR number/state/merged/head-ref/BASE-ref/title, author id). `baseRef`
 *  defaults to the seeded repo's default branch — a merge onto anything else is
 *  held at In Review by the trunk gate (MOTIR-1873). */
export function pullRequestPayload(args: {
  action: 'opened' | 'reopened' | 'closed';
  number: number;
  title: string;
  headRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  baseRef?: string;
  /** WHICH repository the delivery is for (MOTIR-2730). Defaults to
   *  {@link E2E_REPO}, so every existing caller produces the same payload it
   *  always did; a two-repository spec passes the second one explicitly. */
  repo?: { providerRepoId: string; defaultBranch: string };
}): Record<string, unknown> {
  const repo = args.repo ?? E2E_REPO;
  return {
    action: args.action,
    installation: { id: Number(E2E_INSTALLATION_ID) },
    repository: { id: Number(repo.providerRepoId) },
    pull_request: {
      number: args.number,
      state: args.state,
      merged: args.merged,
      title: args.title,
      head: { ref: args.headRef },
      base: { ref: args.baseRef ?? repo.defaultBranch },
      user: { id: E2E_GITHUB_USER.id },
    },
  };
}

/** A minimal `check_suite` delivery (the CI feedback path — 7.10.6): the
 *  aggregate for a commit, linked to its PR by number.
 *
 *  Terminal by default — `{ status: 'completed', conclusion }` — which is every
 *  existing caller, byte for byte. A suite that has NOT finished is expressed by
 *  passing `status: 'in_progress'` with a `null` conclusion (MOTIR-3009): the
 *  lifecycle story needs the state where checks are RUNNING, because "a card
 *  does not move while the build is still going" is a claim only a non-terminal
 *  aggregate can make. */
export function checkSuitePayload(args: {
  conclusion: 'success' | 'failure' | null;
  headSha: string;
  prNumber: number;
  headBranch: string;
  status?: 'queued' | 'in_progress' | 'completed';
}): Record<string, unknown> {
  return {
    action: 'completed',
    installation: { id: Number(E2E_INSTALLATION_ID) },
    repository: { id: Number(E2E_REPO.providerRepoId) },
    check_suite: {
      status: args.status ?? 'completed',
      conclusion: args.conclusion,
      head_sha: args.headSha,
      head_branch: args.headBranch,
      pull_requests: [{ number: args.prNumber }],
      app: { slug: 'e2e-ci' },
    },
  };
}
