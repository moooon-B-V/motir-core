import { describe, expect, it } from 'vitest';
import { FORCE_INSTANCE_HEADER, NO_SUCH_MACHINE } from '@/scripts/staging/lib/pinnedClient';
import { shScript, type FlyRunner } from '@/loadtest/run/fly';
import {
  READY_PATH,
  curlScript,
  generatorProbe,
  parseCurl,
  pinLoop,
  type Probe,
  type ProbeAnswer,
} from '@/loadtest/run/pinned';

// The N-machine pin loop (Story MOTIR-8538 · MOTIR-8678), over a stubbed probe and
// a stubbed `fly`. Staging is flycast-only, so every probe must leave from the
// generator through `fly ssh console -C "sh -c '…'"`.

const BASE = 'http://motir-core-staging.flycast';
const READY: ProbeAnswer = { status: 200, body: '{"state":"ready","inFlight":0,"queued":0}' };
const PROXY_REFUSAL: ProbeAnswer = { status: 503, body: 'no such machine' };

function stubProbe(answer: (id: string) => ProbeAnswer) {
  const calls: { url: string; pinned: string }[] = [];
  const probe: Probe = async (url, headers) => {
    const pinned = headers[FORCE_INSTANCE_HEADER]!;
    calls.push({ url, pinned });
    return answer(pinned);
  };
  return { probe, calls };
}

describe('pinLoop', () => {
  for (const n of [1, 2, 3]) {
    it(`at N=${n}: the enforcement probe, then one pinned readiness request per machine`, async () => {
      const ids = Array.from({ length: n }, (_, i) => `m${i + 1}`);
      const { probe, calls } = stubProbe((id) => (id === NO_SUCH_MACHINE ? PROXY_REFUSAL : READY));
      const r = await pinLoop(probe, BASE, ids);
      expect(r).toMatchObject({
        ok: true,
        enforced: true,
        unknownIdAnswer: 'status 503',
        reason: null,
      });
      expect(calls.map((c) => c.pinned)).toEqual([NO_SUCH_MACHINE, ...ids]);
      for (const c of calls) expect(c.url).toBe(`${BASE}${READY_PATH}`);
    });
  }

  it('a proxy that lets the app answer a bogus pin is not enforced, and no machine is probed', async () => {
    const { probe, calls } = stubProbe(() => READY);
    const r = await pinLoop(probe, BASE, ['m1', 'm2']);
    expect(r.ok).toBe(false);
    expect(r.enforced).toBe(false);
    expect(r.reason).toMatch(/ignores fly-force-instance-id/);
    expect(calls).toHaveLength(1);
  });

  it('a redirect is a failure, not a pass', async () => {
    const { probe } = stubProbe((id) =>
      id === NO_SUCH_MACHINE ? PROXY_REFUSAL : id === 'm2' ? { status: 301, body: '' } : READY,
    );
    const r = await pinLoop(probe, BASE, ['m1', 'm2']);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not ready: m2 (redirect 301)');
  });

  it('a machine answering draining (503) is not ready', async () => {
    const { probe } = stubProbe((id) =>
      id === NO_SUCH_MACHINE ? PROXY_REFUSAL : { status: 503, body: '{"state":"draining"}' },
    );
    const r = await pinLoop(probe, BASE, ['m1']);
    expect(r.reason).toBe('not ready: m1 (status 503 draining)');
  });
});

describe('the generator probe', () => {
  it('is curl on the generator, as an sh -c script, never a bare -C string', async () => {
    const calls: string[][] = [];
    const fly: FlyRunner = async (args) => {
      calls.push([...args]);
      const pinned = /fly-force-instance-id: ([^"]+)"/.exec(args.at(-1)!)![1]!;
      return {
        code: 0,
        stdout: pinned === NO_SUCH_MACHINE ? 'no such machine\n503' : `${READY.body}\n200`,
        stderr: '',
      };
    };
    const probe = generatorProbe(fly, 'motir-loadgen', 'gen1');
    const r = await pinLoop(probe, BASE, ['m1', 'm2', 'm3']);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(4);
    for (const args of calls) {
      expect(args.slice(0, 7)).toEqual([
        'ssh',
        'console',
        '-a',
        'motir-loadgen',
        '--machine',
        'gen1',
        '-C',
      ]);
      expect(args[7]).toMatch(/^sh -c 'curl .*'$/);
      expect(args[7]).toContain(`"${BASE}${READY_PATH}"`);
    }
  });

  it('a failed ssh session is no answer', async () => {
    const fly: FlyRunner = async () => ({ code: 1, stdout: '', stderr: 'ssh: unreachable' });
    expect(await generatorProbe(fly, 'g', 'id')('http://x.flycast/api/health/ready', {})).toEqual({
      status: 0,
      body: '',
    });
  });

  it('parseCurl splits the body from the status line', () => {
    expect(parseCurl('{"state":"ready"}\n200\n')).toEqual({
      status: 200,
      body: '{"state":"ready"}',
    });
    expect(parseCurl('301')).toEqual({ status: 301, body: '' });
    expect(parseCurl('garbage')).toEqual({ status: 0, body: '' });
  });

  it('refuses to build a script from an unsafe URL or header', () => {
    expect(() => curlScript("http://x/'; rm -rf /", {})).toThrow(/unsafe URL/);
    expect(() => curlScript('http://x/', { [FORCE_INSTANCE_HEADER]: '$(id)' })).toThrow(
      /unsafe header/,
    );
    expect(() => shScript("echo 'x'")).toThrow(/single quote/);
  });
});
