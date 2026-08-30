import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// MOTIR-3928 — the guard on "an E2E leg SERVES the shared build, it does not
// rebuild on top of it".
//
// WHY IT NEEDS A GUARD AT ALL. The defect this closes was three individually
// correct pieces that cancelled: `ci.yml`'s `build` job uploaded `.next` "so
// each matrix leg" could share it, `e2e-setup` downloaded it and its own comment
// said "we don't run build", and then `playwright.config.ts` ran `next build`
// unconditionally and overwrote it. Nothing was broken, nothing failed, and the
// artifact was produced, transferred and discarded for months — 128–189s per leg
// on run 33260551040, 110s of it re-running TypeScript.
//
// That is the shape a test has to hold: every failure here is SILENT. A leg that
// rebuilds is not a red check, it is a slow green one, and slow green is what
// this repository has repeatedly proved nobody investigates. So the assertions
// below are about the WIRING — the flag is set where the claim becomes true, and
// read where the decision is made — not about any observable behaviour.

const CI_YML = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const E2E_SETUP = readFileSync(
  new URL('../.github/actions/e2e-setup/action.yml', import.meta.url),
  'utf8',
);
const PW_CONFIG = readFileSync(new URL('../playwright.config.ts', import.meta.url), 'utf8');

describe('the E2E lane serves the prebuilt `.next` (MOTIR-3928)', () => {
  it('reads the three files it is meant to guard', () => {
    // Guards against a rename or a path change turning every assertion below
    // into a vacuous pass on an empty string.
    expect(CI_YML).toContain('name: next-build');
    expect(E2E_SETUP).toContain('next-build:');
    expect(PW_CONFIG).toContain('webServer:');
  });

  it('sets the flag in `e2e-setup`, AFTER both branches have put a `.next` in place', () => {
    // The flag must not be conditional on `next-build`: BOTH branches end with a
    // usable build — one downloaded, one compiled by `pnpm build` — so both may
    // skip the webServer's compile. A branch-scoped flag would silently leave the
    // `build` input rebuilding twice, which is the original defect wearing a
    // different hat.
    const step = E2E_SETUP.slice(E2E_SETUP.indexOf('Signal that `.next` is prebuilt'));
    expect(step, 'e2e-setup declares the prebuilt signal').not.toBe('');
    expect(step).toContain('E2E_REUSE_BUILD=1');
    expect(step).toContain('$GITHUB_ENV');
    expect(
      /if:\s*inputs\.next-build/.test(step.split('\n').slice(0, 12).join('\n')),
      'the signal is unconditional — both branches leave a usable `.next`',
    ).toBe(false);

    // And it comes after both branches, not between them.
    expect(E2E_SETUP.indexOf('Signal that `.next` is prebuilt')).toBeGreaterThan(
      E2E_SETUP.indexOf('Download .next/ build artifact'),
    );
    expect(E2E_SETUP.indexOf('Signal that `.next` is prebuilt')).toBeGreaterThan(
      E2E_SETUP.indexOf('Build the app'),
    );
  });

  it('reads the flag in playwright.config and makes ONLY `next build` conditional', () => {
    expect(PW_CONFIG).toContain("process.env['E2E_REUSE_BUILD'] === '1'");
    // `next build` is the one step that may be skipped.
    expect(PW_CONFIG).toContain("REUSE_PREBUILT_NEXT ? [] : ['pnpm exec next build']");
    // ⚠️ `build:worker` and `prisma generate` must NOT be conditional. Neither is
    // in the `next-build` artifact (it is `.next` only), so nothing upstream can
    // supply them and skipping either yields a leg whose job worker is missing —
    // which surfaces as a spec timing out on work that never ran, nowhere near
    // the cause.
    const command = PW_CONFIG.slice(
      PW_CONFIG.indexOf('command: ['),
      PW_CONFIG.indexOf('url: BASE_URL'),
    );
    expect(command).toContain("'pnpm run build:worker'");
    expect(command).toContain("'pnpm exec prisma generate'");
    expect(command).not.toContain("REUSE_PREBUILT_NEXT ? [] : ['pnpm run build:worker']");
    // The server itself is still a PRODUCTION start — MOTIR-1679's requirement,
    // which is about what serves the tests and not about who compiled it.
    expect(command).toContain('pnpm exec next start');
    expect(command).not.toContain('next dev');
  });

  it('keeps the artifact whole, since a leg now serves it', () => {
    // A dot-file dropped from this upload used to cost nothing — the leg rebuilt
    // anyway. It is now a file no leg has.
    const upload = CI_YML.slice(
      CI_YML.indexOf('Upload .next/ build artifact'),
      CI_YML.indexOf('Upload .next/ build artifact') + 400,
    );
    expect(upload).toContain('include-hidden-files: true');
  });
});
