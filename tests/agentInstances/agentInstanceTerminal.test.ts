import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveBoot } from '../helpers/agentBootDriver';
import { db } from '@/lib/db';
import {
  AgentInstanceNoTerminalServerError,
  AgentInstancesUnavailableError,
} from '@/lib/agentInstances/errors';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import {
  AGENT_MACHINE_CONFIG_VERSION,
  AGENT_TERMINAL_COMMAND,
  AGENT_TERMINAL_PORT,
  agentTerminalMachineConfig,
  isAgentTerminalConfigured,
} from '@/lib/agentInstances/terminal';
import { deriveTerminalKey, terminalKeyId } from '@/lib/agentInstances/terminalKey';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { fleet, fx, seedRepo, setUpHarness, slots, tearDownHarness } from './_harness';

// THE AGENT'S MACHINE SERVES ITS TERMINAL (Story MOTIR-6861 · MOTIR-6939), under
// `docs/decisions/agent-terminal.md` Q2–Q4 and Q8, against a real Postgres and
// the fake persistent fleet: the machine config on create, a wake bringing an
// older agent's config up to date BEFORE its start, and the once-per-digest probe
// that records whether the image serves a terminal at all.

const MASTER = 'm'.repeat(48);
const PROBE = ['motir', 'agent-terminal', '--help'];

beforeEach(async () => {
  await setUpHarness();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx.projectIdentifier;
const create = (name = 'yue-claude') =>
  lifecycle.create(KEY(), { name, profileId: 'claude' }, fx.ctx);
const row = async (id: string) => (await adminDb.agentInstance.findUnique({ where: { id } }))!;
const probes = () => fleet.execs.filter((e) => e.command.join(' ') === PROBE.join(' '));

describe('the per-instance key (Q3)', () => {
  it('is HMAC-SHA256(master, instanceId) as unpadded base64url, and its id is a one-way 16-hex fingerprint', () => {
    const key = deriveTerminalKey(MASTER, 'inst-1');
    expect(key).toBe(createHmac('sha256', MASTER).update('inst-1').digest('base64url'));
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveTerminalKey(MASTER, 'inst-2')).not.toBe(key);
    expect(deriveTerminalKey('n'.repeat(48), 'inst-1')).not.toBe(key);
    expect(terminalKeyId(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(terminalKeyId(key)).not.toContain(key.slice(0, 8));
  });

  it('turns the terminal OFF when the master key is unset, and refuses a short one loudly', () => {
    expect(isAgentTerminalConfigured()).toBe(true);
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    expect(isAgentTerminalConfigured()).toBe(false);
    expect(agentTerminalMachineConfig('inst-1')).toBeNull();
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'too-short');
    expect(() => agentTerminalMachineConfig('inst-1')).toThrow(AgentInstancesUnavailableError);
  });
});

describe('create — the terminal server is the machine’s main process (Q2, Q4)', () => {
  it('provisions with the command, the 7681 → 443 service Fly never wakes or stops, and the derived key; probes once; the DTO says present', async () => {
    await seedRepo('acme', 'web');
    const dto = await create();
    expect(dto.state).toBe('running');

    const spec = fleet.persistentSpecs[0]!;
    // The spec's own env is unchanged; the key travels in the terminal config.
    expect(spec.env).toEqual({ MOTIR_INSTANCE_ID: dto.id });
    const key = deriveTerminalKey(MASTER, dto.id);
    expect(spec.terminal).toEqual({
      version: AGENT_MACHINE_CONFIG_VERSION,
      keyId: terminalKeyId(key),
      command: AGENT_TERMINAL_COMMAND,
      env: { MOTIR_TERMINAL_KEY: key },
      service: {
        internalPort: AGENT_TERMINAL_PORT,
        ports: [{ port: 443, handlers: ['tls', 'http'] }],
        autostart: false,
        autostop: 'off',
      },
    });
    expect(AGENT_TERMINAL_COMMAND).toEqual([
      'sh',
      '-c',
      'motir agent-terminal --help >/dev/null 2>&1 && exec motir agent-terminal serve; exec sleep infinity',
    ]);
    // No credential of the user's, and nothing narrowing a sign-in (Q9).
    expect(Object.keys(spec.terminal!.env)).toEqual(['MOTIR_TERMINAL_KEY']);

    // The clone first, then ONE terminal probe; the record carries the answer for this
    // digest. The run probes follow it (MOTIR-7026): the launcher, then the sign-in.
    expect(fleet.execs.map((e) => e.command[0])).toEqual(['runuser', 'motir', 'motir', 'runuser']);
    expect(probes()).toHaveLength(1);
    expect(dto.terminalServer).toBe('present');
    expect(await row(dto.id)).toMatchObject({
      terminalServer: 'present',
      terminalServerDigest: dto.imageDigest,
    });
    expect(fleet.machineConfigVersion((await row(dto.id)).machineId!)).toBe(
      AGENT_MACHINE_CONFIG_VERSION,
    );
  });

  it('an image with NO terminal server still runs, carries `absent` on its DTO and list row, and is never probed again', async () => {
    fleet.setNextExecResult({
      exitCode: 1,
      stdout: '',
      stderr: "error: unknown command 'agent-terminal'",
    });
    const dto = await create();
    expect(dto).toMatchObject({ state: 'running', terminalServer: 'absent', failureReason: null });
    const listed = await lifecycle.list(KEY(), { take: 10, skip: 0 }, fx.ctx);
    expect(listed.instances[0]).toMatchObject({ id: dto.id, terminalServer: 'absent' });

    // No retry loop: a hibernate and a wake of the same digest probe nothing.
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    const woken = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(woken).toMatchObject({ state: 'running', terminalServer: 'absent' });
    expect(probes()).toHaveLength(1);
    expect(await driveBoot(dto.id)).toBe('noop');
    expect(probes()).toHaveLength(1);
  });

  it('a probe that cannot answer leaves `unknown` and never fails the boot — the next boot probes again', async () => {
    const exec = vi.spyOn(fleet, 'exec').mockRejectedValueOnce(new Error('exec timed out'));
    const dto = await create();
    expect(dto).toMatchObject({ state: 'running', terminalServer: 'unknown' });
    expect((await row(dto.id)).terminalServerDigest).toBeNull();
    exec.mockRestore();

    // An answer without an exit code is not an answer either.
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    fleet.setNextExecResult({ exitCode: -1, stdout: '', stderr: '' });
    expect((await lifecycle.wake(KEY(), dto.id, fx.ctx)).terminalServer).toBe('unknown');

    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    expect((await lifecycle.wake(KEY(), dto.id, fx.ctx)).terminalServer).toBe('present');
  });

  it('a too-short master key refuses the create before anything is taken', async () => {
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'short');
    await expect(create()).rejects.toThrow(AgentInstancesUnavailableError);
    expect(await adminDb.agentInstance.count()).toBe(0);
    expect(await slots()).toEqual([]);
    expect(fleet.persistentSpecs).toEqual([]);
  });

  it('with the terminal OFF, the machine boots as before: no terminal config, no probe, `unknown`', async () => {
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    const dto = await create();
    expect(fleet.persistentSpecs[0]!.terminal).toBeNull();
    expect(fleet.execs).toEqual([]);
    expect(dto).toMatchObject({ state: 'running', terminalServer: 'unknown' });
  });
});

describe('wake — an older agent’s machine config is brought up to date BEFORE its start (Q8)', () => {
  it('an agent made before the terminal: ONE update then the start, the digest and the home mount unchanged; an up-to-date wake sends no update', async () => {
    // Made with the terminal off — the shape every pre-terminal agent has.
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    const dto = await create();
    const { machineId } = await row(dto.id);
    expect(fleet.machineConfigVersion(machineId!)).toBe(0);
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);

    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
    fleet.operations.length = 0;
    const woken = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(woken.state).toBe('running');
    expect(fleet.operations.filter((o) => !o.startsWith('machine:exec'))).toEqual([
      `machine:update:${machineId}`,
      `machine:start:${machineId}`,
    ]);
    expect(fleet.machineConfigVersion(machineId!)).toBe(AGENT_MACHINE_CONFIG_VERSION);
    const [spec] = fleet.persistentSpecs;
    expect(spec!.image).toBe(`ghcr.io/moooon-b-v/motir-sandbox@${dto.imageDigest}`);
    expect(spec!.mountPath).toBe('/home/node');
    // The first boot with the terminal on probes this digest.
    expect(woken.terminalServer).toBe('present');

    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    fleet.operations.length = 0;
    await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(fleet.operations.filter((o) => o.startsWith('machine:update'))).toEqual([]);
    expect(fleet.operations).toContain(`machine:start:${machineId}`);
    expect(probes()).toHaveLength(1);
  });

  it('a rotated master key re-applies the config on the next wake', async () => {
    const dto = await create();
    const { machineId } = await row(dto.id);
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'r'.repeat(48));
    fleet.operations.length = 0;
    await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(fleet.operations.slice(0, 2)).toEqual([
      `machine:update:${machineId}`,
      `machine:start:${machineId}`,
    ]);
  });

  it('a config update that fails fails the wake in words and releases the slot — nothing is started', async () => {
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    const dto = await create();
    await lifecycle.hibernate(KEY(), dto.id, fx.ctx);
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
    vi.spyOn(fleet, 'ensureMachineConfig').mockRejectedValueOnce(new Error('409 version mismatch'));
    fleet.operations.length = 0;
    const failed = await lifecycle.wake(KEY(), dto.id, fx.ctx);
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toMatch(/could not start/);
    expect(fleet.operations.filter((o) => o.startsWith('machine:start'))).toEqual([]);
    expect(await slots()).toEqual([]);
  });
});

describe('the no-terminal reason (Q3, Q8)', () => {
  it('maps to 409 `no_terminal_server` in words', async () => {
    const res = mapAgentInstanceError(new AgentInstanceNoTerminalServerError('inst-1'))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'no_terminal_server',
      error:
        'This agent was made before the terminal existed, so its image has no terminal to open.',
    });
  });

  it('the probe’s record is guarded on the digest the row still pins', async () => {
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    const dto = await create();
    const moved = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      agentInstanceRepository.recordTerminalServer(
        dto.id,
        { terminalServer: 'present', digest: 'sha256:' + '0'.repeat(64) },
        tx,
      ),
    );
    expect(moved).toBe(0);
    expect((await row(dto.id)).terminalServer).toBe('unknown');
  });
});
