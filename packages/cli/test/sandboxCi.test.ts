import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_PROFILES } from '../src/agentProfiles.js';

// Drift guards for the sandbox VALIDATION harness (7.9.7c / MOTIR-885) — the
// smoke scripts, the profile/liveness matrix, and the workflow that runs them —
// plus the RELEASE lane that publishes what that matrix built (7.9.7e /
// MOTIR-1788). Both callers are asserted here because the publish gate IS the
// shared matrix: an image nothing smoke-tested must not be able to reach GHCR.
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
const WORKFLOW_DIR = join(CLI_DIR, '..', '..', '.github', 'workflows');

const read = (path: string): string => readFileSync(path, 'utf8');

const installAgent = read(join(CLI_DIR, 'sandbox', 'install-agent.sh'));
const ci = read(join(WORKFLOW_DIR, 'ci.yml'));
// The matrix itself (7.9.7c) and the tagged lane that publishes what it built
// (7.9.7e). One matrix, two callers — which is the property this file guards.
const images = read(join(WORKFLOW_DIR, 'sandbox-images.yml'));
const release = read(join(WORKFLOW_DIR, 'release-sandbox.yml'));
const readme = read(join(CLI_DIR, 'sandbox', 'README.md'));
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
    // The matrix is reusable, so it has no trigger of its own — the caller's
    // does. A `uses:` that pointed somewhere else would take the whole lane
    // with it.
    expect(ci).toContain('uses: ./.github/workflows/sandbox-images.yml');
    expect(images).toMatch(/^on:\n\s+workflow_call:/m);
  });

  it('build the image and run the smoke driver', () => {
    expect(images).toContain('sandbox-smoke:');
    expect(images).toContain('file: packages/cli/sandbox/Dockerfile');
    expect(images).toContain('packages/cli/sandbox/smoke/run.sh --no-build');
  });

  it('derive the profile matrix from profiles.json instead of restating it', () => {
    // Restating the agent list in YAML is the drift this whole suite exists to
    // prevent; reading the file means adding an agent extends CI by itself.
    expect(images).toContain('packages/cli/sandbox/smoke/profiles.json');
    expect(images).toContain('fromJson(needs.sandbox-profiles-matrix.outputs.profiles)');
  });

  it('run BOTH `motir --version` and the agent liveness check per profile', () => {
    expect(images).toContain(
      'docker run --rm motir-sandbox:${{ matrix.profile.id }} motir --version',
    );
    expect(images).toContain(
      'docker run --rm motir-sandbox:${{ matrix.profile.id }} ${{ matrix.profile.liveness }}',
    );
  });

  it('allow-fails Tier 2 on the PR lane only — a release gates on every tier', () => {
    // "Allow-fail, not removed" is 7.9.7c's posture: a vendor endpoint flaking
    // must not red-X an unrelated pull request, but the leg still runs and still
    // reports. A RELEASE that shipped six of eight images, green, is worse than
    // one that failed — so the exemption is scoped to the non-publish lane.
    expect(images).toContain(
      'continue-on-error: ${{ matrix.profile.tier == 2 && !inputs.publish }}',
    );
    expect(images).toContain('fail-fast: false');
  });

  it('skip on the design/ and docs/ branch prefixes, like the other heavy lanes', () => {
    const call = ci.slice(ci.indexOf('  sandbox:'));
    for (const prefix of ['seed/', 'design/', 'docs/']) {
      expect(call, `${prefix} skip on the sandbox call job`).toContain(
        `!startsWith(github.head_ref, '${prefix}')`,
      );
    }
  });
});

describe('the release lane that publishes the images (7.9.7e)', () => {
  it('is TAG-triggered on the @motir/cli release tag — never a push to main', () => {
    // Same notes.html #49 discipline as above, pointed the other way: a
    // `:latest` that moves on every merge is not a reproducible sandbox, so the
    // ABSENCE of a branch trigger is the load-bearing assertion.
    expect(release).toMatch(/^on:\n\s+push:\n\s+tags:\n\s+- 'cli-v\*'/m);
    expect(release).not.toMatch(/^\s+branches:/m);
  });

  it('guards the tag against the packages/cli version, so image and npm agree', () => {
    expect(release).toContain('${GITHUB_REF_NAME#cli-v}');
    expect(release).toContain("require('./packages/cli/package.json').version");
  });

  it('runs the SAME matrix, with publishing switched on', () => {
    // The whole gating argument depends on this being one workflow, not two: a
    // release-only matrix could build the image its own way and ship something
    // no smoke test ever ran.
    expect(release).toContain('uses: ./.github/workflows/sandbox-images.yml');
    expect(ci).toContain('publish: false');
    expect(release).toMatch(/publish: \$\{\{ !\(github\.event_name == 'workflow_dispatch'/);
  });

  it('pushes only AFTER the smoke and liveness checks, in the same job', () => {
    // The publish gate is step ORDER inside one job: a failed check stops the
    // job before anything leaves the runner. Assert the order, because a
    // re-shuffle would silently publish an unverified image.
    const smoked = images.indexOf('- name: Smoke the image');
    const pushedBase = images.indexOf('- name: Push the base image');
    expect(smoked).toBeGreaterThan(-1);
    expect(pushedBase).toBeGreaterThan(smoked);

    const liveness = images.indexOf('- name: ${{ matrix.profile.liveness }}');
    const pushedProfile = images.indexOf('- name: Push ${{ matrix.profile.id }}');
    expect(liveness).toBeGreaterThan(-1);
    expect(pushedProfile).toBeGreaterThan(liveness);
  });

  it('authenticates with GITHUB_TOKEN under packages: write — no new secret', () => {
    expect(release).toContain('packages: write');
    expect(images).toContain('password: ${{ secrets.GITHUB_TOKEN }}');
    // Any OTHER secret reference would mean an out-of-band credential someone
    // has to provision and rotate — exactly what GHCR + the job token avoids.
    const secrets = [...images.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(secrets)]).toEqual(['GITHUB_TOKEN']);
    // ...and the pull-request lane must not be able to push at all.
    expect(ci.slice(ci.indexOf('  sandbox:'))).not.toContain('packages: write');
  });

  it('tags each profile both movably and immutably, for both architectures', () => {
    expect(images).toContain('${{ env.IMAGE }}:${{ matrix.profile.id }}');
    expect(images).toContain(
      '${{ env.IMAGE }}:${{ matrix.profile.id }}-${{ steps.ver.outputs.version }}',
    );
    expect(images).toContain('${{ env.IMAGE }}:base');
    expect(images).toContain('${{ env.IMAGE }}:base-${{ steps.ver.outputs.version }}');
    expect(images).toContain('platforms: linux/amd64,linux/arm64');
  });

  it('names the registry in LOWERCASE, the only form docker will pull', () => {
    // `ghcr.io/moooon-B-V/...` is not a reference docker will even resolve —
    // OCI repository names are lowercase-only, and it fails before any network
    // call. The org is spelled `moooon-B-V` everywhere else, so this is a real
    // trap rather than a style point.
    expect(images).toContain('IMAGE: ghcr.io/moooon-b-v/motir-sandbox');
    // Comments are exempt — the header explains the trap by SPELLING the
    // uppercase form out. Only references the workflow would actually push to
    // or pull from have to be lowercase.
    const yamlOnly = images
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(yamlOnly).not.toMatch(/ghcr\.io\/\S*[A-Z]/);
    expect(readme).not.toMatch(/ghcr\.io\/\S*[A-Z]/);
  });

  it('verifies the published images by PULLING them back, by digest', () => {
    // "The push exited 0" and "a user can pull this and run it" are different
    // claims. The digest is the only reference that names the exact bytes the
    // moving tag pointed at.
    expect(images).toContain('sandbox-published:');
    expect(images).toContain('docker run --rm "${IMAGE}@${digest}" motir --version');
    expect(images).toContain('needs: [sandbox-smoke, sandbox-profiles-matrix, sandbox-profiles]');
    // A profile whose leg was dropped uploads no digest — that must fail the
    // release rather than pass as a smaller one.
    expect(images).toContain('No digest was published for');
  });
});

describe('the README, as the adoption path', () => {
  it('leads with `docker run` on the published image, not a git clone', () => {
    const run = readme.indexOf('## Run');
    const build = readme.indexOf('## Build it yourself');
    expect(run).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(run);
    expect(readme).toContain('ghcr.io/moooon-b-v/motir-sandbox:claude');
  });

  it('documents the three mounts the run contract is made of', () => {
    expect(readme).toContain('-v "$PWD:/workspace"');
    expect(readme).toContain('-v "$HOME/.config/motir:/home/node/.config/motir:ro"');
    expect(readme).toContain('-v "$HOME/.claude:/home/node/.claude:ro"');
  });

  it('records a digest per published tag and shows how to pin one', () => {
    expect(readme).toContain('ghcr.io/moooon-b-v/motir-sandbox@sha256:');
    for (const profile of matrix) {
      expect(readme, `a published-image row for ${profile.id}`).toContain(
        `| \`ghcr.io/moooon-b-v/motir-sandbox:${profile.id}\``,
      );
    }
    expect(readme).toContain('| `ghcr.io/moooon-b-v/motir-sandbox:base`');
  });

  it('keeps the build-from-source path for anyone customising a profile', () => {
    expect(readme).toContain('docker build -f packages/cli/sandbox/Dockerfile');
  });
});
