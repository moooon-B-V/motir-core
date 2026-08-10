// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { escapeRegExp } from '@/lib/utils/regexp';
import {
  SANDBOX_DEVCONTAINER_JSON,
  SANDBOX_DEVCONTAINER_WRITE_COMMAND,
  SANDBOX_IMAGE,
  SANDBOX_STEPS,
  sandboxProfileRows,
  sandboxPullCommand,
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

// ─────────────────────────────────────────────────────────────────────────────// The PULL, and the fact that makes it necessary (MOTIR-2611)
//
// The defect this family guards was invisible to every check above for the same
// reason 2608's was: nothing on the page was FALSE. The image was real, the tag
// was real, the run command was correct, and the reader still ended up on a CLI
// eleven commits older than the page describes — because `:<profile>` moves,
// `docker run` does not re-fetch, and no rendered command anywhere told anyone
// to pull. A page can be true in every particular and still leave the reader on
// last month's software.
//
// So these assert two things a fact-check cannot: that the pull is PRESENT and
// derived from the same row as the run (they can never name different tags), and
// that the prose tells the reader WHY the pull is not optional — before the
// command, where it is still actionable.
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER_STEP = SANDBOX_STEPS.find((step) => step.id === 'start-the-container')!;
const VS_CODE_SUB_STEP = SANDBOX_STEPS.find((step) => step.id === 'or-from-vs-code')!;
const textOf = (step: (typeof SANDBOX_STEPS)[number]) =>
  step.blocks.flatMap((block) =>
    block.kind === 'prose' || block.kind === 'callout' ? [block.text] : [],
  );

/**
 * (5) The step warns that the tag MOVES and that neither start path refreshes it.
 *
 * All three clauses, because any two of them leave a reader who acts wrongly:
 * "the tag moves" without "`docker run` will not fetch it" reads as someone
 * else's problem, and both of those without `docker start -ai` miss the reader
 * this defect actually reaches — the one coming back to a container they already
 * have.
 *
 * The three patterns are NAMED and shared with the falsifiable case below, so
 * the negative strips exactly what the positive looks for. A hand-written mutant
 * regex drifts from the assertion it is meant to break — and a negative case that
 * has drifted passes for the wrong reason, which is the one thing a falsifiable
 * check may not do.
 */
const STALE_IMAGE_CLAUSES: [RegExp, string][] = [
  [/tags? move|moving tag|points? at the newest|always point/i, 'the profile tag moves'],
  [
    /docker run.*(never|not) go(es)? back to the registry|`docker run`[^.]*already has/i,
    '`docker run` skips the registry',
  ],
  [/docker start -ai/, '`docker start -ai` — the returning reader’s path'],
];

function assertStaleImageIsExplained(prose: string[]): void {
  const joined = prose.join('\n');
  for (const [pattern, what] of STALE_IMAGE_CLAUSES) {
    expect(joined, `the step never says ${what}`).toMatch(pattern);
  }
}

/**
 * (6) The immutable form is offered WITH the reason to prefer it.
 *
 * Naming `:<profile>-<version>` and leaving the reader to guess when to want it
 * is the shape of a footnote; the criterion is a stated reason, so the assertion
 * is one. The schematic spelling is also checked against the workflow that
 * publishes it — a page offering a tag form the release lane does not push is
 * the MOTIR-2010 shape all over again.
 */
function assertImmutableTagIsOffered(prose: string[]): void {
  const joined = prose.join('\n');
  expect(joined, 'the immutable tag form is not documented').toContain('`:<profile>-<version>`');
  expect(joined, 'no reason to prefer it is stated').toMatch(
    /same bytes|reproduc|re-enter exactly|pinning/i,
  );
  // …and that form is the one the release lane actually pushes.
  expect(RELEASE_WORKFLOW).toContain(
    '${{ env.IMAGE }}:${{ matrix.profile.id }}-${{ steps.ver.outputs.version }}',
  );
}

describe('the guide renders the pull it has always told readers to do', () => {
  it('names an image the release lane publishes, for every profile', () => {
    for (const row of sandboxProfileRows()) assertImageReferenceIsReal(sandboxPullCommand(row));
  });

  it('pulls exactly the reference the run command starts — same row, same tag', () => {
    for (const row of sandboxProfileRows()) {
      const pulled = sandboxPullCommand(row).match(/ghcr\.io\/\S+/)![0];
      expect(sandboxRunCommand(row), `${row.id}: run does not start the pulled image`).toContain(
        pulled,
      );
      expect(sandboxPullCommand(row)).toBe(`docker pull ${SANDBOX_IMAGE}:${row.id}`);
    }
  });

  it('FALSIFIABLE: a pull of an unpublished tag fails the same check the run does', () => {
    expect(() =>
      assertImageReferenceIsReal(
        sandboxPullCommand(sandboxProfileRows()[0]!).replace(/:.+$/, ':x'),
      ),
    ).toThrow();
  });
});

describe('step 2 says WHY the pull is not optional, before the command', () => {
  it('explains the moving tag, `docker run`, and `docker start -ai`', () => {
    assertStaleImageIsExplained(textOf(CONTAINER_STEP));
  });

  it('offers the immutable tag with a reason to prefer it', () => {
    assertImmutableTagIsOffered(textOf(CONTAINER_STEP));
  });

  it('puts every word of it BEFORE the commands — the step has no prose after them', () => {
    // Not a stylistic preference: `blocks` render in full before the derived
    // command pair (the page appends them), so a warning authored as a block is
    // structurally ahead of the `docker run` it is warning about. This asserts
    // the property the criterion actually wants — that there is no way to author
    // this caveat as a footnote under the command.
    expect(CONTAINER_STEP.rendersImageCommands).toBe(true);
    expect(CONTAINER_STEP.blocks.some((block) => block.kind === 'code')).toBe(false);
  });

  it('FALSIFIABLE: dropping any one of the three clauses fails', () => {
    const prose = textOf(CONTAINER_STEP);
    for (const [pattern] of STALE_IMAGE_CLAUSES) {
      // Globally — a non-global strip leaves the second phrasing of the same
      // clause standing in the same paragraph, and the check passes on the very
      // text the mutant was supposed to have removed.
      const strip = new RegExp(pattern.source, 'gi');
      expect(() =>
        assertStaleImageIsExplained(prose.map((text) => text.replace(strip, '—'))),
      ).toThrow();
    }
    // …and an immutable tag named with no reason to want it fails too.
    expect(() => assertImmutableTagIsOffered(['Also `:<profile>-<version>` exists.'])).toThrow();
    expect(() => assertImmutableTagIsOffered(['Pin it — the same bytes every time.'])).toThrow();
  });
});

describe('the VS Code sub-step says how to get a newer image too', () => {
  it('names the reuse, the pull, and the command that makes an existing container take it', () => {
    const joined = textOf(VS_CODE_SUB_STEP).join('\n');
    expect(joined, 'never says Dev Containers reuses a local image').toMatch(
      /reuses a local image|already (has|created)|keeps the image/i,
    );
    expect(joined, 'never sends the reader to a pull').toMatch(/pull/i);
    expect(joined, 'no way to make an EXISTING dev container take the new image').toMatch(
      /Rebuild Container/,
    );
  });

  it('FALSIFIABLE: the pre-MOTIR-2611 wording — persistence without the image it implies — fails', () => {
    const before =
      'Swap `:claude` and the `mounts` entry for your row from step 1. A dev container is ' +
      'not torn down when you close the window, so the sign-in in step 4 persists here ' +
      'without any extra flag.';
    expect(before).not.toMatch(/Rebuild Container/);
    expect(before).not.toMatch(/reuses a local image/i);
  });
});

describe('the derivation seam feeds BOTH commands — read off the RENDERED page', () => {
  it('changes the pull AND the run when the CLI’s first profile changes, with no edit to the page', async () => {
    // The proof AC 1 asks for, and the one assertion that can distinguish a pull
    // DERIVED from the profile row from a pull typed to match today's first
    // profile. The worked example is `profiles[0]`, so the injection goes at the
    // FRONT — a push (what the table's derivation test does) would leave both
    // commands on the real head and pass vacuously.
    //
    // ⚠️ Same module-identity discipline as that test: page and profiles both
    // come from ONE fresh graph, or the array being mutated is not the array the
    // page reads.
    const { default: Page } = await import('@/app/(public)/docs/sandbox/page');
    const { AGENT_PROFILES: live } = await import('../../packages/cli/src/agentProfiles');

    const head = {
      ...live[0]!,
      id: 'zzz-head-profile',
      label: 'Head profile',
      binaries: ['zzz-head'] as const,
      sandboxMounts: ['~/.zzz-head'] as const,
    };
    (live as unknown as (typeof head)[]).unshift(head);
    try {
      renderWithIntl(await Page());

      const panes = [
        ...(document.getElementById('start-the-container')?.querySelectorAll('pre') ?? []),
      ].map((pane) => pane.textContent ?? '');
      expect(panes, 'step 2 renders two commands: the pull, then the run').toHaveLength(2);

      const [pull, run] = panes as [string, string];
      expect(pull).toBe(`docker pull ${SANDBOX_IMAGE}:zzz-head-profile`);
      expect(run, 'the run did not follow the profile').toContain(
        `${SANDBOX_IMAGE}:zzz-head-profile`,
      );
      // The ORDER is the deliverable: a pull under the run it is meant to
      // precede instructs nothing.
      expect(pull.startsWith('docker pull')).toBe(true);
      expect(run.startsWith('docker run')).toBe(true);
      // …and the injected profile's mount reached the run, so this is the same
      // row feeding both rather than two lookups that happen to agree.
      expect(run).toContain('/home/node/.zzz-head');
    } finally {
      (live as unknown as unknown[]).shift();
    }
  });

  it('captions the pull from the CATALOG, and names the profile it pulls', async () => {
    // The caption is page CHROME, so unlike the guide's prose it IS localized
    // (ADR Amendment 4 Q4) — and a caption that never interpolates the profile
    // is how the pull and the run come to look like commands for two different
    // things.
    //
    // ⚠️ `getTranslations` is mocked to `key => key` at the top of this file, so
    // what the server render puts on the page is the KEY. That is exactly the
    // assertion worth making here — a hardcoded English caption would NOT appear
    // as a key — and the interpolation is asserted against the catalogs
    // themselves, which is where it lives.
    const { default: Page } = await import('@/app/(public)/docs/sandbox/page');
    renderWithIntl(await Page());
    expect(screen.getAllByText('sandboxPullCaption')).toHaveLength(1);

    for (const locale of ['en', 'zh']) {
      const catalog = JSON.parse(read(`messages/${locale}.json`)) as {
        apiDocs: Record<string, string>;
      };
      const caption = catalog.apiDocs['sandboxPullCaption'];
      expect(caption, `${locale} has no sandboxPullCaption`).toBeDefined();
      expect(caption, `${locale}'s caption does not name the profile`).toContain('{profile}');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The VS Code sub-step, checked as a PROCEDURE rather than as prose (MOTIR-2608)
//
// The three defects this guards were all invisible to every check above,
// because none of them was a false fact: the page named a real palette, a real
// filename and a real command. What it never said was how to open the palette,
// how to produce a file whose name a GUI file manager refuses, or which of the
// two attach commands works from the state the procedure actually leaves the
// reader in. A step can be true in every particular and still be unfollowable,
// so these assert the instructions a cold-start reader needs are PRESENT.
// ─────────────────────────────────────────────────────────────────────────────

// The prose side reuses MOTIR-2611's `textOf(VS_CODE_SUB_STEP)` rather than a
// second extractor of its own — two families reading the same step through two
// helpers is how they come to disagree about what the step contains. Only the
// CODE side is new here: `textOf` deliberately returns prose and callouts, and
// these checks are about a command block.
const vsCodeCode = () =>
  VS_CODE_SUB_STEP.blocks.flatMap((block) => (block.kind === 'code' ? [block.code] : []));

/**
 * (7) The palette is named at FIRST use, not at the second mention.
 *
 * Aimed at the first block that tells the reader to use the palette at all —
 * asserting "the step mentions ⇧⌘P somewhere" would pass on a page that
 * introduces the chord two sub-steps after it first sends the reader there,
 * which is exactly the defect.
 */
function assertPaletteIsOpenableAtFirstUse(prose: string[]): void {
  const first = prose.find((text) => /command palette/i.test(text));
  expect(first, 'no block tells the reader to use the command palette').toBeDefined();
  expect(first, 'the macOS chord is missing at first use').toContain('⇧⌘P');
  expect(first, 'the Windows/Linux chord is missing at first use').toContain('Ctrl+Shift+P');
  expect(first, 'the discoverable menu route is missing at first use').toMatch(
    /View → Command Palette/,
  );
}

/**
 * (8) The step hands over a runnable way to produce the dot-named file — with
 * the heredoc delimiter QUOTED, and with the reason a reader needs it.
 */
function assertTheFileCanBeProduced(prose: string[], code: string[]): void {
  const write = code.find((snippet) => /devcontainer\.json/.test(snippet) && /<</.test(snippet));
  expect(write, 'the step gives no command that writes the file').toBeDefined();
  expect(write, 'the folder is never created').toMatch(/mkdir -p \.devcontainer/);
  // The whole point: an UNQUOTED heredoc eats both substitutions silently.
  expect(write, 'the heredoc delimiter is not quoted').toContain("<<'JSON'");
  expect(write, 'the Dev Containers substitutions did not survive').toContain(
    '${localWorkspaceFolder}',
  );
  expect(write).toContain('${localEnv:HOME}');

  // A GUI route that accepts a dot-prefixed path, so a reader who will not open
  // a terminal is not stranded either.
  expect(
    prose.some(
      (text) => /New File/.test(text) || /Add Dev Container Configuration Files/.test(text),
    ),
    'no GUI route that accepts a dot-name is named',
  ).toBe(true);
  // …and WHY the snippet is there at all. Without the reason a reader does not
  // know the workaround is aimed at them.
  expect(
    prose.some((text) => /refuse[sd]? a name beginning with a dot/i.test(text)),
    'the step never says a GUI file manager refuses the name',
  ).toBe(true);
}

/**
 * (9) The attach command is the one that works from where this procedure
 * actually leaves the reader — with no folder open, or the wrong one.
 */
function assertTheAttachCommandFitsTheState(prose: string[]): void {
  const step3 = prose.find((text) => /Dev Containers: (Re)?[Oo]pen/.test(text));
  expect(step3, 'no block names an attach command').toBeDefined();
  expect(step3, 'the folder-prompting command is not named').toContain(
    'Dev Containers: Open Folder in Container',
  );
  if (/Reopen in Container/.test(step3!)) {
    expect(step3, '“Reopen in Container” appears without its precondition').toMatch(
      /already open in VS Code/i,
    );
  }
}

describe('the VS Code sub-step is followable from a cold start', () => {
  it('says how to open the command palette where it first tells you to use it', () => {
    assertPaletteIsOpenableAtFirstUse(textOf(VS_CODE_SUB_STEP));
  });

  it('gives a runnable way to create the dot-named file, and says why one is needed', () => {
    assertTheFileCanBeProduced(textOf(VS_CODE_SUB_STEP), vsCodeCode());
  });

  it('leads with the command that works when no folder is open yet', () => {
    assertTheAttachCommandFitsTheState(textOf(VS_CODE_SUB_STEP));
  });

  it('FALSIFIABLE: each of the three defects this replaced still fails', () => {
    // A · the palette named only at its SECOND mention.
    expect(() =>
      assertPaletteIsOpenableAtFirstUse([
        'Install the Dev Containers extension. From the command palette’s Extensions: Install Extensions.',
        'Reopen in Container. Command palette (⇧⌘P / Ctrl+Shift+P, or View → Command Palette…).',
      ]),
    ).toThrow();

    // B · a filename with no command behind it — and an UNQUOTED heredoc, which
    // is the silent variant: it writes a file, just not the right one.
    expect(() => assertTheFileCanBeProduced(textOf(VS_CODE_SUB_STEP), [])).toThrow();
    expect(() =>
      assertTheFileCanBeProduced(
        textOf(VS_CODE_SUB_STEP),
        vsCodeCode().map((snippet) => snippet.replace("<<'JSON'", '<<JSON')),
      ),
    ).toThrow();
    expect(() =>
      assertTheFileCanBeProduced(
        textOf(VS_CODE_SUB_STEP).filter((text) => !/refuse/i.test(text)),
        vsCodeCode(),
      ),
    ).toThrow();

    // C · “Reopen in Container” as the sole instruction, and with its
    // precondition dropped.
    expect(() =>
      assertTheAttachCommandFitsTheState([
        '**3 · Reopen in Container.** Command palette → **Dev Containers: Reopen in Container**.',
      ]),
    ).toThrow();
    expect(() =>
      assertTheAttachCommandFitsTheState([
        'Dev Containers: Open Folder in Container…, or Dev Containers: Reopen in Container.',
      ]),
    ).toThrow();
  });
});

describe('the dev-container config is published ONCE', () => {
  it('is the same object in the file listing and in the command that writes it', () => {
    // Acceptance criterion 6. Both code blocks are built from
    // `SANDBOX_DEVCONTAINER_JSON`, so this cannot drift by construction — this
    // asserts that the construction is what the page actually renders, which is
    // the part a refactor can quietly undo.
    const listings = vsCodeCode().filter((snippet) => snippet.trimStart().startsWith('{'));
    expect(listings, 'the file listing is gone').toContain(SANDBOX_DEVCONTAINER_JSON);

    const heredocBody = SANDBOX_DEVCONTAINER_WRITE_COMMAND.split("<<'JSON'\n")[1]?.replace(
      /\nJSON$/,
      '',
    );
    expect(heredocBody, 'the write command carries a second, drifting copy').toBe(
      SANDBOX_DEVCONTAINER_JSON,
    );
    expect(SANDBOX_DEVCONTAINER_JSON).toContain(`${SANDBOX_IMAGE}:claude`);
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
