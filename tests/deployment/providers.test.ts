import { afterEach, describe, expect, it, vi } from 'vitest';
import { flyDeploymentStatusProvider } from '@/lib/deployment/adapters/fly/flyMachinesStatus';
import { deploymentStatusProvider, usingFakeDeploymentStatus } from '@/lib/deployment/providers';

// THE DEPLOYMENT-STATUS BINDING (MOTIR-7332): which provider a deployment gets,
// and that the E2E fake can never arm in a real production build.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('deploymentStatusProvider', () => {
  it('binds nothing off a managed host — a self-hosted install has no provider', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '');
    vi.stubEnv('FLY_APP_NAME', '');
    expect(await deploymentStatusProvider()).toBeNull();
  });

  it('binds the Fly adapter on Fly', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '');
    vi.stubEnv('FLY_APP_NAME', 'motir-core');
    expect(await deploymentStatusProvider()).toBe(flyDeploymentStatusProvider);
  });

  it('binds the fake under the E2E flag: a healthy two-group fleet on one release', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '1');
    vi.stubEnv('FLY_APP_NAME', '');
    expect(usingFakeDeploymentStatus()).toBe(true);
    const provider = await deploymentStatusProvider();
    expect(provider).not.toBe(flyDeploymentStatusProvider);
    expect(provider?.configured()).toBe(true);
    const status = await provider?.read();
    expect(status?.releases).toHaveLength(1);
    for (const group of status?.groups ?? []) expect(group.started).toBe(group.expected);
  });

  it('⚠️ IGNORES the flag in a production build without the E2E harness', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '1');
    vi.stubEnv('FLY_APP_NAME', 'motir-core');
    expect(usingFakeDeploymentStatus()).toBe(false);
    expect(await deploymentStatusProvider()).toBe(flyDeploymentStatusProvider);
  });

  it('arms in a production build only when the E2E harness is ALSO set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '1');
    expect(usingFakeDeploymentStatus()).toBe(true);
  });
});
