import { afterEach, describe, expect, it, vi } from 'vitest';
import { instanceMaxRunning, INSTANCE_NAME_PATTERN } from '@/lib/agentInstances/config';
import { buildCloneCommand, installationBasicAuth } from '@/lib/agentInstances/cloneCommand';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceNotFoundError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentProfileNotOfferedError,
} from '@/lib/agentInstances/errors';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { imageDigestResolver, pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import {
  isOfferedProfile,
  NOT_OFFERED_AGENT_PROFILES,
  profileDisplayName,
  sandboxImageTag,
} from '@/lib/agentInstances/profiles';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';

// The agent-instance lane's small pure modules (Story MOTIR-6860 · MOTIR-6872):
// the error mapper every route uses, the clone command, the digest pin, the
// offered profiles and the cap configuration.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mapAgentInstanceError — every typed refusal is a status, never a 500', () => {
  const statusOf = (err: unknown) => mapAgentInstanceError(err)?.status ?? null;

  it('maps access first: not found 404, permission 403 carrying the key', async () => {
    expect(statusOf(new ProjectNotFoundError('p'))).toBe(404);
    const denied = mapAgentInstanceError(new PermissionDeniedError('p', 'instance:use'))!;
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ permission: 'instance:use' });
    expect(statusOf(new ProjectAccessDeniedError('p', 'edit'))).toBe(403);
  });

  it('maps the lane’s own refusals', async () => {
    expect(statusOf(new AgentInstanceNotFoundError('i'))).toBe(404);
    expect(statusOf(new AgentInstanceNameInvalidError())).toBe(400);
    expect(statusOf(new AgentProfileNotOfferedError('cursor', 'Cursor'))).toBe(400);
    expect(statusOf(new AgentInstanceNameTakenError('x'))).toBe(409);
    expect(statusOf(new AgentInstanceStateConflictError('i', 'waking', 'woken'))).toBe(409);
    expect(statusOf(new AgentInstanceStartRefusedError('credits', 'no'))).toBe(402);
    expect(statusOf(new AgentInstanceStartRefusedError('credits_unknown', 'no'))).toBe(503);
    const cap = mapAgentInstanceError(new AgentInstanceStartRefusedError('user_cap', 'full'))!;
    expect(cap.status).toBe(429);
    expect(await cap.json()).toMatchObject({ reason: 'user_cap', error: 'full' });
    expect(statusOf(new AgentInstanceStartRefusedError('fleet_busy', 'busy'))).toBe(429);
    expect(statusOf(new AgentInstancesUnavailableError('x'))).toBe(503);
    expect(statusOf(new Error('anything else'))).toBeNull();
  });
});

describe('the clone command', () => {
  it('runs as node, passes the token only as a one-shot basic-auth header, and names each repository', () => {
    const cmd = buildCloneCommand(['acme/web', 'acme/api'], 'ghs_secret');
    expect(cmd.slice(0, 4)).toEqual(['runuser', '-u', 'node', '--']);
    expect(cmd.slice(-3)).toEqual([installationBasicAuth('ghs_secret'), 'acme/web', 'acme/api']);
    expect(installationBasicAuth('ghs_secret')).toBe(
      Buffer.from('x-access-token:ghs_secret').toString('base64'),
    );
    const script = cmd[8]!;
    expect(script).toContain('extraheader=AUTHORIZATION: basic $auth');
    expect(script).toContain('clone --quiet "https://github.com/$repo.git"');
    expect(script).toContain('if [ -d "$dest/.git" ]; then continue; fi');
    expect(cmd.join(' ')).not.toContain('ghs_secret');
  });
});

describe('the digest pin', () => {
  it('on the fake fleet, derives a stable stand-in digest without asking a registry', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const a = await imageDigestResolver.resolve(sandboxImageTag('claude'));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await imageDigestResolver.resolve(sandboxImageTag('claude'))).toBe(a);
    expect(await imageDigestResolver.resolve(sandboxImageTag('codex'))).not.toBe(a);
  });

  it('on Fly, asks the registry and refuses an image it cannot resolve', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    try {
      await expect(imageDigestResolver.resolve(sandboxImageTag('claude'))).rejects.toThrow(
        AgentInstancesUnavailableError,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pins a tag to repository@digest', () => {
    expect(pinnedImageReference('ghcr.io/moooon-b-v/motir-sandbox:claude', 'sha256:abc')).toBe(
      'ghcr.io/moooon-b-v/motir-sandbox@sha256:abc',
    );
  });
});

describe('profiles and caps', () => {
  it('offers exactly §9’s six and names the two it does not', () => {
    expect(isOfferedProfile('claude')).toBe(true);
    expect(isOfferedProfile('cursor')).toBe(false);
    expect(NOT_OFFERED_AGENT_PROFILES.map((p) => p.id)).toEqual(['antigravity', 'cursor']);
    expect(profileDisplayName('kimi')).toBe('Kimi Code');
    expect(profileDisplayName('cursor')).toBe('Cursor');
    expect(profileDisplayName('unknown')).toBe('unknown');
  });

  it('reads the agent pool’s safety valve from the environment — default 50, no per-organisation cap', () => {
    vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', '');
    expect(instanceMaxRunning()).toBe(50);
    vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', '120');
    expect(instanceMaxRunning()).toBe(120);
    vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', 'nonsense');
    expect(instanceMaxRunning()).toBe(50);
  });

  it('accepts a lower-case dashed name and refuses the rest', () => {
    expect(INSTANCE_NAME_PATTERN.test('yue-claude')).toBe(true);
    expect(INSTANCE_NAME_PATTERN.test('Yue Claude')).toBe(false);
    expect(INSTANCE_NAME_PATTERN.test('-leading')).toBe(false);
    expect(INSTANCE_NAME_PATTERN.test('a'.repeat(41))).toBe(false);
  });
});
