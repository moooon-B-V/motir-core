import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOOLS, startTestMcpServer, type TestMcpServer } from './helpers/mcpTestServer.js';

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

let server: TestMcpServer;
let root: string;
let cwd: string;

const TOKEN = 'pat_interactive_token';

beforeAll(async () => {
  server = await startTestMcpServer({ token: TOKEN, tools: DEFAULT_TOOLS });
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
  server.script(DEFAULT_TOOLS);
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

    // The URL prompt offers a sensible default rather than an empty line.
    expect(prompts.promptLine).toHaveBeenCalledWith('Server URL', 'http://localhost:3000');
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
  it('asks for the project key when neither a flag nor an existing link supplies one', async () => {
    setCredential(server.url, { token: TOKEN });
    prompts.promptLine.mockResolvedValue('PROD');

    await linkCommand({ server: server.url });

    expect(prompts.promptLine).toHaveBeenCalledWith('Project key');
    expect(JSON.parse(readFileSync(join(root, '.motir.json'), 'utf8'))).toMatchObject({
      project: 'PROD',
    });
  });

  it('refuses an empty answer rather than writing a link with no project', async () => {
    setCredential(server.url, { token: TOKEN });
    prompts.promptLine.mockResolvedValue('');

    await expect(linkCommand({ server: server.url })).rejects.toThrow(/project key is required/);
  });

  it('refuses when the token resolves no workspace and none was named', async () => {
    setCredential(server.url, { token: TOKEN });
    server.script({
      whoami: {
        structured: {
          user: { id: 'u', name: 'Y', email: 'y@motir.test' },
          workspace: null,
        },
      },
    });

    await expect(linkCommand({ server: server.url, project: 'PROD' })).rejects.toMatchObject({
      hint: expect.stringContaining('--workspace'),
    });
  });
});
