// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { COMMAND_CATALOG, DEFAULT_SERVER_URL } from '../../packages/cli/src/commandCatalog';
import {
  CLI_FILES,
  CLI_INSTALL_COMMAND,
  CLI_INTRO,
  CLI_NODE_REQUIREMENT,
  CLI_PACKAGE_NAME,
  CLI_STEPS,
  CLI_WHAT_NEXT,
  cliCommandGroups,
  cliCommandInvocations,
  cliInvocation,
} from '@/lib/apiDocs/cli';
import { CatalogueNav, type DocsPage } from '@/app/(public)/docs/_components/CatalogueNav';
import CliGuidePage from '@/app/(public)/docs/cli/page';

// The /docs/cli guide's own unit suite (Story MOTIR-2308 · Subtask MOTIR-2329).
//
// The STORY-level gate — the truth assertions against the CLI's record, the
// door-to-route seam, the import boundary in its final shape — is MOTIR-2333's
// and lives in `cli-story-gate.test.tsx`. What is here is this card's own floor:
// the content module's derivation, the page's render, and the rail's new row.

const REPO_ROOT = join(import.meta.dirname, '..', '..');

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) =>
    (enMessages.apiDocs as Record<string, string>)[key] ?? key,
}));

async function renderPage() {
  const ui = await CliGuidePage();
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('lib/apiDocs/cli — the facts are DERIVED, not typed', () => {
  it('reads the package name off the CLI’s own manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/cli/package.json'), 'utf8'),
    ) as { name: string; engines: { node: string } };
    expect(CLI_PACKAGE_NAME).toBe(manifest.name);
    expect(CLI_INSTALL_COMMAND).toBe(`npm install -g ${manifest.name}`);
    expect(CLI_NODE_REQUIREMENT).toBe(manifest.engines.node);
  });

  it('builds every table row from COMMAND_CATALOG, and drops none of it', () => {
    const groups = cliCommandGroups();
    const paths = groups.flatMap((group) => group.rows.map((row) => row.path)).sort();
    expect(paths).toEqual(COMMAND_CATALOG.map((entry) => entry.path).sort());
    for (const group of groups) {
      for (const row of group.rows) {
        const entry = COMMAND_CATALOG.find((candidate) => candidate.path === row.path)!;
        expect(row.description).toBe(entry.description);
        expect(row.invocation).toBe(cliInvocation(entry));
      }
    }
  });

  it('prints a command’s ARGUMENT SIGNATURE, so `motir run <key>` is not `motir run`', () => {
    const invocations = cliCommandInvocations();
    expect(invocations).toContain('motir run <key>');
    expect(invocations).toContain('motir sprint [ref]');
    expect(invocations).toContain('motir link add <repo> <path>');
    expect(invocations).not.toContain('motir run');
  });

  it('files a SUBCOMMAND under its parent’s help group', () => {
    const setup = cliCommandGroups().find((group) => group.caption === 'setup')!;
    const paths = setup.rows.map((row) => row.path);
    expect(paths).toContain('auth');
    expect(paths).toContain('auth status');
  });

  it('names only commands the CLI registers', () => {
    const known = new Set(COMMAND_CATALOG.map((entry) => entry.path));
    for (const step of CLI_STEPS) {
      for (const command of step.cliCommands ?? []) expect(known).toContain(command);
    }
    // The guard on the guard: a step set that declared nothing would pass the
    // loop above by doing nothing at all.
    expect(CLI_STEPS.flatMap((step) => step.cliCommands ?? []).length).toBeGreaterThan(5);
  });

  it('DROPS a subcommand whose parent is not in the record, rather than mis-filing it', async () => {
    // The orphan arm of `groupOf`. It cannot happen with a record
    // `packages/cli/test/commandCatalog.test.ts` pins against the real tree —
    // which is exactly why it needs a stub to reach: an entry with no help
    // group and no findable parent belongs under no heading, and the table must
    // leave it out rather than guess one.
    vi.resetModules();
    vi.doMock('../../packages/cli/src/commandCatalog', async () => {
      const actual = await vi.importActual<typeof import('../../packages/cli/src/commandCatalog')>(
        '../../packages/cli/src/commandCatalog',
      );
      return {
        ...actual,
        COMMAND_CATALOG: [
          ...actual.COMMAND_CATALOG,
          {
            path: 'ghost orphan',
            signature: '',
            description: 'A subcommand whose parent does not exist.',
            helpGroup: null,
            options: [],
          },
        ],
      };
    });
    const { cliCommandGroups: stubbed } = await import('@/lib/apiDocs/cli');
    const paths = stubbed().flatMap((group) => group.rows.map((row) => row.path));
    expect(paths).not.toContain('ghost orphan');
    expect(paths).toContain('auth status');
    vi.doUnmock('../../packages/cli/src/commandCatalog');
    vi.resetModules();
  });

  it('cites the CLI’s own default server rather than a retyped host', () => {
    const prose = CLI_FILES.filter((block) => block.kind === 'prose')
      .map((block) => block.text)
      .join(' ');
    expect(prose).toContain(DEFAULT_SERVER_URL);
  });
});

describe('GET /docs/cli', () => {
  it('renders the lede, every numbered step, and the finish line', async () => {
    await renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: enMessages.apiDocs.cliTitle }),
    ).toBeTruthy();
    for (const step of [...CLI_INTRO, ...CLI_STEPS]) {
      expect(screen.getByRole('heading', { name: new RegExp(step.title) })).toBeTruthy();
    }
    expect(screen.getByRole('heading', { name: enMessages.apiDocs.cliWhatNext })).toBeTruthy();
  });

  it('prints the derived install command and the whole command table', async () => {
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain(CLI_INSTALL_COMMAND);
    for (const invocation of cliCommandInvocations()) expect(text).toContain(invocation);
  });

  it('renders one table per help group, each with the command column pinned', async () => {
    const { container } = await renderPage();
    const section = container.querySelector('#every-command')!;
    const tables = section.querySelectorAll('table');
    expect(tables.length).toBe(cliCommandGroups().length);
    for (const table of tables) {
      const first = table.querySelector('th')!;
      expect(first.className).toContain('w-[34%]');
    }
  });

  it('renders the rail with the CLI row current, and NO operation index', async () => {
    const { container } = await renderPage();
    const nav = container.querySelector('nav')!;
    const current = within(nav as HTMLElement).getByRole('link', {
      name: enMessages.apiDocs.navCli,
    });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.getAttribute('href')).toBe('/docs/cli');
    // Amendment 11 Q2: the operation index is gated on the `/docs/api` prefix,
    // so a page outside it cannot acquire one by existing.
    expect(nav.querySelector('[data-testid="catalogue-subarea-api"]')).toBeNull();
    expect(nav.querySelector('[data-operation-id]')).toBeNull();
  });

  it('lists the CLI as a SURFACE on every page in the area, not only its own', () => {
    for (const page of ['reference', 'sandbox'] as DocsPage[]) {
      const view = render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <CatalogueNav current={page} />
        </NextIntlClientProvider>,
      );
      // Scoped to THIS render's container: several docs surfaces are mounted
      // across this file and the rail row exists on every one of them.
      const row = within(view.container).getByRole('link', {
        name: enMessages.apiDocs.navCli,
      });
      expect(row.getAttribute('href')).toBe('/docs/cli');
      expect(row.getAttribute('aria-current')).toBeNull();
      view.unmount();
    }
  });

  it('hands off to the reference, the sandbox guide and the API', async () => {
    const { container } = await renderPage();
    const hrefs = [...container.querySelectorAll('main a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/docs/sandbox');
    expect(hrefs).toContain('/docs/api');
    expect(hrefs).toContain('/docs/api/getting-started');
    const text = container.textContent ?? '';
    // The finish line names each destination and what it owns — the hand-off
    // Amendment 9 Q2 draws, rendered rather than implied.
    const handOffs = CLI_WHAT_NEXT.flatMap((block) =>
      block.kind === 'table' ? block.rows.map((row) => row[0]!) : [],
    );
    expect(handOffs.length).toBe(3);
    for (const label of handOffs) expect(text).toContain(label.replace(/[`*]/g, ''));
  });
});

describe('the catalogs carry the page’s chrome in both locales', () => {
  it('has an en/zh twin for every apiDocs key this card added', () => {
    const added = [
      'navCli',
      'cliTitle',
      'cliLede',
      'cliFilesHeading',
      'cliCommandsHeading',
      'cliCommandsLede',
      'cliThCommand',
      'cliThDoes',
      'cliWhatNext',
    ];
    for (const key of added) {
      expect(Object.keys(enMessages.apiDocs)).toContain(key);
      expect(Object.keys(zhMessages.apiDocs)).toContain(key);
      expect((zhMessages.apiDocs as Record<string, string>)[key]!.length).toBeGreaterThan(0);
    }
  });
});

describe('docs/cli.md points BACK at the published page', () => {
  it('links /docs/cli from its See also section and says which owns what', () => {
    const source = readFileSync(join(REPO_ROOT, 'docs/cli.md'), 'utf8');
    const seeAlso = source.slice(source.indexOf('## See also'));
    expect(seeAlso).toContain('/docs/cli');
    expect(seeAlso).toMatch(/reference/i);
  });
});
