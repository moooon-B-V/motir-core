import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// A zero-dependency release-lane script, deliberately `.mjs` — it runs on a bare
// runner with no install and no build step. Its typed contract lives beside it in
// `render-digest-table.d.mts`.
import {
  checkNovelty,
  checkRecorded,
  demoteSection,
  main,
  parseRows,
  parseSections,
  renderSection,
  wrapProse,
  renderTable,
  resolveDigestRows,
  resolveNames,
  updateReadme,
} from '../sandbox/smoke/render-digest-table.mjs';

// The digest-table writer (MOTIR-2699), driven against a REAL registry — the same
// stub-server choice `sandboxPublic.test.ts` makes, and for the same reason: the
// script's whole value is the wire question it asks at ghcr.io, so a mocked fetch
// would be testing a fake's idea of the answer.
//
// What this suite is FOR. § Published images exists so a BYOK user can pin the
// exact image a run happened in, and it was maintained by hand for four releases
// because the lane's own digest table went to a job summary that no repository
// can read. Automating the transcription is only an improvement if the checks
// survive the automation: a lane that writes nine rows from values the build
// carried forward, with the two invariants demoted to prose, would look
// maintained while removing the only reasons to believe it. So the interesting
// cases here are the ones where writing MUST NOT happen.

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(CLI_DIR, 'sandbox', 'README.md'), 'utf8');

const digest = (char: string): string => `sha256:${char.repeat(64)}`;

interface StubState {
  /** tag → the digest the registry serves for it, anonymously. */
  tags: Map<string, string>;
}

const state: StubState = { tags: new Map() };
let server: Server;
let origin = '';

/** The stub's `<registry>/<repository>`, in the form the script is pointed at. */
const image = (): string => `${origin}/moooon-b-v/motir-sandbox`;

/** The script always talks https; the stub is http, so requests are rewritten
 *  onto it. Everything else — the challenge, the token, the manifest — is real. */
const stubFetch: typeof fetch = (input, init) =>
  fetch(String(input).replace('https://', 'http://'), init);

/** The control the probe insists on before it believes any other answer. */
const control = (): string => `${origin}/control/image:latest`;

const options = () => ({ fetch: stubFetch, control: control() });

/** Publish one release's worth of tags: the moving tag and its immutable twin,
 *  both resolving to the same manifest — the healthy shape. */
function publish(version: string, digests: Record<string, string>): void {
  for (const [name, sha] of Object.entries(digests)) {
    state.tags.set(name, sha);
    state.tags.set(`${name}-${version}`, sha);
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');

    if (url.pathname === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'anonymous-token' }));
      return;
    }

    const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
    if (manifest) {
      if (req.headers.authorization !== 'Bearer anonymous-token') {
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="http://${origin}/token",service="stub",scope="repository:${manifest[1]}:pull"`,
        });
        res.end();
        return;
      }
      const reference = manifest[2] as string;
      // The control lives in its own repository and always resolves.
      const served = manifest[1] === 'control/image' ? digest('0') : state.tags.get(reference);
      if (!served) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/vnd.oci.image.index.v1+json',
        'docker-content-digest': served,
      });
      res.end('{}');
      return;
    }

    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.tags.clear();
});

describe('resolving the digests', () => {
  it('reads each digest from the REGISTRY, anonymously, for the moving tag', async () => {
    publish('0.4.0', { base: digest('a'), claude: digest('b') });
    const resolved = await resolveDigestRows(image(), ['base', 'claude'], '0.4.0', options());
    expect(resolved.exitCode).toBe(0);
    expect(resolved.rows).toEqual([
      { name: 'base', tag: `${image()}:base`, digest: digest('a') },
      { name: 'claude', tag: `${image()}:claude`, digest: digest('b') },
    ]);
  });

  it('never sends an Authorization header of its own', async () => {
    // Inherited from `assert-public.mjs`'s probe and re-asserted here, because it
    // is the property that makes the recorded digest the one a STRANGER gets.
    // The publisher's answer is available to this lane and is the wrong answer.
    publish('0.4.0', { base: digest('a') });
    const seen: (string | undefined)[] = [];
    const recording: typeof fetch = (input, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? undefined);
      return stubFetch(input, init);
    };
    await resolveDigestRows(image(), ['base'], '0.4.0', { ...options(), fetch: recording });
    // Only a token the registry minted for an anonymous caller may ever appear.
    expect(seen.filter((header) => header !== undefined)).toEqual(
      Array(seen.filter((header) => header !== undefined).length).fill('Bearer anonymous-token'),
    );
    expect(seen[0]).toBeUndefined();
  });

  it('exits 2 and resolves NOTHING when the positive control does not answer', async () => {
    // The load-bearing case, and the reason the control is probed first: a broken
    // probe resolves no digests, and "no digests" is indistinguishable from a
    // release that published nothing. Reported as could-not-tell, never written.
    publish('0.4.0', { base: digest('a') });
    const resolved = await resolveDigestRows(image(), ['base'], '0.4.0', {
      ...options(),
      control: `${origin}/absent/control:latest`,
    });
    expect(resolved.exitCode).toBe(2);
    expect(resolved.rows).toEqual([]);
    expect(resolved.summary).toContain('proves NOTHING');
  });

  it('exits 1 when a published tag is missing rather than writing a SHORT table', async () => {
    publish('0.4.0', { base: digest('a') });
    const resolved = await resolveDigestRows(image(), ['base', 'claude'], '0.4.0', options());
    expect(resolved.exitCode).toBe(1);
    expect(resolved.problems.join('\n')).toContain('claude');
  });
});

describe('invariant 1 — a moving tag matches its immutable twin', () => {
  it('FAILS, rather than warning, when the two resolve to different manifests', async () => {
    // The falsifiability case for the first claim the section makes. A moving tag
    // that has drifted from its twin means the reference a reader copies and the
    // digest they pin are different bytes — the exact confusion the table exists
    // to prevent, so it is a red release and no row is written.
    publish('0.4.0', { base: digest('a') });
    state.tags.set('base', digest('f'));
    const resolved = await resolveDigestRows(image(), ['base'], '0.4.0', options());
    expect(resolved.exitCode).toBe(1);
    expect(resolved.rows).toEqual([]);
    expect(resolved.problems.join('\n')).toContain('DIFFERENT bytes');
  });
});

describe('invariant 2 — every digest differs from the previous release', () => {
  const rows = [{ name: 'base', tag: 'ghcr.io/x/y:base', digest: digest('a') }];

  it('FAILS on a forced same-digest case', () => {
    const previous = { version: '0.3.0', rows };
    const verdict = checkNovelty(rows, previous);
    expect(verdict.checked).toBe(true);
    expect(verdict.problems.join('\n')).toContain('did not rebuild');
  });

  it('passes when the digest moved', () => {
    const previous = {
      version: '0.3.0',
      rows: [{ name: 'base', tag: 'ghcr.io/x/y:base', digest: digest('b') }],
    };
    expect(checkNovelty(rows, previous).problems).toEqual([]);
  });

  it('reports itself as NOT CHECKED for a first release, rather than passing 0 of 0', () => {
    // "0 of 0 differ" is the shape that makes an empty check look green, so the
    // absence of a predecessor is carried out and said out loud in the section.
    expect(checkNovelty(rows, null)).toEqual({ checked: false, problems: [] });
  });
});

describe('invariant 3 — the registry agrees with what the push recorded', () => {
  const rows = [{ name: 'base', tag: 'ghcr.io/x/y:base', digest: digest('a') }];

  it('FAILS on a deliberately wrong recorded digest — neither value is written', () => {
    const verdict = checkRecorded(rows, { base: digest('e') });
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain('NEITHER is written');
  });

  it('FAILS when the push recorded nothing for a name the release publishes', () => {
    expect(checkRecorded(rows, {}).problems.join('\n')).toContain('release is incomplete');
  });

  it('FAILS when the push recorded a name this run did not resolve', () => {
    expect(
      checkRecorded(rows, { base: digest('a'), ghost: digest('c') }).problems.join('\n'),
    ).toContain('which this run did not resolve');
  });

  it('is NOT CHECKED when the lane hands over no digest directory', () => {
    expect(checkRecorded(rows, null)).toEqual({ checked: false, problems: [] });
  });
});

describe('the rendered markdown', () => {
  it('pads the table exactly as Prettier does — the shape the shipped file already has', () => {
    // `prettier --check .` covers this README, and markdown tables are one of the
    // few things Prettier rewrites structurally (every cell padded to its
    // column's widest, the separator that same width in dashes). This lane's
    // commit starts no CI run, so the format gate cannot catch a drift here after
    // the fact — pinning the renderer against the table ALREADY in the file,
    // byte for byte, is what makes the generated section format-clean by
    // construction rather than by hope.
    const shipped = README.slice(README.indexOf('### Release `cli-v0.3.0`'));
    const table = shipped.slice(
      shipped.indexOf('| Tag'),
      shipped.indexOf('\n\n', shipped.indexOf('| Tag')),
    );
    expect(renderTable(parseRows(table))).toBe(table);
  });

  it('reads the rows back out of a section it just rendered', () => {
    const rows = [
      { name: 'base', tag: 'ghcr.io/moooon-b-v/motir-sandbox:base', digest: digest('a') },
      { name: 'claude', tag: 'ghcr.io/moooon-b-v/motir-sandbox:claude', digest: digest('b') },
    ];
    const section = renderSection({
      image: 'ghcr.io/moooon-b-v/motir-sandbox',
      version: '0.4.0',
      runUrl: 'https://github.com/moooon-B-V/motir-core/actions/runs/999',
      rows,
      novelty: { checked: true, problems: [], against: '0.3.0' },
    });
    expect(parseRows(section)).toEqual(rows);
    // The section states its own provenance and both counts, so a reader is not
    // asked to take the invariants on trust. Asserted against the prose with its
    // line breaks collapsed: the paragraph is wrapped at 80 columns and the
    // interpolated version and counts move the breaks, so a raw substring would
    // be asserting today's wrapping rather than the sentence.
    const prose = section.replace(/\s+/g, ' ');
    expect(section).toContain('### Release `cli-v0.4.0`');
    expect(prose).toContain(
      '([run 999](https://github.com/moooon-B-V/motir-core/actions/runs/999))',
    );
    expect(prose).toContain('twin (2 of 2)');
    expect(prose).toContain('differs from its `cli-v0.3.0` row** (2 of 2)');
    expect(prose).toContain('this is the current release');
    // Never uppercase in a reference docker has to resolve (`sandboxCi.test.ts`
    // asserts the same thing about the file as a whole).
    expect(section).not.toMatch(/ghcr\.io\/\S*[A-Z]/);
  });

  it('wraps every prose line to the file’s width, and never inside a code span', () => {
    // The generated section lands on `main` through a commit that starts no CI, so
    // nothing downstream would notice a paragraph emitted as one 400-column line.
    // A long URL is the one legitimate over-width line — it is a single token, and
    // the hand-written sections carry the same.
    const section = renderSection({
      image: 'ghcr.io/moooon-b-v/motir-sandbox',
      version: '0.10.11',
      runUrl: 'https://github.com/moooon-B-V/motir-core/actions/runs/31529928332',
      rows: Array.from({ length: 9 }, (_, index) => ({
        name: `profile-${index}`,
        tag: `ghcr.io/moooon-b-v/motir-sandbox:profile-${index}`,
        digest: digest(String(index)),
      })),
      novelty: { checked: true, problems: [], against: '0.9.0' },
    });
    const overlong = section
      .split('\n')
      .filter((line) => line.length > 80 && !line.startsWith('|') && !/\S{60}/.test(line));
    expect(overlong).toEqual([]);
    // No line break landed inside an inline code span — an odd count of backticks
    // on a line is exactly that, and it would render the newline as a space
    // inside a tag reference.
    for (const line of section.split('\n')) {
      if (line.startsWith('```') || line.startsWith('TOKEN=') || line.startsWith('  ')) continue;
      expect((line.match(/`/g) ?? []).length % 2, `unbalanced backticks: ${line}`).toBe(0);
    }
  });

  it('wraps a paragraph greedily at the given width', () => {
    expect(wrapProse('aaa bbb ccc ddd', 7)).toBe('aaa bbb\nccc ddd');
    // A token longer than the width goes on its own line rather than being split.
    expect(wrapProse('aa https://example.com/very/long bb', 10)).toBe(
      'aa\nhttps://example.com/very/long\nbb',
    );
  });

  it('says the novelty invariant is VACUOUS on a first release instead of claiming it', () => {
    const section = renderSection({
      image: 'ghcr.io/moooon-b-v/motir-sandbox',
      version: '0.1.0',
      runUrl: 'https://github.com/moooon-B-V/motir-core/actions/runs/1',
      rows: [{ name: 'base', tag: 'ghcr.io/moooon-b-v/motir-sandbox:base', digest: digest('a') }],
      novelty: { checked: false, problems: [] },
    });
    expect(section).toContain('vacuous here rather than passed');
    expect(section).not.toContain('differs from its');
  });
});

describe('reading the file it edits', () => {
  it('finds every release section the shipped README already carries, newest first', () => {
    expect(parseSections(README).map((section) => section.version)).toEqual([
      '0.3.0',
      '0.2.0',
      '0.1.1',
      '0.1.0',
    ]);
  });

  it('knows which of them carries the frame a demotion needs', () => {
    // Only the OUTGOING section ever needs it: a section's tense changes exactly
    // once, when the next release displaces it. The older hand-written ones are
    // read and never edited, which is this file's own rule about past releases.
    const sections = parseSections(README);
    expect(sections[0]).toMatchObject({ version: '0.3.0', marked: true });
    expect(sections.slice(1).every((section) => !section.marked)).toBe(true);
  });

  it('reads a section as ending at the next heading, not swallowing the ones after it', () => {
    // § Published images is followed by further `###` subsections that are not
    // releases. A section window that ran past its own table would be edited by
    // every insert from then on.
    const lines = README.split('\n');
    const oldest = parseSections(README).at(-1);
    expect(lines[oldest?.end ?? 0]).toBe('### Public, and asserted to be (MOTIR-2010)');
  });

  it('parses the digest rows of the shipped cli-v0.3.0 table', () => {
    const [current] = parseSections(README);
    const text = README.split('\n').slice(current?.start, current?.end).join('\n');
    const rows = parseRows(text);
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({
      name: 'base',
      tag: 'ghcr.io/moooon-b-v/motir-sandbox:base',
      digest: 'sha256:f44c37d71abc267789ac8835d88846b50bd63c498d6729af25062c77035d6cfa',
    });
  });
});

describe('placing the section in the file', () => {
  const section = (version: string, sha: string) =>
    renderSection({
      image: 'ghcr.io/moooon-b-v/motir-sandbox',
      version,
      runUrl: 'https://github.com/moooon-B-V/motir-core/actions/runs/999',
      rows: [{ name: 'base', tag: 'ghcr.io/moooon-b-v/motir-sandbox:base', digest: digest(sha) }],
      novelty: { checked: true, problems: [], against: '0.3.0' },
    });

  it('prepends the new release and DEMOTES the one it displaces', () => {
    const update = updateReadme(README, { version: '0.4.0', section: section('0.4.0', 'a') });
    expect(update.action).toBe('inserted');
    expect(update.changed).toBe(true);
    const content = update.content as string;
    // The new section is above the old one, and the old one now reads as history.
    expect(content.indexOf('cli-v0.4.0')).toBeLessThan(content.indexOf('### Release `cli-v0.3.0`'));
    expect(content).toContain('**was** the current release until `cli-v0.4.0`');
    // …and exactly one section still claims to be current.
    expect(content.match(/this is the current release/g)).toHaveLength(1);
    // The displaced section keeps its own rows and its own prose untouched.
    expect(content).toContain('The release whose 403 hint names a PERMISSION');
    expect(content).toContain(
      'sha256:9d7222cb3700a96effe39c1f0cc7074df79138ee795b396bafb4bef1d4395f7e',
    );
  });

  it('leaves the older, unmarked sections completely alone', () => {
    const update = updateReadme(README, { version: '0.4.0', section: section('0.4.0', 'a') });
    for (const version of ['0.2.0', '0.1.1', '0.1.0']) {
      const before = README.slice(README.indexOf(`### Release \`cli-v${version}\``));
      const after = (update.content as string).slice(
        (update.content as string).indexOf(`### Release \`cli-v${version}\``),
      );
      expect(after).toBe(before);
    }
  });

  it('REPLACES the section when the same version is recorded again', () => {
    // A moved tag republishes the images, so the digests really can change under a
    // version that already has a section. Replacing it in place is right;
    // prepending a second one for the same release is not.
    const once = updateReadme(README, { version: '0.4.0', section: section('0.4.0', 'a') });
    const twice = updateReadme(once.content as string, {
      version: '0.4.0',
      section: section('0.4.0', 'b'),
    });
    expect(twice.action).toBe('replaced');
    expect(twice.changed).toBe(true);
    expect(parseSections(twice.content as string).map((s) => s.version)).toEqual([
      '0.4.0',
      '0.3.0',
      '0.2.0',
      '0.1.1',
      '0.1.0',
    ]);
    // The demotion is not applied twice — 0.3.0 was already displaced.
    expect((twice.content as string).match(/\*\*was\*\* the current release/g)).toHaveLength(3);
  });

  it('reports changed: false when the section is already exactly right', () => {
    // Criterion 5, at its source. The writer knowing it changed nothing is what
    // makes a no-op release commit nothing at all.
    const once = updateReadme(README, { version: '0.4.0', section: section('0.4.0', 'a') });
    const again = updateReadme(once.content as string, {
      version: '0.4.0',
      section: section('0.4.0', 'a'),
    });
    expect(again.changed).toBe(false);
  });

  it('REFUSES rather than rewriting prose when the outgoing section has no frame', () => {
    // The demotion is a tense change on one paragraph. Matching that sentence in
    // English is how a copy-edit turns a demotion into a silent no-op — and a
    // section that still calls itself current is the defect this lane removes. So
    // an unframed predecessor is a loud failure naming its own fix.
    const unframed = README.replace('<!-- sandbox-digests:currency start -->', '');
    const update = updateReadme(unframed, { version: '0.4.0', section: section('0.4.0', 'a') });
    expect(update.content).toBeUndefined();
    expect(update.error).toContain('cannot be demoted');
    expect(update.error).toContain('add the currency markers');
  });

  it('REFUSES when § Published images has no release section to insert above', () => {
    const update = updateReadme('# Something else entirely\n', {
      version: '0.4.0',
      section: section('0.4.0', 'a'),
    });
    expect(update.error).toContain('refuses to guess');
  });

  it('demotes only between the markers, leaving the rest of the section byte-identical', () => {
    const [current] = parseSections(README);
    const text = README.split('\n').slice(current?.start, current?.end).join('\n');
    const demoted = demoteSection(text, '0.3.0', '0.4.0') as string;
    expect(demoted).toContain('**was** the current release until `cli-v0.4.0`');
    expect(demoted).not.toContain('this is the current release');
    // Everything outside the frame survives, including the editorial sentence no
    // lane could have written.
    expect(demoted).toContain('The release whose 403 hint names a PERMISSION');
    expect(demoted.slice(demoted.indexOf('**Read from the registry'))).toBe(
      text.slice(text.indexOf('**Read from the registry')),
    );
  });
});

describe('the release lane driving it end to end', () => {
  const io = (files: Record<string, string>, written: Record<string, string>) => ({
    readdir: (dir: string) =>
      Promise.resolve(
        Object.keys(files)
          .filter((p) => p.startsWith(`${dir}/`))
          .map((p) => p.slice(dir.length + 1)),
      ),
    readFile: (path: string) => Promise.resolve(files[path] ?? ''),
    writeFile: (path: string, content: string) => {
      written[path] = content;
      return Promise.resolve();
    },
    log: () => {},
    error: () => {},
    setOutput: (name: string, value: string) => {
      written[`::${name}`] = value;
    },
    fetch: stubFetch,
  });

  const files = () => ({
    'README.md': README,
    'profiles.json': JSON.stringify({ profiles: [{ id: 'claude', tier: 1, liveness: 'x' }] }),
    'digests/base': `${digest('a')}\n`,
    'digests/claude': `${digest('b')}\n`,
  });

  const argv = (extra: string[] = []) => [
    '--image',
    image(),
    '--version',
    '0.4.0',
    '--profiles',
    'profiles.json',
    '--digests',
    'digests',
    '--readme',
    'README.md',
    '--run-url',
    'https://github.com/moooon-B-V/motir-core/actions/runs/999',
    '--control',
    control(),
    ...extra,
  ];

  it('writes the README and reports changed=true', async () => {
    publish('0.4.0', { base: digest('a'), claude: digest('b') });
    const written: Record<string, string> = {};
    expect(await main(argv(['--write']), io(files(), written))).toBe(0);
    expect(written['::changed']).toBe('true');
    expect(written['README.md']).toContain('### Release `cli-v0.4.0`');
    expect(written['README.md']).toContain('**was** the current release until `cli-v0.4.0`');
  });

  it('writes NOTHING without --write, so a human can read the section first', async () => {
    publish('0.4.0', { base: digest('a'), claude: digest('b') });
    const written: Record<string, string> = {};
    expect(await main(argv(), io(files(), written))).toBe(0);
    expect(written['README.md']).toBeUndefined();
    expect(written['::changed']).toBe('true');
  });

  it('reports changed=false and writes nothing when the release is already recorded', async () => {
    // The no-op release, end to end: a re-run of a tag whose section is already
    // exact must not produce a commit — the workflow gates its commit step on
    // this one output.
    publish('0.4.0', { base: digest('a'), claude: digest('b') });
    const first: Record<string, string> = {};
    await main(argv(['--write']), io(files(), first));
    const second: Record<string, string> = {};
    const code = await main(
      argv(['--write']),
      io({ ...files(), 'README.md': first['README.md'] as string }, second),
    );
    expect(code).toBe(0);
    expect(second['::changed']).toBe('false');
    expect(second['README.md']).toBeUndefined();
  });

  it('writes NOTHING when a recorded digest disagrees with the registry', async () => {
    publish('0.4.0', { base: digest('a'), claude: digest('b') });
    const written: Record<string, string> = {};
    const code = await main(
      argv(['--write']),
      io({ ...files(), 'digests/claude': `${digest('e')}\n` }, written),
    );
    expect(code).toBe(1);
    expect(written['README.md']).toBeUndefined();
    expect(written['::changed']).toBeUndefined();
  });

  it('writes NOTHING when a moving tag has drifted from its immutable twin', async () => {
    publish('0.4.0', { base: digest('a'), claude: digest('b') });
    state.tags.set('claude', digest('f'));
    const written: Record<string, string> = {};
    expect(await main(argv(['--write']), io(files(), written))).toBe(1);
    expect(written['README.md']).toBeUndefined();
  });

  it('writes NOTHING when a digest is unchanged since the previous release', async () => {
    // Reproduced through the real README: 0.3.0's own claude digest, republished
    // under 0.4.0, is a variant that did not rebuild.
    const unchanged = 'sha256:9d7222cb3700a96effe39c1f0cc7074df79138ee795b396bafb4bef1d4395f7e';
    publish('0.4.0', { base: digest('a'), claude: unchanged });
    const written: Record<string, string> = {};
    const code = await main(
      argv(['--write']),
      io({ ...files(), 'digests/claude': `${unchanged}\n` }, written),
    );
    expect(code).toBe(1);
    expect(written['README.md']).toBeUndefined();
  });

  it('exits 2 — never 1, and never a write — when the control does not answer', async () => {
    publish('0.4.0', { base: digest('a'), claude: digest('b') });
    const written: Record<string, string> = {};
    const code = await main(
      [
        ...argv(['--write']).filter((a, i, all) => a !== control() && all[i - 1] !== '--control'),
        '--control',
        `${origin}/absent/control:latest`,
      ],
      io(files(), written),
    );
    expect(code).toBe(2);
    expect(written['README.md']).toBeUndefined();
  });

  it('refuses a version that is not a bare x.y.z, rather than writing a heading for it', async () => {
    const written: Record<string, string> = {};
    await expect(
      main(
        argv(['--write']).map((value) => (value === '0.4.0' ? 'cli-v0.4.0' : value)),
        io(files(), written),
      ),
    ).rejects.toThrow(/bare x\.y\.z/);
  });
});

describe('the published names', () => {
  const io = (files: Record<string, string>) => ({
    readdir: () => Promise.resolve([]),
    readFile: (path: string) => Promise.resolve(files[path] ?? ''),
    writeFile: () => Promise.resolve(),
    log: () => {},
    error: () => {},
    setOutput: () => {},
  });

  it('are the base plus every profile in profiles.json, in that order', async () => {
    // Read from the profile table rather than restated, exactly as the workflow
    // matrix is: adding an agent extends the recorded table on its own, and there
    // is no second list to drift. The order is the order the tables already use.
    const real = readFileSync(join(CLI_DIR, 'sandbox', 'smoke', 'profiles.json'), 'utf8');
    expect(await resolveNames(['--profiles', 'p.json'], io({ 'p.json': real }))).toEqual([
      'base',
      'claude',
      'codex',
      'opencode',
      'kimi',
      'antigravity',
      'cursor',
      'aider',
      'goose',
    ]);
  });

  it('refuses a profile table with no profiles in it', async () => {
    await expect(
      resolveNames(['--profiles', 'p.json'], io({ 'p.json': '{"profiles":[]}' })),
    ).rejects.toThrow(/lists no profiles/);
  });

  it('takes an explicit --names list, which is how a human re-records one release', async () => {
    expect(await resolveNames(['--names', 'base,claude'], io({}))).toEqual(['base', 'claude']);
  });
});
