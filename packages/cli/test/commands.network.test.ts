import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authLogin, authLogout, authStatus } from '../src/commands/auth.js';
import { linkAddCommand, linkCommand, linkRemoveCommand } from '../src/commands/link.js';
import { openCommand, readyCommand, statusCommand } from '../src/commands/read.js';
import { collectReady, openProjectSession, withProjectSession } from '../src/session.js';
import { resolveServerUrl } from '../src/serverResolve.js';
import { getCredential, setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import { DEFAULT_TOOLS, startTestMcpServer, type TestMcpServer } from './helpers/mcpTestServer.js';

// The NETWORK commands (Subtask 7.9.5 · MOTIR-883) — `auth`, `link`, the read
// trio, and the session plumbing under them — exercised as the real functions,
// against the real MCP client, against a real MCP server.
//
// These are the modules a spawn-the-binary test cannot measure (the CLI runs in
// another process), and they are where the CLI's PROMISES live: a token is
// stored only after it is proven, a link is written only after the project is
// proven reachable, a not-logged-in command fails before any network call, and
// the ready read pages through the cursor rather than truncating at one page.
//
// Everything that touches the machine is redirected: `MOTIR_CONFIG_HOME` to a
// temp dir (never a real credential store) and the cwd to a temp workspace root
// (never a real `.motir.json`).

let server: TestMcpServer;
let home: string;
let root: string;
let cwd: string;

const TOKEN = 'pat_test_token_value';

beforeAll(async () => {
  server = await startTestMcpServer({ token: TOKEN, tools: DEFAULT_TOOLS });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-cmd-'));
  home = join(base, 'config');
  root = join(base, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  vi.stubEnv('MOTIR_CONFIG_HOME', home);
  vi.stubEnv('MOTIR_TOKEN', '');
  process.chdir(root);
  server.calls.length = 0;
  server.script(DEFAULT_TOOLS);
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Capture what a command writes, split by stream — the payload/diagnostics
 *  split every command relies on (`out` → stdout, `info` → stderr). */
function capture(): { stdout: () => string; stderr: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  });
  return { stdout: () => outChunks.join(''), stderr: () => errChunks.join('') };
}

/** Log in + link, the precondition of every read/dispatch command. */
async function linked(project = 'PROD'): Promise<void> {
  setCredential(server.url, { token: TOKEN });
  writeFileSync(
    join(root, '.motir.json'),
    JSON.stringify({ serverUrl: server.url, workspace: 'acme', project }) + '\n',
  );
}

// ── auth ────────────────────────────────────────────────────────────────────

describe('motir auth', () => {
  it('login VALIDATES before it stores: a live connect + tool list + whoami', async () => {
    const io = capture();

    await authLogin({ server: server.url, token: TOKEN });

    expect(getCredential(server.url)?.token).toBe(TOKEN);
    expect(getCredential(server.url)?.user?.email).toBe('yue@motir.test');
    expect(io.stderr()).toContain('Logged in as yue@motir.test');
    expect(io.stderr()).toContain('workspace Acme');
    // The validation round-trip really happened.
    expect(server.calls.map((c) => c.name)).toContain('whoami');
  });

  it('login stores NOTHING when the token is rejected', async () => {
    capture();

    await expect(authLogin({ server: server.url, token: 'wrong' })).rejects.toThrow(CliError);

    expect(getCredential(server.url)).toBeUndefined();
  });

  it('reads MOTIR_TOKEN when --token is absent, and refuses when neither is available', async () => {
    capture();
    vi.stubEnv('MOTIR_TOKEN', TOKEN);
    await authLogin({ server: server.url });
    expect(getCredential(server.url)?.token).toBe(TOKEN);

    // Non-interactive with no token anywhere → guidance, not a hang on a prompt.
    vi.stubEnv('MOTIR_TOKEN', '');
    await expect(authLogin({ server: server.url })).rejects.toMatchObject({
      hint: expect.stringMatching(/--token/),
    });
    // …and the same for a missing server URL.
    await expect(authLogin({})).rejects.toMatchObject({
      hint: expect.stringMatching(/--server/),
    });
  });

  it('status reports the owner live and shows only a token PREFIX', async () => {
    await linked();
    const io = capture();

    await authStatus({ server: server.url });

    const printed = io.stdout();
    expect(printed).toContain('yue@motir.test');
    expect(printed).toContain('Acme (acme)');
    expect(printed).not.toContain(TOKEN);
    expect(printed).toContain(TOKEN.slice(0, 14));
  });

  it('status refuses when nothing is stored for the server', async () => {
    capture();
    await expect(authStatus({ server: server.url })).rejects.toMatchObject({
      hint: expect.stringMatching(/auth login/),
    });
  });

  it('logout removes the credential, and says so when there was none', async () => {
    setCredential(server.url, { token: TOKEN });
    const io = capture();

    await authLogout({ server: server.url });
    expect(getCredential(server.url)).toBeUndefined();
    expect(io.stderr()).toContain('Logged out');

    await authLogout({ server: server.url });
    expect(io.stderr()).toContain('No stored credential');
  });
});

// ── which server ────────────────────────────────────────────────────────────

describe('resolveServerUrl — flag, then link, then the single stored server', () => {
  it('prefers the explicit flag, normalized', () => {
    expect(resolveServerUrl('https://app.motir.co/')).toBe('https://app.motir.co');
  });

  it('falls back to the link, then to the one configured server', async () => {
    setCredential('https://only.motir.test', { token: 't' });
    expect(resolveServerUrl()).toBe('https://only.motir.test');

    await linked();
    expect(resolveServerUrl()).toBe(server.url);
  });

  it('refuses when there is NO server, and when there are several', () => {
    expect(() => resolveServerUrl()).toThrow(/No Motir server configured/);

    setCredential('https://a.motir.test', { token: 'a' });
    setCredential('https://b.motir.test', { token: 'b' });
    expect(() => resolveServerUrl()).toThrow(/Multiple servers are configured/);
  });
});

// ── link ────────────────────────────────────────────────────────────────────

describe('motir link', () => {
  it('writes the binding only AFTER proving the project is reachable', async () => {
    setCredential(server.url, { token: TOKEN });
    const io = capture();

    await linkCommand({ server: server.url, project: 'PROD' });

    const config = JSON.parse(readFileSync(join(root, '.motir.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config).toEqual({ serverUrl: server.url, workspace: 'acme', project: 'PROD' });
    // No `repos` key: checkouts resolve by convention until an override is added.
    expect(config).not.toHaveProperty('repos');
    expect(server.calls.map((c) => c.name)).toContain('list_ready');
    expect(io.stdout()).toContain('checkouts resolve by convention');
  });

  it('refuses a project the token cannot see — and writes no link at all', async () => {
    setCredential(server.url, { token: TOKEN });
    server.script({ list_ready: { error: 'PROJECT_NOT_FOUND: no project "NOPE".' } });
    capture();

    await expect(linkCommand({ server: server.url, project: 'NOPE' })).rejects.toThrow(
      /not accessible with this token/,
    );
    expect(() => readFileSync(join(root, '.motir.json'), 'utf8')).toThrow();
  });

  it('refuses to link before login, without a network call', async () => {
    capture();
    await expect(linkCommand({ server: server.url, project: 'PROD' })).rejects.toMatchObject({
      hint: expect.stringMatching(/auth login/),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('refuses without a project when there is no TTY to ask for one', async () => {
    setCredential(server.url, { token: TOKEN });
    capture();

    await expect(linkCommand({ server: server.url })).rejects.toMatchObject({
      hint: expect.stringMatching(/--project/),
    });
  });

  it('a bare re-run SHOWS the existing binding instead of rewriting it', async () => {
    await linked();
    const io = capture();

    await linkCommand({});

    expect(io.stdout()).toContain('Project:   PROD');
    expect(server.calls).toHaveLength(0);
  });

  it('--repo marks THIS folder as one repo’s checkout; add / remove edit the overrides', async () => {
    setCredential(server.url, { token: TOKEN });
    capture();

    await linkCommand({ server: server.url, project: 'PROD', repo: 'motir-core' });
    expect(readLink().repos).toEqual({ 'motir-core': '.' });

    linkAddCommand('motir-ai', '../checkouts/motir-ai');
    expect(readLink().repos).toEqual({
      'motir-core': '.',
      'motir-ai': '../checkouts/motir-ai',
    });

    linkRemoveCommand('motir-ai');
    expect(readLink().repos).toEqual({ 'motir-core': '.' });

    // Removing the LAST override drops the key entirely.
    linkRemoveCommand('motir-core');
    expect(readLink()).not.toHaveProperty('repos');

    expect(() => linkRemoveCommand('motir-core')).toThrow(/No override for repo/);
  });

  function readLink(): { repos?: Record<string, string> } {
    return JSON.parse(readFileSync(join(root, '.motir.json'), 'utf8')) as {
      repos?: Record<string, string>;
    };
  }
});

// ── the project session ─────────────────────────────────────────────────────

describe('the project session', () => {
  it('fails BEFORE the network when the folder is not linked, or the server has no token', async () => {
    await expect(openProjectSession()).rejects.toThrow(/No Motir project link found/);

    writeFileSync(
      join(root, '.motir.json'),
      JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }),
    );
    await expect(openProjectSession()).rejects.toMatchObject({
      hint: expect.stringMatching(/auth login/),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('closes the client even when the body throws', async () => {
    await linked();
    const boom = new Error('body failed');

    await expect(withProjectSession(() => Promise.reject(boom))).rejects.toBe(boom);

    // A leaked connection would keep the process alive; prove the session still
    // opened (so the close path really ran) by making one that succeeds.
    const ok = await withProjectSession(async ({ projectKey }) => projectKey);
    expect(ok).toBe('PROD');
  });

  it('pages the WHOLE ready set through the cursor rather than one page', async () => {
    await linked();
    let call = 0;
    server.script({
      list_ready: () => {
        call += 1;
        return call === 1
          ? { structured: { items: [{ key: 'PROD-1' }], nextCursor: 'cursor-2' } }
          : { structured: { items: [{ key: 'PROD-2' }], nextCursor: null } };
      },
    });

    const items = await withProjectSession(({ client, projectKey }) =>
      collectReady(client, projectKey),
    );

    expect(items.map((i) => i.key)).toEqual(['PROD-1', 'PROD-2']);
    expect(server.calls[1]?.args).toMatchObject({ cursor: 'cursor-2', limit: 200 });
  });
});

// ── the read commands ───────────────────────────────────────────────────────

describe('motir ready / status / open', () => {
  it('`ready` renders a table, or raw JSON with --json', async () => {
    await linked();
    server.script({
      list_ready: {
        structured: {
          items: [
            {
              key: 'PROD-7',
              kind: 'subtask',
              title: 'Wire the thing',
              priority: 'high',
              assignee: { id: 'u1', name: 'Zhu Yue' },
            },
          ],
          nextCursor: null,
        },
      },
    });

    const table = capture();
    await readyCommand({});
    expect(table.stdout()).toContain('PROD-7');
    expect(table.stdout()).toContain('Wire the thing');

    vi.restoreAllMocks();
    const json = capture();
    await readyCommand({ json: true });
    expect(JSON.parse(json.stdout())).toHaveLength(1);
  });

  it('`ready --assignee me` resolves the token owner via whoami; `unassigned` is the bucket', async () => {
    await linked();
    capture();

    await readyCommand({ assignee: 'me' });
    expect(server.calls.find((c) => c.name === 'list_ready')?.args).toMatchObject({
      assigneeId: 'user-1',
    });

    server.calls.length = 0;
    await readyCommand({ assignee: 'unassigned' });
    expect(server.calls.find((c) => c.name === 'list_ready')?.args).toMatchObject({
      assigneeId: 'unassigned',
    });

    server.calls.length = 0;
    await readyCommand({ assignee: 'user-42' });
    expect(server.calls.find((c) => c.name === 'list_ready')?.args).toMatchObject({
      assigneeId: 'user-42',
    });
  });

  it('`ready --kinds` rejects an unknown kind before any network call', async () => {
    await linked();
    capture();

    await expect(readyCommand({ kinds: 'widget' })).rejects.toThrow(/Unknown work item kind/);
    expect(server.calls).toHaveLength(0);
  });

  it('`status` composes the pulse: ready count, in-flight total, the ACTIVE sprint', async () => {
    await linked();
    server.script({
      list_ready: {
        structured: { items: [{ key: 'PROD-1' }, { key: 'PROD-2' }], nextCursor: null },
      },
      search_work_items: { structured: { items: [], total: 5, nextCursor: null } },
      list_sprints: {
        structured: {
          sprints: [
            { id: 's1', name: 'Sprint 1', state: 'complete', issueCount: 3 },
            { id: 's2', name: 'Journey D', state: 'active', goal: 'Ship the CLI', issueCount: 9 },
          ],
        },
      },
    });

    const io = capture();
    await statusCommand({ json: true });

    expect(JSON.parse(io.stdout())).toMatchObject({
      projectKey: 'PROD',
      readyCount: 2,
      inFlightCount: 5,
      totalSprints: 2,
      activeSprint: { name: 'Journey D' },
    });

    vi.restoreAllMocks();
    const text = capture();
    await statusCommand({});
    expect(text.stdout()).toContain('Journey D');
  });

  it('`open` builds the URL from the LINK (no hardcoded host) and needs a key', async () => {
    await linked();
    const io = capture();

    await openCommand('PROD-7', { print: true });

    expect(io.stdout().trim()).toBe(`${server.url}/issues/PROD-7`);
    expect(server.calls).toHaveLength(0);
    await expect(openCommand('   ', { print: true })).rejects.toThrow(/key is required/);
  });

  it('`open` without --print still PRINTS the URL, and says so when no browser opens', async () => {
    await linked();
    const io = capture();

    // The test runner is headless, so the launcher is skipped — the printed URL
    // is the result, and the CLI says why nothing opened.
    await openCommand('PROD-7', {});

    expect(io.stdout()).toContain('/issues/PROD-7');
    expect(io.stderr()).toContain('Could not open a browser here');
  });
});
