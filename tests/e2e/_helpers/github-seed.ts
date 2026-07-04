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
export async function seedGithubInstallation(workspaceId: string): Promise<GithubInstallationDTO> {
  return githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId: E2E_INSTALLATION_ID,
      accountLogin: E2E_INSTALLATION_ACCOUNT.login,
      accountType: E2E_INSTALLATION_ACCOUNT.type,
    },
    repos: [{ ...E2E_REPO }],
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
 *  id, PR number/state/merged/head-ref/title, author id). */
export function pullRequestPayload(args: {
  action: 'opened' | 'reopened' | 'closed';
  number: number;
  title: string;
  headRef: string;
  state: 'open' | 'closed';
  merged: boolean;
}): Record<string, unknown> {
  return {
    action: args.action,
    installation: { id: Number(E2E_INSTALLATION_ID) },
    repository: { id: Number(E2E_REPO.providerRepoId) },
    pull_request: {
      number: args.number,
      state: args.state,
      merged: args.merged,
      title: args.title,
      head: { ref: args.headRef },
      user: { id: E2E_GITHUB_USER.id },
    },
  };
}

/** A minimal terminal `check_suite` delivery (the CI feedback path — 7.10.6):
 *  the aggregate conclusion for a commit, linked to its PR by number. */
export function checkSuitePayload(args: {
  conclusion: 'success' | 'failure';
  headSha: string;
  prNumber: number;
  headBranch: string;
}): Record<string, unknown> {
  return {
    action: 'completed',
    installation: { id: Number(E2E_INSTALLATION_ID) },
    repository: { id: Number(E2E_REPO.providerRepoId) },
    check_suite: {
      status: 'completed',
      conclusion: args.conclusion,
      head_sha: args.headSha,
      head_branch: args.headBranch,
      pull_requests: [{ number: args.prNumber }],
      app: { slug: 'e2e-ci' },
    },
  };
}
