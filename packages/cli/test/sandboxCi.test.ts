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

/**
 * The `sandbox:` job in `ci.yml`, and only it — from its own key to the next
 * top-level job key, with comments stripped.
 *
 * ⚠️ This used to be `ci.slice(ci.indexOf('  sandbox:'))`, i.e. slice-to-EOF,
 * which was the same thing ONLY while `sandbox:` was the last job in the file.
 * MOTIR-1978 appended a `runner-image:` job after it, at which point the
 * "the pull-request lane cannot push" assertion below silently started guarding
 * a job it knows nothing about — and failed on that job's COMMENT explaining
 * that it, too, has no `packages: write`. Both halves are fixed here: the window
 * is the sandbox job, and a comment is not a permission grant.
 */
const sandboxJob = (() => {
  // Comments are dropped BEFORE the window is cut, not after: a job's
  // documentation sits above its key, so a window that ends at the next key
  // would otherwise swallow the next job's entire comment block.
  const lines = ci.split('\n').filter((line) => !line.trim().startsWith('#'));
  const start = lines.findIndex((line) => line === '  sandbox:');
  // Loud rather than an empty window silently passing every assertion below.
  if (start === -1) throw new Error('ci.yml has no `sandbox:` job — this suite guards nothing');
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
  return [lines[start], ...(end === -1 ? after : after.slice(0, end))].join('\n');
})();
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
    'failure-smoke.sh',
    'confinement.sh',
    'env-credential-smoke.sh',
    'login-smoke.sh',
    'readonly-login-smoke.sh',
    'fake-agent.sh',
    'failing-agent.sh',
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
    // The FAILURE path only reproduces under the real read-only credential
    // mount (MOTIR-1836), so it has to run in the container too — a driver that
    // stopped at the happy path is how the defect stayed invisible.
    expect(runSh).toContain('/workspace/.smoke/failure-smoke.sh');
    // …and so does the login REFUSAL, for the same reason: it is the read-only
    // mount that makes the write fail.
    expect(runSh).toContain('/workspace/.smoke/readonly-login-smoke.sh');
  });

  it('runs the MOUNT-FREE recipes as their own container runs (MOTIR-1877)', () => {
    // Whether a credential mount exists cannot be simulated from inside a
    // container that has one — the same argument the confinement suite rests on.
    // So the env tier and the in-container login each get a run of their own,
    // launched WITHOUT the credential bind.
    const mountFree = runSh.slice(runSh.indexOf('the mount-free recipes'));
    expect(mountFree).toContain('/workspace/.smoke/env-credential-smoke.sh');
    expect(mountFree).toContain('/workspace/.smoke/login-smoke.sh');
    expect(mountFree).toContain('-e "MOTIR_TOKEN=env-not-a-real-token"');
    expect(mountFree).toContain('-e "MOTIR_SERVER=http://127.0.0.1:$ENV_PORT"');
    // THE assertion: neither mount-free run may carry the credential bind, or
    // the tier under test would never be the one that supplied the credential.
    expect(mountFree).not.toContain('/home/node/.config/motir');
  });

  it('makes each mount-free leg PROVE the bind is absent before asserting anything', () => {
    // A driver edit that re-added the mount would otherwise leave both legs
    // green while testing the old path — the failure mode is a test that still
    // passes, which is the worst kind.
    for (const name of ['env-credential-smoke.sh', 'login-smoke.sh']) {
      const script = read(join(SMOKE_DIR, name));
      expect(script, `${name} reads the mount table`).toContain('/proc/self/mounts');
      expect(script, `${name} refuses a pre-existing credential`).toContain('config.json');
    }
  });

  it('drives `motir login` against the stub REAL device routes, not a mock', () => {
    // The login is the one command that speaks something other than MCP, so the
    // stub has to serve `/api/cli/device/*` for the leg to mean anything.
    const stub = read(join(SMOKE_DIR, 'stub-server.mjs'));
    expect(stub).toContain('/api/cli/device/start');
    expect(stub).toContain('/api/cli/device/token');
    expect(stub).toContain('authorization_pending');
    const loginSh = read(join(SMOKE_DIR, 'login-smoke.sh'));
    expect(loginSh).toContain('motir login --server "$SERVER" --no-browser');
    // The credential it wrote must then be USED — a file appearing proves less
    // than a read that succeeds because of it.
    expect(loginSh).toContain('motir ready');
  });

  it('asserts the read-only login fails as ONE SENTENCE, never as a stack', () => {
    // MOTIR-1836's class: a supported configuration used correctly must not
    // surface as a raw errno.
    const roSh = read(join(SMOKE_DIR, 'readonly-login-smoke.sh'));
    expect(roSh).toContain('Could not write the credential');
    expect(roSh).toContain('MOTIR_TOKEN');
    expect(roSh).toContain("'Unexpected error' 'EROFS'");
  });

  it('gives the failure leg its OWN stub port, and a CREDENTIAL that covers it', () => {
    // The credential mount is READ-ONLY, so every port any suite will speak to
    // has to be minted before the container starts. A suite on a port the
    // credential does not carry dies with "Not logged in to http://127.0.0.1:…"
    // before it dispatches anything — which is a startup failure wearing the
    // costume of the thing the suite was meant to assert.
    const loopPort = /MOTIR_SMOKE_PORT:-(\d+)/.exec(
      readFileSync(join(SMOKE_DIR, 'loop-smoke.sh'), 'utf8'),
    )?.[1];
    const failurePort = /MOTIR_SMOKE_PORT_FAILURE:-(\d+)/.exec(
      readFileSync(join(SMOKE_DIR, 'failure-smoke.sh'), 'utf8'),
    )?.[1];
    expect(loopPort).toBeDefined();
    expect(failurePort).toBeDefined();
    expect(failurePort).not.toBe(loopPort);

    // Both ports resolve in run.sh, are carried into the container, and each has
    // its own entry in the read-only credential.
    expect(runSh).toContain(`MOTIR_SMOKE_PORT_FAILURE:-${failurePort}`);
    expect(runSh).toContain('-e "MOTIR_SMOKE_PORT_FAILURE=$FAILURE_PORT"');
    expect(runSh).toContain('"http://127.0.0.1:$PORT"');
    expect(runSh).toContain('"http://127.0.0.1:$FAILURE_PORT"');
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
    // Scoped to the sandbox job itself (see `sandboxJob` above) — a sibling job
    // further down the file is not this suite's business, and the sandbox job
    // being last was never the property under test.
    expect(sandboxJob).toContain('uses: ./.github/workflows/sandbox-images.yml');
    expect(sandboxJob).not.toContain('packages: write');
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
    // "The push exited 0" and "the bytes are in the registry and they run" are
    // different claims. The digest is the only reference that names the exact
    // bytes the moving tag pointed at.
    expect(images).toContain('sandbox-published:');
    expect(images).toContain('docker run --rm "${IMAGE}@${digest}" motir --version');
    expect(images).toContain('needs: [sandbox-smoke, sandbox-profiles-matrix, sandbox-profiles]');
    // A profile whose leg was dropped uploads no digest — that must fail the
    // release rather than pass as a smaller one.
    expect(images).toContain('No digest was published for');
  });

  // ── The consumer's question (MOTIR-2010) ─────────────────────────────────
  // `sandbox-published` above pulls as the PUBLISHER, for whom a private package
  // is pullable — which is how `cli-v0.1.0` shipped nine images that no user
  // could obtain, green. These assertions guard the job that asks the question
  // as a stranger, and above all guard the property that makes its answer worth
  // anything: that it holds no credential.
  describe('and then asks whether a STRANGER can pull them', () => {
    /** The `sandbox-public:` job window — its own key to the next top-level job
     *  key (or EOF), comments stripped. Same cut as `sandboxJob` above, and for
     *  the same reason: "this job contains no login" is a claim about THIS job,
     *  and a slice-to-EOF would quietly start including whatever lands next. */
    const publicJob = (() => {
      const lines = images.split('\n').filter((line) => !line.trim().startsWith('#'));
      const start = lines.findIndex((line) => line === '  sandbox-public:');
      if (start === -1) {
        throw new Error('sandbox-images.yml has no `sandbox-public:` job — MOTIR-2010 regressed');
      }
      const after = lines.slice(start + 1);
      const end = after.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
      return [lines[start], ...(end === -1 ? after : after.slice(0, end))].join('\n');
    })();

    it('runs on the release lane only, after everything has been published', () => {
      expect(publicJob).toContain('if: ${{ inputs.publish }}');
      expect(publicJob).toContain(
        'needs: [sandbox-smoke, sandbox-profiles-matrix, sandbox-profiles, sandbox-published]',
      );
    });

    it('holds NO credential — no login, and no `packages:` scope to log in with', () => {
      // The load-bearing assertion of this whole card. A `docker/login-action`
      // step, or a `packages:` grant, would turn the check back into the one
      // that already existed and already passed while the images were private.
      expect(publicJob).not.toContain('docker/login-action');
      expect(publicJob).not.toContain('packages:');
      expect(publicJob).toMatch(/permissions:\n\s+contents: read\n/);
    });

    it('probes every published DIGEST, not the moving tags', () => {
      expect(publicJob).toContain(
        'node packages/cli/sandbox/smoke/assert-public.mjs --image "$IMAGE" --digests digests',
      );
      expect(publicJob).toContain('pattern: sandbox-digest-*');
    });

    it('then runs the command docs/cli.md actually prints, on the profile it names', () => {
      // A readable manifest and a working `docker run` are not the same claim
      // either — and the documented onboarding path is the second one.
      expect(publicJob).toContain('digest=$(cat digests/claude)');
      expect(publicJob).toContain('docker run --rm "${IMAGE}@${digest}" motir --version');
      const documented = read(join(CLI_DIR, '..', '..', 'docs', 'cli.md'));
      expect(documented).toContain('ghcr.io/moooon-b-v/motir-sandbox:claude');
    });
  });
});

// ── The tripwire for the gap BETWEEN releases (MOTIR-2131) ─────────────────
// Everything above guards the release lane, and the release lane was working:
// `cli-v0.1.0` built, smoke-tested, published and (after MOTIR-2129) served
// nine images anyone could pull. It was simply five days and eleven commits
// out of date, so the image greeted every new user with a credential banner
// naming one of the three tiers `docs/cli.md` promises, and `motir login` was
// not in it at all. No lane here fires between releases, by design — which is
// exactly why the drift needed its own scheduled check.
describe('the staleness tripwire that watches the gap between releases', () => {
  const staleness = read(join(WORKFLOW_DIR, 'sandbox-staleness.yml'));

  it('is SCHEDULED, and deliberately not part of the pull-request lane', () => {
    // The trigger is the design decision. A PR job would go red for a condition
    // its author did not cause and cannot fix, which is how a check gets muted
    // — and a muted check is indistinguishable from a passing one.
    expect(staleness).toMatch(/^on:\n\s+schedule:\n(\s+#.*\n)*\s+- cron:/m);
    expect(staleness).toContain('workflow_dispatch:');
    expect(ci).not.toContain('sandbox-staleness');
  });

  it('checks out with FULL history and tags — the whole check depends on it', () => {
    // A shallow checkout has no tags to compare against and cannot walk
    // `<tag>..HEAD`. The script refuses to answer in that case rather than
    // reporting "up to date", so without this the job can only ever say
    // "could not tell" — a check that never checks anything.
    expect(staleness).toMatch(/uses: actions\/checkout@v6\n\s+with:\n\s+fetch-depth: 0/);
  });

  it('calls the script rather than reimplementing the comparison in YAML', () => {
    // Same split as `sandbox-public` and `assert-public.mjs`: the logic is a
    // zero-dependency script with unit tests and a human can run it from any
    // shell; the workflow is a caller. Logic inlined into a `run:` block is
    // testable only by pushing to main.
    expect(staleness).toContain('node packages/cli/sandbox/smoke/assert-current.mjs');
    expect(existsSync(join(SMOKE_DIR, 'assert-current.mjs'))).toBe(true);
    expect(existsSync(join(SMOKE_DIR, 'assert-current.d.mts'))).toBe(true);
  });

  it('needs no registry credential, no Docker and no packages: scope', () => {
    // It answers a question about git, not about a registry. Any credential
    // here would be scope this job has no use for.
    expect(staleness).toMatch(/permissions:\n\s+contents: read/);
    expect(staleness).not.toContain('packages:');
    expect(staleness).not.toContain('docker/login-action');
    expect(staleness).not.toContain('secrets.');
  });

  it('passes the dispatch input through the environment, not into the shell', () => {
    // `${{ inputs.… }}` inside a `run:` body is substituted before bash sees
    // it, so a crafted value would be executed rather than passed.
    expect(staleness).toContain('MAX_AGE_DAYS: ${{ inputs.max_age_days }}');
    expect(staleness).toMatch(/args\+=\(--max-age-days "\$MAX_AGE_DAYS"\)/);
    expect(staleness).not.toMatch(/assert-current\.mjs.*\$\{\{/);
  });

  it('watches the tag prefix both release lanes actually key on', () => {
    // A bare `v*` would fire for the app too, which is why the lanes are
    // package-scoped — and why a tripwire watching a different prefix would
    // silently measure against nothing.
    const script = read(join(SMOKE_DIR, 'assert-current.mjs'));
    expect(script).toContain("export const TAG_PREFIX = 'cli-v'");
    expect(release).toContain("- 'cli-v*'");
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

  it('documents the mounts the run contract is made of — and which one is optional', () => {
    expect(readme).toContain('-v "$PWD:/workspace"');
    expect(readme).toContain('-v "$HOME/.config/motir:/home/node/.config/motir:ro"');
    expect(readme).toContain('-v "$HOME/.claude:/home/node/.claude:ro"');
    // The mount-free form is what a machine with no prior host login runs, so it
    // is part of the adoption path, not a footnote (MOTIR-1877).
    expect(readme).toContain('-e MOTIR_TOKEN -e MOTIR_SERVER');
    expect(readme).toContain('### Three ways to give it a Motir credential');
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
