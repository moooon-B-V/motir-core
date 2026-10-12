// E2E boundary mock for the GitHub reads behind the Git room's account and
// repository pickers (Story MOTIR-8216 · MOTIR-8225), behind
// E2E_TEST_GITHUB_ACCOUNTS=1.
//
// The pickers are server reads, so the spawned app server is the process that
// calls GitHub and a mock in the spec file cannot reach it. This seam answers,
// for ONE synthetic GitHub account that the Motir GitHub App is installed on:
//
//   - `GET /user/installations` (the actor's user token) — the account, for
//     ANY signed-in member with a GitHub identity, so two organisations' admins
//     see the same account the way two people on one GitHub organisation do;
//   - `POST /app/installations/{id}/access_tokens` — a token NAMED for this
//     installation, so the repository read below can tell it apart from every
//     other installation the lane mints for;
//   - `GET /installation/repositories` with that token — the account's five
//     repositories;
//   - `GET /app/installations/{id}` (the App JWT) — the account the App is on.
//
// ⚠️ REGISTERED BEFORE `E2E_TEST_GITHUB_REPOS`, and the order is load-bearing:
// that seam answers EVERY `POST /app/installations/*` with one shared token,
// undici tries intercepts in registration order, and this one claims only its
// own installation id. Every other installation still falls through to it.
//
// The fixture is STATIC. Which organisation owns which repository is Motir's
// own state, written by the journey through the shipped picker, so nothing here
// needs steering per test.

import type { MockAgent } from 'undici';

const GITHUB_ORIGIN = 'https://api.github.com';

/** The installation the journey links — distinct from every other E2E id. */
export const E2E_MULTI_ORG_INSTALLATION_ID = '99000077';
export const E2E_MULTI_ORG_ACCOUNT = { login: 'moooon-shared', type: 'Organization' } as const;

/** The account's repositories, A to E, in the order the story names them. */
export const E2E_MULTI_ORG_REPOS = [
  { id: 88000101, name: 'alpha' },
  { id: 88000102, name: 'bravo' },
  { id: 88000103, name: 'charlie' },
  { id: 88000104, name: 'delta' },
  { id: 88000105, name: 'echo' },
] as const;

const INSTALLATION_TOKEN = `ghs_e2e_accounts_${E2E_MULTI_ORG_INSTALLATION_ID}`;

interface MockReply {
  statusCode: number;
  data: object | string;
  responseOptions: { headers: Record<string, string> };
}

function reply(statusCode: number, data: object): MockReply {
  return { statusCode, data, responseOptions: { headers: { 'content-type': 'application/json' } } };
}

function headerOf(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    }
    return null;
  }
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const entry = Object.entries(headers as Record<string, unknown>).find(
    ([k]) => k.toLowerCase() === name,
  );
  return entry ? String(entry[1]) : null;
}

function account() {
  return {
    login: E2E_MULTI_ORG_ACCOUNT.login,
    type: E2E_MULTI_ORG_ACCOUNT.type,
    avatar_url: '',
  };
}

export function installGithubAccountsMock(agent: MockAgent): void {
  const pool = agent.get(GITHUB_ORIGIN);
  const id = E2E_MULTI_ORG_INSTALLATION_ID;

  pool
    .intercept({ path: (p) => p.split('?')[0] === '/user/installations', method: 'GET' })
    .reply(
      (): MockReply =>
        reply(200, {
          total_count: 1,
          installations: [
            {
              id: Number(id),
              app_id: Number(process.env['GITHUB_APP_ID'] ?? 0),
              repository_selection: 'selected',
              account: account(),
            },
          ],
        }),
    )
    .persist();

  pool
    .intercept({ path: `/app/installations/${id}/access_tokens`, method: 'POST' })
    .reply(
      (): MockReply =>
        reply(201, {
          token: INSTALLATION_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
    )
    .persist();

  pool
    .intercept({ path: `/app/installations/${id}`, method: 'GET' })
    .reply((): MockReply => reply(200, { id: Number(id), account: account() }))
    .persist();

  pool
    .intercept({
      path: (p) => p.split('?')[0] === '/installation/repositories',
      method: 'GET',
      headers: (headers) =>
        headerOf(headers, 'authorization') === `token ${INSTALLATION_TOKEN}` ||
        headerOf(headers, 'authorization') === `Bearer ${INSTALLATION_TOKEN}`,
    })
    .reply(
      (): MockReply =>
        reply(200, {
          total_count: E2E_MULTI_ORG_REPOS.length,
          repositories: E2E_MULTI_ORG_REPOS.map((repo) => ({
            id: repo.id,
            name: repo.name,
            full_name: `${E2E_MULTI_ORG_ACCOUNT.login}/${repo.name}`,
            owner: { login: E2E_MULTI_ORG_ACCOUNT.login },
            default_branch: 'main',
            archived: false,
          })),
        }),
    )
    .persist();
}
