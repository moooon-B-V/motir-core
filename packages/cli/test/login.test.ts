import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupUserCode, loginCommand, type LoginDeps } from '../src/commands/login.js';
import { CLI_CLIENT_ID } from '../src/deviceAuth.js';
import { getCredential, listServers, setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import {
  GRANTED_CREDENTIAL,
  startDeviceTestServer,
  type DeviceTestServer,
  type DeviceTestServerOptions,
} from './helpers/deviceTestServer.js';

// `motir login` — the browser-completed default (Subtask MOTIR-1868).
//
// Driven as the real command against a REAL scripted device server over a real
// socket (see helpers/deviceTestServer.ts for why the transport is not stubbed).
// Two seams are injected and nothing else: `sleep`, so the poll cadence can be
// ASSERTED instead of waited through, and `openUrl`, so the headless path is a
// case in its own right rather than a property of the runner.
//
// The credential store is redirected to a temp dir via `MOTIR_CONFIG_HOME` in
// every test, so nothing here can touch a real `~/.config/motir/config.json`.

/** Undefined for the pure tests that never start one — and cleared after each
 *  close, since closing an already-closed server throws. */
let server: DeviceTestServer | undefined;
let home: string;
/** The cwd + home the AUTO-LINK step (MOTIR-1880) sees, pinned to throwaway
 *  directories for EVERY test in the file. A successful login now offers to
 *  write a `.motir.json`, and the one thing no suite may do is write that file
 *  into the checkout it is running from — so no test is left standing in the
 *  runner's real cwd, whether or not it is about the auto-link. */
let linkCwd: string;
let linkHome: string;
/** Every delay the command asked for, in order — the `slow_down` evidence. */
let slept: number[];
let stderr: string;

/** The injected seams, with a browser that reports "opened" by default. */
function deps(overrides: LoginDeps = {}): LoginDeps {
  return {
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    openUrl: async () => true,
    cwd: linkCwd,
    home: linkHome,
    ...overrides,
  };
}

async function serve(options: DeviceTestServerOptions = {}): Promise<DeviceTestServer> {
  server = await startDeviceTestServer(options);
  return server;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-login-'));
  linkCwd = mkdtempSync(join(tmpdir(), 'motir-login-cwd-'));
  linkHome = mkdtempSync(join(tmpdir(), 'motir-login-home-'));
  vi.stubEnv('MOTIR_CONFIG_HOME', home);
  // The server ladder must not fall through to a real host or to a link walked
  // up from the runner's cwd; every test passes --server explicitly.
  vi.stubEnv('MOTIR_SERVER', '');
  slept = [];
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await server?.close();
  server = undefined;
});

describe('the happy path, end to end', () => {
  it('requests a code, prints it with the URL, polls to success, and stores the credential', async () => {
    const s = await serve();

    await loginCommand({ server: s.url }, deps());

    // 1 — the grant was opened, reporting this machine so the approval screen
    // can answer "what is connecting" and the token is labelled for it.
    expect(s.starts).toEqual([{ hostname: hostname() }]);

    // 2 — the code and the URL were printed, code FIRST and grouped for typing.
    expect(stderr).toContain('Your code:  K4TP-9RXM');
    expect(stderr).toContain(`Open:       ${s.grant.verification_uri}`);
    expect(stderr.indexOf('Your code:')).toBeLessThan(stderr.indexOf('Open:'));

    // 3 — the poll carried the RFC 8628 body the route requires.
    expect(s.polls).toEqual([
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: s.grant.device_code,
        client_id: CLI_CLIENT_ID,
      },
    ]);

    // 4 — the credential landed in the same store `auth login` writes, so
    // `auth status`, `doctor` and every other command read it unchanged.
    expect(getCredential(s.url)).toEqual({
      token: GRANTED_CREDENTIAL.access_token,
      user: GRANTED_CREDENTIAL.user,
    });

    // 5 — the confirmation names the user AND the workspace.
    expect(stderr).toContain(
      `Logged in as yue@motir.test on ${s.url} (workspace ${GRANTED_CREDENTIAL.workspace.name}).`,
    );
  });

  it('waits at the server’s interval before the first poll', async () => {
    const s = await serve({ grant: { interval: 5 } });

    await loginCommand({ server: s.url }, deps());

    expect(slept).toEqual([5_000]);
  });
});

describe('the five poll states', () => {
  it('`authorization_pending` keeps waiting — it is the normal path, not an error', async () => {
    const s = await serve({
      poll: [
        { error: 'authorization_pending' },
        { error: 'authorization_pending' },
        { granted: true },
      ],
    });

    await loginCommand({ server: s.url }, deps());

    expect(s.polls).toHaveLength(3);
    // Three polls, all at the unchanged interval — pending never backs off.
    expect(slept).toEqual([5_000, 5_000, 5_000]);
    expect(getCredential(s.url)?.token).toBe(GRANTED_CREDENTIAL.access_token);
  });

  it('`slow_down` WIDENS the interval by 5s each time (the delay itself, not just survival)', async () => {
    const s = await serve({
      poll: [{ error: 'slow_down' }, { error: 'slow_down' }, { granted: true }],
    });

    await loginCommand({ server: s.url }, deps());

    // 5s → the throttle → 10s → the throttle again → 15s. The widening is the
    // assertion: a login that merely SURVIVED `slow_down` would show 5/5/5 and
    // keep tripping the server's per-grant throttle forever.
    expect(slept).toEqual([5_000, 10_000, 15_000]);
    expect(getCredential(s.url)?.token).toBe(GRANTED_CREDENTIAL.access_token);
  });

  it('`access_denied` exits non-zero with its own message and writes nothing', async () => {
    const s = await serve({ poll: [{ error: 'access_denied' }] });

    await expect(loginCommand({ server: s.url }, deps())).rejects.toMatchObject({
      message: 'Approval was denied. No credential was written.',
      exitCode: 1,
    });
    expect(getCredential(s.url)).toBeUndefined();
  });

  it('`expired_token` exits non-zero with a DIFFERENT message and writes nothing', async () => {
    const s = await serve({ poll: [{ error: 'expired_token' }] });

    const failure = await loginCommand({ server: s.url }, deps()).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toBe('The code expired before it was approved.');
    expect((failure as CliError).hint).toContain('motir login');
    // The two terminal states do not share a message — a user who denied and a
    // user whose code aged out need different next steps.
    expect((failure as CliError).message).not.toBe(
      'Approval was denied. No credential was written.',
    );
    expect(getCredential(s.url)).toBeUndefined();
  });

  it('success stores EXACTLY once and stops polling', async () => {
    const s = await serve({
      poll: [{ error: 'authorization_pending' }, { granted: true }],
    });

    await loginCommand({ server: s.url }, deps());

    // The grant is single-use server-side (the winning poll deletes the row), so
    // a CLI that polled once more would get `invalid_grant` and a second store
    // would be a second credential. One entry, one server, no extra poll.
    expect(s.polls).toHaveLength(2);
    expect(listServers()).toEqual([s.url]);
    expect(getCredential(s.url)).toEqual({
      token: GRANTED_CREDENTIAL.access_token,
      user: GRANTED_CREDENTIAL.user,
    });
  });

  it('`invalid_grant` is a hard error, not a retry', async () => {
    const s = await serve({ poll: [{ error: 'invalid_grant' }] });

    await expect(loginCommand({ server: s.url }, deps())).rejects.toThrow(
      /login could not be completed/,
    );
    expect(s.polls).toHaveLength(1);
    expect(getCredential(s.url)).toBeUndefined();
  });

  it('`server_error` (HTTP 500) is the one failure it keeps polling through', async () => {
    const s = await serve({ poll: [{ error: 'server_error' }, { granted: true }] });

    await loginCommand({ server: s.url }, deps());

    expect(s.polls).toHaveLength(2);
    expect(getCredential(s.url)?.token).toBe(GRANTED_CREDENTIAL.access_token);
  });
});

describe('headless parity — the browser is never load-bearing', () => {
  it('completes identically when `openUrl` reports FALSE (no display)', async () => {
    const s = await serve();

    await loginCommand({ server: s.url }, deps({ openUrl: async () => false }));

    expect(stderr).toContain('Your code:  K4TP-9RXM');
    expect(stderr).toContain(`Open:       ${s.grant.verification_uri}`);
    expect(stderr).toContain('Open that URL on any device');
    expect(stderr).not.toContain('Opened your browser');
    expect(getCredential(s.url)?.token).toBe(GRANTED_CREDENTIAL.access_token);
  });

  it('completes identically with `--no-browser`, and never ATTEMPTS a launch', async () => {
    const s = await serve();
    const open = vi.fn(async () => true);

    await loginCommand({ server: s.url, browser: false }, deps({ openUrl: open }));

    // The distinction from the case above: there, the launcher ran and declined;
    // here it is never invoked at all.
    expect(open).not.toHaveBeenCalled();
    expect(stderr).toContain('Your code:  K4TP-9RXM');
    expect(stderr).toContain(`Open:       ${s.grant.verification_uri}`);
    expect(stderr).toContain('Open that URL on any device');
    expect(getCredential(s.url)?.token).toBe(GRANTED_CREDENTIAL.access_token);
  });

  it('opens the PRE-FILLED url when it can, and prints the plain one either way', async () => {
    const s = await serve();
    const open = vi.fn(async () => true);

    await loginCommand({ server: s.url }, deps({ openUrl: open }));

    expect(open).toHaveBeenCalledWith(s.grant.verification_uri_complete);
    // What is PRINTED is the plain URL — that is the one a human retypes.
    expect(stderr).toContain(`Open:       ${s.grant.verification_uri}`);
    expect(stderr).toContain('Opened your browser');
  });
});

describe('nothing is written on any losing path', () => {
  it('times out without writing, once the grant’s own lifetime is spent', async () => {
    // A grant nobody ever approves: the script's last entry repeats forever.
    const s = await serve({
      grant: { expires_in: 60, interval: 5 },
      poll: [{ error: 'authorization_pending' }],
    });

    await expect(loginCommand({ server: s.url }, deps())).rejects.toMatchObject({
      message: 'Timed out waiting for approval.',
      exitCode: 1,
    });
    // 12 × 5s = the 60s budget, and then it stops rather than polling forever.
    expect(slept).toEqual(Array.from({ length: 12 }, () => 5_000));
    expect(getCredential(s.url)).toBeUndefined();
  });

  it('leaves a credential for ANOTHER server untouched when this login fails', async () => {
    const s = await serve({ poll: [{ error: 'access_denied' }] });
    const other = 'https://other.motir.test';
    setCredential(other, { token: 'motir_pat_untouched' });

    await expect(loginCommand({ server: s.url }, deps())).rejects.toThrow(CliError);

    expect(getCredential(other)?.token).toBe('motir_pat_untouched');
    expect(getCredential(s.url)).toBeUndefined();
  });

  it('an interrupted poll (the Ctrl-C analogue) leaves nothing behind', async () => {
    const s = await serve({ poll: [{ error: 'authorization_pending' }] });
    // Aborting mid-wait is exactly what Ctrl-C does: the process dies inside the
    // sleep, before any poll has returned a token and before any write.
    const interrupt = deps({
      sleep: async () => {
        throw new Error('SIGINT');
      },
    });

    await expect(loginCommand({ server: s.url }, interrupt)).rejects.toThrow('SIGINT');
    expect(getCredential(s.url)).toBeUndefined();
  });
});

describe('a config dir it cannot write to fails in ONE sentence', () => {
  it('reports the path and the way forward, with no stack trace', async () => {
    const s = await serve();
    // A config home whose PARENT is a FILE. Chosen over `chmod 0555` because it
    // reproduces for root too (root ignores the mode bits), so this assertion
    // cannot silently stop testing anything on a root CI runner.
    const wall = join(home, 'not-a-dir');
    writeFileSync(wall, 'x');
    vi.stubEnv('MOTIR_CONFIG_HOME', join(wall, 'motir-config'));

    const failure = await loginCommand({ server: s.url }, deps()).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toMatch(/^Could not write the credential to .+\.$/);
    expect((failure as CliError).message).not.toContain('\n');
    expect((failure as CliError).hint).toContain('MOTIR_CONFIG_HOME');
    expect((failure as CliError).hint).toContain('MOTIR_TOKEN');
    // Not an EROFS/ENOTDIR trace leaking through.
    expect((failure as CliError).message).not.toMatch(/ENOTDIR|EROFS|EACCES/);
  });

  it.runIf(process.getuid?.() !== 0)(
    'also fails cleanly on a READ-ONLY dir — the sandbox’s own posture',
    async () => {
      const s = await serve();
      const readOnly = join(home, 'ro');
      mkdirSync(join(readOnly, 'motir'), { recursive: true });
      chmodSync(join(readOnly, 'motir'), 0o555);
      vi.stubEnv('MOTIR_CONFIG_HOME', readOnly);

      await expect(loginCommand({ server: s.url }, deps())).rejects.toMatchObject({
        message: expect.stringContaining('Could not write the credential to'),
      });

      chmodSync(join(readOnly, 'motir'), 0o700);
    },
  );
});

describe('the server refuses, or is not a Motir server', () => {
  it('names the refusal and points at the paste tier', async () => {
    const s = await serve({ startStatus: 404 });

    await expect(loginCommand({ server: s.url }, deps())).rejects.toMatchObject({
      message: `${s.url} refused to start a login (HTTP 404).`,
      hint: expect.stringContaining('motir auth login --token'),
    });
  });

  it('rejects a 200 that is not a device grant', async () => {
    const s = await serve({ startBody: { hello: 'world' } });

    await expect(loginCommand({ server: s.url }, deps())).rejects.toMatchObject({
      message: `${s.url} did not return a device grant.`,
    });
  });

  it('turns an unreachable host into a CliError naming the server, not `fetch failed`', async () => {
    const s = await serve();
    const dead = s.url.replace(/:\d+$/, ':1');

    const failure = await loginCommand({ server: dead }, deps()).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toBe(`Could not reach ${dead}.`);
    expect((failure as CliError).hint).toContain('MOTIR_SERVER');
  });

  it('reports an approval that came back WITHOUT a token, rather than storing undefined', async () => {
    const s = await serve({ grantedBody: { token_type: 'Bearer' } });

    await expect(loginCommand({ server: s.url }, deps())).rejects.toMatchObject({
      message: `${s.url} approved the login but returned no token.`,
    });
    expect(getCredential(s.url)).toBeUndefined();
  });
});

describe('the default seams are the real ones', () => {
  it('runs with no injected deps at all (the production wiring)', async () => {
    // Fails at `/start`, so this exercises the `deps.sleep ?? delay` and
    // `deps.openUrl ?? openUrl` defaults without waiting five real seconds or
    // spawning a browser.
    const s = await serve({ startStatus: 500 });

    await expect(loginCommand({ server: s.url })).rejects.toBeInstanceOf(CliError);
  });
});

// ── the auto-link step (MOTIR-1880) ─────────────────────────────────────────
//
// `loginCommand` hooks the success path, so these assert the WIRING: that the
// step runs at all, that it is fed the granted credential's own workspace and
// token, and — the half that matters — that each of the four disqualifying
// conditions ends with NO FILE WRITTEN. The rules themselves, and the messages,
// are `projectLink.test.ts`'s; what is under test here is that login applies
// them to the right inputs.

describe('the login auto-link', () => {
  const oneProject = [
    { key: 'PROD', id: 'p1', name: 'Prodect', slug: 'prodect', accessLevel: 'open' },
  ];
  const linkFile = (dir: string): string => join(dir, '.motir.json');

  /** The pinned cwd (`linkCwd`) plays the workspace root; `linkHome` plays
   *  `$HOME`. Both are throwaway temp dirs — see the note on their declaration. */
  function autoLinkDeps(overrides: LoginDeps = {}): LoginDeps {
    return deps({ listProjects: async () => oneProject, ...overrides });
  }

  it('links this folder when the workspace has exactly one project', async () => {
    const s = await serve();

    await loginCommand({ server: s.url }, autoLinkDeps());

    expect(JSON.parse(readFileSync(linkFile(linkCwd), 'utf8'))).toEqual({
      serverUrl: s.url,
      // The link's workspace is the GRANT's workspace slug, not a second lookup:
      // the token was minted for it, so nothing else can be right.
      workspace: GRANTED_CREDENTIAL.workspace.slug,
      project: 'PROD',
    });
    expect(stderr).toContain(`Wrote ${linkFile(linkCwd)}`);
  });

  it('reads the projects with the credential it just stored', async () => {
    const s = await serve();
    const seen: { serverUrl: string; token: string }[] = [];

    await loginCommand(
      { server: s.url },
      autoLinkDeps({
        listProjects: async (input) => {
          seen.push(input);
          return oneProject;
        },
      }),
    );

    expect(seen).toEqual([{ serverUrl: s.url, token: GRANTED_CREDENTIAL.access_token }]);
  });

  it('writes NOTHING when a link already exists at or above cwd', async () => {
    const s = await serve();
    const existing = { serverUrl: 'https://other.test', workspace: 'other', project: 'OTHER' };
    writeFileSync(linkFile(linkCwd), JSON.stringify(existing));

    await loginCommand({ server: s.url }, autoLinkDeps());

    expect(JSON.parse(readFileSync(linkFile(linkCwd), 'utf8'))).toEqual(existing);
    expect(stderr).toContain('motir link --project OTHER');
  });

  it('writes NOTHING when the workspace has several projects', async () => {
    const s = await serve();
    const several = [...oneProject, { ...oneProject[0]!, key: 'ACME', id: 'p2', name: 'Acme' }];

    await loginCommand({ server: s.url }, autoLinkDeps({ listProjects: async () => several }));

    expect(existsSync(linkFile(linkCwd))).toBe(false);
    expect(stderr).toContain('motir link --project <key>');
  });

  it('writes NOTHING when the workspace has no projects', async () => {
    const s = await serve();

    await loginCommand({ server: s.url }, autoLinkDeps({ listProjects: async () => [] }));

    expect(existsSync(linkFile(linkCwd))).toBe(false);
    expect(stderr).toContain('No projects in workspace');
  });

  it('writes NOTHING when cwd is $HOME — the file would bind every folder below it', async () => {
    const s = await serve();

    await loginCommand({ server: s.url }, autoLinkDeps({ cwd: linkHome }));

    expect(existsSync(linkFile(linkHome))).toBe(false);
    expect(stderr).toContain('home directory');
  });

  it('still reports a SUCCESSFUL login when the project read fails', async () => {
    const s = await serve();

    await loginCommand(
      { server: s.url },
      autoLinkDeps({
        listProjects: async () => {
          throw new CliError('server fell over');
        },
      }),
    );

    // The credential is stored and the login line printed: the auto-link is a
    // convenience on top of a completed login, never a gate on it.
    expect(getCredential(s.url)?.token).toBe(GRANTED_CREDENTIAL.access_token);
    expect(stderr).toContain('Logged in as yue@motir.test');
    expect(existsSync(linkFile(linkCwd))).toBe(false);
  });
});

describe('groupUserCode', () => {
  it('groups an 8-character code into two blocks a human can retype', () => {
    expect(groupUserCode('K4TP9RXM')).toBe('K4TP-9RXM');
  });

  it('leaves an already-grouped code alone (no double dashing)', () => {
    expect(groupUserCode('K4TP-9RXM')).toBe('K4TP-9RXM');
  });

  it('handles a short or empty code without inventing one', () => {
    expect(groupUserCode('AB')).toBe('AB');
    expect(groupUserCode('')).toBe('');
  });
});
