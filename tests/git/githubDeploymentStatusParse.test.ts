import { describe, expect, it } from 'vitest';
import { getGitProvider } from '@/lib/git';
import { DEPLOYMENT_STATES } from '@/lib/git/types';

// The GitHub `deployment_status` normalization (Story MOTIR-4906 · MOTIR-5329).
// PURE — no database. The recorded payload below is the shape GitHub sends
// (`deployment` + `deployment_status` + `repository` + `installation`), trimmed to
// the fields the seam reads plus the ones it must NOT read (`target_url`).

function payload(
  over: {
    state?: string;
    environmentUrl?: string | null;
    targetUrl?: string;
    updatedAt?: string | null;
    createdAt?: string;
    sha?: string;
    ref?: string;
  } = {},
) {
  return {
    action: 'created',
    deployment_status: {
      id: 9001,
      state: over.state ?? 'success',
      environment: 'Preview',
      environment_url:
        over.environmentUrl === undefined
          ? 'https://acme-git-feat.vercel.app'
          : over.environmentUrl,
      target_url: over.targetUrl ?? 'https://vercel.com/acme/logs/123',
      created_at: over.createdAt ?? '2026-09-13T10:00:00Z',
      updated_at: over.updatedAt === undefined ? '2026-09-13T10:00:05Z' : over.updatedAt,
    },
    deployment: {
      id: 4242,
      sha: over.sha ?? 'c0ffee'.padEnd(40, '0'),
      ref: over.ref ?? 'feat/MOTIR-7-a-change',
      environment: 'Preview',
    },
    repository: { id: 555, name: 'acme', owner: { login: 'moooon' } },
    installation: { id: 'inst-1' },
  };
}

const github = getGitProvider('github');

describe('github.parseDeploymentStatusEvent', () => {
  it.each(DEPLOYMENT_STATES)('normalizes the %s state', (state) => {
    expect(github.parseDeploymentStatusEvent!(payload({ state }))).toEqual({
      providerRepoId: '555',
      providerDeploymentId: '4242',
      commitSha: 'c0ffee'.padEnd(40, '0'),
      ref: 'feat/MOTIR-7-a-change',
      environment: 'Preview',
      state,
      environmentUrl: 'https://acme-git-feat.vercel.app',
      occurredAt: new Date('2026-09-13T10:00:05Z'),
    });
  });

  it('reads environment_url and NEVER target_url (the log link)', () => {
    const noEnvUrl = github.parseDeploymentStatusEvent!(payload({ environmentUrl: null }));
    expect(noEnvUrl?.environmentUrl).toBeNull();
    const emptyEnvUrl = github.parseDeploymentStatusEvent!(payload({ environmentUrl: '' }));
    expect(emptyEnvUrl?.environmentUrl).toBeNull();
  });

  it('falls back to created_at when updated_at is absent', () => {
    const event = github.parseDeploymentStatusEvent!(payload({ updatedAt: null }));
    expect(event?.occurredAt).toEqual(new Date('2026-09-13T10:00:00Z'));
  });

  it('refuses an unknown state rather than guessing a member', () => {
    expect(github.parseDeploymentStatusEvent!(payload({ state: 'exploded' }))).toBeNull();
  });

  it('refuses a body missing the deployment, the status, the repository, or a sha/ref', () => {
    const full = payload();
    expect(github.parseDeploymentStatusEvent!({ ...full, deployment: undefined })).toBeNull();
    expect(
      github.parseDeploymentStatusEvent!({ ...full, deployment_status: undefined }),
    ).toBeNull();
    expect(github.parseDeploymentStatusEvent!({ ...full, repository: undefined })).toBeNull();
    expect(github.parseDeploymentStatusEvent!(payload({ sha: '' }))).toBeNull();
    expect(github.parseDeploymentStatusEvent!(payload({ ref: '' }))).toBeNull();
    expect(github.parseDeploymentStatusEvent!(null)).toBeNull();
  });
});
