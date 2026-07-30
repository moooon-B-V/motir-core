import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Drift guards for the npm RELEASE lane of `@motir/cli` (8.7.9 / MOTIR-669):
// the publish metadata in package.json, and the `release-cli.yml` workflow that
// consumes it.
//
// The lane itself can only run for real by minting a version, so — like
// `sandboxCi.test.ts` does for the image lane — the expensive lane checks the
// ARTIFACT and this suite checks that the lane is still WIRED: the tag
// namespace, the auth wiring, the publish gates, and the tarball's contents.
//
// The tag-vs-version guard is the exception: its `run:` block is deliberately
// free of `${{ }}` interpolation, so this file EXECUTES it against a fake
// GITHUB_REF_NAME and proves it exits non-zero on a mismatch, rather than
// asserting that the YAML looks like it would.

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(CLI_DIR, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

const read = (path: string): string => readFileSync(path, 'utf8');

const release = read(join(WORKFLOW_DIR, 'release-cli.yml'));
const sandboxRelease = read(join(WORKFLOW_DIR, 'release-sandbox.yml'));
const pkg = JSON.parse(read(join(CLI_DIR, 'package.json'))) as {
  name: string;
  version: string;
  repository?: { type: string; url: string; directory?: string };
  homepage?: string;
  bugs?: { url: string };
  bin: Record<string, string>;
  exports?: Record<string, string>;
  files: string[];
  publishConfig?: { access?: string; provenance?: boolean };
  engines: { node: string };
};
const cliReadme = read(join(CLI_DIR, 'README.md'));
const cliDoc = read(join(REPO_ROOT, 'docs', 'cli.md'));

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The shell body of a workflow step, by its `- name:`. Only sound because the
 * release steps use `run: |` block scalars at a fixed indent; it stops at the
 * first line that dedents out of the block.
 */
const runBlockOf = (workflow: string, stepName: string): string => {
  const start = workflow.indexOf(`- name: ${stepName}`);
  expect(start, `step "${stepName}" exists`).toBeGreaterThan(-1);
  const lines = workflow.slice(start).split('\n');
  const runAt = lines.findIndex((line) => line.trim() === 'run: |');
  expect(runAt, `step "${stepName}" has a run block`).toBeGreaterThan(-1);
  const rest = lines.slice(runAt + 1);
  const first = rest[0] ?? '';
  const indent = indentOf(first);
  const body: string[] = [];
  for (const line of rest) {
    if (line.trim() !== '' && indentOf(line) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
};

describe('the @motir/cli publish metadata', () => {
  it('points repository / homepage / bugs at the RENAMED repo', () => {
    // The 0.0.1 name-claim on npm still advertises `moooon-B-V/prodect-core`,
    // which 404s since the MOTIR-668 rename. The registry is not evidence these
    // fields are right — this is.
    expect(pkg.repository?.url).toBe('git+https://github.com/moooon-B-V/motir-core.git');
    expect(pkg.repository?.directory).toBe('packages/cli');
    expect(pkg.homepage).toBe('https://motir.co');
    expect(pkg.bugs?.url).toBe('https://github.com/moooon-B-V/motir-core/issues');
    for (const field of [pkg.repository?.url, pkg.bugs?.url]) {
      expect(field, 'no pre-rename prodect-core URL survives').not.toContain('prodect-core');
    }
  });

  it('publishes publicly, with provenance, from any lane that runs npm publish', () => {
    // `provenance: true` in publishConfig is belt to the workflow's
    // `--provenance` braces: it also makes a hand-run `npm publish` from a
    // laptop FAIL (provenance needs a supported CI), which is the point — after
    // the 0.0.1 bootstrap, releases go through the workflow or not at all.
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.publishConfig?.provenance).toBe(true);
  });

  it('exposes only BUILT artifacts — no path into src/ or the test tree', () => {
    // Bin-only package: the public surface is the `motir` command, not an
    // importable module (dist/index.js parses argv and calls process.exit the
    // moment it loads, so exporting "." would be a trap). The map therefore
    // exposes package.json alone, which blocks every deep import.
    expect(pkg.exports).toEqual({ './package.json': './package.json' });
    expect(pkg.bin).toEqual({ motir: './dist/index.js' });
    expect(pkg.files).toEqual(['dist']);
    for (const target of Object.values(pkg.exports ?? {})) {
      expect(target.startsWith('./dist/') || target === './package.json').toBe(true);
    }
  });

  it('ships a tarball of dist/ + package.json + README, and nothing stray', () => {
    // The real `npm pack` file list, not a reading of `files`: an .npmignore, a
    // stray root-level asset or a `files` edit would all show up here first.
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: CLI_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const paths = (packed[0]?.files ?? []).map((f) => f.path);

    for (const path of paths) {
      expect(
        path === 'package.json' || path === 'README.md' || path.startsWith('dist/'),
        `unexpected file in the tarball: ${path}`,
      ).toBe(true);
    }
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    // The build is a prerequisite of the publish, not of this suite — CI's `CLI
    // package` job builds before it tests, but a bare local run may not have.
    if (existsSync(join(CLI_DIR, 'dist', 'index.js'))) {
      expect(paths).toContain('dist/index.js');
    }
  });
});

describe('the release lane that publishes the package (8.7.9)', () => {
  it('is TAG-triggered on cli-v* + workflow_dispatch — never a push to main', () => {
    expect(release).toMatch(/^on:\n\s+push:\n\s+tags:\n\s+- 'cli-v\*'/m);
    expect(release).toMatch(/^\s+workflow_dispatch:$/m);
    // The ABSENCE of a branch trigger is the load-bearing assertion: a lane that
    // fired on merge would publish an unversioned package on every commit.
    expect(release).not.toMatch(/^\s+branches:/m);
  });

  it('shares the ONE cli-v* namespace with the sandbox image lane', () => {
    // Same tag, two lanes, by design (MOTIR-1788): the binary on npm and the one
    // baked into the images are the same version by construction. A second
    // namespace here would silently decouple them.
    const tagsOf = (workflow: string) =>
      /on:\n\s+push:\n\s+tags:\n\s+- '([^']+)'/.exec(workflow)?.[1];
    expect(tagsOf(release)).toBe('cli-v*');
    expect(tagsOf(sandboxRelease)).toBe('cli-v*');
  });

  it('targets THIS package — not the app and not the design system', () => {
    expect(release).toContain("PACKAGE: '@motir/cli'");
    expect(release).toContain('PKG_DIR: packages/cli');
    // Comments are exempt — the header explains that this file is the
    // `release-design-system.yml` copy, and names it. Only lines the runner
    // would actually execute have to be free of the other package.
    const yamlOnly = release
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(yamlOnly).not.toContain('design-system');
  });

  it('authenticates with NPM_TOKEN and attests provenance', () => {
    // `registry-url` is what writes the .npmrc that maps NODE_AUTH_TOKEN onto
    // the registry — without it the publish authenticates as nobody, and npm's
    // 404-not-401 failure mode makes that a confusing half-hour.
    expect(release).toContain("registry-url: 'https://registry.npmjs.org'");
    expect(release).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(release).toContain('id-token: write');
    expect(release).toContain('npm publish --access public --provenance');
    // No OTHER secret: any second credential would be one more thing to
    // provision and rotate out of band.
    const secrets = [...release.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(secrets)]).toEqual(['NPM_TOKEN']);
  });

  it('skips the publish on a dry run AND on an already-published version', () => {
    // Two independent gates on one `if:`. The dry run is how the lane is
    // rehearsed without minting a version; the idempotency check is what makes
    // re-running a tag (to recover the sandbox half) safe.
    const publishIf = release.slice(release.indexOf('- name: Publish to npm'));
    expect(publishIf).toContain("steps.published.outputs.already == 'false'");
    expect(publishIf).toContain("!(github.event_name == 'workflow_dispatch' && inputs.dry_run)");
    expect(release).toContain('npm view "${PACKAGE}@${{ steps.ver.outputs.pkg_version }}" version');
  });

  it('builds, tests and packs BEFORE it publishes — order, not just presence', () => {
    // A publish that outran the test lane would ship a red build; a publish
    // before the pack would ship a tarball nobody looked at.
    const build = release.indexOf('- name: Build the package');
    const test = release.indexOf('- name: Test the package');
    const pack = release.indexOf('- name: Pack the tarball');
    const publish = release.indexOf('- name: Publish to npm');
    expect(build).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(build);
    expect(pack).toBeGreaterThan(test);
    expect(publish).toBeGreaterThan(pack);
    // The same lane ci.yml gates pull requests with, coverage gate included.
    expect(release).toContain('test:coverage');
  });
});

describe('the tag-vs-version guard (executed, not asserted)', () => {
  const guard = runBlockOf(release, 'Guard — tag version must equal package version');
  const runGuard = (ref: string): { code: number; output: string } => {
    try {
      const output = execFileSync('bash', ['-c', guard], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REF_NAME: ref },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, output };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { code: e.status, output: `${e.stdout}${e.stderr}` };
    }
  };

  it('PASSES when the tag matches packages/cli/package.json', () => {
    const { code, output } = runGuard(`cli-v${pkg.version}`);
    expect(code).toBe(0);
    expect(output).toContain(pkg.version);
  });

  it('FAILS, loudly, when the tag implies a different version', () => {
    const { code, output } = runGuard('cli-v9.99.99');
    expect(code).toBe(1);
    expect(output).toContain('::error::');
    expect(output).toContain('9.99.99');
    expect(output).toContain(pkg.version);
  });

  it('strips the cli-v prefix, not a bare v — a `v0.1.0` tag is a mismatch', () => {
    // The prefix is what scopes the tag to this package in a monorepo. If the
    // strip were `#v`, a bare `v0.1.0` would compare equal and publish off a tag
    // that also means "the app".
    expect(guard).toContain('${GITHUB_REF_NAME#cli-v}');
    expect(runGuard(`v${pkg.version}`).code).toBe(1);
  });
});

describe('the install docs, now that the package is publishable', () => {
  const installedDocs: Array<[string, string]> = [
    ['docs/cli.md', cliDoc],
    ['packages/cli/README.md', cliReadme],
  ];

  it.each(installedDocs)('%s leads with the npm install path', (_name, doc) => {
    expect(doc).toContain('npm install -g @motir/cli');
  });

  it.each(installedDocs)('%s no longer claims the package is unpublished', (_name, doc) => {
    for (const stale of [
      'not on npm yet',
      'is not published to npm',
      'Epic-8 work',
      'gated on securing',
      'alias motir=',
    ]) {
      expect(doc, `stale install claim: "${stale}"`).not.toContain(stale);
    }
  });

  it.each(installedDocs)('%s keeps the contributor build path, labelled', (_name, doc) => {
    expect(doc).toContain('pnpm --filter @motir/cli build');
    expect(doc).toContain('For contributors');
  });

  it.each(installedDocs)('%s states the same Node floor as package.json', (_name, doc) => {
    expect(pkg.engines.node).toBe('>=22');
    expect(doc).toMatch(/Node ≥ 22/);
  });
});
