import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentProfileIds, codegraphWiredProfiles, AGENT_PROFILES } from '../src/agentProfiles.js';

// Structural guards for the sandbox image (base: 7.9.7a, agent profiles:
// 7.9.7b). These assert the image's CONTRACT — the Node floor, the mounts and
// their read-only split, the absence of a docker socket, and the per-agent
// profile matrix — from the source files, with no docker daemon involved.
// Building the image, running the loop inside it and asserting write-
// confinement for real is 7.9.7c's smoke matrix (MOTIR-885); this suite is what
// keeps a later edit from quietly widening the blast radius between now and
// then, and from letting the three per-agent surfaces (install layer, compose
// service, devcontainer) drift apart.

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
const readme = read('README.md');
const devcontainerRaw = read(join('devcontainer', 'devcontainer.json'));

const PROFILE_IDS = agentProfileIds();

/**
 * Split the compose file into its top-level service blocks. A dependency-free
 * split is enough (and keeps this suite runnable with no YAML parser): service
 * keys are the only thing at exactly two spaces of indentation.
 */
// Comments are KEPT here: a profile that deliberately mounts no credential has
// to explain itself in the block, and the volume/socket matchers below ignore
// comment lines anyway.
const composeServices: Record<string, string> = (() => {
  const lines = compose.split('\n');
  const services: Record<string, string> = {};
  let current = '';
  for (const line of lines) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1] ?? '';
      services[current] = '';
      continue;
    }
    if (current && line.trim()) services[current] += `${line}\n`;
  }
  return services;
})();

/** A compose service block by name — asserted present so callers get a string. */
const serviceBlock = (name: string): string => {
  const block = composeServices[name];
  expect(block, `compose service ${name}`).toBeDefined();
  return block ?? '';
};

/** The bind-mount sources of one compose service block, in file order. */
const volumesOf = (block: string): string[] =>
  block
    .split('\n')
    .filter((line) => /^\s+- \S+:\S/.test(line))
    .map((line) => line.trim().replace(/^- /, ''));

/**
 * A profile's case arm in install-agent.sh: everything from its own `<id>)`
 * label up to the next `;;`. Read as an ARM rather than a substring so the
 * "profile is named somewhere in the file" drift guard cannot be satisfied by
 * a comment or by a shared refuse-everything arm.
 */
const armOf = (id: string): string => {
  const start = new RegExp(`^\\s{4}${id}\\)$`, 'm').exec(installAgent);
  if (!start) return '';
  const rest = installAgent.slice(start.index);
  const end = rest.indexOf('\n        ;;');
  return end === -1 ? rest : rest.slice(0, end);
};

/** A profile's row in the README's install matrix. */
const readmeRowOf = (id: string): string =>
  readme.split('\n').find((line) => line.startsWith(`| \`${id}\``)) ?? '';

describe('sandbox Dockerfile', () => {
  it('bases on the Node line and ASSERTS the >= 24.15 floor rather than trusting the tag', () => {
    expect(dockerfile).toMatch(/^ARG NODE_TAG=24-/m);
    expect(dockerfile).toMatch(/FROM node:\$\{NODE_TAG\}/);
    // Headroom over every supported agent's own floor (the highest being Kimi
    // Code's Node >= 22.19).
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

  it('creates the pack destination before packing into it', () => {
    // `npm pack --pack-destination` does NOT create the directory, and the
    // failure is a bare ENOENT on the .tgz that reads like a missing INPUT.
    // Caught by 7.9.7c's build matrix on its first run — until then nothing had
    // ever built this file. The real guard is now that CI build; this one keeps
    // the line from being tidied away as redundant.
    // Anchored on the DIRECTIVE, not the word: the header comment mentions
    // `npm pack` a hundred lines earlier, and matching that would compare the
    // mkdir against a comment and pass or fail for the wrong reason.
    const packAt = dockerfile.indexOf('npm pack --pack-destination /pkg');
    const mkdirAt = dockerfile.indexOf('mkdir -p /pkg');
    expect(packAt).toBeGreaterThan(-1);
    expect(mkdirAt).toBeGreaterThan(-1);
    expect(mkdirAt).toBeLessThan(packAt);
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

  it('gives EVERY agent profile the CLI knows about its own install arm', () => {
    // Drift guard: adding a profile to AGENT_PROFILES without extending the
    // seam would leave that agent falling through to "unknown AGENT".
    for (const id of PROFILE_IDS) {
      expect(armOf(id), `install arm for ${id}`).not.toBe('');
    }
  });

  it('installs each agent from a real source instead of claiming one it lacks', () => {
    // The 7.9.7a placeholder REFUSED a known profile rather than half-building
    // it. Now every arm must actually fetch something — an arm that only echoes
    // would produce an image advertising an agent that is not in it.
    for (const id of PROFILE_IDS) {
      expect(armOf(id), `install source for ${id}`).toMatch(/npm_agent |curl |pip install/);
    }
  });

  it('smoke-tests the binary it installed, so a broken profile fails the BUILD', () => {
    // Same rule the base applies to `motir --version`: a profile that cannot
    // execute its agent must fail here, not inside an unattended run.
    for (const id of PROFILE_IDS) {
      expect(armOf(id), `version check for ${id}`).toMatch(/^\s+\S+ --version$/m);
    }
  });

  it('installs onto the global PATH — the layer runs as root, before USER node', () => {
    // An installer left to its own default would drop the agent in /root,
    // invisible to the unprivileged user that actually runs it.
    for (const id of PROFILE_IDS) {
      const arm = armOf(id);
      if (!arm.includes('curl ')) continue;
      expect(arm, `global install for ${id}`).toMatch(/AGENT_PREFIX/);
    }
    expect(installAgent).toContain('AGENT_PREFIX=/usr/local/bin');
  });

  it('ships NO Gemini CLI profile — Antigravity replaces the retired tool', () => {
    // Asserted as the absence of a PROFILE, not of the word: the README names
    // Gemini precisely to say it is deliberately not shipped.
    expect(PROFILE_IDS).toContain('antigravity');
    expect(PROFILE_IDS).not.toContain('gemini');
    expect(armOf('gemini')).toBe('');
    expect(directivesOf(compose)).not.toContain('AGENT: gemini');
    expect(existsSync(join(SANDBOX_DIR, 'devcontainer', 'gemini'))).toBe(false);
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

  it('binds no host path beyond the workspace, the PAT config and the agent credential', () => {
    // Scoped PER SERVICE rather than over the whole file: every service must
    // carry the two base mounts FIRST, and anything it adds beyond them has to
    // be a read-only agent credential path — never a second writable host bind.
    for (const [name, block] of Object.entries(composeServices)) {
      const volumes = volumesOf(block);
      expect(volumes.slice(0, 2), `${name} base mounts`).toEqual([
        '${MOTIR_WORKSPACE:-../../../..}:/workspace',
        '${HOME}/.config/motir:/home/node/.config/motir:ro',
      ]);
      for (const extra of volumes.slice(2)) {
        expect(extra, `${name} extra mount`).toMatch(/^\$\{HOME\}\/.+:ro$/);
      }
    }
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

// ── The per-agent profile matrix (Subtask 7.9.7b) ───────────────────────────
// Every profile the CLI knows about must be RUNNABLE, not just installable:
// a compose service and a devcontainer that select it and mount its credential,
// plus a README row a human can act on. These guards are what keep the three
// surfaces from drifting apart as agents are added.

// ── CodeGraph in the sandbox (Subtask 7.9.7d / MOTIR-1513) ──────────────────
// The coding agent's OWN navigation graph: the binary in the base image, the
// MCP server wired per agent at build time, and the entrypoint that indexes the
// mount and keeps the graph fresh through git hooks. These guards assert the
// contract from the sources; actually building the image and querying the graph
// in-container is 7.9.7c's smoke matrix (MOTIR-885).

describe('codegraph in the base image', () => {
  it('installs the engine the 7.5.3 spike selected and smoke-tests it in the same layer', () => {
    expect(dockerfile).toContain('npm install -g --no-fund --no-audit @colbymchenry/codegraph');
    // Same rule the base applies to `motir --version`: an image that cannot run
    // the binary must fail the BUILD, not the first unattended run.
    expect(dockerfile).toMatch(/&& codegraph --version/);
  });

  it('disables telemetry by ENV as well as by the persisted setting', () => {
    // The env var is the one that actually holds in an unattended run: it
    // survives a home directory replaced by a bind mount, which the persisted
    // `telemetry off` state file does not.
    expect(dockerfile).toMatch(/^ENV CODEGRAPH_TELEMETRY=0$/m);
    expect(dockerfile).toContain('codegraph telemetry off');
  });

  it('installs codegraph BEFORE the per-agent seam, which wires MCP with it', () => {
    // Ordering is load-bearing twice over: install-agent.sh calls the codegraph
    // binary, and an agent-independent layer stays cached across all eight
    // profile builds.
    const codegraphLayer = dockerfile.indexOf('@colbymchenry/codegraph');
    const agentSeam = dockerfile.indexOf('install-agent.sh "${AGENT}"');
    expect(codegraphLayer).toBeGreaterThan(-1);
    expect(agentSeam).toBeGreaterThan(codegraphLayer);
  });

  it('chowns the whole runtime home, which the root-run seam writes MCP config into', () => {
    // `codegraph install` writes ~/.claude.json, ~/.codex/config.toml, … as
    // ROOT. Left root-owned, an agent that rewrites its own config at startup
    // fails on a home it cannot write.
    expect(dockerfile).toContain('chown -R node:node /workspace /home/node');
  });
});

describe('the per-agent codegraph MCP wiring', () => {
  // codegraph's OWN accepted target ids, read off `codegraph install
  // --print-config <id>` against the shipped version — NOT the profile ids, and
  // not assumable: three of the eight sandbox profiles have no target at all.
  const CODEGRAPH_TARGETS = [
    'claude',
    'cursor',
    'codex',
    'opencode',
    'hermes',
    'gemini',
    'antigravity',
    'kiro',
  ];

  it('claims a target only from the set codegraph actually accepts', () => {
    // The mistake this blocks is the #124 shape: carrying an assumed capability
    // list for a third-party tool instead of the one it reports. A near-miss id
    // ("claude-code", "codex-cli") is rejected by codegraph at build time, so a
    // wrong entry here would fail every image build for that profile.
    for (const { id, target } of codegraphWiredProfiles()) {
      expect(CODEGRAPH_TARGETS, `codegraph target for ${id}`).toContain(target);
    }
  });

  it('wires every profile that HAS a target, inside that profile own arm', () => {
    const wired = codegraphWiredProfiles();
    // Five of the eight: claude, codex, opencode, antigravity, cursor.
    expect(wired.map((p) => p.id).sort()).toEqual([
      'antigravity',
      'claude',
      'codex',
      'cursor',
      'opencode',
    ]);
    for (const { id, target } of wired) {
      expect(armOf(id), `codegraph wiring for ${id}`).toContain(`wire_codegraph ${target}`);
    }
  });

  it('leaves a profile codegraph has NO target for explicitly unwired', () => {
    // Same "UNKNOWN rather than guessed" rule the profile table applies to
    // credential paths: pointing kimi/aider/goose at a near-miss id would claim
    // a wiring the image does not have.
    const unwired = AGENT_PROFILES.filter((p) => p.codegraphTarget === null).map((p) => p.id);
    expect(unwired.sort()).toEqual(['aider', 'goose', 'kimi']);
    for (const id of unwired) {
      expect(armOf(id), `${id} must record that it has no wiring`).toContain('no_codegraph');
      expect(armOf(id), `${id} must not claim a wiring`).not.toContain('wire_codegraph');
    }
  });

  it('installs the wiring into the RUNTIME home, not the root that runs the layer', () => {
    // The same trap invariant 1 describes for binaries, one directory up: the
    // seam runs as root, so an install left to $HOME lands in /root, invisible
    // to the `node` user that runs the agent.
    expect(installAgent).toContain('RUNTIME_HOME=/home/node');
    expect(installAgent).toMatch(/HOME="\$RUNTIME_HOME" codegraph install/);
  });

  it('installs non-interactively WITH the auto-allow list, so an unattended agent can call the tools', () => {
    // `--yes` is what turns the auto-allow permissions on; without it the agent
    // has the server but stops to ask before every call — useless unattended.
    // `--no-permissions` would defeat exactly that, so it must not appear.
    expect(installAgent).toContain('--location global --yes');
    expect(installAgent).not.toContain('--no-permissions');
  });

  it('records the resolved target in ONE place for the entrypoint to re-read', () => {
    // The profile -> target map lives in the case arms and nowhere else; a
    // second copy in the entrypoint could drift out of agreement with the arm
    // that actually did the install.
    expect(installAgent).toContain(
      'CODEGRAPH_TARGET_FILE=/usr/local/lib/motir-sandbox/codegraph-target',
    );
    expect(entrypoint).toContain(
      'CODEGRAPH_TARGET_FILE=/usr/local/lib/motir-sandbox/codegraph-target',
    );
  });
});

describe('the entrypoint codegraph step', () => {
  it('indexes the mounted workspace on start, and re-syncs an already-indexed one', () => {
    expect(entrypoint).toMatch(/codegraph init "\$WORKSPACE"/);
    expect(entrypoint).toMatch(/codegraph sync --quiet "\$WORKSPACE"/);
  });

  it('installs BOTH the post-merge and post-checkout sync hooks', () => {
    expect(entrypoint).toMatch(/for hook in post-merge post-checkout; do/);
    expect(entrypoint).toContain('chmod +x "$hooks/$hook"');
  });

  it('never clobbers a hook the user already wrote', () => {
    // .git/hooks is untracked and lives in the HOST repo, so overwriting one
    // would silently destroy the user's own tooling.
    expect(entrypoint).toContain('CODEGRAPH_HOOK_MARKER=');
    expect(entrypoint).toMatch(/grep -qF "\$CODEGRAPH_HOOK_MARKER"/);
  });

  it('follows core.hooksPath, so the hook is not decoration in a redirected repo', () => {
    expect(entrypoint).toContain('core.hooksPath');
  });

  it('writes a hook that is a silent no-op without codegraph and NEVER fails a merge', () => {
    // The hook OUTLIVES the container inside the host repo, where codegraph
    // usually is not installed. It must not error on every merge, and a sync
    // failure must never block one.
    expect(entrypoint).toContain('command -v codegraph >/dev/null 2>&1 || exit 0');
    expect(entrypoint).toMatch(/codegraph sync --quiet "\\\$dir" >\/dev\/null 2>&1 \|\| true/);
  });

  it('treats the graph as an ENHANCEMENT — no codegraph failure aborts the run', () => {
    // `set -e` is on, so every call needs an explicit guard; an unindexable
    // workspace must still dispatch work.
    const block = entrypoint.slice(entrypoint.indexOf('── CodeGraph'));
    expect(block).toMatch(/codegraph init "\$WORKSPACE" >&2 \|\|/);
    expect(block).toMatch(/codegraph sync --quiet "\$WORKSPACE" >&2 \|\|/);
  });

  it('keeps codegraph output OFF stdout, which belongs to the prompt alone', () => {
    // The echo-only guard above cannot see a SUBPROCESS writing stdout, and
    // `codegraph init` is chatty.
    expect(entrypoint).toMatch(/codegraph init "\$WORKSPACE" >&2/);
    expect(entrypoint).not.toMatch(/^\s*codegraph (init|sync)[^|]*$/m);
  });

  it('says so out loud when a read-only mount masks the wiring, instead of failing silently', () => {
    // A credential dir mounted :ro (compose does this for ~/.codex and
    // ~/.config/opencode) shadows the config the build wrote — the agent would
    // otherwise just quietly have no code-graph tools.
    expect(entrypoint).toContain('could not refresh the codegraph MCP wiring');
    expect(entrypoint).toContain('READ-ONLY');
  });

  it('can be skipped entirely for a print-only or smoke-test run', () => {
    expect(entrypoint).toMatch(/\$\{MOTIR_SANDBOX_CODEGRAPH:-1\}/);
  });
});

describe.each(PROFILE_IDS)('agent profile: %s', (id) => {
  const service = serviceBlock(`sandbox-${id}`);

  it('has a compose service selecting its AGENT behind its own compose profile', () => {
    expect(service).toContain(`profiles: ['${id}']`);
    expect(service).toContain(`AGENT: ${id}`);
    expect(service).toContain('dockerfile: packages/cli/sandbox/Dockerfile');
  });

  it('mounts its own credential path READ-ONLY, or documents why it cannot', () => {
    const credentialMounts = volumesOf(service).slice(2);
    if (credentialMounts.length === 0) {
      // The honest case: no vendor-documented portable credential path (the
      // agent uses the OS keyring). Guessing one would make docker create an
      // empty root-owned directory on the host — so the profile must SAY so
      // rather than mount a path nobody documented.
      expect(service, `${id} has no credential mount and must explain that`).toMatch(
        /No agent credential mount/,
      );
      return;
    }
    for (const mount of credentialMounts) {
      expect(mount, `${id} credential mount`).toMatch(/:ro$/);
      // It must be the AGENT's path, not a second copy of the Motir PAT.
      expect(mount).not.toContain('/.config/motir');
    }
  });

  it('has a devcontainer variant carrying the same selector and mounts', () => {
    const path = join(SANDBOX_DIR, 'devcontainer', id, 'devcontainer.json');
    expect(existsSync(path), `devcontainer for ${id}`).toBe(true);
    const variant = JSON.parse(readFileSync(path, 'utf8')) as {
      build: { args: Record<string, string>; dockerfile: string; context: string };
      workspaceFolder: string;
      mounts: string[];
      remoteUser: string;
    };
    expect(variant.build.args['AGENT']).toBe(id);
    expect(variant.workspaceFolder).toBe('/workspace');
    expect(variant.remoteUser).toBe('node');
    // A nested variant sits one directory deeper than the base one.
    expect(variant.build.dockerfile).toBe('../../Dockerfile');
    // Every mount is read-only, PAT included — the workspace comes in through
    // workspaceMount, so nothing here should ever be writable.
    expect(variant.mounts.some((m) => m.includes('.config/motir'))).toBe(true);
    for (const mount of variant.mounts) expect(mount).toContain('readonly');
    // Same credential paths as the compose service, so the two forms cannot
    // drift into disagreeing about where an agent keeps its credential.
    const composeTargets = volumesOf(service)
      .slice(2)
      .map((mount) => mount.split(':')[1]);
    for (const target of composeTargets) {
      expect(variant.mounts.some((m) => m.includes(`target=${target}`))).toBe(true);
    }
  });

  it('is documented in the README with an install source and a credential column', () => {
    const row = readmeRowOf(id);
    expect(row, `README matrix row for ${id}`).not.toBe('');
    // Tier, install source, binary, credential — a row that lost a column would
    // leave the reader without the thing the profile is selected by.
    expect(row.split('|').filter((cell) => cell.trim()).length).toBeGreaterThanOrEqual(5);
  });

  it('documents a VERIFIED auto-approve mechanism for unattended runs', () => {
    // These flags drift release-to-release, which is why they are documented
    // per agent rather than assumed — a profile with no documented unattended
    // path cannot be used by `motir auto` at all.
    const flagRows = readme
      .split('\n')
      .filter((line) => line.startsWith(`| \`${id}\``))
      .filter((line) => /--|GOOSE_MODE|auto/.test(line));
    expect(flagRows.length, `auto-approve row for ${id}`).toBeGreaterThanOrEqual(1);
  });

  it('has no docker socket anywhere in its variant', () => {
    const variantRaw = readFileSync(
      join(SANDBOX_DIR, 'devcontainer', id, 'devcontainer.json'),
      'utf8',
    );
    expect(variantRaw).not.toContain('docker.sock');
    expect(directivesOf(service)).not.toContain('docker.sock');
  });
});
