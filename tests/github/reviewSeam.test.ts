import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';

import { githubProvider } from '@/lib/git/providers/github';
import { gitlabProvider } from '@/lib/git/providers/gitlab';
import { ProviderPermissionReadError } from '@/lib/git/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  installGithubMergeMock,
  reviewerPermissionFor,
  type GithubMergeControl,
} from '@/lib/test-github-merge-mock';

// THE REVIEW SEAM (Story MOTIR-4910 · MOTIR-5595; `docs/decisions/approval-gates.md`
// §8 FOURTH AMENDMENT, decision 2).
//
// Two host facts a review sync needs — WHAT the review says, and whether its author was
// entitled to say it — both through `GitProvider` so the consumer holds no GitHub type.
// No database and no network: the parser is pure, and the permission read runs against a
// MockAgent.

/** The App credentials the token mint needs before any read reaches the host. The mint
 *  itself is intercepted; this only has to be a well-formed key it can sign with. */
function stubAppCredentials(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  // The mint caches per installation, so a token from a previous test's intercept would
  // otherwise satisfy this one without ever reaching the agent under test.
  _resetInstallationTokenCache();
}

function fixture(name: string): unknown {
  const file = join(process.cwd(), 'tests/fixtures/github/pull-request-review', `${name}.json`);
  return (JSON.parse(readFileSync(file, 'utf8')) as { payload: unknown }).payload;
}

describe('parseReviewEvent — normalising a pull_request_review delivery (MOTIR-5595)', () => {
  it('normalises an APPROVED submission, keeping the review commit separate from the head', () => {
    const event = githubProvider.parseReviewEvent!(fixture('submitted-approved'));

    expect(event).not.toBeNull();
    expect(event!.action).toBe('submitted');
    expect(event!.installationId).toBe('4206669');
    expect(event!.repo).toEqual({ owner: 'moooon', name: 'acme', providerRepoId: '9001' });
    expect(event!.pullRequest).toEqual({ number: 131, headSha: 'a'.repeat(40) });
    expect(event!.review.id).toBe('999100');
    expect(event!.review.state).toBe('approved');
    // The head the review was GIVEN AT, which is not the same question as the pull
    // request's current head — the two differing IS the stale-review case.
    expect(event!.review.commitSha).toBe('c'.repeat(40));
    expect(event!.review.submittedAt.toISOString()).toBe('2026-09-16T09:12:00.000Z');
    expect(event!.review.reviewer).toEqual({
      providerUserId: '4242',
      login: 'ada-l',
      type: 'User',
    });
    expect(event!.review.htmlUrl).toContain('#pullrequestreview-999100');
  });

  it('carries the review BODY, trimmed, and NULL when there is none (MOTIR-6074)', () => {
    const base = fixture('submitted-changes-requested') as { review: Record<string, unknown> };
    const withBody = { ...base, review: { ...base.review, body: '  Add a ceiling.\n' } };
    expect(githubProvider.parseReviewEvent!(withBody)!.review.body).toBe('Add a ceiling.');
    for (const body of ['', '   ', null, undefined, 42]) {
      const blank = { ...base, review: { ...base.review, body } };
      expect(githubProvider.parseReviewEvent!(blank)!.review.body).toBeNull();
    }
  });

  it('normalises changes_requested, commented, dismissed and edited', () => {
    expect(
      githubProvider.parseReviewEvent!(fixture('submitted-changes-requested'))!.review.state,
    ).toBe('changes_requested');
    // `commented` is carried even though it never decides anything: the Development
    // block draws reviews that do not count.
    expect(githubProvider.parseReviewEvent!(fixture('submitted-commented'))!.review.state).toBe(
      'commented',
    );

    const dismissed = githubProvider.parseReviewEvent!(fixture('dismissed'))!;
    expect(dismissed.action).toBe('dismissed');
    expect(dismissed.review.state).toBe('dismissed');

    // An `edited` delivery carries no `submitted_at` in GitHub's own example. The review
    // still exists, so it normalises; the consumer keeps the stored timestamp.
    const edited = githubProvider.parseReviewEvent!(fixture('edited'))!;
    expect(edited.action).toBe('edited');
    expect(edited.review.submittedAt.getTime()).toBe(0);
  });

  it('reads the state CASE-INSENSITIVELY — the webhook lowercases it and the REST API does not', () => {
    const body = fixture('submitted-approved') as { review: Record<string, unknown> };
    const upper = { ...body, review: { ...body.review, state: 'APPROVED' } };
    expect(githubProvider.parseReviewEvent!(upper)!.review.state).toBe('approved');
  });

  it('returns NULL, never a partial event, when a load-bearing field is missing', () => {
    const base = fixture('submitted-approved') as Record<string, unknown>;
    const review = base['review'] as Record<string, unknown>;
    const pr = base['pull_request'] as Record<string, unknown>;

    const drop = (patch: Record<string, unknown>) =>
      githubProvider.parseReviewEvent!({ ...base, ...patch });

    // Without the id the row cannot be idempotent...
    expect(drop({ review: { ...review, id: undefined } })).toBeNull();
    // ...without the commit it cannot be matched to a head...
    expect(drop({ review: { ...review, commit_id: undefined } })).toBeNull();
    // ...without the author it cannot be attributed or permission-checked...
    expect(drop({ review: { ...review, user: undefined } })).toBeNull();
    expect(drop({ review: { ...review, user: { login: 'ada-l' } } })).toBeNull();
    // ...and without the number it belongs to no pull request.
    expect(drop({ pull_request: { ...pr, number: undefined } })).toBeNull();
    // The installation is what mints the token the permission read needs.
    expect(drop({ installation: undefined })).toBeNull();
    // An unrecognised state fails the whole event rather than defaulting.
    expect(drop({ review: { ...review, state: 'rubber_stamped' } })).toBeNull();
    // Not a review event at all.
    expect(drop({ action: 'opened' })).toBeNull();
    expect(githubProvider.parseReviewEvent!(null)).toBeNull();
    expect(githubProvider.parseReviewEvent!('nonsense')).toBeNull();
  });
});

describe('getRepositoryPermission — whether a reviewer can write (MOTIR-5595)', () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    stubAppCredentials();
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    // The token mint the read makes first.
    agent
      .get('https://api.github.com')
      .intercept({ path: /^\/app\/installations\/[^/]+\/access_tokens$/, method: 'POST' })
      .reply(201, { token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      .persist();
  });

  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
    vi.unstubAllEnvs();
    _resetInstallationTokenCache();
  });

  const permissionPath = '/repos/moooon/acme/collaborators/ada-l/permission';

  const read = () =>
    githubProvider.getRepositoryPermission!({
      installationId: '4206669',
      owner: 'moooon',
      repo: 'acme',
      username: 'ada-l',
    });

  it.each(['admin', 'maintain', 'write', 'triage', 'read'] as const)(
    'maps role_name %s to itself',
    async (role) => {
      agent
        .get('https://api.github.com')
        .intercept({ path: permissionPath, method: 'GET' })
        .reply(200, { permission: 'read', role_name: role, user: { login: 'ada-l' } });
      await expect(read()).resolves.toBe(role);
    },
  );

  it('falls back to `permission` when role_name is absent or a custom role', async () => {
    agent
      .get('https://api.github.com')
      .intercept({ path: permissionPath, method: 'GET' })
      .reply(200, { permission: 'write', role_name: 'release-manager', user: { login: 'ada-l' } });
    // A custom role Motir does not know is not an answer, so the legacy base role is.
    await expect(read()).resolves.toBe('write');
  });

  it('maps a 404 to `none` — an ANSWER about the person, not a failure', async () => {
    agent
      .get('https://api.github.com')
      .intercept({ path: permissionPath, method: 'GET' })
      .reply(404, { message: 'Not Found' });
    // Throwing here would make a drive-by reviewer indistinguishable from an outage.
    await expect(read()).resolves.toBe('none');
  });

  it.each([403, 500] as const)(
    'throws ProviderPermissionReadError on a %i — the host did not ANSWER',
    async (status) => {
      agent
        .get('https://api.github.com')
        .intercept({ path: permissionPath, method: 'GET' })
        .reply(status, { message: 'nope' })
        .persist();

      // One call, inspected — a second `read()` would need a second intercept and would
      // otherwise fail as `unreachable`, which is a different reason.
      const error = await read().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ProviderPermissionReadError);
      expect((error as ProviderPermissionReadError).status).toBe(status);
      expect((error as ProviderPermissionReadError).reason).toBe('unexpected_status');
      // `unknown` is what a consumer records on this — never `none`, which would claim a
      // fact about the person that Motir does not have.
      expect((error as ProviderPermissionReadError).code).toBe('PROVIDER_PERMISSION_READ_FAILED');
    },
  );
});

describe('the E2E permission intercept (MOTIR-5595)', () => {
  it('DEFAULTS to write, so an unconfigured reviewer counts', () => {
    expect(reviewerPermissionFor({}, 'ada-l')).toBe('write');
    expect(reviewerPermissionFor({ reviewerPermissions: {} }, 'ada-l')).toBe('write');
  });

  it('answers per username, case-insensitively', () => {
    const control: GithubMergeControl = {
      reviewerPermissions: { 'Ada-L': 'read', 'octo-reviewer': '404' },
    };
    expect(reviewerPermissionFor(control, 'ada-l')).toBe('read');
    expect(reviewerPermissionFor(control, 'OCTO-REVIEWER')).toBe('404');
    expect(reviewerPermissionFor(control, 'somebody-else')).toBe('write');
  });

  it('serves the endpoint through the shared MockAgent, driving the real provider read', async () => {
    stubAppCredentials();
    const agent = new MockAgent();
    agent.disableNetConnect();
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(agent);
    const controlPath = join(
      process.env['MOTIR_TEST_TMP'] ?? '/tmp',
      `merge-control-${Date.now()}.json`,
    );
    const { writeFileSync, rmSync } = await import('node:fs');
    writeFileSync(
      controlPath,
      JSON.stringify({
        repositories: ['moooon/acme'],
        reviewerPermissions: { 'drive-by': 'read' },
      } satisfies GithubMergeControl),
    );
    process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH'] = controlPath;

    try {
      installGithubMergeMock(agent);
      // The REAL provider read runs against it, so the lane exercises the shipped
      // mapping rather than a stub of it.
      await expect(
        githubProvider.getRepositoryPermission!({
          installationId: '4206669',
          owner: 'moooon',
          repo: 'acme',
          username: 'drive-by',
        }),
      ).resolves.toBe('read');
      await expect(
        githubProvider.getRepositoryPermission!({
          installationId: '4206669',
          owner: 'moooon',
          repo: 'acme',
          username: 'ada-l',
        }),
      ).resolves.toBe('write');
    } finally {
      delete process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH'];
      rmSync(controlPath, { force: true });
      setGlobalDispatcher(previous);
      await agent.close();
      vi.unstubAllEnvs();
      _resetInstallationTokenCache();
    }
  });
});

describe('the seam stays OPTIONAL (MOTIR-5595)', () => {
  it('GitLab implements neither, and that is the contract rather than a gap', () => {
    // GitLab's approval model is approval RULES with counts; nothing here is written to
    // generalise to it, so it must compile WITHOUT these rather than ship stubs.
    expect(gitlabProvider.parseReviewEvent).toBeUndefined();
    expect(gitlabProvider.getRepositoryPermission).toBeUndefined();
    // GitHub declares both.
    expect(typeof githubProvider.parseReviewEvent).toBe('function');
    expect(typeof githubProvider.getRepositoryPermission).toBe('function');
  });
});
