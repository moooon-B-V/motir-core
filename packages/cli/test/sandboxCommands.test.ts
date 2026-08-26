import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
// A zero-dependency script, deliberately `.mjs` — it runs on a bare runner with
// no install and no build step, and a human mid-investigation can node it from
// any shell. Its typed contract lives beside it in `assert-commands.d.mts`.
import {
  anonymousRegistry,
  assertCommandSet,
  assertReference,
  expectedCommands,
  extractCliPackage,
  main,
  orderLayersByLikelihood,
  parseCliCommands,
  parseHelpCommands,
  resolvePlatforms,
  runHelp,
  verifyDigest,
  walkTar,
  CLI_PACKAGE_DIR,
  CONTROL_COMMAND,
  DEFAULT_GUIDE_PATH,
  IndeterminateError,
  type AssertCommandsIo,
  type ExtractedPackage,
} from '../sandbox/smoke/assert-commands.mjs';

// Does the command on the page exist in the image? (MOTIR-2612)
//
// The defect this script exists for has been observed in BOTH directions, which
// is why the suite spends as much effort on the false answers as on the true
// ones. MOTIR-2131: the published image predated `motir login` while the guide's
// step 4 told every reader to run it — green for five days. MOTIR-2611: the same
// belief, held about an image that had shipped the command all along, cost a card
// written, prioritised and dispatched (`notes.html` #253).
//
// So the two wrong answers this suite is built around are:
//
//   1. A GREEN that means nothing — an expectation that silently derived to
//      nothing, or a matcher that answers "present" to anything. Both would read
//      as coverage forever. Guarded by the derivation counts and by the negative
//      control.
//   2. A RED that means nothing — reporting the documented commands MISSING
//      because the help text could not be read, the layer could not be found, or
//      the host node is too old. Every one of those is exit 2, never exit 1.
//
// Nothing here reaches the network: the registry, the subprocess and the guide
// are all injected. The end-to-end run against the real published images is in
// the PR body, and re-running it is two commands (see the script's header).

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = join(CLI_DIR, '..', '..', DEFAULT_GUIDE_PATH);

const createSha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The real top-level surface of the CLI in the published `:claude` image
 *  (0.2.0), trimmed to the shape the parser has to survive: curated group
 *  headings, wrapped descriptions at a deeper indent, a `FLAGS:` block whose
 *  entries are not commands, and an `EXAMPLES:` block whose lines mention every
 *  command name in prose — which is what a substring matcher would find. */
const REAL_HELP = `Usage: motir [options] [command]

Motir CLI — terminal dispatch of the work loop (an MCP client of the Motir
server).

SETUP COMMANDS:
  login [options]           Connect this terminal: shows a code, opens Motir,
                            waits for your approval.
  auth                      Authenticate to a Motir server with a PAT.
  link [options]            Bind this workspace-root folder to a project, and
                            clone the repositories it is missing.
  doctor [options]          Preflight your BYOK setup: auth, project link, agent
                            binary, credential presence.

READ COMMANDS:
  ready [options]           List the linked project’s ready set.
  show [options] <key>      Read one work item (e.g. PROD-7).

HELP TOPICS:
  help [command...]         Show help for a command, or read a help topic.
  environment               Environment variables Motir reads.

FLAGS:
  -v, --version             Print the CLI version.
  -h, --help                display help for command

EXAMPLES:
  $ motir login                                      # connect this terminal
  $ motir link --project MOTIR                       # bind this folder
  $ motir doctor                                     # check the setup

LEARN MORE:
  Use \`motir <command> --help\` for the flags of a single command.
`;

/** Commander's DEFAULT rendering, which is what a subcommand's help looks like —
 *  a plain `Commands:` heading rather than a curated group. */
const AUTH_HELP = `Usage: motir auth [options] [command]

Authenticate to a Motir server with a PAT.

Options:
  -h, --help        display help for command

Commands:
  login [options]   Validate and store a personal access token for a server.
  status [options]  Show the resolved server, token prefix, and owning user.
  help [command]    display help for command
`;

/** A help surface for the `helpFor` seam: the top level, plus any subcommand. */
const helpSeam =
  (top: string, subs: Record<string, string> = {}) =>
  (segments: string[]): Promise<string> =>
    Promise.resolve(segments.length === 0 ? top : (subs[segments.join(' ')] ?? ''));

describe('the expectation, DERIVED from the guide the reader follows', () => {
  it('takes the command set from lib/apiDocs/sandbox.ts, not from a list in here', () => {
    // The property the whole card turns on: adding `cliCommands` to a guide step
    // changes what the job asserts, with nothing else to edit.
    const before = expectedCommands(`
      { id: 'sign-in', title: 'Sign in', cliCommands: ['login'], blocks: [] },
      { id: 'link-it', title: 'Link', cliCommands: ['link'], blocks: [] },
    `);
    expect(before.ok).toBe(true);
    expect(before.commands).toEqual(['link', 'login']);

    const after = expectedCommands(`
      { id: 'sign-in', title: 'Sign in', cliCommands: ['login'], blocks: [] },
      { id: 'link-it', title: 'Link', cliCommands: ['link'], blocks: [] },
      { id: 'check-it', title: 'Check', cliCommands: ['doctor'], blocks: [] },
    `);
    expect(after.commands).toEqual(['doctor', 'link', 'login']);
  });

  it('reads the REAL guide, and what it reads is what /docs/sandbox instructs', () => {
    // The unit cases above prove the parser; this proves it still matches the
    // file. A regex guarding a source it no longer recognises is `notes.html`
    // #231 — and here it would produce a green check over an empty assertion.
    const parsed = parseCliCommands(readFileSync(GUIDE, 'utf8'));
    expect(parsed.declared).toBeGreaterThan(0);
    expect(parsed.parsed).toBe(parsed.declared);
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.commands).toEqual(expect.arrayContaining(['doctor', 'link', 'login']));
  });

  it('REFUSES rather than deriving nothing — an empty expectation is exit 2', () => {
    // The dangerous silence: 0 expected, 0 missing, PASS. A guide with no
    // annotation and a parser that has stopped matching are the same
    // observation from here, and the first is not a state this repo is in.
    const empty = expectedCommands('export const SANDBOX_STEPS = [{ id: "sign-in" }];');
    expect(empty.ok).toBe(false);
    expect(empty.commands).toEqual([]);
    expect(empty.detail).toMatch(/NO documented commands/);
  });

  it('REFUSES when it can see a cliCommands array it cannot read', () => {
    // Counting the keys separately from the arrays understood is what turns a
    // partial match into a refusal instead of a quietly smaller expectation.
    const dynamic = expectedCommands(`
      { cliCommands: ['login'], blocks: [] },
      { cliCommands: [...EXTRA_COMMANDS], blocks: [] },
    `);
    expect(dynamic.ok).toBe(false);
    expect(dynamic.detail).toMatch(
      /declares 2 cliCommands array\(s\) and this parser understood 1/,
    );
    expect(dynamic.detail).toContain('...EXTRA_COMMANDS');

    const templated = expectedCommands('{ cliCommands: [`login`] }');
    expect(templated.ok).toBe(false);
  });

  it('handles the shapes a real source throws at it', () => {
    // Double quotes, spread over lines, an optional-property type declaration
    // (`cliCommands?: string[]`, which declares no array and must not be
    // counted as one), and duplicates across steps.
    const parsed = parseCliCommands(`
      export interface SandboxStep { cliCommands?: string[]; }
      { cliCommands: ["login", 'link'] },
      { cliCommands: [
          'doctor',
        ] },
      { cliCommands: ['login'] },
    `);
    expect(parsed.commands).toEqual(['doctor', 'link', 'login']);
    // Three data arrays, and the `cliCommands?: string[]` TYPE declaration is
    // not one of them — it declares no array, so counting it would make every
    // parse of the real file a refusal.
    expect(parsed.declared).toBe(3);
    expect(parsed.parsed).toBe(3);
    expect(parsed.unparsed).toEqual([]);
  });
});

describe('reading the command set out of the image’s own help', () => {
  it('takes the commands from the group blocks, and nothing else from the page', () => {
    const parsed = parseHelpCommands(REAL_HELP);
    expect(parsed.commands).toEqual([
      'login',
      'auth',
      'link',
      'doctor',
      'ready',
      'show',
      'help',
      'environment',
    ]);
    expect(parsed.groups.map((group) => group.heading)).toEqual([
      'SETUP COMMANDS',
      'READ COMMANDS',
      'HELP TOPICS',
    ]);
  });

  it('does NOT harvest flags, example lines, or wrapped descriptions', () => {
    // Each of these sits at a two-space indent somewhere in a real help page, so
    // an indent-only matcher would invent commands called `$` and `-v,` — and,
    // worse, would find every command name it was asked for inside EXAMPLES.
    const parsed = parseHelpCommands(REAL_HELP);
    expect(parsed.commands).not.toContain('$');
    expect(parsed.commands).not.toContain('-v,');
    expect(parsed.commands).not.toContain('waits');
    expect(parsed.commands).not.toContain('use');
  });

  it('reads commander’s DEFAULT `Commands:` rendering too', () => {
    // Subcommand help is not the curated surface — the group heading is plain
    // `Commands:`, and `Options:` above it must not become a group.
    const parsed = parseHelpCommands(AUTH_HELP);
    expect(parsed.commands).toEqual(['login', 'status', 'help']);
    expect(parsed.groups.map((group) => group.heading)).toEqual(['Commands']);
  });

  it('yields nothing for output that is not a help page', () => {
    for (const junk of ['', null, undefined, 'Error: Unknown command "help"', '{"json":true}']) {
      expect(parseHelpCommands(junk).commands).toEqual([]);
    }
  });
});

describe('the verdict', () => {
  it('is exit 0 when every documented command is a top-level command', async () => {
    const result = await assertCommandSet({
      expected: ['login', 'link', 'doctor'],
      helpFor: helpSeam(REAL_HELP),
    });
    expect(result).toMatchObject({ verdict: 'complete', exitCode: 0, missing: [] });
    expect(result.present).toEqual(['login', 'link', 'doctor']);
  });

  it('is exit 1 when one is missing, and names it and the remedy', async () => {
    // The MOTIR-2131 shape, which is what `:claude-0.1.0` still does today.
    const withoutLogin = REAL_HELP.replace(/ {2}login \[options\][\s\S]*?approval\.\n/, '');
    const result = await assertCommandSet({
      expected: ['login', 'link', 'doctor'],
      helpFor: helpSeam(withoutLogin),
    });
    expect(result).toMatchObject({ verdict: 'missing', exitCode: 1, missing: ['login'] });
    expect(result.present).toEqual(['link', 'doctor']);
    // The remedy matters: the wrong fix is editing the guide down to the stale
    // image, and a check that does not say so invites it.
    expect(result.summary).toMatch(/Cut a release/);
    expect(result.summary).toMatch(/Unknown command/);
  });

  it('is exit 2 — not a verdict — when the CONTROL comes back present', async () => {
    // A matcher that answers yes to anything would report every documented
    // command present, which is the reassuring wrong answer. The control is the
    // only thing that can catch it, so its own failure must never be a pass.
    const loose = `${REAL_HELP}\nSTRAY COMMANDS:\n  ${CONTROL_COMMAND}   whatever\n`;
    const result = await assertCommandSet({
      expected: ['login'],
      helpFor: helpSeam(loose),
    });
    expect(result).toMatchObject({ verdict: 'control-present', exitCode: 2 });
    expect(result.summary).toMatch(/proves NOTHING/);
    // And specifically NOT a claim about the documented commands, which ARE all
    // present in this fixture.
    expect(result.missing).toEqual([]);
  });

  it('accepts an injected control, so the control itself is testable', async () => {
    const result = await assertCommandSet({
      expected: ['login'],
      helpFor: helpSeam(REAL_HELP),
      control: 'ready',
    });
    expect(result.verdict).toBe('control-present');
  });

  it('is exit 2 for MALFORMED help — never “everything is missing”', async () => {
    // The false-red that would make this check untrustworthy in the other
    // direction: an empty stdout, a crashed CLI, or a help surface that has
    // changed shape is a probe failure, not a release defect.
    for (const junk of ['', 'Error: Unknown command "help"', 'Usage: motir [options]']) {
      const result = await assertCommandSet({
        expected: ['login', 'link'],
        helpFor: helpSeam(junk),
      });
      expect(result, junk).toMatchObject({ verdict: 'unreadable-help', exitCode: 2 });
      expect(result.summary).toMatch(/NOT a report that the commands are missing/);
      expect(result.missing).toEqual([]);
    }
  });

  it('is exit 2 when the derivation produced nothing, even with a readable image', async () => {
    const result = await assertCommandSet({ expected: [], helpFor: helpSeam(REAL_HELP) });
    expect(result).toMatchObject({ verdict: 'no-expectation', exitCode: 2 });
  });

  it('resolves a NESTED path by asking the CLI about the parent', async () => {
    // `lib/apiDocs/cli.ts` already annotates `auth status`, so a sandbox step
    // could tomorrow. Matching a two-word path against a one-word list would
    // report a shipped command missing.
    const helpFor = vi.fn(helpSeam(REAL_HELP, { auth: AUTH_HELP }));
    const result = await assertCommandSet({ expected: ['auth status', 'login'], helpFor });
    expect(result).toMatchObject({ verdict: 'complete', exitCode: 0 });
    expect(helpFor).toHaveBeenCalledWith(['auth']);

    const missing = await assertCommandSet({
      expected: ['auth rotate'],
      helpFor: helpSeam(REAL_HELP, { auth: AUTH_HELP }),
    });
    expect(missing).toMatchObject({ verdict: 'missing', missing: ['auth rotate'], exitCode: 1 });
  });

  it('refuses rather than calling a child missing when the parent’s help is unreadable', async () => {
    const result = await assertCommandSet({
      expected: ['auth status'],
      helpFor: helpSeam(REAL_HELP, { auth: 'crashed' }),
    });
    expect(result).toMatchObject({ verdict: 'unreadable-help', exitCode: 2 });
    expect(result.summary).toContain('motir help auth');
  });
});

// ── The image side ──────────────────────────────────────────────────────────

/** Build a tar buffer from `{ path: contents }`, with real 512-byte headers. */
function makeTar(entries: Record<string, string>, options: { longNames?: boolean } = {}): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, contents] of Object.entries(entries)) {
    const body = Buffer.from(contents, 'utf8');
    const push = (entryName: string, type: string, payload: Buffer) => {
      const header = Buffer.alloc(512);
      header.write(entryName.slice(0, 100), 0, 'utf8');
      header.write(payload.length.toString(8).padStart(11, '0'), 124, 'latin1');
      header.write(type, 156, 'latin1');
      blocks.push(header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512));
    };
    if (options.longNames) {
      // GNU tar's long-name extension: an `L` entry carrying the real path,
      // then the entry itself with a truncated name. Deep `node_modules` paths
      // in a real layer arrive this way.
      push('././@LongLink', 'L', Buffer.from(`${name}\0`, 'utf8'));
      push(name.slice(-99), '0', body);
    } else {
      push(name, '0', body);
    }
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const CLI_FILES = {
  [`${CLI_PACKAGE_DIR}/package.json`]: JSON.stringify({
    name: '@motir/cli',
    version: '0.2.0',
    bin: { motir: './dist/index.js' },
    engines: { node: '>=22' },
  }),
  [`${CLI_PACKAGE_DIR}/dist/index.js`]: '// the bundle',
};

describe('the tar reader that opens a layer', () => {
  it('reads regular files, and the paths a real layer uses', () => {
    const seen: string[] = [];
    walkTar(makeTar({ 'a/b.txt': 'hi', './c.txt': 'there' }), ({ name, body }) =>
      seen.push(`${name}=${body.toString('utf8')}`),
    );
    expect(seen).toEqual(['a/b.txt=hi', './c.txt=there']);
  });

  it('follows a GNU long-name entry instead of the truncated header name', () => {
    const deep = `${CLI_PACKAGE_DIR}/node_modules/commander/lib/${'x'.repeat(60)}/command.js`;
    const seen: string[] = [];
    walkTar(makeTar({ [deep]: 'body' }, { longNames: true }), ({ name }) => seen.push(name));
    expect(seen).toEqual([deep]);
  });

  it('stops at the end-of-archive padding rather than reading past it', () => {
    let count = 0;
    walkTar(makeTar({ 'a.txt': 'x' }), () => {
      count += 1;
    });
    expect(count).toBe(1);
  });
});

describe('choosing which layer to open', () => {
  it('puts the layer whose Dockerfile step installed the CLI first', () => {
    // The point is speed, not correctness: the alternative is walking forward
    // through two 50 MB apt layers to reach a 1.4 MB one.
    const config = {
      history: [
        { created_by: 'RUN apt-get install …' },
        { created_by: 'ENV NODE_VERSION=24', empty_layer: true },
        { created_by: 'COPY /pkg/*.tgz /tmp/motir-cli.tgz # buildkit' },
        { created_by: 'RUN npm install -g /tmp/motir-cli.tgz && rm /tmp/motir-cli.tgz' },
        { created_by: 'RUN install-agent.sh claude' },
      ],
    };
    expect(orderLayersByLikelihood(config, 4)).toEqual([1, 2, 3, 0]);
  });

  it('falls back to newest-first when the history says nothing useful', () => {
    // A hint that stops matching costs a slower run and never a wrong verdict —
    // every other layer is still searched, in filesystem order.
    expect(orderLayersByLikelihood({ history: [] }, 3)).toEqual([2, 1, 0]);
    expect(orderLayersByLikelihood(null, 2)).toEqual([1, 0]);
  });
});

describe('digest verification, because the bytes are about to be EXECUTED', () => {
  it('accepts bytes that match', () => {
    const bytes = Buffer.from('hello');
    const digest = `sha256:${createSha256(bytes)}`;
    expect(() => verifyDigest(bytes, digest, 'the blob')).not.toThrow();
  });

  it('refuses bytes that do not, and says nothing was extracted', () => {
    expect(() => verifyDigest(Buffer.from('hello'), `sha256:${'0'.repeat(64)}`, 'layer 3')).toThrow(
      /layer 3 did not match its digest[\s\S]*Nothing was extracted or executed/,
    );
  });

  it('refuses a digest algorithm it cannot check', () => {
    expect(() => verifyDigest(Buffer.from('x'), 'md5:abc', 'the config')).toThrow(
      /unsupported digest/,
    );
    expect(() => verifyDigest(Buffer.from('x'), null, 'the config')).toThrow(/unsupported digest/);
  });
});

/** A stub registry serving one multi-arch image, recording every request. */
function stubRegistry(options: { layers?: Buffer[]; history?: unknown[] } = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const layerBytes = options.layers ?? [gzipSync(makeTar(CLI_FILES))];
  const digestOf = (bytes: Buffer) => `sha256:${createSha256(bytes)}`;
  const config = Buffer.from(
    JSON.stringify({ history: options.history ?? [{ created_by: 'RUN npm i -g motir-cli.tgz' }] }),
  );
  const manifest = (platform: string) => ({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: digestOf(config), size: config.length },
    layers: layerBytes.map((bytes) => ({
      digest: digestOf(bytes),
      size: bytes.length,
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
    })),
    annotations: { platform },
  });
  const manifests: Record<string, unknown> = {
    'sha256:amd64': manifest('linux/amd64'),
    'sha256:arm64': manifest('linux/arm64'),
    claude: {
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        { digest: 'sha256:amd64', platform: { os: 'linux', architecture: 'amd64' } },
        { digest: 'sha256:arm64', platform: { os: 'linux', architecture: 'arm64' } },
        // buildx's attestation manifests, which carry no filesystem at all.
        { digest: 'sha256:attest', platform: { os: 'unknown', architecture: 'unknown' } },
      ],
    },
  };

  const blobs = new Map<string, Buffer>([
    [digestOf(config), config],
    ...layerBytes.map((bytes) => [digestOf(bytes), bytes] as [string, Buffer]),
  ]);

  const registry = (): ((path: string, accept: string) => Promise<Response>) => {
    return async (path, accept) => {
      requests.push({ url: path, headers: { accept } });
      const manifestMatch = /^manifests\/(.+)$/.exec(path);
      if (manifestMatch) {
        const document = manifests[manifestMatch[1]!];
        if (!document) throw new IndeterminateError(`HTTP 404 reading ${path}`);
        return new Response(JSON.stringify(document), {
          headers: { 'docker-content-digest': 'sha256:index' },
        });
      }
      const blobMatch = /^blobs\/(.+)$/.exec(path);
      const blob = blobMatch ? blobs.get(blobMatch[1]!) : undefined;
      if (!blob) throw new IndeterminateError(`HTTP 404 reading ${path}`);
      return new Response(blob);
    };
  };
  return { registry, requests, digestOf };
}

/** An `io` whose every seam is a stub: no network, no subprocess, no files. */
function stubIo(overrides: Partial<AssertCommandsIo> = {}): AssertCommandsIo {
  const stub = stubRegistry();
  const lines: string[] = [];
  const errors: string[] = [];
  const io: AssertCommandsIo = {
    readGuide: () => Promise.resolve("{ cliCommands: ['login', 'link', 'doctor'] }"),
    readdir: () => Promise.resolve([]),
    readFile: () => Promise.resolve(''),
    registry: stub.registry,
    cached: (_key, produce) => produce(),
    runNode: () => Promise.resolve(REAL_HELP),
    log: (line) => void lines.push(line),
    error: (line) => void errors.push(line),
    ...overrides,
  };
  return Object.assign(io, { lines, errors });
}

describe('pulling the CLI out of a published image', () => {
  it('fans an index out to every real platform and skips the attestations', async () => {
    const resolved = await resolvePlatforms('ghcr.io/moooon-b-v/motir-sandbox:claude', stubIo());
    expect(resolved.platforms).toEqual([
      { platform: 'linux/amd64', digest: 'sha256:amd64' },
      { platform: 'linux/arm64', digest: 'sha256:arm64' },
    ]);
  });

  it('refuses a reference that is not fully qualified', async () => {
    await expect(resolvePlatforms('motir-sandbox:claude', stubIo())).rejects.toThrow(
      /not a fully-qualified/,
    );
  });

  it('extracts the installed package, keyed by its path inside the package', async () => {
    const pkg = await extractCliPackage(
      { registry: 'ghcr.io', repository: 'moooon-b-v/motir-sandbox', reference: 'claude' },
      'sha256:amd64',
      stubIo(),
    );
    expect([...pkg.files.keys()].sort()).toEqual(['dist/index.js', 'package.json']);
    expect(pkg.version).toBe('0.2.0');
  });

  it('reports could-not-tell when no layer holds the CLI', async () => {
    // An image that is not a motir sandbox, or a Dockerfile that moved the
    // install. Either way: not a verdict about documented commands.
    const stub = stubRegistry({ layers: [gzipSync(makeTar({ 'usr/bin/other': 'x' }))] });
    await expect(
      extractCliPackage(
        { registry: 'ghcr.io', repository: 'moooon-b-v/motir-sandbox', reference: 'claude' },
        'sha256:amd64',
        stubIo({ registry: stub.registry }),
      ),
    ).rejects.toThrow(/no usr\/local\/lib\/node_modules\/@motir\/cli found in any layer/);
  });

  it('finds the CLI in a later layer when the history hint misses', async () => {
    const stub = stubRegistry({
      layers: [gzipSync(makeTar({ 'usr/bin/other': 'x' })), gzipSync(makeTar(CLI_FILES))],
      history: [{ created_by: 'RUN something' }, { created_by: 'RUN something else' }],
    });
    const pkg = await extractCliPackage(
      { registry: 'ghcr.io', repository: 'moooon-b-v/motir-sandbox', reference: 'claude' },
      'sha256:amd64',
      stubIo({ registry: stub.registry }),
    );
    expect(pkg.layerIndex).toBe(1);
  });
});

describe('running the extracted CLI', () => {
  const pkgOf = (files: Record<string, string>): ExtractedPackage => ({
    files: new Map(Object.entries(files).map(([name, body]) => [name, Buffer.from(body)])),
    version: '0.2.0',
    layerDigest: 'sha256:layer',
    layerIndex: 0,
  });

  it('runs the entry point the package DECLARES, not a path assumed here', async () => {
    const runNode = vi.fn(() => Promise.resolve(REAL_HELP));
    await runHelp(
      pkgOf({
        'package.json': JSON.stringify({
          bin: { motir: './dist/cli.js' },
          engines: { node: '>=22' },
        }),
      }),
      stubIo({ runNode }),
      ['auth'],
    );
    expect(runNode).toHaveBeenCalledWith(expect.anything(), 'dist/cli.js', ['help', 'auth']);
  });

  it('accepts the string form of `bin`', async () => {
    const runNode = vi.fn(() => Promise.resolve(REAL_HELP));
    await runHelp(pkgOf({ 'package.json': '{"bin":"dist/index.js"}' }), stubIo({ runNode }));
    expect(runNode).toHaveBeenCalledWith(expect.anything(), 'dist/index.js', ['help']);
  });

  it('refuses when the host node is older than the CLI requires', async () => {
    // A CLI that will not start on this machine says nothing about what it
    // contains — reporting its commands missing would be a false red.
    await expect(
      runHelp(pkgOf({ 'package.json': '{"bin":"x.js","engines":{"node":">=99"}}' }), stubIo()),
    ).rejects.toThrow(/requires node >=99/);
  });

  it('refuses an extracted package it cannot read', async () => {
    await expect(runHelp(pkgOf({ 'dist/index.js': '' }), stubIo())).rejects.toThrow(
      /no package\.json/,
    );
    await expect(runHelp(pkgOf({ 'package.json': 'not json' }), stubIo())).rejects.toThrow(
      /unreadable/,
    );
    await expect(runHelp(pkgOf({ 'package.json': '{}' }), stubIo())).rejects.toThrow(
      /declares no `motir` bin/,
    );
  });
});

describe('the anonymous registry reader', () => {
  it('sends NO credential of ours, and only a token the registry issued to a nobody', async () => {
    // The load-bearing property of the whole check. It reads no docker config
    // and no environment, so it gives the same answer from a logged-in shell.
    const sent: { url: string; headers: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, unknown> });
      if (sent.length === 1) {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="s"',
          },
        });
      }
      if (String(url).startsWith('https://ghcr.io/token')) {
        return new Response(JSON.stringify({ token: 'anon-token' }));
      }
      return new Response('{}');
    }) as unknown as typeof fetch;

    const get = anonymousRegistry(
      { registry: 'ghcr.io', repository: 'moooon-b-v/motir-sandbox', reference: 'claude' },
      fetchImpl,
    );
    await get('manifests/claude', 'application/json');

    // The FIRST request carries no authorization at all…
    expect(sent[0]!.headers.authorization).toBeUndefined();
    // …the token request carries none either — that is what makes it anonymous…
    expect(sent[1]!.headers).not.toHaveProperty('authorization');
    expect(sent[1]!.url).toContain('scope=s');
    // …and the only bearer ever sent is the one the token endpoint handed back.
    expect(sent[2]!.headers.authorization).toBe('Bearer anon-token');
  });

  it('reports could-not-tell when the registry refuses an anonymous token', async () => {
    // `assert-public.mjs` reports that same wire fact as `private-or-absent`.
    // Here it is a refusal: this script's question is about CONTENTS, and it
    // has not seen any.
    const fetchImpl = (async (url: string) =>
      String(url).startsWith('https://ghcr.io/token')
        ? new Response('{}', { status: 403 })
        : new Response('', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token"' },
          })) as unknown as typeof fetch;
    const get = anonymousRegistry(
      { registry: 'ghcr.io', repository: 'moooon-b-v/private', reference: 'x' },
      fetchImpl,
    );
    await expect(get('manifests/x', 'application/json')).rejects.toThrow(
      /refused an anonymous pull token[\s\S]*assert-public/,
    );
  });

  it('turns a transport failure into could-not-tell, never a verdict', async () => {
    const fetchImpl = (() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as never;
    const get = anonymousRegistry(
      { registry: 'ghcr.io', repository: 'a/b', reference: 'x' },
      fetchImpl,
    );
    await expect(get('manifests/x', 'application/json')).rejects.toThrow(
      /could not be reached[\s\S]*ENOTFOUND/,
    );
  });

  it('turns any other HTTP status into could-not-tell', async () => {
    const fetchImpl = (() => Promise.resolve(new Response('', { status: 500 }))) as never;
    const get = anonymousRegistry(
      { registry: 'ghcr.io', repository: 'a/b', reference: 'x' },
      fetchImpl,
    );
    await expect(get('manifests/x', 'application/json')).rejects.toThrow(/HTTP 500/);
  });
});

describe('the whole run, end to end over the stubs', () => {
  it('judges EVERY platform of every reference', async () => {
    const { results } = await assertReference(
      'ghcr.io/moooon-b-v/motir-sandbox:claude',
      ['login', 'link', 'doctor'],
      stubIo(),
    );
    expect(results.map((row) => `${row.platform}:${row.verdict}`)).toEqual([
      'linux/amd64:complete',
      'linux/arm64:complete',
    ]);
    expect(results[0]!.cliVersion).toBe('0.2.0');
  });

  it('exits 0 and reports the expectation it derived', async () => {
    const io = stubIo();
    const code = await main(['--ref', 'ghcr.io/moooon-b-v/motir-sandbox:claude'], io);
    expect(code).toBe(0);
    const lines = (io as unknown as { lines: string[] }).lines;
    expect(lines[0]).toContain('expected doctor, link, login');
    expect(lines[1]).toContain(CONTROL_COMMAND);
    expect(lines.join('\n')).toContain('PRESENT');
  });

  it('exits 2 BEFORE pulling a byte when the derivation refuses', async () => {
    const registry = vi.fn(() => () => Promise.reject(new Error('should not be called')));
    const io = stubIo({
      readGuide: () => Promise.resolve('no annotations here'),
      registry: registry as never,
    });
    expect(await main(['--ref', 'ghcr.io/moooon-b-v/motir-sandbox:claude'], io)).toBe(2);
    expect(registry).not.toHaveBeenCalled();
    expect((io as unknown as { errors: string[] }).errors.join('\n')).toMatch(/proves NOTHING/);
  });

  it('exits 1 when a platform is missing a command, and says how to fix it', async () => {
    const io = stubIo({
      runNode: () =>
        Promise.resolve(REAL_HELP.replace(/ {2}doctor \[options\][\s\S]*?presence\.\n/, '')),
    });
    expect(await main(['--ref', 'ghcr.io/moooon-b-v/motir-sandbox:claude'], io)).toBe(1);
    const errors = (io as unknown as { errors: string[] }).errors.join('\n');
    expect(errors).toMatch(/cut a CLI release/);
    expect(errors).toMatch(/Do NOT edit the guide to match a stale image/);
  });

  it('lets a DEFINITE defect outrank a could-not-tell on another reference', async () => {
    // A release with one image provably missing a documented command must not be
    // reported as inconclusive because a second image failed to download.
    const io = stubIo({
      runNode: () =>
        // Cut the whole `link` block, up to the next two-space-indented command
        // line. Anchored on the SHAPE rather than on the last word of the
        // description, which is prose and moves (it did, with MOTIR-3589).
        Promise.resolve(REAL_HELP.replace(/ {2}link \[options\][\s\S]*?(?=\n {2}\S)/, '')),
    });
    const code = await main(
      [
        '--ref',
        'ghcr.io/moooon-b-v/motir-sandbox:claude',
        '--ref',
        'ghcr.io/moooon-b-v/nope:absent',
      ],
      io,
    );
    expect(code).toBe(1);
    expect((io as unknown as { lines: string[] }).lines.join('\n')).toContain('UNKNOWN');
  });

  it('reports an unreadable image as UNKNOWN, exit 2', async () => {
    const io = stubIo();
    expect(await main(['--ref', 'ghcr.io/moooon-b-v/nope:absent'], io)).toBe(2);
    expect((io as unknown as { errors: string[] }).errors.join('\n')).toMatch(
      /PROBE failure, not a[\s\S]*verdict/,
    );
  });

  it('takes the release lane’s --image/--digests form, via assert-public’s own reader', async () => {
    const io = stubIo({
      readdir: () => Promise.resolve(['claude']),
      readFile: () => Promise.resolve('sha256:amd64\n'),
    });
    // The digest form resolves to `<image>@<digest>`; the stub serves that
    // digest as a single-arch manifest, which is the `unspecified` platform arm.
    expect(
      await main(['--image', 'ghcr.io/moooon-b-v/motir-sandbox', '--digests', 'digests'], io),
    ).toBe(0);
    expect((io as unknown as { lines: string[] }).lines.join('\n')).toContain('[unspecified]');
  });

  it('memoises by platform digest, because every profile shares the CLI layer', async () => {
    // A release publishes ten tags whose CLI bytes are identical. Keyed by
    // digest, which is what makes the reuse sound rather than an assumption.
    const produced = new Map<string, unknown>();
    const io = stubIo({
      cached: async (key, produce) => {
        if (!produced.has(key)) produced.set(key, await produce());
        return produced.get(key) as never;
      },
    });
    await main(
      [
        '--ref',
        'ghcr.io/moooon-b-v/motir-sandbox:claude',
        '--ref',
        'ghcr.io/moooon-b-v/motir-sandbox:claude',
      ],
      io,
    );
    expect([...produced.keys()]).toEqual(['sha256:amd64', 'sha256:arm64']);
  });
});
