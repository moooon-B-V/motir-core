// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { escapeRegExp } from '@/lib/utils/regexp';
import {
  SANDBOX_IMAGE,
  sandboxProfileRows,
  sandboxRunCommand,
  type SandboxProfileRow,
} from '@/lib/apiDocs/sandbox';
import { AGENT_PROFILES } from '../../packages/cli/src/agentProfiles';

// The STORY GATE for the sandbox guide (Story MOTIR-2268 · Subtask MOTIR-2272),
// modelled on `guide-truth.test.ts` and resting on the same argument, sharpened:
// a guide that is slightly wrong about an API burns ten minutes, and a guide
// that is slightly wrong about a `docker run` makes someone bind their real
// credential directory into a container that will never read it, then fail
// somewhere further in with no idea which of six instructions was the bad one.
//
// So nothing here trusts the page. The page says a profile exists — this asks
// the CLI. The page prints an image — this asks the workflow that publishes it.
// The page shows a container path — this asks the entrypoint what it reads.
//
// ── Every check is FALSIFIABLE ──────────────────────────────────────────────
// Each assertion is a named function, and each has a negative case that feeds it
// a wrong value and proves it throws. A truth test nobody has watched fail might
// be asserting nothing at all — and this artifact has already shipped confidently
// wrong documentation twice (MOTIR-2010, MOTIR-2131), green both times.
//
// ── What this does NOT own ──────────────────────────────────────────────────
// `packages/cli/test/sandboxCi.test.ts` already pins `smoke/profiles.json`
// against `AGENT_PROFILES` (tier parity, liveness commands) and the smoke
// harness; `sandbox.test.ts` pins `sandboxMounts` against the compose file.
// Re-asserting either here would be a second, weaker copy. This file asserts the
// PAGE against those already-guarded sources.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

const ENTRYPOINT = read('packages/cli/sandbox/entrypoint.sh');
const RELEASE_WORKFLOW = read('.github/workflows/sandbox-images.yml');
const SMOKE_PROFILES = JSON.parse(read('packages/cli/sandbox/smoke/profiles.json')) as {
  profiles: { id: string; tier: number }[];
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.resetModules();
});

// ─────────────────────────────────────────────────────────────────────────────
// The checks, as functions, so each can be aimed at a WRONG value on purpose.
// ─────────────────────────────────────────────────────────────────────────────

/** (1) The row describes a profile the CLI actually declares, identically. */
function assertProfileIsReal(row: SandboxProfileRow): void {
  const profile = AGENT_PROFILES.find((candidate) => candidate.id === row.id);
  expect(profile, `the CLI has no profile "${row.id}"`).toBeDefined();
  expect(row.tier, `${row.id} tier`).toBe(profile!.tier);
  expect(row.binary, `${row.id} binary`).toBe(profile!.binaries[0]);
  expect(row.installSource, `${row.id} install source`).toBe(profile!.installSource);
  expect([...row.mounts], `${row.id} mounts`).toEqual([...profile!.sandboxMounts]);
}

/**
 * (2) Every container-side path the command binds is one the image reads.
 *
 * Three legal destinations and no others: `/workspace`, the Motir config home
 * the entrypoint resolves, and the profile's own credential directory. A
 * plausible-but-unread path is the failure that costs a reader their afternoon.
 */
function assertMountTargetsAreReal(row: SandboxProfileRow, command: string): void {
  const binds = [...command.matchAll(/-v "([^:]+):([^:"]+)(?::ro)?"/g)].map(([, from, to]) => ({
    from: from!,
    to: to!,
  }));
  expect(binds.length, `${row.id} binds nothing`).toBeGreaterThan(0);

  const legal = new Set<string>([
    '/workspace',
    '/home/node/.config/motir',
    ...row.mounts.map((mount) => `/home/node/${mount.replace(/^~\//, '')}`),
  ]);
  for (const bind of binds) {
    expect(legal.has(bind.to), `${row.id} binds ${bind.to}, which the image never reads`).toBe(
      true,
    );
  }
  // …and the workspace bind is present and writable — it is the one mount the
  // entrypoint refuses to start without.
  expect(binds.some((bind) => bind.to === '/workspace')).toBe(true);
  expect(command).not.toMatch(/\$PWD:\/workspace:ro/);
}

/** (3) The image the page prints is the one the release lane pushes. */
function assertImageReferenceIsReal(command: string): void {
  const match = command.match(/(ghcr\.io\/[^\s:]+):([^\s\\]+)/);
  expect(match, 'the command names no image').not.toBeNull();
  const [, repository, tag] = match!;

  // The workflow is the authority; README prose is not.
  expect(RELEASE_WORKFLOW).toContain(`IMAGE: ${repository}`);
  expect(repository).toBe(SANDBOX_IMAGE);
  expect(
    SMOKE_PROFILES.profiles.some((profile) => profile.id === tag),
    `no profile publishes the tag "${tag}"`,
  ).toBe(true);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the guide is true of the shipped CLI', () => {
  it('names only profiles the CLI declares, with the CLI’s own facts — every row', () => {
    const rows = sandboxProfileRows();
    expect(rows.length).toBe(AGENT_PROFILES.length);
    for (const row of rows) assertProfileIsReal(row);
  });

  it('FALSIFIABLE: a fabricated profile fails', () => {
    expect(() =>
      assertProfileIsReal({
        id: 'not-an-agent',
        label: 'Not an agent',
        tier: 1,
        binary: 'nope',
        installSource: 'nowhere',
        mounts: [],
      }),
    ).toThrow();
    // …and so does a real profile carrying one wrong fact.
    const real = sandboxProfileRows()[0]!;
    expect(() => assertProfileIsReal({ ...real, tier: real.tier === 1 ? 2 : 1 })).toThrow();
    expect(() => assertProfileIsReal({ ...real, binary: 'wrong-binary' })).toThrow();
    expect(() => assertProfileIsReal({ ...real, mounts: ['~/.invented'] })).toThrow();
  });
});

describe('every path the guide tells a reader to mount is one the image reads', () => {
  it('binds only /workspace, the Motir config home, or the profile’s own directory', () => {
    for (const row of sandboxProfileRows()) {
      assertMountTargetsAreReal(row, sandboxRunCommand(row));
    }
  });

  it('is checked against what the ENTRYPOINT resolves, not against prose', () => {
    // The two non-profile destinations are read out of the shipped script, so a
    // change to either lands here rather than in a user's terminal.
    expect(ENTRYPOINT).toContain('WORKSPACE=/workspace');
    expect(ENTRYPOINT).toMatch(/CONFIG_DIR=.*\/motir/);
    expect(ENTRYPOINT).toContain('/home/node/.config/motir');
  });

  it('FALSIFIABLE: a plausible-but-unread mount target fails', () => {
    const row = sandboxProfileRows().find((candidate) => candidate.mounts.length > 0)!;
    const fabricated = sandboxRunCommand(row).replace(
      /:\/home\/node\/[^:"]+/,
      ':/home/node/.credentials',
    );
    expect(() => assertMountTargetsAreReal(row, fabricated)).toThrow();
    // …and dropping the workspace bind fails too.
    expect(() =>
      assertMountTargetsAreReal(
        row,
        sandboxRunCommand(row).replace(/-v "\$PWD:\/workspace" \\\n/, ''),
      ),
    ).toThrow();
  });
});

describe('the image reference is the one that is actually published', () => {
  it('matches the release workflow’s IMAGE and a tag the matrix publishes', () => {
    for (const row of sandboxProfileRows()) {
      assertImageReferenceIsReal(sandboxRunCommand(row));
    }
  });

  it('FALSIFIABLE: an unpublished tag and a wrong registry both fail', () => {
    const command = sandboxRunCommand(sandboxProfileRows()[0]!);
    expect(() =>
      assertImageReferenceIsReal(command.replace(/motir-sandbox:[^\s\\]+/, 'motir-sandbox:gemini')),
    ).toThrow();
    expect(() =>
      assertImageReferenceIsReal(command.replace('ghcr.io/moooon-b-v', 'docker.io/moooon-b-v')),
    ).toThrow();
  });
});

describe('the derivation seam actually derives — read off the RENDERED page', () => {
  it('gains a row for a profile added to the CLI, with no edit to the page', async () => {
    // The assertion the whole approach rests on, and the one a reviewer is most
    // likely to accept on faith: rendered output cannot distinguish a table read
    // from the CLI from a table typed to match it. This can.
    // ⚠️ Both the page AND the profile record are imported from the SAME fresh
    // module graph. `vi.resetModules()` between tests means a statically
    // imported `AGENT_PROFILES` is a different array instance from the one the
    // dynamically imported page will read — mutating the wrong one makes this
    // test pass vacuously, which is the failure mode a derivation test can least
    // afford.
    const { default: Page } = await import('@/app/(public)/docs/sandbox/page');
    const { AGENT_PROFILES: live } = await import('../../packages/cli/src/agentProfiles');

    const extra = {
      ...live[0]!,
      id: 'zzz-gate-profile',
      label: 'Gate profile',
      binaries: ['zzz-gate'] as const,
      installSource: 'the gate',
      sandboxMounts: ['~/.zzz-gate'] as const,
    };
    (live as unknown as (typeof extra)[]).push(extra);
    try {
      renderWithIntl(await Page());

      const table = document.getElementById('pick-your-profile')?.querySelector('table');
      const ids = [...(table?.querySelectorAll('tbody tr') ?? [])].map(
        (row) => row.querySelector('code')?.textContent,
      );
      expect(ids).toContain('zzz-gate-profile');
      expect(ids).toHaveLength(live.length);
      // …and its mount reached the rendered cell, not just the row.
      expect(screen.getAllByText('~/.zzz-gate').length).toBeGreaterThan(0);
    } finally {
      (live as unknown as unknown[]).pop();
    }
  });
});

describe('a profile that declares NO binaries falls back to its id', () => {
  it('is the one branch `sandboxProfileRows` has that the shipped profiles never take', async () => {
    // `AgentProfile.binaries` is `readonly string[]`, not a non-empty tuple, so
    // `binaries[0] ?? profile.id` is a REAL defensive branch rather than dead
    // code TypeScript forces on us — and every shipped profile declares at
    // least one binary, so nothing in the live data reaches it. Left untested
    // it is 50% branch coverage on this module and a red CI gate.
    //
    // Covered by injection rather than a `v8 ignore`, using the same
    // push/finally-pop the derivation test above established: the fallback is a
    // CONTRACT ("the canonical binary is `binaries[0]`, or the id when there is
    // none"), and a contract deserves an assertion rather than an exemption.
    const { AGENT_PROFILES: live } = await import('../../packages/cli/src/agentProfiles');
    const { sandboxProfileRows: rows } = await import('@/lib/apiDocs/sandbox');

    const binaryless = { ...live[0]!, id: 'zzz-no-binaries', binaries: [] as const };
    (live as unknown as (typeof binaryless)[]).push(binaryless);
    try {
      const row = rows().find((candidate) => candidate.id === 'zzz-no-binaries');
      expect(row, 'the injected profile should produce a row').toBeDefined();
      expect(row?.binary).toBe('zzz-no-binaries');
    } finally {
      (live as unknown as unknown[]).pop();
    }
  });

  it('still prefers binaries[0] when there IS one — the fallback is not the default', async () => {
    // The negative control: without it, the assertion above would also pass if
    // `binary` were hard-wired to `id`. It has to INJECT a profile whose id and
    // binary genuinely differ — reading a shipped one does not discriminate,
    // because `claude`'s id and its only binary are both `'claude'` (which is
    // how the first draft of this control failed).
    const { AGENT_PROFILES: live } = await import('../../packages/cli/src/agentProfiles');
    const { sandboxProfileRows: rows } = await import('@/lib/apiDocs/sandbox');

    const distinct = {
      ...live[0]!,
      id: 'zzz-distinct-id',
      binaries: ['zzz-distinct-binary'] as const,
    };
    (live as unknown as (typeof distinct)[]).push(distinct);
    try {
      const row = rows().find((candidate) => candidate.id === 'zzz-distinct-id');
      expect(row?.binary).toBe('zzz-distinct-binary');
      expect(row?.binary).not.toBe('zzz-distinct-id');
    } finally {
      (live as unknown as unknown[]).pop();
    }
  });
});

describe('the coverage floor covers what this story shipped', () => {
  it('gives the page and its data module per-file thresholds at the CI floor', () => {
    // The story's own files must be inside the ≥90% gate rather than diluted
    // into the global average — the same floor 11.4's pages carry.
    //
    // ⚠️ The page is entered as `app/**/docs/sandbox/page.tsx`, NOT as its
    // literal path: a Next.js route group is a literal `(public)` directory on
    // disk, but `(` is grouping syntax to the coverage matcher, so the literal
    // form resolves to no file and gates nothing (MOTIR-2449 — this test used
    // to assert the literal string and passed on an inert entry). That the
    // pattern reaches a real file is asserted repo-wide, for every entry, by
    // `tests/coverage-gate-globs.test.ts`; this test asserts the FLOOR.
    const config = read('vitest.config.ts');
    for (const file of ['app/**/docs/sandbox/page.tsx', 'lib/apiDocs/sandbox.ts']) {
      expect(config, `${file} is not in the coverage include list`).toContain(`'${file}'`);
      expect(
        new RegExp(`'${escapeRegExp(file)}':\\s*\\{[^}]*lines:\\s*9\\d`).test(config),
        `${file} has no ≥90% per-file threshold`,
      ).toBe(true);
    }
  });
});
