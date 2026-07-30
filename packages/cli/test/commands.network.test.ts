import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authLogin, authLogout, authStatus } from '../src/commands/auth.js';
import { linkAddCommand, linkCommand, linkRemoveCommand } from '../src/commands/link.js';
import {
  openCommand,
  readyCommand,
  sprintCommand,
  sprintsCommand,
  statusCommand,
} from '../src/commands/read.js';
import { collectReady, openProjectSession, withProjectSession } from '../src/session.js';
import { DEFAULT_SERVER_URL, resolveServerUrl } from '../src/serverResolve.js';
import {
  envToken,
  getCredential,
  resolveCredential,
  setCredential,
} from '../src/config/userConfig.js';
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
const STORED_USER = { id: 'u1', name: 'Yue', email: 'yue@motir.test' };

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

describe('resolveServerUrl — the ladder, rung by rung (MOTIR-1876)', () => {
  it('prefers the explicit flag, normalized', () => {
    expect(resolveServerUrl('https://app.motir.co/')).toBe('https://app.motir.co');
  });

  it('walks --server > MOTIR_SERVER > .motir.json > the single stored > the default', async () => {
    // Rung 5 (the floor): nothing configured at all still resolves — this is the
    // fresh box / CI runner / container that has never run a login.
    expect(resolveServerUrl()).toBe(DEFAULT_SERVER_URL);
    expect(DEFAULT_SERVER_URL).toBe('https://app.motir.co');

    // Rung 4 — exactly one stored server.
    setCredential('https://only.motir.test', { token: 't' });
    expect(resolveServerUrl()).toBe('https://only.motir.test');

    // Rung 3 — the link beats the store.
    await linked();
    expect(resolveServerUrl()).toBe(server.url);

    // Rung 2 — the env beats the link (a container has no link to walk up to),
    // and is normalized on the way through.
    vi.stubEnv('MOTIR_SERVER', 'https://env.motir.test/');
    expect(resolveServerUrl()).toBe('https://env.motir.test');

    // Rung 1 — the flag beats everything.
    expect(resolveServerUrl('https://flag.motir.test')).toBe('https://flag.motir.test');
  });

  it('treats an EMPTY MOTIR_SERVER as unset rather than as a server', async () => {
    await linked();
    vi.stubEnv('MOTIR_SERVER', '   ');
    expect(resolveServerUrl()).toBe(server.url);
  });

  it('still refuses when SEVERAL stored servers leave it genuinely ambiguous', () => {
    setCredential('https://a.motir.test', { token: 'a' });
    setCredential('https://b.motir.test', { token: 'b' });

    // Logging in to two servers IS an expressed intent, so falling through to a
    // third host neither names would defeat the point of the ordering.
    expect(() => resolveServerUrl()).toThrow(/Multiple servers are configured/);

    // …unless the default host is one of them — then it is the canonical
    // default, not a guess (the same call `gh` makes with several hosts).
    setCredential(DEFAULT_SERVER_URL, { token: 'hosted' });
    expect(resolveServerUrl()).toBe(DEFAULT_SERVER_URL);
  });
});

// ── the env credential tier ─────────────────────────────────────────────────

describe('the credential ladder — MOTIR_TOKEN above the stored config (MOTIR-1876)', () => {
  /** Write ONLY the link — no credential, so the env tier is the only route in. */
  function linkOnly(project = 'PROD'): void {
    writeFileSync(
      join(root, '.motir.json'),
      JSON.stringify({ serverUrl: server.url, workspace: 'acme', project }) + '\n',
    );
  }

  it('resolves the env token with NO config file at all, and reports its source', () => {
    vi.stubEnv('MOTIR_TOKEN', TOKEN);

    const cred = resolveCredential('https://app.motir.co');
    expect(cred?.token).toBe(TOKEN);
    expect(cred?.source).toBe('environment');
    expect(cred?.origin).toBe('environment (MOTIR_TOKEN)');
    // The env tier is not server-scoped (GH_TOKEN's shape): one exported value is
    // the credential for whatever server the run resolves to.
    expect(resolveCredential('https://self-hosted.motir.test')?.token).toBe(TOKEN);
  });

  it('OVERRIDES a different stored token for the same server — and defers when unset', () => {
    setCredential(server.url, { token: 'stored-token', user: STORED_USER });

    vi.stubEnv('MOTIR_TOKEN', 'env-token');
    expect(resolveCredential(server.url)?.token).toBe('env-token');
    expect(resolveCredential(server.url)?.source).toBe('environment');

    vi.stubEnv('MOTIR_TOKEN', '');
    const stored = resolveCredential(server.url);
    expect(stored?.token).toBe('stored-token');
    expect(stored?.source).toBe('config');
    expect(stored?.origin).toBe(join(home, 'motir', 'config.json'));
    // The stored tier keeps the recorded owner; the env tier cannot know one.
    expect(stored?.user).toEqual(STORED_USER);
  });

  it('treats an EMPTY / whitespace MOTIR_TOKEN as UNSET, not as a token', () => {
    // `gh` shipped this exact bug (cli/cli#7800): an empty GH_TOKEN outranked a
    // good stored credential, turning "no credential" into a 401 far from its
    // cause. `FOO=` in a compose file and an unresolved CI secret both land here.
    for (const blank of ['', '   ', '\n']) {
      vi.stubEnv('MOTIR_TOKEN', blank);
      expect(envToken()).toBeUndefined();
      expect(resolveCredential(server.url)).toBeUndefined();
    }

    vi.stubEnv('MOTIR_TOKEN', `  ${TOKEN}  `);
    expect(envToken()).toBe(TOKEN);
  });

  it('runs `ready` / `status` / `show` / `link` on the env token alone, writing NOTHING', async () => {
    // The sandbox / CI shape: an empty config home, no stored credential, the
    // whole configuration in two env vars. `MOTIR_SERVER` points at the test
    // server here because a unit test cannot reach the real host — that the
    // ladder's floor IS `https://app.motir.co` is asserted in the ladder suite.
    const empty = join(root, 'no-config-here');
    vi.stubEnv('MOTIR_CONFIG_HOME', empty);
    vi.stubEnv('MOTIR_TOKEN', TOKEN);
    vi.stubEnv('MOTIR_SERVER', server.url);
    linkOnly();
    const io = capture();

    await readyCommand({});
    await statusCommand({});
    await openCommand('PROD-1', { print: true });
    await linkCommand({ project: 'PROD' });

    expect(server.calls.map((c) => c.name)).toContain('list_ready');
    expect(io.stdout()).toContain('PROD-1');
    // Nothing was persisted: no config dir, no config file, no token on disk.
    // This is what makes the tier work on a READ-ONLY mount — and it is asserted
    // by absence rather than by permissions, so it cannot go vacuous as root.
    expect(existsSync(empty)).toBe(false);
  });

  it('works with the config dir READ-ONLY — no EROFS/EACCES escapes (MOTIR-1836 class)', async () => {
    const locked = join(root, 'locked-config');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    try {
      vi.stubEnv('MOTIR_CONFIG_HOME', locked);
      vi.stubEnv('MOTIR_TOKEN', TOKEN);
      vi.stubEnv('MOTIR_SERVER', server.url);
      linkOnly();
      capture();

      await expect(readyCommand({})).resolves.toBeUndefined();

      expect(existsSync(join(locked, 'motir'))).toBe(false);
    } finally {
      // Always restore the mode, or the temp-dir cleanup cannot remove it.
      chmodSync(locked, 0o700);
    }
  });

  it('`auth status` names the SOURCE and still never prints the token', async () => {
    vi.stubEnv('MOTIR_TOKEN', TOKEN);
    const io = capture();

    await authStatus({ server: server.url });

    expect(io.stdout()).toContain('Source:    environment (MOTIR_TOKEN)');
    expect(io.stdout()).toContain('Token:     pat_test_token…');
    expect(io.stdout()).not.toContain(TOKEN);
  });

  it('`auth status` names the CONFIG path when the credential came from the file', async () => {
    setCredential(server.url, { token: TOKEN });
    const io = capture();

    await authStatus({ server: server.url });

    expect(io.stdout()).toContain(`Source:    ${join(home, 'motir', 'config.json')}`);
  });

  it('`auth logout` says the env var still overrides, instead of claiming success', async () => {
    setCredential(server.url, { token: TOKEN });
    vi.stubEnv('MOTIR_TOKEN', TOKEN);
    const io = capture();

    await authLogout({ server: server.url });

    expect(io.stderr()).toContain(`Logged out of ${server.url}`);
    expect(io.stderr()).toContain('MOTIR_TOKEN is still set — it overrides');
  });

  it('a not-logged-in command points at BOTH tiers, not just login', async () => {
    linkOnly();
    capture();

    await expect(openProjectSession()).rejects.toThrow(/Not logged in/);
    await expect(openProjectSession()).rejects.toThrow(
      expect.objectContaining({ hint: expect.stringContaining('MOTIR_TOKEN') }),
    );
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

// ── the sprint reads (7.9.14 · MOTIR-1844) ──────────────────────────────────

/** A `list_sprints` row, with the fields `motir sprints` renders. */
const sprintRow = (over: Record<string, unknown> = {}) => ({
  id: 's2',
  name: 'Journey D',
  state: 'active',
  goal: 'Ship the CLI',
  startDate: '2026-07-20',
  endDate: '2026-08-03',
  sequence: 2,
  issueCount: 2,
  committedPoints: 21,
  committedIssueCount: 2,
  ...over,
});

/** A `search_work_items` row. */
const itemRow = (identifier: string) => ({
  identifier,
  kind: 'subtask',
  title: `Work item ${identifier}`,
  status: 'todo',
  priority: 'high',
});

describe('motir sprints / sprint', () => {
  it('`sprints` tables every sprint, marks the ACTIVE one, and --json emits the rows', async () => {
    await linked();
    server.script({
      list_sprints: {
        structured: {
          sprints: [
            sprintRow({ id: 's1', name: 'Sprint 1', state: 'complete', sequence: 1 }),
            sprintRow({}),
          ],
        },
      },
    });

    const table = capture();
    await sprintsCommand({});
    expect(table.stdout()).toContain('2 sprints:');
    expect(table.stdout()).toContain('Journey D');
    expect(table.stdout()).toContain('Sprint 1');

    vi.restoreAllMocks();
    const io = capture();
    await sprintsCommand({ json: true });
    expect(JSON.parse(io.stdout())).toHaveLength(2);
  });

  it('`sprints --state` filters, and rejects an unknown state before any network call', async () => {
    await linked();
    server.script({
      list_sprints: {
        structured: {
          sprints: [
            sprintRow({ id: 's1', name: 'Sprint 1', state: 'complete', sequence: 1 }),
            sprintRow({}),
          ],
        },
      },
    });

    const io = capture();
    await sprintsCommand({ state: 'Active', json: true });
    expect(JSON.parse(io.stdout())).toMatchObject([{ id: 's2' }]);

    server.calls.length = 0;
    await expect(sprintsCommand({ state: 'nope' })).rejects.toThrow(/Unknown sprint state/);
    expect(server.calls).toHaveLength(0);
  });

  it('`sprints` renders the empty case rather than a bare table', async () => {
    await linked();
    const io = capture();

    await sprintsCommand({});

    expect(io.stdout().trim()).toBe('No sprints.');
  });

  it('`sprint` defaults to the ACTIVE sprint and PAGES the whole set via nextCursor', async () => {
    await linked();
    server.script({
      list_sprints: { structured: { sprints: [sprintRow({ issueCount: 3 })] } },
      // Two pages: the count the CLI prints must equal the tool's own `total`,
      // which only holds if it followed the cursor instead of stopping at one.
      search_work_items: (args) =>
        args.cursor === undefined
          ? {
              structured: {
                items: [itemRow('PROD-1'), itemRow('PROD-2')],
                total: 3,
                nextCursor: 'p2',
              },
            }
          : { structured: { items: [itemRow('PROD-3')], total: 3, nextCursor: null } },
    });

    const io = capture();
    await sprintCommand(undefined, {});

    const searches = server.calls.filter((c) => c.name === 'search_work_items');
    expect(searches).toHaveLength(2);
    expect(searches[0]?.args).toMatchObject({
      filter: {
        version: 'v1',
        combinator: 'and',
        conditions: [{ field: 'sprint', operator: 'is_any_of', value: ['s2'] }],
      },
    });
    expect(io.stdout()).toContain('Journey D  [active]');
    expect(io.stdout()).toContain('goal: Ship the CLI');
    expect(io.stdout()).toContain('3 work items:');
    for (const key of ['PROD-1', 'PROD-2', 'PROD-3']) expect(io.stdout()).toContain(key);
    expect(io.stdout()).not.toContain('could not be collected');
  });

  it('`sprint <name>` resolves case-insensitively; ambiguous and unknown refs error', async () => {
    await linked();
    server.script({
      list_sprints: {
        structured: {
          sprints: [
            sprintRow({ id: 's1', name: 'Sprint 1', state: 'complete', sequence: 1 }),
            sprintRow({ id: 's10', name: 'Sprint 10', state: 'planned', sequence: 3 }),
            sprintRow({}),
          ],
        },
      },
      search_work_items: { structured: { items: [itemRow('PROD-1')], total: 1, nextCursor: null } },
    });

    const io = capture();
    await sprintCommand('journey d', { json: true });
    expect(JSON.parse(io.stdout())).toMatchObject({ sprint: { id: 's2' }, total: 1 });

    await expect(sprintCommand('Sprint', {})).rejects.toThrow(/matches 2 sprints/);
    await expect(sprintCommand('nope', {})).rejects.toThrow(/No sprint matches "nope"/);
  });

  it('`sprint` with no active sprint and no ref names the situation instead of an empty table', async () => {
    await linked();
    server.script({
      list_sprints: { structured: { sprints: [sprintRow({ state: 'planned' })] } },
    });
    capture();

    await expect(sprintCommand(undefined, {})).rejects.toThrow(/No sprint is active/);
    // It failed on the sprint READ — it never went looking for items.
    expect(server.calls.filter((c) => c.name === 'search_work_items')).toHaveLength(0);
  });

  it('`sprint --kinds` narrows the query, and rejects an unknown kind before any network call', async () => {
    await linked();
    server.script({
      list_sprints: { structured: { sprints: [sprintRow({})] } },
      search_work_items: { structured: { items: [], total: 0, nextCursor: null } },
    });

    const io = capture();
    await sprintCommand(undefined, { kinds: 'Subtask, BUG' });
    expect(server.calls.find((c) => c.name === 'search_work_items')?.args).toMatchObject({
      filter: {
        conditions: [
          { field: 'sprint', operator: 'is_any_of', value: ['s2'] },
          { field: 'kind', operator: 'is_any_of', value: ['subtask', 'bug'] },
        ],
      },
    });
    expect(io.stdout()).toContain('No work items in this sprint.');

    server.calls.length = 0;
    await expect(sprintCommand(undefined, { kinds: 'widget' })).rejects.toThrow(
      /Unknown work item kind/,
    );
    expect(server.calls).toHaveLength(0);
  });
});
