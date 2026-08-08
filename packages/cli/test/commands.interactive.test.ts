import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestServer, v1Page, v1Project, type TestServer } from './helpers/testServer.js';

// The INTERACTIVE branches of `auth login` and `link` (Subtask 7.9.5 ·
// MOTIR-883).
//
// `prompts.ts` is a readline against the real TTY — there is no seam to inject
// and no TTY under a test runner, so the READER is mocked here and nothing else.
// What is under test is the COMMANDS' behaviour when a value is missing: that
// they ask rather than fail, that what they ask for is what they store, and that
// the same paths refuse with guidance when there is no TTY to ask (that half is
// covered non-interactively in commands.network.test.ts).

const prompts = vi.hoisted(() => ({
  isInteractive: vi.fn(() => true),
  promptLine: vi.fn(async () => ''),
  promptSecret: vi.fn(async () => ''),
}));

vi.mock('../src/prompts.js', () => prompts);

const { authLogin } = await import('../src/commands/auth.js');
const { linkCommand } = await import('../src/commands/link.js');
const { getCredential, setCredential } = await import('../src/config/userConfig.js');
const { DEFAULT_SERVER_URL } = await import('../src/serverResolve.js');

let server: TestServer;
let root: string;
let cwd: string;

const TOKEN = 'pat_interactive_token';

beforeAll(async () => {
  server = await startTestServer({ token: TOKEN });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-tty-'));
  root = join(base, 'workspace');
  mkdirSync(root, { recursive: true });
  vi.stubEnv('MOTIR_CONFIG_HOME', join(base, 'config'));
  vi.stubEnv('MOTIR_TOKEN', '');
  process.chdir(root);
  prompts.isInteractive.mockReturnValue(true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  prompts.promptLine.mockReset();
  prompts.promptSecret.mockReset();
});

describe('motir auth login, interactively', () => {
  it('asks for the server URL and the token, then validates and stores them', async () => {
    prompts.promptLine.mockResolvedValue(server.url);
    prompts.promptSecret.mockResolvedValue(TOKEN);

    await authLogin({});

    // The URL prompt offers the HOSTED default, not a dev server: the common case
    // is app.motir.co, and suggesting localhost made a zero-argument login
    // impossible for every user who is not running the app themselves.
    expect(prompts.promptLine).toHaveBeenCalledWith('Server URL', DEFAULT_SERVER_URL);
    expect(DEFAULT_SERVER_URL).toBe('https://app.motir.co');
    expect(prompts.promptSecret).toHaveBeenCalledWith('Personal access token');
    expect(getCredential(server.url)?.token).toBe(TOKEN);
  });

  it('refuses an EMPTY answer to the token prompt instead of storing nothing', async () => {
    prompts.promptLine.mockResolvedValue(server.url);
    prompts.promptSecret.mockResolvedValue('');

    await expect(authLogin({})).rejects.toThrow(/A token is required/);
    expect(getCredential(server.url)).toBeUndefined();
  });
});

describe('motir link, interactively', () => {
  // Before MOTIR-1880 this asked for a project KEY whenever no flag supplied
  // one — including in the single-project workspace where there was nothing to
  // choose. It now RESOLVES (see projectLink.test.ts for the resolution rules);
  // the prompt survives only for the genuinely ambiguous case, and as a PICKER.
  it('does NOT ask when the workspace has exactly one project — it resolves it', async () => {
    setCredential(server.url, { token: TOKEN });

    await linkCommand({ server: server.url });

    expect(prompts.promptLine).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(root, '.motir.json'), 'utf8'))).toMatchObject({
      project: 'PROD',
    });
  });

  it('shows a picker when there are several, and links what was picked', async () => {
    setCredential(server.url, { token: TOKEN });
    server.scriptV1({
      'GET /api/v1/projects': {
        body: v1Page([v1Project('PROD', 'Prodect'), v1Project('ACME', 'Acme')]),
      },
    });
    prompts.promptLine.mockResolvedValue('2');

    await linkCommand({ server: server.url });

    expect(prompts.promptLine).toHaveBeenCalledWith('Project [1-2, or a key]');
    expect(JSON.parse(readFileSync(join(root, '.motir.json'), 'utf8'))).toMatchObject({
      project: 'ACME',
    });
  });

  it('refuses an empty answer rather than writing a link with no project', async () => {
    setCredential(server.url, { token: TOKEN });
    server.scriptV1({
      'GET /api/v1/projects': {
        body: v1Page([v1Project('PROD', 'Prodect'), v1Project('ACME', 'Acme')]),
      },
    });
    prompts.promptLine.mockResolvedValue('');

    await expect(linkCommand({ server: server.url })).rejects.toThrow(/not one of/);
    expect(existsSync(join(root, '.motir.json'))).toBe(false);
  });

  it('refuses when the token resolves no workspace and none was named', async () => {
    setCredential(server.url, { token: TOKEN });
    // `whoami` is TWO v1 reads: `/me` names the bound workspace by id, and
    // `/workspaces` describes it. A token whose workspace the caller cannot see
    // is an EMPTY list — the adapter then resolves `workspace: null`, which is
    // the state this test is about.
    server.scriptV1({ 'GET /api/v1/workspaces': { body: v1Page([]) } });

    await expect(linkCommand({ server: server.url, project: 'PROD' })).rejects.toMatchObject({
      hint: expect.stringContaining('--workspace'),
    });
  });
});
