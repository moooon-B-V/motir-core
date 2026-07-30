import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agentProfileIds,
  codegraphWiredProfiles,
  sandboxAgentConfigHome,
  AGENT_PROFILES,
  type AgentProfile,
} from '../src/agentProfiles.js';

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
 * The `environment:` keys of one compose service block. Read as `KEY: value`
 * lines under that key so a variable named only in a COMMENT cannot satisfy the
 * pass-through assertion.
 */
const environmentOf = (block: string): string[] => {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => /^\s{4}environment:\s*$/.test(line));
  if (start === -1) return [];
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{4}\S/.test(line)) break; // the next service-level key
    const entry = /^\s{6}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (entry?.[1]) keys.push(entry[1]);
  }
  return keys;
};

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

/**
 * That row's cells: profile, tier, installed-from, binary, credential mount.
 * Split on unescaped pipes only — an install command may contain a `\|`.
 */
const readmeMatrixCells = (id: string): string[] =>
  readmeRowOf(id)
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());

/** The dirs the profile table's credential paths are resolved against here. */
const TEST_DIRS = {
  home: '/home/tester',
  xdgConfigHome: '/home/tester/.config',
  xdgDataHome: '/home/tester/.local/share',
};

/** A profile by id — asserted present so callers get a profile, not undefined. */
const profileOf = (id: string): AgentProfile => {
  const profile = AGENT_PROFILES.find((p) => p.id === id);
  expect(profile, `profile ${id}`).toBeDefined();
  return profile as AgentProfile;
};

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

// ── The credential story: three tiers, one of which needs no mount (MOTIR-1877)
// The sandbox used to have exactly ONE way in — a credential mounted read-only
// from a host that had already run a login — which left a fresh machine, a CI
// runner and anyone running a published image with no path at all. These guards
// pin the three tiers across every surface that has to agree about them: the
// entrypoint's message, compose, the devcontainers and the README.

describe('the credential tiers', () => {
  const CREDENTIAL_ENV = ['MOTIR_TOKEN', 'MOTIR_SERVER'];

  it('passes the env tier through on EVERY compose service, not just the base one', () => {
    // A profile that forgot them would work on the maintainer's laptop (where
    // the mount is populated) and fail on every machine that has no host login —
    // the exact split the env tier exists to close.
    for (const [name, block] of Object.entries(composeServices)) {
      const env = environmentOf(block);
      for (const key of CREDENTIAL_ENV) {
        expect(env, `compose service ${name} must pass ${key} through`).toContain(key);
      }
    }
  });

  it('names ALL THREE ways in when no credential is present', () => {
    // The old message named one (mount it from the host), which is correct only
    // on the machine you already logged in on.
    const block = entrypoint.slice(entrypoint.indexOf('THREE ways a credential gets in here'));
    expect(block, 'the env tier').toContain('-e MOTIR_TOKEN');
    expect(block, 'the in-container login').toMatch(/motir login/);
    expect(block, 'the mount').toContain('$HOME/.config/motir:$CONFIG_DIR:ro');
  });

  it('says nothing at all when MOTIR_TOKEN carries the credential', () => {
    // A warning that fires on a working configuration teaches people to ignore
    // the warnings that matter.
    expect(entrypoint).toContain(
      'if [ -z "${MOTIR_TOKEN:-}" ] && [ ! -f "$CONFIG_DIR/config.json" ]',
    );
  });

  it('tells the truth about `motir login` by TESTING whether the config dir is writable', () => {
    // Under a `:ro` mount the login cannot persist, so offering it flatly would
    // send the reader at a command that must fail. The writability of the
    // nearest existing ancestor is the honest test — the dir itself may not
    // exist yet, in which case the CLI creates it.
    expect(entrypoint).toContain('config_dir_writable() {');
    expect(entrypoint).toMatch(/while \[ ! -e "\$dir" \]/);
    expect(entrypoint).toContain('drop the :ro mount to use it');
  });

  it('carries the mount-free one-liner in the entrypoint header AND the README', () => {
    const header = entrypoint.slice(0, entrypoint.indexOf('set -euo pipefail'));
    expect(header).toContain('-e MOTIR_TOKEN -e MOTIR_SERVER');
    expect(readme).toContain('-e MOTIR_TOKEN -e MOTIR_SERVER');
    // …and the mount is documented as OPTIONAL rather than as the contract.
    expect(readme).toContain('Three ways to give it a Motir credential');
    expect(readme).toMatch(/\*\*Optional\*\*, read-only/);
  });

  it('forwards the env tier into every devcontainer variant too', () => {
    // `remoteEnv` is the devcontainer analogue of compose's `environment:` — a
    // variant without it is the one shape of this image that still demands a
    // host login.
    const variants = [
      'devcontainer.json',
      ...PROFILE_IDS.map((id) => join(id, 'devcontainer.json')),
    ];
    for (const relative of variants) {
      const variant = JSON.parse(
        readFileSync(join(SANDBOX_DIR, 'devcontainer', relative), 'utf8'),
      ) as { remoteEnv?: Record<string, string> };
      for (const key of CREDENTIAL_ENV) {
        expect(variant.remoteEnv?.[key], `${relative} must forward ${key}`).toBe(
          `\${localEnv:${key}}`,
        );
      }
    }
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
    // to the `node` user that runs the agent. Both homes the wiring can target
    // — the runtime home and the image-owned config home a shadowed profile is
    // redirected to — are under /home/node, never root's.
    expect(installAgent).toContain('RUNTIME_HOME=/home/node');
    expect(installAgent).toMatch(/local target="\$1" home="\$\{2:-\$RUNTIME_HOME\}"/);
    expect(installAgent).toMatch(/HOME="\$home" codegraph install/);
    expect(installAgent).toContain(
      'SANDBOX_AGENT_HOME="$RUNTIME_HOME/.motir-sandbox/agent-config"',
    );
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

// ── The read-only mount must never shadow the wiring (7.9.7f + 7.9.7g) ───────
// 7.9.7d wired the codegraph MCP server into each agent at BUILD time, writing
// that agent's own config file. For `codex` and `opencode` (MOTIR-1835) and then
// `claude` (MOTIR-1840) that file landed INSIDE the directory 7.9.7b bind-mounts
// READ-ONLY from the host, so the host's copy shadowed it and those agents saw
// no code-graph tools at all under the recommended compose path. The fix
// redirects all three to a config home the image owns; this guard is what stops
// a future profile reintroducing the shadowing silently — the failure mode is
// invisible at build time and only shows up as an agent that quietly greps
// instead of querying the graph.

describe('codegraph config is never shadowed by a read-only credential mount', () => {
  /** The container-side dirs the sandbox pins (Dockerfile: ENV HOME=/home/node). */
  const CONTAINER_DIRS = {
    home: '/home/node',
    xdgConfigHome: '/home/node/.config',
    xdgDataHome: '/home/node/.local/share',
  };

  /** The container paths a profile's compose service mounts READ-ONLY. */
  const readOnlyMountTargets = (id: string): string[] =>
    volumesOf(serviceBlock(`sandbox-${id}`))
      .filter((mount) => mount.endsWith(':ro'))
      .map((mount) => mount.split(':')[1] ?? '');

  /** Is `path` the mount itself, or anything beneath it? */
  const shadowedBy = (path: string, mounts: string[]): string | null =>
    mounts.find((mount) => path === mount || path.startsWith(`${mount}/`)) ?? null;

  it('gives every profile with a codegraph target a placement, and no other profile one', () => {
    // The two fields answer different questions ("is it wired?" vs "where does
    // the wiring land?"), so a profile carrying one without the other would
    // leave this guard with nothing to check.
    for (const profile of AGENT_PROFILES) {
      expect(
        profile.codegraphConfig !== null,
        `${profile.id}: codegraphConfig must be present iff codegraphTarget is`,
      ).toBe(profile.codegraphTarget !== null);
    }
  });

  it('never lets a profile read its MCP SERVER config from inside its own :ro mount', () => {
    // THE guard. A shadowed server file is the total failure — the agent has no
    // code-graph tools at all, which is exactly what shipped for codex and
    // opencode until 7.9.7f.
    for (const { id } of codegraphWiredProfiles()) {
      const placement = profileOf(id).codegraphConfig;
      expect(placement, `${id} placement`).not.toBeNull();
      const path = placement?.mcpServers(CONTAINER_DIRS) ?? '';
      const mounts = readOnlyMountTargets(id);
      expect(
        shadowedBy(path, mounts),
        `${id}: ${path} is shadowed by the read-only mount it sits inside`,
      ).toBeNull();
    }
  });

  it('declares — never hides — an auto-allow list that IS still inside a mount', () => {
    // The narrower failure: the agent HAS the tools but reads the host's
    // permission list, so an unattended run stops to ask before calling them.
    // It may exist, but only as a tracked, named condition.
    for (const { id } of codegraphWiredProfiles()) {
      const placement = profileOf(id).codegraphConfig;
      const autoAllow = placement?.autoAllow?.(CONTAINER_DIRS);
      const gap = placement?.knownAutoAllowGap ?? null;
      if (autoAllow && shadowedBy(autoAllow, readOnlyMountTargets(id))) {
        expect(gap, `${id}: a shadowed auto-allow list must name its tracking item`).toMatch(
          /^MOTIR-\d+$/,
        );
        continue;
      }
      // Nothing shadowed — a lingering reference would misreport a fixed gap.
      expect(gap, `${id} has no shadowed auto-allow list, so it must claim no gap`).toBeNull();
    }
  });

  it('leaves NO declared gap standing — claude was the last one (7.9.7g)', () => {
    // The stronger form of the guard above: not "every gap is declared" but
    // "there is nothing left to declare". Until 7.9.7g claude carried
    // MOTIR-1840 here, which is the whole reason the field exists.
    const declared = AGENT_PROFILES.filter((p) => p.codegraphConfig?.knownAutoAllowGap).map(
      (p) => p.id,
    );
    expect(declared).toEqual([]);
  });

  it('redirects exactly the profiles that would otherwise be shadowed, and exports the env var', () => {
    // A redirect that the entrypoint does not actually export is decoration;
    // claude, codex and opencode are the three the mount contract shadows.
    const redirected = codegraphWiredProfiles()
      .filter(({ id }) => profileOf(id).codegraphConfig?.redirect)
      .map(({ id }) => id);
    expect(redirected.sort()).toEqual(['claude', 'codex', 'opencode']);
    for (const id of redirected) {
      const env = profileOf(id).codegraphConfig?.redirect?.env ?? '';
      expect(entrypoint, `${id}: entrypoint must export ${env}`).toMatch(
        new RegExp(`export ${env}=`),
      );
    }
  });

  it('keeps the image-owned config home identical across the table and both shell files', () => {
    // Three copies of one path is a drift risk; the profile table computes the
    // paths this suite checks, so a shell file that moved would let the guard
    // pass against a location the image no longer uses.
    const home = sandboxAgentConfigHome(CONTAINER_DIRS.home);
    expect(home).toBe('/home/node/.motir-sandbox/agent-config');
    expect(installAgent).toContain('.motir-sandbox/agent-config');
    expect(entrypoint).toContain('SANDBOX_AGENT_HOME="$HOME/.motir-sandbox/agent-config"');
    // It must sit outside every profile's mounts, not just the two redirected
    // ones — that is the property that makes it a safe destination at all.
    for (const id of PROFILE_IDS) {
      expect(shadowedBy(home, readOnlyMountTargets(id)), `${id} must not mount over ${home}`).toBe(
        null,
      );
    }
  });

  it('seeds the redirected codex home from the mount, so the credential survives', () => {
    // CODEX_HOME governs auth.json as well as config.toml, so a bare redirect
    // would trade "no code-graph tools" for "not signed in" — a worse bug.
    const block = entrypoint.slice(entrypoint.indexOf('redirect_codegraph_config() {'));
    expect(block).toContain('cp -a "$mounted/." "$private/"');
    expect(block).toMatch(/export CODEX_HOME=/);
  });

  it('seeds the redirected claude dir too — CLAUDE_CONFIG_DIR governs the credential', () => {
    // Same trap as codex, one profile over: CLAUDE_CONFIG_DIR moves
    // .credentials.json along with the settings and the state file, so a bare
    // redirect would sign the agent out.
    const block = entrypoint.slice(entrypoint.indexOf('redirect_codegraph_config() {'));
    expect(block).toMatch(/local mounted="\$HOME\/\.claude"/);
    expect(block).toMatch(/export CLAUDE_CONFIG_DIR=/);
    expect(block).toContain('cp -a "$mounted/$entry" "$private/"');
  });

  it('seeds only the claude CONFIG surface, never the session archives', () => {
    // ~/.claude is ~850 MB on a working machine and all but ~50 MB of it is
    // per-machine session state the container regenerates. A blanket `cp -a`
    // here would tax every container start to copy transcripts nothing reads.
    const seeded = (/^CLAUDE_SEED_ENTRIES='([^']*)'/m.exec(entrypoint)?.[1] ?? '').split(' ');
    expect(seeded).toContain('.credentials.json'); // the credential itself
    expect(seeded).toContain('.claude.json'); // the state file the lift targets
    expect(seeded).toContain('settings.json'); // where the auto-allow list lands
    expect(seeded).toContain('CLAUDE.md');
    for (const bulk of ['projects', 'file-history', 'history.jsonl', 'shell-snapshots']) {
      expect(seeded, `${bulk} is session state, not config`).not.toContain(bulk);
    }
  });

  it('lifts the one file codegraph and Claude Code disagree about, MERGING not replacing', () => {
    // codegraph writes the claude server stanza to <HOME>/.claude.json; the
    // shipped CLI reads <CLAUDE_CONFIG_DIR>/.claude.json and ignores the legacy
    // sibling entirely. The seeded target holds the user's OWN servers plus the
    // rest of Claude Code's state, so the lift merges a single key into it.
    const block = entrypoint.slice(entrypoint.indexOf('reconcile_codegraph_config() {'));
    expect(block).toMatch(/\[ "\$1" = claude \] \|\| return 0/); // claude-only
    expect(block).toContain('state.mcpServers = { ...(state.mcpServers || {}), ...servers };');
    expect(block).toContain('"$CLAUDE_CONFIG_DIR/.claude.json"');
    // Running it is part of the install step, not a function nobody calls.
    expect(entrypoint).toContain('elif ! reconcile_codegraph_config "$codegraph_target"; then');
  });

  it('wires claude into the image-owned home, where the redirected config dir looks', () => {
    // Two of codegraph's three claude outputs land under <HOME>/.claude, which
    // IS the redirected config dir — so installing under $SANDBOX_AGENT_HOME is
    // what puts settings.json and CLAUDE.md where the agent reads them.
    expect(armOf('claude')).toContain('wire_codegraph claude "$SANDBOX_AGENT_HOME"');
  });

  it('returns the install home through a global, not a subshell capture', () => {
    // `codegraph_home=$(redirect …)` would run the function in a SUBSHELL,
    // where the exported CODEX_HOME / OPENCODE_CONFIG die with it — the agent
    // would then read its unredirected (shadowed) config after all.
    expect(entrypoint).toContain('redirect_codegraph_config "$codegraph_target" || true');
    expect(entrypoint).toMatch(/HOME="\$CODEGRAPH_INSTALL_HOME" codegraph install/);
    expect(entrypoint).not.toMatch(/\$\(redirect_codegraph_config/);
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

  it('matches the README matrix on the BINARY the agent actually installs as', () => {
    // The README matrix is the VERIFIED source for this column (re-checked
    // against each vendor's installer). The CLI's profile table restates it, and
    // a restatement drifts: `cursor` sat in the table as the binary name for a
    // CLI whose installer links `agent`, so it matched nothing at all and the
    // profile was dead code nobody could reach.
    const readmeBinaries = [...(readmeMatrixCells(id)[3] ?? '').matchAll(/`([^`]+)`/g)].map(
      (match) => match[1],
    );
    expect(readmeBinaries.length, `README binary column for ${id}`).toBeGreaterThan(0);
    const profile = profileOf(id);
    for (const binary of readmeBinaries) {
      expect(profile.binaries, `${id} must match its documented binary`).toContain(binary);
    }
    // Any name BEYOND the documented ones may only be the profile id itself —
    // the alias a user might have made. The table may not invent a third name.
    for (const binary of profile.binaries) {
      if (readmeBinaries.includes(binary)) continue;
      expect(binary, `${id} extra alias`).toBe(id);
    }
  });

  it('tests a credential only WITHIN a path the README matrix pins', () => {
    // The matrix pins the MOUNT; `doctor` may narrow it (opencode's auth.json
    // inside the data dir) or decline it, but it may never test a path the
    // sandbox does not mount — that would report a credential the container
    // never receives.
    const readmePaths = [...(readmeMatrixCells(id)[4] ?? '').matchAll(/~\/[^\s`*]+/g)].map(
      (match) => match[0].replace('~', TEST_DIRS.home),
    );
    const profilePaths = profileOf(id).credentialPaths(TEST_DIRS);
    if (readmePaths.length === 0) {
      // No documented portable credential (the OS-keyring agents) — so there is
      // nothing legitimate to look for either.
      expect(profilePaths, `${id} has no documented credential path`).toEqual([]);
      return;
    }
    for (const path of profilePaths) {
      expect(
        readmePaths.some((mount) => path === mount || path.startsWith(`${mount}/`)),
        `${id}: ${path} is outside the documented mounts ${readmePaths.join(', ')}`,
      ).toBe(true);
    }
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
