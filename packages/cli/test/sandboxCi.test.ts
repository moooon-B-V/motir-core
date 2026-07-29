import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_PROFILES } from '../src/agentProfiles.js';

// Drift guards for the sandbox VALIDATION harness (7.9.7c / MOTIR-885) — the
// smoke scripts, the profile/liveness matrix, and the two CI jobs that run them.
//
// The harness itself is a docker build plus a container run: 15+ minutes, and
// unavailable to anyone without a daemon. So the expensive lane checks the
// ARTIFACT, and this suite checks that the lane is still WIRED and still
// describes the same set of agents as the CLI's own profile table. A renamed
// binary, an agent added to AGENT_PROFILES, or a `run:` line quietly deleted
// fails here in milliseconds instead of surfacing as a green matrix that tested
// nothing.
//
// The companion suite is `sandbox.test.ts` (7.9.7a/b), which guards the image
// SOURCES — Dockerfile, entrypoint, install arms, compose, devcontainers.

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE_DIR = join(CLI_DIR, 'sandbox', 'smoke');
const WORKFLOW = join(CLI_DIR, '..', '..', '.github', 'workflows', 'ci.yml');

const read = (path: string): string => readFileSync(path, 'utf8');

const installAgent = read(join(CLI_DIR, 'sandbox', 'install-agent.sh'));
const ci = read(WORKFLOW);
const runSh = read(join(SMOKE_DIR, 'run.sh'));
const loopSh = read(join(SMOKE_DIR, 'loop-smoke.sh'));
const confinementSh = read(join(SMOKE_DIR, 'confinement.sh'));
const fakeAgentSh = read(join(SMOKE_DIR, 'fake-agent.sh'));

interface MatrixProfile {
  id: string;
  tier: 1 | 2;
  liveness: string;
}

const matrix = (JSON.parse(read(join(SMOKE_DIR, 'profiles.json'))) as { profiles: MatrixProfile[] })
  .profiles;

/** A profile's case arm in install-agent.sh — its own label up to the next `;;`. */
const armOf = (id: string): string => {
  const start = new RegExp(`^\\s{4}${id}\\)$`, 'm').exec(installAgent);
  if (!start) return '';
  const rest = installAgent.slice(start.index);
  const end = rest.indexOf('\n        ;;');
  return end === -1 ? rest : rest.slice(0, end);
};

describe('the CI build/liveness matrix', () => {
  it('covers EVERY agent profile the CLI knows about, at the same tier', () => {
    // The matrix is what CI iterates. A profile added to AGENT_PROFILES but not
    // here would ship an install arm no job ever builds.
    expect(matrix.map((p) => p.id).sort()).toEqual(AGENT_PROFILES.map((p) => p.id).sort());
    for (const profile of AGENT_PROFILES) {
      const entry = matrix.find((p) => p.id === profile.id);
      expect(entry?.tier, `tier for ${profile.id}`).toBe(profile.tier);
    }
  });

  it('names the four Tier-1 profiles the sandbox matrix pins', () => {
    // Tier 1 is the gating set — these four must BUILD AND RUN for a pull
    // request to be green, so demoting one is a decision, not a typo.
    expect(
      matrix
        .filter((p) => p.tier === 1)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['claude', 'codex', 'kimi', 'opencode']);
  });

  it('runs the liveness command install-agent.sh actually installs', () => {
    // The trap this closes: `binary` in agentProfiles.ts is a LOOKUP KEY, not
    // the installed command — `antigravity` installs `agy`, `cursor` installs
    // `agent`. Taking the liveness command from the id would make those two
    // matrix legs fail with "command not found" 15 minutes into a docker build.
    for (const profile of matrix) {
      const arm = armOf(profile.id);
      expect(arm, `install arm for ${profile.id}`).not.toBe('');
      const versionLine = /^\s+(\S+) --version$/m.exec(arm);
      expect(versionLine, `a --version smoke test in the ${profile.id} arm`).not.toBeNull();
      expect(profile.liveness, `liveness command for ${profile.id}`).toBe(
        `${versionLine?.[1]} --version`,
      );
    }
  });
});

describe('the sandbox smoke harness', () => {
  const scripts = [
    'run.sh',
    'loop-smoke.sh',
    'confinement.sh',
    'fake-agent.sh',
    'stub-server.mjs',
    'assert-run.mjs',
    join('bin', 'gh'),
  ];

  it('ships every script, each EXECUTABLE', () => {
    // The scripts are mounted into the container through /workspace, not baked
    // into the image, so the committed mode bit is what makes them runnable —
    // a 0644 file fails with "permission denied" inside the container only.
    for (const name of scripts) {
      const path = join(SMOKE_DIR, name);
      expect(existsSync(path), `${name} exists`).toBe(true);
      expect(statSync(path).mode & 0o111, `${name} is executable`).not.toBe(0);
    }
  });

  it('runs the container through the DOCUMENTED mount recipe', () => {
    // The whole confinement claim is a property of HOW the container is
    // launched. A smoke run that mounted something else would assert nothing
    // about what users actually run.
    expect(runSh).toContain('-v "$FIXTURE:/workspace"');
    expect(runSh).toContain('-v "$CREDENTIAL:/home/node/.config/motir:ro"');
    expect(runSh).toContain('/workspace/.smoke/confinement.sh');
    expect(runSh).toContain('/workspace/.smoke/loop-smoke.sh');
  });

  it('agrees with the loop script about the stub port', () => {
    // The credential mount is READ-ONLY, so the server URL it carries is fixed
    // before the run starts — the stub must listen on exactly that port.
    const portOf = (source: string): string | undefined =>
      /MOTIR_SMOKE_PORT:-(\d+)/.exec(source)?.[1];
    expect(portOf(runSh)).toBeDefined();
    expect(portOf(loopSh)).toBe(portOf(runSh));
    expect(runSh).toContain('"http://127.0.0.1:$PORT"');
  });

  it('drives the loop with a fake agent and no real credential', () => {
    expect(loopSh).toMatch(/motir auto --agent "\$SMOKE_DIR\/fake-agent\.sh"/);
    expect(runSh).toContain('smoke-not-a-real-token');
  });

  it('asserts the CALL SEQUENCE, not just the exit code', () => {
    // A loop that skipped mark_integrated, or read the ready set ahead in a
    // batch, would still exit 0.
    expect(loopSh).toContain('assert-run.mjs');
    const assertRun = read(join(SMOKE_DIR, 'assert-run.mjs'));
    for (const tool of ['next_ready', 'transition_status', 'dispatch_prompt', 'mark_integrated']) {
      expect(assertRun, `assertion covering ${tool}`).toContain(tool);
    }
  });

  it('makes the fake agent verify BOTH prompt delivery channels', () => {
    // agentRun.ts delivers the prompt on stdin AND at $MOTIR_PROMPT_FILE. An
    // agent that only read one would leave the other free to rot.
    expect(fakeAgentSh).toContain('MOTIR_PROMPT_FILE');
    expect(fakeAgentSh).toContain('stdin_prompt');
    expect(fakeAgentSh).toContain('"$stdin_prompt" != "$file_prompt"');
  });
});

describe('the confinement assertions', () => {
  it('cover the read-only credential mount, the system tree and the docker socket', () => {
    expect(confinementSh).toContain('docker.sock');
    expect(confinementSh).toContain('refute_write "$CONFIG_DIR"');
    expect(confinementSh).toMatch(/refute_write "\$dir"/);
    expect(confinementSh).toContain('/usr/local/bin');
  });

  it('refuses a container running as root', () => {
    expect(confinementSh).toContain('if [ "$(id -u)" -eq 0 ]');
  });

  it('reads the MOUNT TABLE rather than trusting the documentation', () => {
    // The blast-radius claim is about host binds; /proc/self/mounts is the only
    // thing that actually knows what they are.
    expect(confinementSh).toContain('/proc/self/mounts');
    expect(confinementSh).toContain('undocumented host bind');
  });
});

describe('the CI jobs that run all of it', () => {
  it('are PULL-REQUEST triggered, so they gate a merge', () => {
    // notes.html #49: an inherited workflow with `on: push: main` LOOKS like CI
    // and gates nothing. Assert the trigger, never the file's existence.
    expect(ci).toMatch(/^on:\n\s+pull_request:/m);
  });

  it('build the image and run the smoke driver', () => {
    expect(ci).toContain('sandbox-smoke:');
    expect(ci).toContain('file: packages/cli/sandbox/Dockerfile');
    expect(ci).toContain('packages/cli/sandbox/smoke/run.sh --no-build');
  });

  it('derive the profile matrix from profiles.json instead of restating it', () => {
    // Restating the agent list in YAML is the drift this whole suite exists to
    // prevent; reading the file means adding an agent extends CI by itself.
    expect(ci).toContain('packages/cli/sandbox/smoke/profiles.json');
    expect(ci).toContain('fromJson(needs.sandbox-profiles-matrix.outputs.profiles)');
  });

  it('run BOTH `motir --version` and the agent liveness check per profile', () => {
    expect(ci).toContain('docker run --rm motir-sandbox:${{ matrix.profile.id }} motir --version');
    expect(ci).toContain(
      'docker run --rm motir-sandbox:${{ matrix.profile.id }} ${{ matrix.profile.liveness }}',
    );
  });

  it('allow-fails Tier 2 only — Tier 1 gates', () => {
    // "Allow-fail, not removed" is the card's own posture: a vendor endpoint
    // flaking must not red-X an unrelated pull request, but the leg still runs
    // and still reports.
    expect(ci).toContain('continue-on-error: ${{ matrix.profile.tier == 2 }}');
    expect(ci).toContain('fail-fast: false');
  });

  it('skip on the design/ and docs/ branch prefixes, like the other heavy lanes', () => {
    const sandboxJobs = ci.slice(ci.indexOf('  sandbox-smoke:'));
    const skips = sandboxJobs.match(/!startsWith\(github\.head_ref, 'design\/'\)/g) ?? [];
    // One for the smoke job, one for the matrix-setup job the profile legs need.
    expect(skips.length).toBe(2);
  });
});
