// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  SANDBOX_INTRO,
  SANDBOX_STEPS,
  sandboxProfileRows,
  sandboxRunCommand,
} from '@/lib/apiDocs/sandbox';
import { AGENT_PROFILES } from '../../packages/cli/src/agentProfiles';

// The agent sandbox setup guide (Story MOTIR-2268 · Subtask MOTIR-2271).
//
// The interesting assertions here are not about React. They are about the ONE
// property the story is buying — that the published profile table is DERIVED
// from the CLI's own record rather than retyped — plus the two boundary
// invariants ADR Amendment 9 Q3 permits the cross-package import under.

// The page is a Server Component, so `getTranslations` has to be stubbed the way
// the sibling guide suite does — it returns the KEY, which is why this file
// asserts page chrome by key and rail chrome (a client component, given real
// messages by `renderWithIntl`) by its English string.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('/docs/sandbox', () => {
  it('renders unauthenticated, with the rail marking itself current', async () => {
    const { default: Page } = await import('@/app/(public)/docs/sandbox/page');
    renderWithIntl(await Page());

    const current = document.querySelector('nav a[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe('/docs/sandbox');
    // The other three pages stay one click away.
    expect(screen.getAllByText('API reference').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Getting started').length).toBeGreaterThan(0);
  });

  it('renders its content when the spec cannot be built', async () => {
    // The guide does not depend on the spec, so a broken emitter costs the
    // operation rows and nothing else. Asserted because the failure mode it
    // guards is a blank page, not an exception anyone would notice.
    vi.resetModules();
    vi.doMock('@/lib/apiDocs/reference', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/apiDocs/reference')>()),
      buildApiReference: () => {
        throw new Error('spec unavailable');
      },
    }));
    const { default: Page } = await import('@/app/(public)/docs/sandbox/page');
    renderWithIntl(await Page());

    expect(screen.getByRole('heading', { name: 'sandboxTitle' })).toBeTruthy();
    expect(document.querySelectorAll('[data-operation-id]')).toHaveLength(0);
    vi.doUnmock('@/lib/apiDocs/reference');
    vi.resetModules();
  });

  it('renders every step in order, ending at the hand-off', async () => {
    const { default: Page } = await import('@/app/(public)/docs/sandbox/page');
    renderWithIntl(await Page());

    for (const section of [...SANDBOX_INTRO, ...SANDBOX_STEPS]) {
      expect(document.getElementById(section.id), section.id).toBeTruthy();
    }
    // The hand-off is NOT a numbered step — it is the page's boundary.
    expect(document.getElementById('what-next')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'sandboxWhatNext' })).toBeTruthy();
  });
});

describe('the profile table is DERIVED, not retyped', () => {
  it('renders one row per profile the CLI declares, in source order', async () => {
    const { default: Page } = await import('@/app/(public)/docs/sandbox/page');
    renderWithIntl(await Page());

    // Scope to step 1's own section — the page has several tables, and the
    // first one on it is the confinement summary — then to the wide rendering,
    // since the narrow one repeats the same data.
    const table = document.getElementById('pick-your-profile')?.querySelector('table');
    const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
    const ids = rows
      .map((row) => row.querySelector('code')?.textContent)
      .filter((id): id is string => Boolean(id));

    expect(ids).toEqual(AGENT_PROFILES.map((profile) => profile.id));
  });

  it('publishes the MOUNT, never the doctor probe — they diverge on four profiles', () => {
    // The regression this exists for: deriving the credential column from
    // `credentialPaths` would tell `cursor`, `aider` and `goose` they need no
    // mount, and would show one of `opencode`'s two.
    const rows = sandboxProfileRows();
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    expect(byId['cursor']?.mounts).toEqual(['~/.local/share/cursor-agent']);
    expect(byId['aider']?.mounts).toEqual(['~/.aider.conf.yml']);
    expect(byId['goose']?.mounts).toEqual(['~/.config/goose']);
    expect(byId['opencode']?.mounts).toHaveLength(2);
    // …and the one profile that genuinely mounts nothing still says so.
    expect(byId['antigravity']?.mounts).toEqual([]);

    for (const row of rows) {
      expect(row.mounts, `${row.id}`).toEqual([
        ...(AGENT_PROFILES.find((p) => p.id === row.id)?.sandboxMounts ?? []),
      ]);
    }
  });

  it('gains a profile added to AGENT_PROFILES with NO edit to the page', () => {
    // The property the whole story is buying, asserted the only way that means
    // anything: add one to the source and read the derived output.
    const before = sandboxProfileRows().length;
    const added = {
      ...AGENT_PROFILES[0]!,
      id: 'zzz-test-profile',
      binaries: ['zzz'] as const,
      sandboxMounts: ['~/.zzz'] as const,
    };
    (AGENT_PROFILES as unknown as (typeof added)[]).push(added);
    try {
      const rows = sandboxProfileRows();
      expect(rows).toHaveLength(before + 1);
      const row = rows.at(-1);
      expect(row?.id).toBe('zzz-test-profile');
      expect(row?.binary).toBe('zzz');
      expect(row?.mounts).toEqual(['~/.zzz']);
      // …and it reaches the printed command too, not only the table.
      expect(sandboxRunCommand(row!)).toContain('motir-sandbox:zzz-test-profile');
      expect(sandboxRunCommand(row!)).toContain('$HOME/.zzz:/home/node/.zzz:ro');
    } finally {
      (AGENT_PROFILES as unknown as unknown[]).pop();
    }
  });

  it('prints a run command whose mounts match the profile it names', () => {
    for (const row of sandboxProfileRows()) {
      const command = sandboxRunCommand(row);
      expect(command).toContain(`ghcr.io/moooon-b-v/motir-sandbox:${row.id}`);
      // No `--rm`: step 4 signs in INSIDE the container, and `--rm` would throw
      // that away on exit (sandbox/README.md § the three ways).
      expect(command).not.toContain('--rm');
      expect(command).toContain('--name motir-sandbox');
      expect(command).toContain('-v "$PWD:/workspace"');
      for (const mount of row.mounts) {
        const bare = mount.replace(/^~\//, '');
        expect(command).toContain(`$HOME/${bare}:/home/node/${bare}:ro`);
      }
      // A profile with no mount gets no credential bind at all.
      if (row.mounts.length === 0) expect(command).not.toContain(':ro');
    }
  });
});

describe('guard: the cross-package import stays a single, bounded seam', () => {
  it('is imported by exactly ONE module under app/ or lib/', () => {
    // ADR Amendment 9 Q3 permits one crossing. One is a documented seam; a habit
    // is a merged build, and the CLI's dependency graph arriving in the app
    // through a documentation page is what this refuses.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          // An IMPORT, not a mention. Several modules name `packages/cli` in a
          // comment to explain a contract they share with it; that is
          // documentation, not a dependency, and a guard that cannot tell the
          // difference would be turned off the first time it fired on prose.
          const source = read(path);
          if (/\bfrom\s+'[^']*packages\/cli\//.test(source)) offenders.push(path);
        }
      }
    };
    walk('lib');
    walk('app');
    expect(offenders).toEqual(['lib/apiDocs/sandbox.ts']);
  });

  it('reaches a CLI module that imports nothing but node: builtins', () => {
    const source = read('packages/cli/src/agentProfiles.ts');
    const imports = [...source.matchAll(/^import .*? from '([^']+)';/gm)].map((m) => m[1]!);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
  });

  it('exports plain serializable data, so a row may cross to a client component', () => {
    for (const row of sandboxProfileRows()) {
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
      for (const value of Object.values(row)) expect(typeof value).not.toBe('function');
    }
  });
});
