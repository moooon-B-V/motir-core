import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentProfileIds } from '../src/agentProfiles.js';

// Structural guards for the sandbox image (Subtask 7.9.7a). These assert the
// image's CONTRACT — the Node floor, the two mounts and their read-only split,
// the absence of a docker socket, and the per-agent layer seam — from the source
// files, with no docker daemon involved. Building the image, running the loop
// inside it and asserting write-confinement for real is 7.9.7c's smoke matrix
// (MOTIR-885); this suite is what keeps a later edit from quietly widening the
// blast radius between now and then.

const SANDBOX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox');
const read = (name: string): string => readFileSync(join(SANDBOX_DIR, name), 'utf8');

/**
 * Drop whole-line `#` comments. The sandbox files DOCUMENT what they
 * deliberately leave out (a docker socket, extra host binds), so an
 * absence assertion has to read the directives, not the prose.
 */
const directivesOf = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const dockerfile = read('Dockerfile');
const installAgent = read('install-agent.sh');
const entrypoint = read('entrypoint.sh');
const compose = read('docker-compose.yml');
const devcontainerRaw = read(join('devcontainer', 'devcontainer.json'));

describe('sandbox Dockerfile', () => {
  it('bases on the Node line and ASSERTS the >= 24.15 floor rather than trusting the tag', () => {
    expect(dockerfile).toMatch(/^ARG NODE_TAG=24-/m);
    expect(dockerfile).toMatch(/FROM node:\$\{NODE_TAG\}/);
    // The floor is Kimi's, which is the highest across the supported agents.
    expect(dockerfile).toContain('maj < 24 || (maj === 24 && min < 15)');
  });

  it('installs git and gh — both are part of the dispatch contract', () => {
    const aptPackages = dockerfile.slice(
      dockerfile.indexOf('apt-get install'),
      dockerfile.indexOf('rm -rf /var/lib/apt/lists'),
    );
    expect(aptPackages).toMatch(/^\s+git \\$/m);
    expect(aptPackages).toMatch(/install -y --no-install-recommends gh \\$/m);
  });

  it('installs the motir binary and smoke-tests it in the same layer', () => {
    expect(dockerfile).toContain('npm install -g /tmp/motir-cli.tgz');
    // A base that cannot run `motir --version` must fail the BUILD.
    expect(dockerfile).toMatch(/&& motir --version/);
  });

  it('exposes the AGENT selector with a base-only default and routes it through the seam', () => {
    expect(dockerfile).toMatch(/^ARG AGENT=base$/m);
    expect(dockerfile).toContain('install-agent.sh "${AGENT}"');
  });

  it('runs unprivileged and drops into /workspace via the entrypoint', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^WORKDIR \/workspace$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["motir-sandbox-entrypoint"]');
    // HOME is what makes the read-only PAT mount target deterministic.
    expect(dockerfile).toMatch(/^ENV HOME=\/home\/node$/m);
  });
});

describe('the per-agent layer seam', () => {
  it('handles the base default as a no-op', () => {
    expect(installAgent).toMatch(/^\s*base \| none\)/m);
  });

  it('names EVERY agent profile the CLI knows about', () => {
    // Drift guard: adding a profile to AGENT_PROFILES without extending the
    // seam would leave that agent falling through to "unknown AGENT".
    for (const id of agentProfileIds()) {
      expect(installAgent).toContain(id);
    }
  });

  it('refuses an unknown profile instead of building a half-image', () => {
    expect(installAgent).toContain("unknown AGENT '${AGENT}'");
    expect(installAgent).toMatch(/exit 1/);
  });
});

describe('sandbox entrypoint', () => {
  it('drops into /workspace and execs the requested command', () => {
    expect(entrypoint).toContain('cd "$WORKSPACE"');
    expect(entrypoint).toContain('exec "$@"');
  });

  it('fails fast when /workspace is not writable', () => {
    expect(entrypoint).toContain('if [ ! -w "$WORKSPACE" ]');
  });

  it('keeps stdout clean — every message goes to stderr', () => {
    const echoes = entrypoint.match(/^\s*echo .*$/gm) ?? [];
    expect(echoes.length).toBeGreaterThan(0);
    // `motir next --print | pbcopy` must receive the prompt and nothing else.
    for (const line of echoes) expect(line).toMatch(/>&2$/);
  });
});

describe('sandbox mounts and blast radius', () => {
  it('mounts /workspace writable and the PAT config READ-ONLY', () => {
    expect(compose).toContain(':/workspace');
    expect(compose).toContain('${HOME}/.config/motir:/home/node/.config/motir:ro');
  });

  it('builds from the repo root with the base AGENT', () => {
    expect(compose).toContain('context: ../../..');
    expect(compose).toContain('dockerfile: packages/cli/sandbox/Dockerfile');
    expect(compose).toMatch(/profiles: \['base'\]/);
  });

  it('never mounts a docker socket anywhere in the sandbox', () => {
    // A container that can drive the host daemon is not confined at all.
    for (const source of [dockerfile, compose, entrypoint, installAgent]) {
      expect(directivesOf(source)).not.toContain('docker.sock');
    }
    expect(devcontainerRaw).not.toContain('docker.sock');
  });

  it('binds no host path beyond the workspace and the PAT config', () => {
    const volumes = directivesOf(compose)
      .split('\n')
      .filter((line) => /^\s+- .*:/.test(line))
      .map((line) => line.trim());
    expect(volumes).toEqual([
      '- ${MOTIR_WORKSPACE:-../../../..}:/workspace',
      '- ${HOME}/.config/motir:/home/node/.config/motir:ro',
    ]);
  });
});

describe('devcontainer variant', () => {
  const devcontainer = JSON.parse(devcontainerRaw) as {
    build: { args: Record<string, string>; dockerfile: string };
    workspaceFolder: string;
    mounts: string[];
    remoteUser: string;
  };

  it('is strict JSON and opens the same /workspace folder as the plain image', () => {
    expect(devcontainer.workspaceFolder).toBe('/workspace');
    expect(devcontainer.remoteUser).toBe('node');
  });

  it('carries the same AGENT selector', () => {
    expect(devcontainer.build.dockerfile).toBe('../Dockerfile');
    expect(devcontainer.build.args['AGENT']).toBe('base');
  });

  it('mounts the PAT config read-only', () => {
    const configMount = devcontainer.mounts.find((m) => m.includes('.config/motir'));
    expect(configMount).toBeDefined();
    expect(configMount).toContain('readonly');
  });
});
