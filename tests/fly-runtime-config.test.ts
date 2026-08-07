import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guards for MOTIR-2387 — the Fly runtime: `output: 'standalone'`, the
 * multi-stage `Dockerfile`, `fly.toml`, and the release lane that applies
 * migrations.
 *
 * These assertions exist because NOTHING else would catch a regression in them.
 * A Dockerfile and a `fly.toml` are not type-checked, not linted, and not
 * executed by any suite; the first thing that reads them is a production deploy,
 * and every failure mode below is one that presents there as something else:
 *
 *   * A missing `HOSTNAME=0.0.0.0` produces a server that logs "✓ Ready" and
 *     answers nothing — on a first deploy it looks like a networking problem.
 *   * A release command that cannot resolve the Prisma CLI, or a
 *     `prisma.config.ts` separated from the `node_modules` that satisfies its
 *     imports, dies in the release step and rolls the whole deploy back.
 *   * `fly.toml` asserting a machine COUNT is the exact belief MOTIR-2102
 *     disproved: the file cannot create a machine, and stating otherwise cost
 *     this project three days on its other service.
 *
 * Same mould as `tests/ci-acceptance-lane.test.ts` — read the file, assert the
 * load-bearing lines, and say in a comment why each one is load-bearing.
 */

const root = process.cwd();
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const flyToml = readFileSync(join(root, 'fly.toml'), 'utf8');
const nextConfig = readFileSync(join(root, 'next.config.ts'), 'utf8');

/** The runner stage — everything after the last `FROM … AS runner`. */
const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'));

/** The builder stage — from `AS builder` up to the runner. */
const builderStage = dockerfile.slice(
  dockerfile.indexOf('AS builder'),
  dockerfile.indexOf('AS runner'),
);

/**
 * The prune step's shell body, lifted verbatim out of the Dockerfile so the
 * tests below can RUN it rather than pattern-match it. Takes the `RUN set -eu;`
 * line and every continued line after it, and strips the `RUN ` prefix and the
 * trailing backslashes that make it one Docker instruction.
 */
function extractPruneScript(): string {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((l) => l.startsWith('RUN set -eu;'));
  if (start === -1) throw new Error('the standalone prune step is gone from the Dockerfile');
  const body = [lines[start]!.replace(/^RUN /, '')];
  for (let i = start; lines[i]!.trimEnd().endsWith('\\'); i++) body.push(lines[i + 1]!);
  return body.map((l) => l.replace(/\\$/, '')).join('\n');
}

describe('next.config.ts — the standalone artifact', () => {
  it("sets output: 'standalone'", () => {
    // The load-bearing half of the whole move (ADR Q1). Without it `next build`
    // emits a per-route artifact and the Dockerfile's runner stage copies a
    // directory that does not exist.
    expect(nextConfig).toMatch(/output:\s*'standalone'/);
  });

  it('carries NO outputFileTracingExcludes, and says why (MOTIR-2403)', () => {
    // The key is read in exactly one module, `collect-build-traces.js`, which
    // `next/dist/build/index.js` calls behind
    // `if (bundler !== Bundler.Turbopack && …)`. Next 16 builds with Turbopack,
    // so the module never runs. The version that shipped here excluded
    // `./design/**` + three more directories and removed none of them, while
    // reading — with a measured byte figure attached — as a solved problem. That
    // second half is the defect: MOTIR-2102 is the same shape one file over, a
    // config asserting a behaviour the tool does not perform.
    expect(nextConfig).not.toMatch(/^\s*outputFileTracingExcludes:/m);
    // Absence alone would leave the next reader to rediscover why, and re-adding
    // the key is the obvious-looking fix. The comment is the deliverable.
    expect(nextConfig).toMatch(/outputFileTracingExcludes/); // named in prose
    expect(nextConfig).toMatch(/Turbopack/);
    expect(nextConfig).toMatch(/collect-build-traces/);
    expect(nextConfig).toMatch(/MOTIR-2403/);
  });

  it('marks outputFileTracingIncludes as inert under this build, not as working', () => {
    // Same mechanism, same skipped module — so the OG-font entry does not take
    // effect either. It is KEPT (it is the only record of why those bytes must
    // ship, and it is the webpack-path net), but it must not read as the thing
    // delivering them: Turbopack's own tracer is, verified in the built
    // `route.js.nft.json`. A reader who believes this key works will debug a
    // missing font in the wrong place.
    expect(nextConfig).toMatch(/outputFileTracingIncludes:/);
    expect(nextConfig).toMatch(/does NOT currently do anything/);
  });
});

describe('Dockerfile — the runner image', () => {
  it('sets HOSTNAME=0.0.0.0 and says why omitting it is silent', () => {
    expect(runnerStage).toMatch(/^ENV HOSTNAME=0\.0\.0\.0$/m);
    // The value alone is not the deliverable; the reason beside it is. This is
    // the finding the spike paid for, and a comment is the only form of it that
    // survives into the next person's edit.
    expect(runnerStage).toMatch(/SILENTLY|silently/);
  });

  it('copies the standalone output, the static assets and public/', () => {
    // `.next/static` and `public` are NOT part of the standalone bundle; Next
    // requires them to be copied alongside it, and a missing copy serves an
    // unstyled page rather than an error.
    expect(runnerStage).toMatch(/COPY --from=builder[^\n]*\/app\/\.next\/standalone \.\//);
    expect(runnerStage).toMatch(
      /COPY --from=builder[^\n]*\/app\/\.next\/static \.\/\.next\/static/,
    );
    expect(runnerStage).toMatch(/COPY --from=builder[^\n]*\/app\/public \.\/public/);
  });

  it("does NOT copy the builder's dependency tree into the runner", () => {
    // The entire point of the multi-stage split. The builder carries the full
    // dev dependency set (next build needs it); the runner must carry only the
    // traced standalone bundle plus the migration toolchain.
    expect(runnerStage).not.toMatch(/COPY --from=builder[^\n]*\/app\/node_modules(\s|$)/);
  });

  it('prunes the standalone output in the BUILDER, before the runner copies it', () => {
    // Docker layers are additive: `COPY --from=builder … .next/standalone` in the
    // runner commits every byte it copies, and a later `RUN rm -rf` only writes a
    // whiteout over them. The image would not shrink at all. Pruning before the
    // COPY is the whole reason this step sits where it does, so its POSITION is
    // the assertion — MOTIR-2403.
    expect(builderStage).toMatch(/^RUN set -eu;/m);
    // Not "no `rm -rf` in the runner" — the apt-cache cleanup is a legitimate
    // one, and it shrinks the image precisely because it shares a layer with the
    // `apt-get install` that created those files. What must not appear is a
    // prune of the standalone payload, which would land in a layer of its own.
    for (const d of ['design', 'tests', 'docs', 'scripts']) {
      expect(runnerStage, d).not.toMatch(new RegExp(String.raw`rm -rf[^\n]*\b${d}\b`));
    }
    // …and after `next build`, which is what produces the directory it prunes.
    expect(builderStage.indexOf('RUN pnpm exec next build')).toBeLessThan(
      builderStage.indexOf('RUN set -eu;'),
    );
  });

  it('builds with `next build`, never the `build` script that migrates', () => {
    // package.json's `build` is `prisma generate && node scripts/migrate-deploy.mjs
    // && next build`. Migrations belong to fly.toml's release_command; running
    // them during an image build either fails the build (no DATABASE_URL at
    // build time, by design) or migrates whatever database the builder can see.
    expect(dockerfile).toMatch(/RUN pnpm exec next build/);
    expect(dockerfile).not.toMatch(/^RUN pnpm build$/m);
  });
});

describe('Dockerfile — the migration toolchain', () => {
  it('pins the Prisma CLI by READING the installed version, not by literal', () => {
    // A hardcoded version drifts silently behind package.json's `^` range: the
    // image would migrate with a different CLI than the repo develops against,
    // and nothing would say so. Reading it out of the resolved tree makes drift
    // impossible rather than detectable.
    expect(dockerfile).toMatch(/require\('prisma\/package\.json'\)\.version/);
    expect(dockerfile).toMatch(/npm install --prefix \/migrate/);
    expect(dockerfile).not.toMatch(/prisma@\d+\.\d+\.\d+/);
  });

  it('keeps prisma.config.ts beside the toolchain, not at the app root', () => {
    // `prisma.config.ts` is a MODULE: it imports `dotenv` and `prisma/config`,
    // which Node resolves from the config FILE's own directory. At /app those
    // resolve against the standalone server's minimal node_modules, which has
    // neither, and the release command dies with `Cannot find module 'dotenv'`.
    expect(runnerStage).toMatch(
      /COPY --from=builder[^\n]*\/app\/prisma\.config\.ts \.\/migrate\/prisma\.config\.ts/,
    );
    expect(runnerStage).toMatch(/COPY --from=builder[^\n]*\/app\/prisma \.\/migrate\/prisma/);
    expect(runnerStage).toMatch(
      /COPY --from=builder[^\n]*\/migrate\/node_modules \.\/migrate\/node_modules/,
    );
  });

  it('does not merge the toolchain into the standalone server node_modules', () => {
    // The two trees both contain `@prisma`, `react` and `react-dom`. Merging
    // them lets the CLI's copies shadow the ones the server was traced against.
    expect(runnerStage).not.toMatch(/\/migrate\/node_modules \.\/node_modules/);
  });
});

describe('Dockerfile — the standalone prune, RUN rather than read (MOTIR-2403)', () => {
  const ALL = ['design', 'tests', 'docs', 'scripts'];
  /** Directories the running server needs — the prune must not touch them. */
  const KEEP = ['app/_brand/fonts', 'node_modules', 'prisma'];

  /**
   * Build a fake `.next/standalone` holding `present` (plus the KEEP set), run
   * the real prune script over it, and hand the result + the tree to `assert`
   * before the temp directory goes away.
   */
  function withPrune(
    present: string[],
    assert: (res: { status: number; stdout: string; stderr: string }, standalone: string) => void,
  ): void {
    const dir = mkdtempSync(join(tmpdir(), 'standalone-prune-'));
    try {
      const standalone = join(dir, '.next/standalone');
      for (const d of [...present, ...KEEP]) {
        mkdirSync(join(standalone, d), { recursive: true });
        writeFileSync(join(standalone, d, 'payload.bin'), 'x'.repeat(1024));
      }
      const res = spawnSync('sh', ['-c', extractPruneScript()], { cwd: dir, encoding: 'utf8' });
      assert(
        { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' },
        standalone,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('removes every payload directory and leaves the runtime ones alone', () => {
    // The behavioural assertion the old `outputFileTracingExcludes` could never
    // pass: it named these same four directories and removed none of them. The
    // KEEP set matters as much — the OG cards read `app/_brand/fonts/*.ttf` off
    // disk at request time, so a prune that reached `app/` would 404 the cards.
    withPrune(ALL, (res, standalone) => {
      expect(res.status, res.stderr).toBe(0);
      for (const d of ALL) expect(existsSync(join(standalone, d)), d).toBe(false);
      for (const d of KEEP) expect(existsSync(join(standalone, d)), d).toBe(true);
    });
  });

  it.each(ALL)('FAILS instead of silently pruning nothing when %s is absent', (missing) => {
    // The bug this card is about, in its general form: `rm -rf` on a path that
    // does not exist exits 0 in silence, exactly as the inert config key did. If
    // a Next upgrade stops sweeping one of these directories into the standalone
    // output, the build must stop and say so rather than quietly become a step
    // that reads as pruning and prunes nothing.
    withPrune(
      ALL.filter((d) => d !== missing),
      (res) => {
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain(`prune target '${missing}'`);
      },
    );
  });

  it('reports the before and after size, so the log carries the evidence', () => {
    // A number in the build log is what lets the next person confirm the prune
    // is still doing something, without reproducing a build to find out.
    withPrune(ALL, (res) => {
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/standalone before prune: \d+ MB/);
      expect(res.stdout).toMatch(/standalone after prune:\s+\d+ MB/);
    });
  });
});

describe('fly.toml — the deployment configuration', () => {
  it('pins the region and the VM the ADR decided', () => {
    expect(flyToml).toMatch(/^primary_region\s*=\s*"iad"/m);
    expect(flyToml).toMatch(/size\s*=\s*"shared-cpu-2x"/);
  });

  it('runs migrations from the release command, through the staged lane', () => {
    // Not `pnpm prisma migrate deploy`: the standalone image has no pnpm and no
    // CLI on PATH. The entrypoint is what makes the staged directory runnable.
    expect(flyToml).toMatch(/release_command\s*=\s*"node \/app\/migrate\/release-migrate\.mjs"/);
    expect(flyToml).not.toMatch(/release_command[^\n]*pnpm/);
  });

  it('declares the machine POLICY', () => {
    expect(flyToml).toMatch(/^\s*min_machines_running\s*=\s*1$/m);
    expect(flyToml).toMatch(/^\s*auto_stop_machines\s*=\s*"stop"$/m);
    expect(flyToml).toMatch(/^\s*auto_start_machines\s*=\s*true$/m);
  });

  it('records the intended count as an INTENT, and never asserts one', () => {
    // ADR Q6. The file states that two machines are intended, that `flyctl
    // deploy` adds none, and that `fly scale count 2` on MOTIR-2386 is what
    // creates them. What it must NOT do is carry a key that reads as a count —
    // that is MOTIR-2102's mistake, where a config comment asserting a platform
    // behaviour stood in for a command nobody ran.
    expect(flyToml).toMatch(/fly scale count 2/);
    expect(flyToml).toMatch(/MOTIR-2386/);
    expect(flyToml).toMatch(/MOTIR-2102/);
    expect(flyToml).toMatch(/flyctl deploy/);
    expect(flyToml).toMatch(/without adding any/);
    // No key assigns a machine count. `min_machines_running` is a floor on an
    // existing pool and is asserted above; anything else is a claim.
    const assignments = flyToml
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => /^\s*(machine_count|count|machines)\s*=/.test(line));
    expect(assignments).toEqual([]);
  });
});

describe('scripts/release-migrate.mjs — the release entrypoint', () => {
  it('runs from its own directory with its own toolchain on PATH', () => {
    // Behavioural, not textual: the two invariants the release lane rests on are
    // that it chdirs beside prisma.config.ts and that `prisma` resolves from the
    // staged toolchain — regardless of the working directory Fly happens to give
    // it. Stubbing `migrate-deploy.mjs` (which the entrypoint imports by
    // relative path) lets both be observed without a database.
    const dir = mkdtempSync(join(tmpdir(), 'release-migrate-'));
    try {
      copyFileSync(join(root, 'scripts/release-migrate.mjs'), join(dir, 'release-migrate.mjs'));
      mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
      writeFileSync(
        join(dir, 'migrate-deploy.mjs'),
        'console.log(JSON.stringify({ cwd: process.cwd(), path: process.env.PATH }));\n',
      );

      const out = execFileSync(process.execPath, [join(dir, 'release-migrate.mjs')], {
        cwd: root, // deliberately NOT the script's directory
        encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      });
      const observed = JSON.parse(out.trim()) as { cwd: string; path: string };

      // macOS resolves the temp dir through a /private symlink, so compare the
      // basename rather than the absolute path.
      expect(observed.cwd.endsWith(dir.split('/').pop() as string)).toBe(true);
      expect(observed.path.startsWith(join(observed.cwd, 'node_modules', '.bin') + ':')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
