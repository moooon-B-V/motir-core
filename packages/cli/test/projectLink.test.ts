import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOOLS,
  projectRow,
  startTestMcpServer,
  type TestMcpServer,
} from './helpers/mcpTestServer.js';
// Type-only: the VALUE comes through the post-`vi.mock` dynamic import below,
// which cannot also serve as a type reference.
import type { CliError as CliErrorType } from '../src/errors.js';

// Project RESOLUTION and the login auto-link (MOTIR-1880).
//
// Two halves with different risk profiles, tested accordingly:
//
//  • `resolveProject` reads a real MCP tool, so it runs against the real client
//    over a real socket (helpers/mcpTestServer.ts) — the same posture the rest of
//    the command tests take. The interactive picker's READER is mocked, because
//    there is no TTY under a runner and `prompts.ts` has no other seam.
//
//  • `autoLinkAfterLogin` is the half that WRITES A FILE somewhere the user did
//    not ask for, so every guard gets its own case and every one of them asserts
//    the ABSENCE of the file — not just the message. `cwd`/`home` are injected so
//    the `$HOME` rule is a claim about the rule and not about the runner's
//    environment (a test that had to chdir into the real home directory to prove
//    it could never be run safely).

const prompts = vi.hoisted(() => ({
  isInteractive: vi.fn(() => true),
  promptLine: vi.fn(async () => ''),
  promptSecret: vi.fn(async () => ''),
}));

vi.mock('../src/prompts.js', () => prompts);

const { autoLinkAfterLogin, describeProject, nextLinkCommand, pickProject, resolveProject } =
  await import('../src/projectLink.js');
const { MotirClient } = await import('../src/mcpClient.js');
const { LINK_FILENAME } = await import('../src/config/linkConfig.js');
const { CliError } = await import('../src/errors.js');

const TOKEN = 'pat_project_link';

let server: TestMcpServer;
let root: string;
let home: string;
let stderr: string;

/** A connected client against the scripted server; closed by the afterEach. */
let open: InstanceType<typeof MotirClient>[] = [];
async function client(): Promise<InstanceType<typeof MotirClient>> {
  const c = new MotirClient({ serverUrl: server.url, token: TOKEN });
  await c.connect();
  open.push(c);
  return c;
}

const linkPath = (dir: string): string => join(dir, LINK_FILENAME);
const readLink = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(linkPath(dir), 'utf8')) as Record<string, unknown>;

/** `autoLinkAfterLogin` with the ambient inputs pinned to this test's temp dirs
 *  and a one-project workspace, so each case overrides only what it is about. */
function autoLink(
  overrides: Partial<Parameters<typeof autoLinkAfterLogin>[0]> = {},
): Promise<string | null> {
  return autoLinkAfterLogin({
    serverUrl: 'https://app.motir.test',
    workspace: 'acme',
    listProjects: async () => [projectRow('PROD', 'Prodect')],
    cwd: root,
    home,
    ...overrides,
  });
}

beforeAll(async () => {
  server = await startTestMcpServer({ token: TOKEN, tools: DEFAULT_TOOLS });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-projectlink-'));
  root = join(base, 'workspace');
  home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  server.script(DEFAULT_TOOLS);
  prompts.isInteractive.mockReturnValue(true);
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  for (const c of open) await c.close();
  open = [];
  vi.restoreAllMocks();
  prompts.promptLine.mockReset();
  prompts.isInteractive.mockReset();
});

// ── resolveProject ──────────────────────────────────────────────────────────

describe('resolveProject', () => {
  it('takes the ONLY project without asking — there is nothing to disambiguate', async () => {
    const resolved = await resolveProject(await client(), 'acme', server.url);

    expect(resolved).toEqual({ project: projectRow('PROD', 'Prodect'), sole: true });
    // The point of the card: a workspace with one project never prompts, and
    // never asks for a key the user would have had to look up.
    expect(prompts.promptLine).not.toHaveBeenCalled();
  });

  it('resolves the single project even with NO TTY — a non-choice needs no terminal', async () => {
    prompts.isInteractive.mockReturnValue(false);

    const resolved = await resolveProject(await client(), 'acme', server.url);

    expect(resolved.project.key).toBe('PROD');
  });

  it('offers a numbered picker when there are several, and takes the ORDINAL', async () => {
    server.script({
      list_projects: { structured: { projects: [projectRow('PROD'), projectRow('ACME')] } },
    });
    prompts.promptLine.mockResolvedValue('2');

    const resolved = await resolveProject(await client(), 'acme', server.url);

    expect(resolved).toEqual({ project: projectRow('ACME'), sole: false });
    // Both keys were SHOWN — the whole reason not to demand a typed key.
    expect(stderr).toContain('1) PROD');
    expect(stderr).toContain('2) ACME');
  });

  it('also accepts a KEY at the picker, case-insensitively', async () => {
    server.script({
      list_projects: { structured: { projects: [projectRow('PROD'), projectRow('ACME')] } },
    });
    prompts.promptLine.mockResolvedValue('acme');

    const resolved = await resolveProject(await client(), 'acme', server.url);

    expect(resolved.project.key).toBe('ACME');
  });

  it('refuses an answer that is neither an ordinal nor a key, naming the valid ones', async () => {
    server.script({
      list_projects: { structured: { projects: [projectRow('PROD'), projectRow('ACME')] } },
    });
    prompts.promptLine.mockResolvedValue('9');

    const failure = await resolveProject(await client(), 'acme', server.url).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliErrorType).hint).toContain('PROD, ACME');
  });

  it('demands --project when there are several and no TTY to ask at', async () => {
    server.script({
      list_projects: { structured: { projects: [projectRow('PROD'), projectRow('ACME')] } },
    });
    prompts.isInteractive.mockReturnValue(false);

    await expect(resolveProject(await client(), 'acme', server.url)).rejects.toMatchObject({
      message: 'The workspace acme has 2 projects.',
      hint: expect.stringContaining('--project'),
    });
    expect(prompts.promptLine).not.toHaveBeenCalled();
  });

  it('fails CLEARLY on an empty workspace, pointing at where a project is made', async () => {
    server.script({ list_projects: { structured: { projects: [] } } });

    const failure = await resolveProject(await client(), 'acme', server.url).catch(
      (err: unknown) => err,
    );

    // Not a crash and not an empty link: an empty workspace is a real answer
    // that the CLI cannot act on, so it says so and names the fix.
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliErrorType).message).toBe('The workspace acme has no projects yet.');
    expect((failure as CliErrorType).hint).toContain(server.url);
  });
});

describe('pickProject / describeProject / nextLinkCommand', () => {
  const projects = [projectRow('PROD'), projectRow('ACME')];

  it('reads an ordinal, a key, and rejects everything else', () => {
    expect(pickProject(projects, ' 1 ')?.key).toBe('PROD');
    expect(pickProject(projects, 'ACME')?.key).toBe('ACME');
    expect(pickProject(projects, '0')).toBeUndefined();
    expect(pickProject(projects, '3')).toBeUndefined();
    expect(pickProject(projects, 'nope')).toBeUndefined();
  });

  it('claims "the only project" ONLY when it was, in fact, the only one', () => {
    const one = projectRow('PROD', 'Prodect');
    expect(describeProject({ project: one, sole: true }, 'acme')).toContain('the only project');
    expect(describeProject({ project: one, sole: false }, 'acme')).not.toContain('only');
  });

  it('pre-fills the next command with a key when there is one to pre-fill', () => {
    expect(nextLinkCommand()).toBe('motir link');
    expect(nextLinkCommand('PROD')).toBe('motir link --project PROD');
  });
});

// ── autoLinkAfterLogin ──────────────────────────────────────────────────────

describe('autoLinkAfterLogin — the one case it writes', () => {
  it('links an unlinked, non-$HOME directory with exactly one project', async () => {
    const written = await autoLink();

    expect(written).toBe(linkPath(root));
    expect(readLink(root)).toEqual({
      serverUrl: 'https://app.motir.test',
      workspace: 'acme',
      project: 'PROD',
    });
    // The ABSOLUTE path is printed, plus how to undo it — a link created on the
    // user's behalf that they cannot find is the failure mode this prevents.
    expect(stderr).toContain(`Wrote ${linkPath(root)}`);
    expect(stderr).toContain('move or delete it');
    expect(stderr).toContain('the only project in workspace acme');
  });

  it('sandbox parity: cwd `/workspace`-shaped root, no prior link → linked', async () => {
    // The container entrypoint `cd`s to $WORKSPACE before handing over, which is
    // exactly the workspace root, and $HOME is elsewhere — so the auto-link path
    // is the one that runs there. Asserted here as the RULE (an unlinked root
    // that is not $HOME); the real container is MOTIR-1877's smoke.
    const workspace = join(root, 'workspace-mount');
    mkdirSync(workspace);

    await autoLink({ cwd: workspace });

    expect(readLink(workspace)).toMatchObject({ project: 'PROD' });
  });
});

describe('autoLinkAfterLogin — every guard writes NOTHING', () => {
  it('an existing link AT cwd is never overwritten', async () => {
    const existing = {
      serverUrl: 'https://other.motir.test',
      workspace: 'other',
      project: 'OTHER',
    };
    writeFileSync(linkPath(root), JSON.stringify(existing));

    expect(await autoLink()).toBeNull();

    expect(readLink(root)).toEqual(existing);
    expect(stderr).toContain('Already linked');
    expect(stderr).toContain('motir link --project OTHER');
  });

  it('an existing link ABOVE cwd counts — the walk is upward, so it already applies', async () => {
    const child = join(root, 'repo', 'nested');
    mkdirSync(child, { recursive: true });
    writeFileSync(linkPath(root), JSON.stringify({ serverUrl: 'x', workspace: 'w', project: 'P' }));

    expect(await autoLink({ cwd: child })).toBeNull();

    // The nested directory gets no file of its own: the parent's link is the
    // binding, and a second one below it would shadow the user's real root.
    expect(existsSync(linkPath(child))).toBe(false);
  });

  it('$HOME is refused outright — a link there would bind every folder beneath it', async () => {
    expect(await autoLink({ cwd: home })).toBeNull();

    expect(existsSync(linkPath(home))).toBe(false);
    expect(stderr).toContain('home directory');
    expect(stderr).toContain('motir link');
  });

  it('several projects → prints the pre-filled command instead of guessing', async () => {
    const several = [projectRow('PROD'), projectRow('ACME')];

    expect(await autoLink({ listProjects: async () => several })).toBeNull();

    expect(existsSync(linkPath(root))).toBe(false);
    expect(stderr).toContain('2 projects in workspace acme: PROD, ACME');
    expect(stderr).toContain('motir link --project <key>');
  });

  it('zero projects → says so and names where one is created', async () => {
    expect(await autoLink({ listProjects: async () => [] })).toBeNull();

    expect(existsSync(linkPath(root))).toBe(false);
    expect(stderr).toContain('No projects in workspace acme');
    expect(stderr).toContain('https://app.motir.test');
  });
});

describe('autoLinkAfterLogin — it can decline, but it can never fail the login', () => {
  it('an unreadable .motir.json is left alone, not overwritten', async () => {
    writeFileSync(linkPath(root), '{ not json');

    expect(await autoLink()).toBeNull();

    expect(readFileSync(linkPath(root), 'utf8')).toBe('{ not json');
    expect(stderr).toContain('could not be read');
  });

  it('a failing list_projects degrades to the next step — the credential is already stored', async () => {
    const written = await autoLink({
      listProjects: async () => {
        throw new CliError('the server fell over');
      },
    });

    // It RESOLVES rather than rejecting: `loginCommand` awaits this after the
    // credential is on disk, so a throw here would report a failed login that
    // in fact succeeded.
    expect(written).toBeNull();
    expect(existsSync(linkPath(root))).toBe(false);
    expect(stderr).toContain('motir link');
  });

  it('an unwritable directory degrades the same way', async () => {
    // A cwd that does not exist: `writeFileSync` fails for a reason the process
    // cannot fix, which is the read-only-mount case without needing root-proof
    // permission bits.
    const missing = join(root, 'gone');

    expect(await autoLink({ cwd: missing })).toBeNull();

    expect(stderr).toContain('Could not write a link');
    expect(stderr).toContain('motir link --project PROD');
  });

  it('falls back to the real cwd/home when neither is injected (the production wiring)', async () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(root);

    const written = await autoLinkAfterLogin({
      serverUrl: 'https://app.motir.test',
      workspace: 'acme',
      listProjects: async () => [projectRow('PROD', 'Prodect')],
    });

    expect(spy).toHaveBeenCalled();
    expect(written).toBe(linkPath(root));
  });
});
