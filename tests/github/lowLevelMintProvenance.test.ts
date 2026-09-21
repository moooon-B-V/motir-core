import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitProvider, requireRepoTarballUrlResolver } from '@/lib/git';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  readCommitCheckRuns,
  readPullRequestHeadSha,
  writeCheckRun,
  LINK_CHECK_NAME,
} from '@/lib/github/checkRuns';
import {
  mintedAppIds,
  stubAppCredentials,
  stubBothAppCredentials,
  PROVISIONING_APP_ID,
  USER_FACING_APP_ID,
} from '../helpers/appCredentials';

// PROVENANCE AT THE SIX LOW-LEVEL MINTS (MOTIR-5861) — the other half of
// MOTIR-5843's sweep. Those four callers went through the `GitProvider` SEAM and
// were handed no repository; these six call `appAuth`'s `mintInstallationToken`
// DIRECTLY, with their repository's owner already in hand, and passed no role.
//
// `githubAppRoleForRepo(repo, provisioningOrgLogin())` is the provenance decision
// (MOTIR-5511). A HOSTED repository — one under the organisation Motir provisions
// into — is installed on the provisioning App and on NO other, so a mint through
// `mintInstallationToken`'s `'user-facing'` default cannot reach it: it throws
// `GithubAppNotConfiguredError`, and every one of these six sites catches that and
// returns a benign-looking value.
//
// ⚠️ THE ONE-APP ARM IS THE ASSERTION, NOT THE SETUP. Each hosted case wires ONLY
// the provisioning registration (`stubAppCredentials('provisioning')` stubs the
// other EMPTY, and `resolveConfig` refuses a falsy value), so an implementation
// that ignored provenance could not produce a token at all and the case fails on
// the defect itself rather than on a later assertion about which credential was
// used.
//
// ⚠️ AND EVERY ONE CARRIES A CONTROL. Asserting only that a hosted repository
// reaches the provisioning App is satisfied by an implementation that ALWAYS mints
// through it — which would break every real tenant. So each control wires BOTH
// registrations with the provisioning org CONFIGURED and not this repository's
// owner, and reads the App id back out of the signed JWT (`mintedAppIds`), which
// is the only place the registration behind a request is recorded. The pair pins
// the decision; either half alone pins one direction of it.

/** The organisation Motir provisions into, in these tests. */
const HOSTED_OWNER = 'moooon';
/** A repository the CUSTOMER connected — never the provisioning org. */
const CUSTOMER_OWNER = 'acme-corp';
const INSTALLATION_ID = 'inst-lowlevel';
const HEAD_SHA = 'a'.repeat(40);
const CODELOAD_URL = 'https://codeload.github.com/o/r/legacy.tar.gz/main?token=ABC';

const github = getGitProvider('github');
const resolveTarball = requireRepoTarballUrlResolver(github);

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      token: 'ghs_lowlevel',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** The GitHub host, stubbed just far enough for each of the six reads to succeed.
 *  `/access_tokens` is served by the REAL mint above it, so a role the App set
 *  cannot satisfy fails before any of this is reached. */
function stubHost(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/access_tokens')) return tokenResponse();
    // resolveRepoTarballUrl — stops at the redirect and takes the Location.
    if (url.includes('/tarball/'))
      return new Response(null, { status: 302, headers: { location: CODELOAD_URL } });
    // compareCommits
    if (url.includes('/compare/'))
      return new Response(JSON.stringify({ behind_by: 3 }), { status: 200 });
    // fetchWorkflowRunJobs
    if (url.includes('/attempts/'))
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    // writeCheckRun — the existing-run lookup, then the write. The same path
    // serves readCommitCheckRuns' pagination, which requires a NUMERIC
    // `total_count` and returns `null` without one — so omitting it here fails
    // the provenance assertion for a reason that has nothing to do with the App.
    if (url.includes('/check-runs')) {
      if ((init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
      return new Response(JSON.stringify({ id: 7 }), { status: 201 });
    }
    // readPullRequestHeadSha
    if (/\/pulls\/\d+$/.test(url))
      return new Response(JSON.stringify({ head: { sha: HEAD_SHA } }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A HOSTED repository, with ONLY the provisioning App wired. A mint that
 *  defaulted to the user-facing registration throws here. */
function hosted(): ReturnType<typeof vi.fn> {
  vi.stubEnv('GITHUB_FALLBACK_ORG', HOSTED_OWNER);
  stubAppCredentials('provisioning');
  return stubHost();
}

/** A CUSTOMER-OWNED repository, with BOTH Apps wired and the provisioning org
 *  configured — so "only one App was available" cannot explain the result and the
 *  resolved role is the only thing that can decide it. */
function customer(): ReturnType<typeof vi.fn> {
  vi.stubEnv('GITHUB_FALLBACK_ORG', HOSTED_OWNER);
  stubBothAppCredentials();
  return stubHost();
}

const checkSpec = (owner: string) => ({
  installationId: INSTALLATION_ID,
  owner,
  name: 'acme',
  headSha: HEAD_SHA,
  conclusion: 'failure' as const,
  title: 'No work item linked',
  summary: `Call link_pull_request. ${LINK_CHECK_NAME}`,
});

beforeEach(() => {
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // An env stub that outlives its test silently re-classifies every later
  // repository — the provisioning org is read per call (MOTIR-5843's afterEach).
  vi.unstubAllEnvs();
  _resetInstallationTokenCache();
});

describe('github.resolveRepoTarballUrl mints by provenance (MOTIR-5861)', () => {
  it('a HOSTED repository resolves its tarball with only the PROVISIONING App wired', async () => {
    const fetchMock = hosted();

    // Before the fix this threw GithubAppNotConfiguredError, which the indexer's
    // caller reads as a repository it cannot index.
    await expect(resolveTarball(INSTALLATION_ID, HOSTED_OWNER, 'acme', 'main')).resolves.toBe(
      CODELOAD_URL,
    );
    expect(mintedAppIds(fetchMock)).toEqual([PROVISIONING_APP_ID]);
  });

  it('CONTROL — a CUSTOMER-OWNED repository still mints through the USER-FACING App, with the provisioning org configured', async () => {
    const fetchMock = customer();

    await expect(resolveTarball(INSTALLATION_ID, CUSTOMER_OWNER, 'acme', 'main')).resolves.toBe(
      CODELOAD_URL,
    );
    expect(mintedAppIds(fetchMock)).toEqual([USER_FACING_APP_ID]);
  });
});

describe('github.compareCommits mints by provenance (MOTIR-5861)', () => {
  it('a HOSTED repository is compared with only the PROVISIONING App wired', async () => {
    const fetchMock = hosted();

    // `behindBy: null` is what the drift count got before the fix — and its
    // `unreachable` reason is indistinguishable from GitHub being down.
    await expect(
      github.compareCommits(INSTALLATION_ID, HOSTED_OWNER, 'acme', 'base', 'head'),
    ).resolves.toEqual({ behindBy: 3 });
    expect(mintedAppIds(fetchMock)).toEqual([PROVISIONING_APP_ID]);
  });

  it('CONTROL — a CUSTOMER-OWNED repository still mints through the USER-FACING App, with the provisioning org configured', async () => {
    const fetchMock = customer();

    await expect(
      github.compareCommits(INSTALLATION_ID, CUSTOMER_OWNER, 'acme', 'base', 'head'),
    ).resolves.toEqual({ behindBy: 3 });
    expect(mintedAppIds(fetchMock)).toEqual([USER_FACING_APP_ID]);
  });
});

describe('github.fetchWorkflowRunJobs mints by provenance (MOTIR-5861)', () => {
  it('a HOSTED repository’s jobs are read with only the PROVISIONING App wired', async () => {
    const fetchMock = hosted();

    // A hosted repository is precisely the one whose Actions minutes Motir is
    // billed for, so this is the metering read that matters most.
    await expect(
      github.fetchWorkflowRunJobs?.(INSTALLATION_ID, HOSTED_OWNER, 'acme', '12345', 1),
    ).resolves.toEqual([]);
    expect(mintedAppIds(fetchMock)).toEqual([PROVISIONING_APP_ID]);
  });

  it('CONTROL — a CUSTOMER-OWNED repository still mints through the USER-FACING App, with the provisioning org configured', async () => {
    const fetchMock = customer();

    await expect(
      github.fetchWorkflowRunJobs?.(INSTALLATION_ID, CUSTOMER_OWNER, 'acme', '12345', 1),
    ).resolves.toEqual([]);
    expect(mintedAppIds(fetchMock)).toEqual([USER_FACING_APP_ID]);
  });
});

describe('writeCheckRun mints by provenance (MOTIR-5861)', () => {
  it('a HOSTED repository’s link check IS WRITTEN with only the PROVISIONING App wired', async () => {
    const fetchMock = hosted();

    // ⚠️ THE SHARPEST CONSEQUENCE IN THIS CARD. Before the fix the mint refused,
    // the catch returned `'unavailable'` — documented as "no check was written and
    // nothing is wrong" — so `Motir / work item link` had NEVER been written on a
    // hosted repository, and an unlinked pull request there carried no red check.
    await expect(writeCheckRun(checkSpec(HOSTED_OWNER))).resolves.toBe('created');
    expect(mintedAppIds(fetchMock)).toEqual([PROVISIONING_APP_ID]);
  });

  it('CONTROL — a CUSTOMER-OWNED repository’s check still mints through the USER-FACING App, with the provisioning org configured', async () => {
    const fetchMock = customer();

    await expect(writeCheckRun(checkSpec(CUSTOMER_OWNER))).resolves.toBe('created');
    expect(mintedAppIds(fetchMock)).toEqual([USER_FACING_APP_ID]);
  });
});

describe('readPullRequestHeadSha mints by provenance (MOTIR-5861)', () => {
  it('a HOSTED repository’s head sha is read with only the PROVISIONING App wired', async () => {
    const fetchMock = hosted();

    // `null` before the fix — and `null` is what this returns for a pull request
    // the host does not have, so the link side could not tell the two apart.
    await expect(readPullRequestHeadSha(INSTALLATION_ID, HOSTED_OWNER, 'acme', 61)).resolves.toBe(
      HEAD_SHA,
    );
    expect(mintedAppIds(fetchMock)).toEqual([PROVISIONING_APP_ID]);
  });

  it('CONTROL — a CUSTOMER-OWNED repository still mints through the USER-FACING App, with the provisioning org configured', async () => {
    const fetchMock = customer();

    await expect(readPullRequestHeadSha(INSTALLATION_ID, CUSTOMER_OWNER, 'acme', 61)).resolves.toBe(
      HEAD_SHA,
    );
    expect(mintedAppIds(fetchMock)).toEqual([USER_FACING_APP_ID]);
  });
});

describe('readCommitCheckRuns mints by provenance (MOTIR-5861)', () => {
  it('a HOSTED repository’s check runs are read with only the PROVISIONING App wired', async () => {
    const fetchMock = hosted();

    // ⚠️ AN EMPTY ARRAY, NOT `null` — and the difference is the defect. This
    // function's own header says `null` means "no answer, ask again later", so the
    // reconcile worker asked again for ever; `[]` says the host has nothing
    // recorded for this commit, which is an answer it can act on.
    await expect(
      readCommitCheckRuns(INSTALLATION_ID, HOSTED_OWNER, 'acme', HEAD_SHA),
    ).resolves.toEqual([]);
    expect(mintedAppIds(fetchMock)).toEqual([PROVISIONING_APP_ID]);
  });

  it('CONTROL — a CUSTOMER-OWNED repository still mints through the USER-FACING App, with the provisioning org configured', async () => {
    const fetchMock = customer();

    await expect(
      readCommitCheckRuns(INSTALLATION_ID, CUSTOMER_OWNER, 'acme', HEAD_SHA),
    ).resolves.toEqual([]);
    expect(mintedAppIds(fetchMock)).toEqual([USER_FACING_APP_ID]);
  });
});
