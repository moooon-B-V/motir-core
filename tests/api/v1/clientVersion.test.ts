import { describe, expect, it } from 'vitest';
import {
  CLIENT_VERSION_FLOOR_ENV,
  CLIENT_VERSION_HEADER,
  CLIENT_WARNING_HEADER,
  clientVersionFloor,
  clientVersionWarning,
  stampClientVersionWarning,
  compareClientVersions,
  judgeClientVersion,
} from '@/lib/api/v1/clientVersion';

// THE SERVER'S HALF OF THE STALE-CLI FIX (MOTIR-4974 · MOTIR-4970).
//
// A reader's container ran `@motir/cli` 0.1.0 for six weeks. The other two
// children of that bug ship INSIDE the image and so cannot reach a container
// that already exists; the server is the one thing such a client still talks
// to. Everything here is about saying the right thing to it — and, just as
// importantly, saying nothing to everyone else.

const env = (floor?: string): NodeJS.ProcessEnv =>
  (floor === undefined ? {} : { [CLIENT_VERSION_FLOOR_ENV]: floor }) as NodeJS.ProcessEnv;

const request = (version?: string) => ({
  headers: {
    get: (name: string) =>
      name.toLowerCase() === CLIENT_VERSION_HEADER && version !== undefined ? version : null,
  },
});

describe('the floor is SERVER-owned', () => {
  it('is read from the environment, so raising it ships no CLI', () => {
    // ⚠️ THE WHOLE POINT. The clients this is aimed at are the ones that do not
    // update — a floor compiled into this repository could only start warning a
    // stale install by publishing something that install will never fetch.
    expect(clientVersionFloor(env('0.5.0'))).toBe('0.5.0');
  });

  it('is ABSENT by default, and absent means silence', () => {
    // A deployment that has not decided on a floor does not get to nag every
    // caller by default.
    expect(clientVersionFloor(env())).toBeNull();
    expect(clientVersionFloor(env('   '))).toBeNull();
    expect(judgeClientVersion('0.1.0', null)).toBeNull();
    expect(judgeClientVersion(null, null)).toBeNull();
  });

  it('changing it changes the verdict, with NO client change', () => {
    // Same client, same request, two deployments. This is the property the card
    // exists for: the reach into an installed base that cannot be redeployed.
    expect(judgeClientVersion('0.4.0', '0.5.0')).not.toBeNull();
    expect(judgeClientVersion('0.4.0', '0.3.0')).toBeNull();
  });
});

describe('the verdict', () => {
  it('names BOTH the version it saw and the floor', () => {
    const warning = judgeClientVersion('0.1.0', '0.5.0');
    expect(warning).toContain('0.1.0');
    expect(warning).toContain('0.5.0');
    expect(warning).toContain('npm install -g @motir/cli@latest');
  });

  it('is silent at or above the floor', () => {
    expect(judgeClientVersion('0.5.0', '0.5.0')).toBeNull();
    expect(judgeClientVersion('0.6.0', '0.5.0')).toBeNull();
    expect(judgeClientVersion('0.10.0', '0.9.0')).toBeNull();
  });

  it('orders numerically, not lexically', () => {
    // '0.10.0' < '0.9.0' as strings. A server that believed that would warn the
    // newest client it has ever seen.
    expect(compareClientVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareClientVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareClientVersions('1.2', '1.2.0')).toBe(0);
    expect(compareClientVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(compareClientVersions('nonsense', '0.0.1')).toBe(-1);
  });

  it('WARNS on an absent version — the decision, not an oversight', () => {
    // ⚠️ EVERY CLIENT ALREADY IN THE WILD REPORTS NOTHING, including the 0.1.0
    // install this bug was filed from. Treating absence as "probably fine" would
    // make this mechanism reach exactly the population it was built for and say
    // nothing to them. Absence is not ambiguous in the direction that matters: a
    // caller that does not report a version cannot be a client NEWER than the
    // one that started reporting.
    const warning = judgeClientVersion(null, '0.5.0');
    expect(warning).toContain('did not report a version');
    expect(warning).toContain('0.5.0');
    expect(judgeClientVersion('   ', '0.5.0')).toContain('did not report a version');
  });

  it('never REFLECTS an unreadable value into the response', () => {
    // Echoing an arbitrary request header into a response header is how a
    // header-injection bug is written. An unreadable version is treated as an
    // unreported one.
    const warning = judgeClientVersion('0.1.0\r\nX-Injected: yes', '0.5.0');
    expect(warning).toContain('unreadable version');
    expect(warning).not.toContain('X-Injected');
    expect(warning).not.toMatch(/[\r\n]/);
  });

  it('stays single-line ASCII whatever it answers', () => {
    for (const reported of [null, '0.1.0', 'nope', '0.1.0-rc.1']) {
      const warning = judgeClientVersion(reported, '0.5.0');
      expect(warning).not.toBeNull();
      expect(warning).toMatch(/^[\x20-\x7E]+$/);
    }
  });
});

describe('reading it off a request', () => {
  it('judges the header the CLI actually sends', () => {
    expect(clientVersionWarning(request('0.1.0'), env('0.5.0'))).toContain('0.1.0');
    expect(clientVersionWarning(request('0.9.0'), env('0.5.0'))).toBeNull();
    expect(clientVersionWarning(request(), env('0.5.0'))).toContain('did not report');
    expect(clientVersionWarning(request('0.1.0'), env())).toBeNull();
  });

  it('defaults to the real process environment', () => {
    // The default-parameter arms: shipped code calls these with no `env`, so the
    // arm every test would otherwise skip is the only one production uses.
    const before = process.env[CLIENT_VERSION_FLOOR_ENV];
    try {
      delete process.env[CLIENT_VERSION_FLOOR_ENV];
      expect(clientVersionFloor()).toBeNull();
      expect(clientVersionWarning(request('0.1.0'))).toBeNull();

      process.env[CLIENT_VERSION_FLOOR_ENV] = '0.5.0';
      expect(clientVersionFloor()).toBe('0.5.0');
      expect(clientVersionWarning(request('0.1.0'))).toContain('0.5.0');
    } finally {
      if (before === undefined) delete process.env[CLIENT_VERSION_FLOOR_ENV];
      else process.env[CLIENT_VERSION_FLOOR_ENV] = before;
    }
  });

  it('publishes a response header distinct from the request one', () => {
    // Two names, deliberately: one is what a client CLAIMS, the other is what
    // this server SAYS about it. Collapsing them would make a response
    // indistinguishable from an echo.
    expect(CLIENT_WARNING_HEADER).not.toBe(CLIENT_VERSION_HEADER);
    expect(CLIENT_VERSION_HEADER).toBe('x-motir-client-version');
  });
});

describe('stamping it onto a response', () => {
  it('sets the warning header only when there IS a verdict', () => {
    // ⚠️ THE ARM THE WRAPPER CANNOT DRIVE. `withV1Route` is held at 90% branches
    // and none of its callers configures a floor, so this conditional lives here
    // and is exercised here — with no database — rather than adding an un-driven
    // arm to the v1 envelope.
    const silent = new Headers();
    stampClientVersionWarning(silent, request('0.1.0'), env());
    expect(silent.get(CLIENT_WARNING_HEADER)).toBeNull();

    const warned = new Headers();
    stampClientVersionWarning(warned, request('0.1.0'), env('0.5.0'));
    expect(warned.get(CLIENT_WARNING_HEADER)).toContain('0.5.0');
  });

  it('defaults to the process environment at the real call site', () => {
    const before = process.env[CLIENT_VERSION_FLOOR_ENV];
    try {
      delete process.env[CLIENT_VERSION_FLOOR_ENV];
      const headers = new Headers();
      stampClientVersionWarning(headers, request('0.1.0'));
      expect(headers.get(CLIENT_WARNING_HEADER)).toBeNull();
    } finally {
      if (before !== undefined) process.env[CLIENT_VERSION_FLOOR_ENV] = before;
    }
  });
});
