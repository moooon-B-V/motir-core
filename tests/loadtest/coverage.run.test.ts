import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FORCE_INSTANCE_HEADER, NO_SUCH_MACHINE } from '@/scripts/staging/lib/pinnedClient';
import {
  listMachines,
  parseMachines,
  PlatformReadError,
  readEnv,
  scaleGroup,
  startMachine,
  stopMachine,
  type CommandResult,
  type Exec,
  type FlyRunner,
  type Machine,
} from '@/loadtest/run/fly';
import {
  k6VersionMismatch,
  parseK6Version,
  pickGenerator,
  pollOnce,
  prepareRemote,
  readK6Version,
  readRemoteLine,
  startAndWait,
  startDetached,
  type GeneratorRef,
} from '@/loadtest/run/generator';
import { branchConnectionString, copiedFrom, readBranch } from '@/loadtest/run/neon';
import { parseCurl, pinLoop, READY_PATH, type ProbeAnswer } from '@/loadtest/run/pinned';
import { EXIT, manifestShortfall, runLoadTest, traceRateOf } from '@/loadtest/run/run';
import { UNMEASURED } from '@/loadtest/run/runRecord';
import { loadProfile } from '@/loadtest/profiles/schema';
import { resolveProfile } from '@/loadtest/profiles/resolve';
import {
  APP,
  BASE_URL,
  ENV,
  GEN_APP,
  appMachine,
  deps,
  fail,
  fake,
  fakeExec,
  generatorStarts,
  generatorStops,
  k6Starts,
  manifestFor,
  ok,
  record,
  resetFake,
  ROOT,
  SMOKE_ARGS,
  type FakeMachine,
} from './fakePlatform';

// The run command's remaining branches (Story MOTIR-8538 · MOTIR-8681): every
// refusal and fallback runCommand.test.ts does not reach, driven through the same
// fake `fly` / `neonctl` platform, plus the fly / neon / pinned / generator helpers
// over stubbed runners.

beforeEach(resetFake);

/** A `fly` runner answering from a script, recording every call. */
function scripted(answer: (args: readonly string[]) => CommandResult) {
  const calls: string[][] = [];
  const fly: FlyRunner = async (args) => {
    calls.push([...args]);
    return answer(args);
  };
  return { fly, calls };
}

/** An `Exec` that answers matching calls itself and passes the rest to the fake platform. */
function override(
  pick: (bin: string, args: readonly string[]) => CommandResult | 'throw' | undefined,
): Exec {
  return async (bin, args, opts) => {
    const a = pick(bin, args);
    if (a === 'throw') {
      fake.world.calls.push({ bin, args: [...args] });
      throw new Error('ssh: session dropped');
    }
    if (a) {
      fake.world.calls.push({ bin, args: [...args] });
      return a;
    }
    return fakeExec(bin, args, opts);
  };
}

const noGuest = { cpu_kind: 'performance' } as unknown as FakeMachine['guest'];
const reason = (dir: string | null) => record(dir!).reason;

describe('fly — machine JSON and command failures', () => {
  it('parseMachines refuses non-JSON and a non-array', () => {
    expect(() => parseMachines('Error: not logged in')).toThrow(PlatformReadError);
    expect(() => parseMachines('Error: not logged in')).toThrow(/did not return JSON/);
    expect(() => parseMachines('{"machines":[]}')).toThrow(/did not return an array/);
  });

  it('parseMachines falls back to the digest, then config.image, and reads no services', () => {
    const [byDigest, byImage, bare] = parseMachines(
      JSON.stringify([
        { id: 'm1', image_ref: { digest: 'sha256:abc' }, config: { services: 'nope' } },
        { id: 'm2', image_ref: { registry: 'registry.fly.io' }, config: { image: 'img:1' } },
        null,
      ]),
    );
    expect(byDigest).toMatchObject({ imageRef: 'sha256:abc', imageTag: null, services: [] });
    expect(byImage).toMatchObject({ imageRef: 'img:1', imageTag: null });
    expect(bare).toMatchObject({
      id: 'unknown',
      state: 'unknown',
      group: 'app',
      cpus: null,
      memoryMb: null,
      imageRef: 'unknown',
    });
  });

  it('listMachines, startMachine and stopMachine throw on a non-zero exit', async () => {
    const { fly } = scripted(() => ({ code: 3, stdout: '', stderr: 'no' }));
    await expect(listMachines(fly, APP)).rejects.toThrow(`fly machine list -a ${APP} exited 3`);
    await expect(startMachine(fly, GEN_APP, 'g1')).rejects.toThrow(
      `fly machine start g1 -a ${GEN_APP} exited 3`,
    );
    await expect(stopMachine(fly, GEN_APP, 'g1')).rejects.toThrow(
      `fly machine stop g1 -a ${GEN_APP} exited 3`,
    );
  });

  it('scaleGroup throws when both spellings are refused, having tried both', async () => {
    const { fly, calls } = scripted(() => ({ code: 1, stdout: '', stderr: '' }));
    await expect(scaleGroup(fly, APP, 2)).rejects.toThrow(/refused both spellings.*exits 1, 1/);
    expect(calls.map((c) => c[2])).toEqual(['app=2', '2']);
  });

  it('readEnv refuses a non-variable name without calling fly, and throws on a failed read', async () => {
    const { fly, calls } = scripted(() => ({ code: 1, stdout: 'partial', stderr: '' }));
    await expect(readEnv(fly, APP, 'app1', 'db url')).rejects.toThrow(
      /not an environment variable name/,
    );
    expect(calls).toEqual([]);
    // Exit 1 WITH output is not "unset": the read itself is not trusted.
    await expect(readEnv(fly, APP, 'app1', 'DATABASE_URL')).rejects.toThrow(
      'reading DATABASE_URL on app1 exited 1',
    );
    const ssh = scripted(() => ({ code: 255, stdout: '', stderr: 'ssh' }));
    await expect(readEnv(ssh.fly, APP, 'app1', 'DATABASE_URL')).rejects.toThrow(/exited 255/);
  });
});

describe('neon — branch JSON and command failures', () => {
  it('copiedFrom refuses JSON with no branch id', () => {
    expect(() => copiedFrom(null, null)).toThrow(/has no id/);
    expect(() => copiedFrom(null, { branch: 'br-1' })).toThrow(/has no id/);
    expect(copiedFrom(null, { id: 'br-2', created_at: '2026-10-01T00:00:00Z' })).toEqual({
      branchId: 'br-2',
      copiedAt: '2026-10-01T00:00:00Z',
      copiedAtField: 'created_at',
    });
  });

  it('readBranch throws on a non-zero exit and on output that is not JSON', async () => {
    const failing: Exec = async () => fail(2);
    await expect(readBranch(failing, 'p', 'b')).rejects.toThrow('neonctl branches get exited 2');
    const garbled: Exec = async () => ok('Branch loadtest\n');
    await expect(readBranch(garbled, 'p', 'b')).rejects.toThrow(/did not return JSON/);
  });

  it('branchConnectionString throws on a non-zero exit and on output with no host', async () => {
    const failing: Exec = async () => fail(1);
    await expect(branchConnectionString(failing, 'p', 'b')).rejects.toThrow(
      'neonctl connection-string exited 1',
    );
    const hostless: Exec = async () => ok('\n');
    await expect(branchConnectionString(hostless, 'p', 'b')).rejects.toThrow(
      /returned no readable host/,
    );
  });
});

describe('pinned — answers the loop reads', () => {
  it('parseCurl reads a non-numeric status as 0', () => {
    expect(parseCurl('body\nnot-a-code')).toEqual({ status: 0, body: 'body' });
  });

  it('names a silent bogus pin "no answer", and a non-string state as no state', async () => {
    const answers: Record<string, ProbeAnswer> = {
      [NO_SUCH_MACHINE]: { status: 0, body: '' },
      a: { status: 0, body: '' },
      b: { status: 503, body: '{"state":5}' },
      c: { status: 200, body: '{"state":"ready"}' },
    };
    const urls: string[] = [];
    const res = await pinLoop(
      async (url, headers) => {
        urls.push(url);
        return answers[headers[FORCE_INSTANCE_HEADER]!]!;
      },
      `${BASE_URL}///`,
      ['a', 'b', 'c'],
    );
    expect(urls[0]).toBe(`${BASE_URL}${READY_PATH}`);
    expect(res).toMatchObject({
      enforced: true,
      unknownIdAnswer: 'no answer',
      ok: false,
      machines: [
        { id: 'a', ready: false, answer: 'no answer' },
        { id: 'b', ready: false, answer: 'status 503' },
        { id: 'c', ready: true, answer: 'status 200 ready' },
      ],
    });
    expect(res.reason).toBe('not ready: a (no answer), b (status 503)');
  });
});

describe('generator — helpers over a stubbed fly', () => {
  const machine = (id: string, state = 'started') =>
    ({ id, state, region: 'iad', group: 'app', services: [] }) as unknown as Machine;

  it('pickGenerator takes the first machine by id, or null for none', () => {
    expect(pickGenerator([machine('gen2'), machine('gen1'), machine('gen3')])?.id).toBe('gen1');
    expect(pickGenerator([])).toBeNull();
  });

  it('startAndWait names a machine that vanished from the list as missing', async () => {
    let clock = 0;
    const { fly } = scripted((args) => (args[1] === 'list' ? ok('[]') : ok()));
    const g: GeneratorRef = { fly, app: GEN_APP, id: 'gen1' };
    await expect(
      startAndWait(g, {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow('generator gen1 did not reach started within 10 s (state missing)');
    expect(clock).toBe(10_000);
  });

  it('parseK6Version and k6VersionMismatch: an unreadable version', () => {
    const found = parseK6Version('command not found');
    expect(found).toEqual({ version: null, extensions: [] });
    expect(k6VersionMismatch(found, { K6_VERSION: 'v1.2.1' })).toBe(
      'k6 is unreadable, versions.env pins v1.2.1',
    );
  });

  it('readK6Version, prepareRemote and startDetached throw on a non-zero exit', async () => {
    const g: GeneratorRef = { ...scripted(() => fail(4)), app: GEN_APP, id: 'gen1' };
    await expect(readK6Version(g)).rejects.toThrow('/opt/loadtest/k6 version exited 4');
    await expect(prepareRemote(g)).rejects.toThrow(/preparing \/data\/run .* exited 4/);
    await expect(startDetached(g)).rejects.toThrow('starting k6 on the generator exited 4');
  });

  it('pollOnce: a failed ssh changes nothing; output without an exit marker is still running', async () => {
    const down: GeneratorRef = { ...scripted(() => fail(1)), app: GEN_APP, id: 'gen1' };
    expect(await pollOnce(down, 7)).toEqual({ exitCode: null, newLines: [], linesSeen: 7 });
    const running: GeneratorRef = {
      ...scripted(() => ok('line a\nline b\n@@exit \n')),
      app: GEN_APP,
      id: 'gen1',
    };
    expect(await pollOnce(running, 3)).toEqual({
      exitCode: null,
      newLines: ['line a', 'line b'],
      linesSeen: 5,
    });
  });

  it('readRemoteLine is null on a failed read and on an empty file', async () => {
    const failing: GeneratorRef = { ...scripted(() => fail(1)), app: GEN_APP, id: 'gen1' };
    expect(await readRemoteLine(failing, '/data/run/started.at')).toBeNull();
    const empty: GeneratorRef = { ...scripted(() => ok('\n')), app: GEN_APP, id: 'gen1' };
    expect(await readRemoteLine(empty, '/data/run/started.at')).toBeNull();
  });
});

describe('run — pure helpers', () => {
  it('traceRateOf: unset, out of range or not a number reads as 0', () => {
    expect(traceRateOf(null)).toBe(0);
    expect(traceRateOf(' 0.25\n')).toBe(0.25);
    expect(traceRateOf('2')).toBe(0);
    expect(traceRateOf('-0.1')).toBe(0);
    expect(traceRateOf('lots')).toBe(0);
  });

  it('manifestShortfall names burst agents, readers and workspaces in turn', async () => {
    const { profile } = await loadProfile('smoke', 1, ROOT);
    const resolved = resolveProfile(profile, 1);
    const full = manifestFor(1);
    expect(manifestShortfall(full, resolved)).toBeNull();

    const noBurst = manifestFor(1);
    noBurst.agents = noBurst.agents.map((a) => ({ ...a, burst: undefined }));
    expect(manifestShortfall(noBurst, resolved)).toBe(
      `burst agents: 0 seeded, ${resolved.vus.burst} VUs`,
    );

    const fewUsers = { ...manifestFor(1), users: [] };
    expect(manifestShortfall(fewUsers, resolved)).toBe(
      `readers: 0 users seeded, ${resolved.vus.readers} VUs`,
    );

    const oneWorkspace = { ...manifestFor(1), workspaces: manifestFor(1).workspaces.slice(0, 1) };
    expect(manifestShortfall(oneWorkspace, resolved)).toBe(
      `workspaces: 1 seeded, ${profile.tenancy.agentWorkspaces} agent workspaces`,
    );
  });
});

describe('run — step 1 refusals', () => {
  const refusal = async (argv: string[], env: Record<string, string | undefined> = ENV) => {
    const out = await runLoadTest(argv, deps({ env }));
    expect(out).toEqual({ exitCode: EXIT.refused, runDir: null, reportExitCode: null });
    expect(fake.world.calls).toEqual([]);
    return fake.logs.join('\n');
  };

  it('no --app and no LOADTEST_STAGING_APP', async () => {
    expect(
      await refusal(['--profile', 'smoke', '--instances', '1'], {
        ...ENV,
        LOADTEST_STAGING_APP: undefined,
      }),
    ).toMatch(/--app \(or LOADTEST_STAGING_APP\) is required/);
  });

  it('an --app that is not LOADTEST_STAGING_APP', async () => {
    expect(
      await refusal(['--profile', 'smoke', '--instances', '1', '--app', 'other-staging']),
    ).toMatch(`--app other-staging is not LOADTEST_STAGING_APP (${APP})`);
  });

  it('names the missing flags', async () => {
    expect(await refusal(['--app', APP])).toMatch('missing --profile, --instances');
  });

  it('an --instances that is not a positive integer', async () => {
    expect(await refusal(['--profile', 'smoke', '--instances=0', '--app', APP])).toMatch(
      '--instances must be an integer ≥ 1, got 0',
    );
    expect(await refusal(['--profile', 'smoke', '--instances', '1.5', '--app', APP])).toMatch(
      'got 1.5',
    );
  });

  it('an environment the seed would refuse', async () => {
    expect(await refusal(SMOKE_ARGS, { ...ENV, LOADTEST_PRODUCTION_DB_HOSTS: undefined })).toMatch(
      'the seed would refuse: missing LOADTEST_PRODUCTION_DB_HOSTS',
    );
  });

  it('a profile whose target the offered load cannot reach', async () => {
    const smoke = JSON.parse(readFileSync(join(ROOT, 'loadtest/profiles/smoke.json'), 'utf8'));
    smoke.thresholds.perInstance.targetRps = 100_000;
    writeFileSync(join(fake.cwd, 'greedy.json'), JSON.stringify(smoke));
    expect(await refusal(['--profile', 'greedy.json', '--instances', '1', '--app', APP])).toMatch(
      /invalid load profile:[\s\S]*thresholds\.perInstance\.targetRps: 100000 is above offered/,
    );
  });

  it('a --baseline with no run.json, or one not run at 1 instance', async () => {
    mkdirSync(join(fake.cwd, 'empty'));
    const argv = ['--profile', 'smoke', '--instances', '2', '--app', APP, '--baseline'];
    expect(await refusal([...argv, 'empty'])).toMatch('--baseline: no run.json in empty');
    mkdirSync(join(fake.cwd, 'at2'));
    writeFileSync(join(fake.cwd, 'at2/run.json'), JSON.stringify({ instances: 2 }));
    expect(await refusal([...argv, 'at2'])).toMatch('--baseline: at2 ran at 2 instances, not 1');
  });
});

describe('run — the platform reads', () => {
  it('takes --app from LOADTEST_STAGING_APP and completes', async () => {
    const out = await runLoadTest(['--profile', 'smoke', '--instances', '1'], deps());
    expect(out.exitCode).toBe(EXIT.completed);
    expect(record(out.runDir!).app.name).toBe(APP);
  });

  it('records a guest with no cpus or memory as unmeasured, on staging and production alike', async () => {
    fake.world.production = [appMachine('prod1', { guest: noGuest })];
    fake.world.staging = [appMachine('app1', { guest: noGuest })];
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.completed);
    const r = record(out.runDir!);
    expect(r.production).toEqual({
      cpuKind: 'performance',
      cpus: UNMEASURED,
      memoryMb: UNMEASURED,
    });
    expect(r.app.machines[0]).toMatchObject({ cpus: UNMEASURED, memoryMb: UNMEASURED });
  });

  it('production with no app machine exits 4 before the generator is touched', async () => {
    fake.world.production = [];
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(reason(out.runDir)).toBe('motir-core has no app machine to match the size against');
    expect(generatorStarts()).toEqual([]);
    expect(generatorStops()).toEqual([]);
  });

  it('an app machine with no service exits 4', async () => {
    fake.world.staging = [appMachine('app1', { services: [] })];
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(reason(out.runDir)).toBe('app machine app1 has no service');
  });

  it('a failed platform read is exit 4 with the read named, and the report still runs', async () => {
    const exec = override((_bin, args) =>
      args[1] === 'list' && args.includes('motir-core') ? fail(1) : undefined,
    );
    const out = await runLoadTest(SMOKE_ARGS, deps({ exec }));
    expect(out.exitCode).toBe(EXIT.platform);
    expect(reason(out.runDir)).toBe('fly machine list -a motir-core exited 1');
    expect(fake.reports).toEqual([out.runDir]);
  });

  it('a generator app with no machine exits 4 and stops nothing', async () => {
    fake.world.generator = [];
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(reason(out.runDir)).toBe(`${GEN_APP} has no machine`);
    expect(generatorStops()).toEqual([]);
  });

  it('a generator guest with no cpus is recorded unmeasured; an unreadable k6 too', async () => {
    fake.world.generator[0]!.guest = noGuest;
    fake.world.k6Version = 'sh: k6: not found\n';
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    const r = record(out.runDir!);
    expect(r.generator.cpus).toBe(UNMEASURED);
    expect(r.k6.version).toBe(UNMEASURED);
    expect(r.reason).toMatch(/^k6 is unreadable/);
    expect(generatorStops()).toHaveLength(1);
  });

  it('a generator that will not stop is logged for a hand stop; the run still completes', async () => {
    const exec = override((_bin, args) => (args[1] === 'stop' ? fail(1) : undefined));
    const out = await runLoadTest(SMOKE_ARGS, deps({ exec }));
    expect(out.exitCode).toBe(EXIT.completed);
    expect(record(out.runDir!).generator.stoppedAt).toBe(UNMEASURED);
    expect(fake.logs.join('\n')).toMatch(
      /⚠️ could not stop generator gen1: fly machine stop gen1 -a motir-loadgen exited 1 — stop it by hand/,
    );
  });

  it('an error that is not a platform read is exit 4 "unexpected", and the generator is stopped', async () => {
    const out = await runLoadTest(
      SMOKE_ARGS,
      deps({
        preflight: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(out.exitCode).toBe(EXIT.platform);
    expect(reason(out.runDir)).toBe('unexpected: boom');
    expect(generatorStops()).toHaveLength(1);
  });
});

describe('run — step 7, the database and its limits', () => {
  it('a machine with no DATABASE_URL exits 4 naming no readable host', async () => {
    fake.world.stagingEnv = {};
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(reason(out.runDir)).toMatch(
      /^staging reads no readable host, not the branch's endpoint/,
    );
  });

  it('LOADTEST_ALLOWED_DB_HOST that is not the branch endpoint exits 4', async () => {
    const env = { ...ENV, LOADTEST_ALLOWED_DB_HOST: 'ep-other-1.us-east-2.aws.neon.tech' };
    const out = await runLoadTest(SMOKE_ARGS, deps({ env }));
    expect(out.exitCode).toBe(EXIT.platform);
    expect(reason(out.runDir)).toMatch(
      /^LOADTEST_ALLOWED_DB_HOST \(ep-other-1\.us-east-2\.aws\.neon\.tech\) is not the branch's endpoint/,
    );
  });

  it('a rate limit that is not a positive integer is recorded unmeasured and exits 4', async () => {
    fake.world.stagingEnv['MOTIR_MCP_RATE_LIMIT'] = 'lots';
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    const r = record(out.runDir!);
    expect(r.rateLimits).toEqual({ apiV1: 'default', mcp: UNMEASURED, agentWorkspace: 'default' });
    expect(r.reason).toBe('MOTIR_MCP_RATE_LIMIT on app1 is not a positive integer');
    expect(k6Starts()).toEqual([]);
  });
});

describe('run — step 8, the seed', () => {
  it('a failed reset exits 2', async () => {
    const out = await runLoadTest(
      SMOKE_ARGS,
      deps({ seed: async (command) => (command === 'reset' ? 3 : 0) }),
    );
    expect(out.exitCode).toBe(EXIT.refused);
    expect(reason(out.runDir)).toBe('pnpm loadtest:seed:reset exited 3');
  });

  it('a manifest for another base URL exits 2', async () => {
    const other = { ...manifestFor(1), baseUrl: 'http://elsewhere.flycast' };
    const out = await runLoadTest(SMOKE_ARGS, deps({ readManifest: async () => other }));
    expect(out.exitCode).toBe(EXIT.refused);
    expect(reason(out.runDir)).toBe("the manifest's base URL is not STAGING_BASE_URL");
    expect(k6Starts()).toEqual([]);
  });

  it('by default seeds through pnpm under the seed env and reads the manifest it wrote', async () => {
    const pnpm: { args: string[]; env: Record<string, string | undefined> }[] = [];
    const exec: Exec = async (bin, args, opts) => {
      if (bin !== 'pnpm') return fakeExec(bin, args, opts);
      pnpm.push({ args: [...args], env: { ...opts?.env } });
      if (args[1] === 'loadtest:seed') {
        writeFileSync(args[args.indexOf('--out') + 1]!, JSON.stringify(manifestFor(1)));
        return ok('seeded 8 users\n\n');
      }
      return ok('reset 0 rows\n');
    };
    const out = await runLoadTest(
      SMOKE_ARGS,
      deps({ exec, seed: undefined, readManifest: undefined }),
    );
    expect(out.exitCode).toBe(EXIT.completed);
    expect(pnpm.map((p) => p.args.slice(0, 2))).toEqual([
      ['-s', 'loadtest:seed'],
      ['-s', 'loadtest:seed:reset'],
    ]);
    expect(pnpm[0]!.env['DATABASE_URL']).toBe(ENV.LOADTEST_DATABASE_URL);
    expect(pnpm[0]!.env['MOTIR_BASE_URL']).toBe(BASE_URL);
    expect(fake.logs).toContain('seed | seeded 8 users');
    expect(fake.logs).toContain('seed | reset 0 rows');
  });

  it('a failed default seed logs its stderr, so the run says why', async () => {
    const exec: Exec = async (bin, args, opts) =>
      bin === 'pnpm'
        ? { code: 1, stdout: 'users: 8\n', stderr: 'Raw query failed. Code: `40P01`.\n\n' }
        : fakeExec(bin, args, opts);
    const out = await runLoadTest(
      SMOKE_ARGS,
      deps({ exec, seed: undefined, readManifest: undefined }),
    );
    expect(out.exitCode).toBe(EXIT.refused);
    expect(reason(out.runDir)).toBe('pnpm loadtest:seed exited 1');
    expect(fake.logs).toContain('seed | users: 8');
    expect(fake.logs).toContain('seed ! Raw query failed. Code: `40P01`.');
  });
});

describe('run — step 9, k6 on the generator', () => {
  it('k6 that never writes its exit file times out with exit 5, streaming its log', async () => {
    const exec = override((_bin, args) =>
      args.some((a) => a.includes('@@exit')) ? ok('running (00m10.0s)\n@@exit \n') : undefined,
    );
    const out = await runLoadTest(SMOKE_ARGS, deps({ exec }));
    expect(out.exitCode).toBe(EXIT.k6);
    expect(reason(out.runDir)).toMatch(/^k6 did not finish within \d+ s$/);
    expect(fake.logs).toContain('k6 | running (00m10.0s)');
    expect(record(out.runDir!).manifestDeleted).toBe(true);
    expect(generatorStops()).toHaveLength(1);
  });

  it('no started.at leaves the window unset; no ended.at records its end unmeasured', async () => {
    const noStart = override((_bin, args) =>
      args.at(-1)?.endsWith('started.at') && args.at(-1)?.startsWith('cat ') ? fail(1) : undefined,
    );
    const a = await runLoadTest(SMOKE_ARGS, deps({ exec: noStart }));
    expect(a.exitCode).toBe(EXIT.completed);
    expect(record(a.runDir!).window.startedAt).toBe(UNMEASURED);

    resetFake();
    const noEnd = override((_bin, args) =>
      args.at(-1)?.endsWith('ended.at') && args.at(-1)?.startsWith('cat ') ? fail(1) : undefined,
    );
    const b = await runLoadTest(SMOKE_ARGS, deps({ exec: noEnd }));
    expect(b.exitCode).toBe(EXIT.completed);
    expect(record(b.runDir!).window).toMatchObject({
      startedAt: '2026-10-15T20:00:00.000Z',
      endedAt: UNMEASURED,
    });
  });

  it('a summary.json that cannot be fetched exits 5; the other files are still fetched', async () => {
    const exec = override((_bin, args) =>
      args[2] === 'get' && args.at(-2)!.endsWith('summary.json') ? fail(1) : undefined,
    );
    const out = await runLoadTest(SMOKE_ARGS, deps({ exec }));
    expect(out.exitCode).toBe(EXIT.k6);
    expect(reason(out.runDir)).toBe('summary.json could not be fetched');
    expect(readFileSync(join(out.runDir!, 'k6.log'), 'utf8')).toBe('x\n');
  });

  it('a manifest or point-file delete that throws is logged and recorded as not deleted', async () => {
    const exec = override((_bin, args) =>
      args.some(
        (a) =>
          a.includes('rm -f /dev/shm/loadtest/manifest.json') ||
          a.includes('rm -f /data/run/k6-points'),
      )
        ? 'throw'
        : undefined,
    );
    const out = await runLoadTest(SMOKE_ARGS, deps({ exec }));
    expect(out.exitCode).toBe(EXIT.completed);
    expect(record(out.runDir!).manifestDeleted).toBe(false);
    const logs = fake.logs.join('\n');
    expect(logs).toMatch('⚠️ the manifest may still be on gen1 at /dev/shm/loadtest/manifest.json');
    expect(logs).toMatch('⚠️ the point file may still be on gen1 at /data/run/k6-points.json.gz');
  });
});

describe('run — the default report', () => {
  it('with no loadtest:report script, says so and reports null', async () => {
    const out = await runLoadTest(SMOKE_ARGS, deps({ report: undefined }));
    expect(out.exitCode).toBe(EXIT.completed);
    expect(out.reportExitCode).toBeNull();
    expect(fake.logs.join('\n')).toMatch(/`pnpm loadtest:report` is not in this checkout yet/);
  });

  it('with the script, runs it on the run directory and returns its exit code', async () => {
    writeFileSync(
      join(fake.cwd, 'package.json'),
      JSON.stringify({ scripts: { 'loadtest:report': 'tsx loadtest/report/report.ts' } }),
    );
    const reports: string[][] = [];
    const exec: Exec = async (bin, args, opts) => {
      if (bin !== 'pnpm') return fakeExec(bin, args, opts);
      reports.push([...args]);
      return { code: 1, stdout: 'VERDICT FAIL\n\n', stderr: '' };
    };
    const out = await runLoadTest(SMOKE_ARGS, deps({ exec, report: undefined }));
    expect(out.exitCode).toBe(EXIT.completed);
    expect(out.reportExitCode).toBe(1);
    expect(reports).toEqual([['-s', 'loadtest:report', out.runDir!]]);
    expect(fake.logs).toContain('VERDICT FAIL');
  });
});
