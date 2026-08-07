import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

describe('next.config.ts — the standalone artifact', () => {
  it("sets output: 'standalone'", () => {
    // The load-bearing half of the whole move (ADR Q1). Without it `next build`
    // emits a per-route artifact and the Dockerfile's runner stage copies a
    // directory that does not exist.
    expect(nextConfig).toMatch(/output:\s*'standalone'/);
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
