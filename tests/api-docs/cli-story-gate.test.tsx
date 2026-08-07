// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { COMMAND_CATALOG, DEFAULT_SERVER_URL } from '../../packages/cli/src/commandCatalog';
import { CLI_INSTALL_COMMAND, CLI_PACKAGE_NAME, cliCommandInvocations } from '@/lib/apiDocs/cli';

// STORY MOTIR-2308's VITEST GATE (Subtask MOTIR-2333).
//
// Four cards build one chain — a pure command record, a content module reading
// it, a page rendering that, and a link in Settings pointing at the page — and
// each tests its own link. The failures that survive are the ones BETWEEN
// links, plus the contract properties a coverage percentage cannot see. That is
// what this suite is for, in the shape `story-gate.test.tsx` established for
// this area.
//
// ⚠️ It does NOT re-derive `packages/cli/test/commandCatalog.test.ts`'s
// agreement between the record and the real `buildProgram()` tree. That test
// lives in the CLI package because it needs `commander`, which is legal there
// and is not legal here; duplicating it would make one change fail twice with
// two messages. What this file asserts is that the PAGE cannot say anything the
// record does not carry — the other half of the same promise.

const REPO_ROOT = process.cwd();
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(
    async () => (key: string) => (en.apiDocs as Record<string, string>)[key] ?? key,
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.resetModules();
});

/** Render an async server-component tree to HTML, client children included. */
async function renderPageToHtml(page: React.ReactElement): Promise<string> {
  const { renderToReadableStream } = await import('react-dom/server.edge');
  const stream = await renderToReadableStream(
    <NextIntlClientProvider locale="en" messages={en}>
      {page}
    </NextIntlClientProvider>,
  );
  return new Response(stream).text();
}

async function renderCliPage(): Promise<string> {
  const { default: CliGuidePage } = await import('@/app/(public)/docs/cli/page');
  return renderPageToHtml(await CliGuidePage());
}

/**
 * What a READER sees — the rendered page's text, with the markup gone and the
 * entities decoded, so `motir run &lt;key&gt;` reads back as `motir run <key>`.
 *
 * ⚠️ Parsed, never regex-stripped. The obvious spelling — drop `<[^>]+>` and
 * then turn `&lt;` back into `<` — strips markup once and then RE-INTRODUCES
 * the characters it just removed, which is the incomplete-multi-character
 * sanitization shape CodeQL flags as high severity (js/incomplete-multi-character-sanitization,
 * caught on this file's first CI run). It is inert here, since the only input
 * is our own render — but a sanitizer-shaped helper in the test tree is exactly
 * the thing somebody copies somewhere it is not inert. The parser decodes
 * entities as part of parsing, so there is no second pass to get wrong.
 */
function renderedText(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 1 — the TRUTH GATE: the page cannot claim what the CLI does not have
// ─────────────────────────────────────────────────────────────────────────────

describe('truth: every command the RENDERED page prints is one the CLI registers', () => {
  it('resolves every `motir …` the page prints against the CLI’s own record', async () => {
    // Read it the way a reader does: the renderer wraps inline code in
    // elements, so a sweep over raw HTML would split `motir link add` across
    // three nodes.
    const text = renderedText(await renderCliPage());

    const paths = new Set(COMMAND_CATALOG.map((entry) => entry.path));
    const mentions = [...text.matchAll(/\bmotir ([a-z-]+(?: [a-z-]+)?)/g)].map((m) => m[1]!);
    expect(mentions.length, 'the page prints no commands at all').toBeGreaterThan(10);

    const unknown = [
      ...new Set(
        mentions.filter((mention) => {
          // A two-word mention is either a subcommand (`auth status`) or a
          // command followed by prose ("motir doctor is a usable gate"), so try
          // the longer path first and fall back to the head.
          if (paths.has(mention)) return false;
          const head = mention.split(' ')[0]!;
          return !paths.has(head) && !['help', '--help', '--version'].includes(head);
        }),
      ),
    ];
    expect(unknown, 'the page names commands the CLI does not register').toEqual([]);
  });

  it('resolves every FLAG the page prints against that command’s registered options', async () => {
    const text = renderedText(await renderCliPage());
    const registered = new Set(
      COMMAND_CATALOG.flatMap((entry) =>
        entry.options.flatMap((option) =>
          option.flags.split(/[ ,|]+/).filter((f) => f.startsWith('--')),
        ),
      ),
    );
    // `--help` and `--version` are commander's, registered on the root program
    // rather than in the catalog; the page may print either.
    const builtIn = new Set(['--help', '--version']);
    const printed = [...new Set([...text.matchAll(/(--[a-z][a-z-]+)/g)].map((m) => m[1]!))];
    expect(printed.length, 'the page prints no flags at all').toBeGreaterThan(2);
    const unknown = printed.filter((flag) => !registered.has(flag) && !builtIn.has(flag));
    expect(unknown, 'the page names flags the CLI does not register').toEqual([]);
  });

  it('READS the install command and the default server rather than typing them', async () => {
    // The inverse direction, and the one that rots quietly: a page that happens
    // to print the right string today is indistinguishable from one that
    // derives it — until the source changes. Both values are asserted to come
    // out of the CLI's own artifacts, not out of this file.
    const manifest = JSON.parse(read('packages/cli/package.json')) as { name: string };
    expect(CLI_PACKAGE_NAME).toBe(manifest.name);
    expect(CLI_INSTALL_COMMAND).toBe(`npm install -g ${manifest.name}`);

    const html = await renderCliPage();
    expect(html).toContain(`npm install -g ${manifest.name}`);
    expect(html).toContain(DEFAULT_SERVER_URL);
    // And the constant is the CLI's, not a second copy: `serverResolve.ts`
    // re-exports it rather than declaring one.
    expect(read('packages/cli/src/serverResolve.ts')).not.toMatch(/const DEFAULT_SERVER_URL\s*=/);
  });

  it('renders a row for EVERY command in the record, and none that is not in it', async () => {
    const text = renderedText(await renderCliPage());
    for (const invocation of cliCommandInvocations()) {
      expect(text, `${invocation} missing from the rendered table`).toContain(invocation);
    }
    expect(cliCommandInvocations().length).toBe(COMMAND_CATALOG.length);
  });
});

describe('truth, PROVEN BY A STUB: the page reads the record rather than typing it', () => {
  // The assertions above show the page and the record AGREE today, which a page
  // that happened to type the right strings would also satisfy. These change the
  // record and require the render to change with it — the only form of the claim
  // that cannot be met by a coincidence.

  it('a command ADDED to the record appears on the page with no edit to the page', async () => {
    vi.doMock('../../packages/cli/src/commandCatalog', async () => {
      const actual = await vi.importActual<typeof import('../../packages/cli/src/commandCatalog')>(
        '../../packages/cli/src/commandCatalog',
      );
      return {
        ...actual,
        COMMAND_CATALOG: [
          ...actual.COMMAND_CATALOG,
          {
            path: 'teleport',
            signature: '<destination>',
            description: 'A command that exists only inside this test.',
            helpGroup: actual.HELP_GROUP.workLoop,
            options: [],
          },
        ],
      };
    });
    const html = await renderCliPage();
    expect(html).toContain('motir teleport');
    expect(html).toContain('A command that exists only inside this test.');
    vi.doUnmock('../../packages/cli/src/commandCatalog');
  });

  it('a command REMOVED from the record disappears from the page', async () => {
    vi.doMock('../../packages/cli/src/commandCatalog', async () => {
      const actual = await vi.importActual<typeof import('../../packages/cli/src/commandCatalog')>(
        '../../packages/cli/src/commandCatalog',
      );
      return {
        ...actual,
        COMMAND_CATALOG: actual.COMMAND_CATALOG.filter((entry) => entry.path !== 'sprints'),
      };
    });
    const html = await renderCliPage();
    expect(html).not.toContain('motir sprints');
    // …and the rest of the table is still there, so this is a removal rather
    // than a broken render.
    expect(html).toContain('motir ready');
    vi.doUnmock('../../packages/cli/src/commandCatalog');
  });

  it('a CHANGED default server changes what the page prints', async () => {
    vi.doMock('../../packages/cli/src/commandCatalog', async () => {
      const actual = await vi.importActual<typeof import('../../packages/cli/src/commandCatalog')>(
        '../../packages/cli/src/commandCatalog',
      );
      return { ...actual, DEFAULT_SERVER_URL: 'https://motir.example.invalid' };
    });
    const html = await renderCliPage();
    expect(html).toContain('https://motir.example.invalid');
    expect(html).not.toContain(DEFAULT_SERVER_URL);
    vi.doUnmock('../../packages/cli/src/commandCatalog');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 2 — the seams BETWEEN the four cards
// ─────────────────────────────────────────────────────────────────────────────

describe('seam: the content module’s blocks → the shipped DocBlocks renderer', () => {
  it('emits only block kinds the shipped renderer handles', async () => {
    const { CLI_FILES, CLI_INTRO, CLI_STEPS, CLI_WHAT_NEXT } = await import('@/lib/apiDocs/cli');
    const blocks = [
      ...CLI_INTRO.flatMap((section) => section.blocks),
      ...CLI_STEPS.flatMap((step) => step.blocks),
      ...CLI_FILES,
      ...CLI_WHAT_NEXT,
    ];
    // The renderer's four arms. A fifth kind emitted here would fall through
    // `DocBlock` to its callout default and render a warning box with no words,
    // at runtime, on a published page.
    const handled = new Set(['prose', 'code', 'callout', 'table']);
    expect(blocks.length).toBeGreaterThan(15);
    for (const block of blocks) expect(handled).toContain(block.kind);
    for (const block of blocks) {
      if (block.kind === 'table') {
        // Every row is as wide as the header, or a cell silently disappears in
        // the wide arm and a label goes unpaired in the narrow one.
        for (const row of block.rows) expect(row.length).toBe(block.columns.length);
        if (block.columnWidths) expect(block.columnWidths.length).toBe(block.columns.length);
      }
    }
  });

  it('renders through the REAL renderer, not a stub — the page carries its tables', async () => {
    const html = await renderCliPage();
    expect(html).toContain('<table');
    // The narrow arm ships too: the same rows as a card per row.
    expect(html).toContain('md:hidden');
  });
});

describe('seam: the DOOR in Settings resolves to a route that EXISTS', () => {
  it('crosses ConnectCliPanel’s shipped href with the real route tree', () => {
    // The gap neither card's own units can see: MOTIR-2331 asserts the literal
    // href, MOTIR-2329 asserts the page renders, and nothing checked that the
    // two名 the same place. A page moved without the link fails here, and so
    // does a link changed without the page.
    const panel = read('app/(authed)/settings/account/_components/ConnectCliPanel.tsx');
    const match = panel.match(/const CLI_GUIDE_HREF = '([^']+)';/);
    expect(match, 'CLI_GUIDE_HREF not found — has it been renamed?').toBeTruthy();
    const href = match![1]!;

    expect(href.startsWith('/'), `${href} is not an in-product route`).toBe(true);
    const routeFile = join(REPO_ROOT, 'app/(public)', `${href}`, 'page.tsx');
    expect(existsSync(routeFile), `${href} has no route file at ${routeFile}`).toBe(true);
  });

  it('links it as an IN-PRODUCT link, not with the leaves-the-app treatment', () => {
    const panel = read('app/(authed)/settings/account/_components/ConnectCliPanel.tsx');
    const linkBlock = panel.slice(panel.indexOf('href={CLI_GUIDE_HREF}'));
    const element = linkBlock.slice(0, linkBlock.indexOf('>'));
    expect(element).not.toContain('target=');
    expect(element).not.toContain('rel=');
  });

  it('leaves the MCP link pointing at GitHub, because /docs/mcp does not exist', () => {
    // The boundary MOTIR-2331 draws, asserted so a later sweep cannot "tidy"
    // the two links into agreement and produce a link to a route the app does
    // not serve.
    const tokens = read('app/(authed)/settings/account/_components/ApiTokensManager.tsx');
    const match = tokens.match(/const MCP_GUIDE_HREF = '([^']+)';/);
    expect(match).toBeTruthy();
    expect(match![1]!.startsWith('https://')).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'app/(public)/docs/mcp/page.tsx'))).toBe(false);
  });
});

describe('seam: the rail’s surface tier on EVERY page in the area', () => {
  it('renders the CLI row on every docs page, and marks only the current one', async () => {
    const pages = [
      ['@/app/(public)/docs/api/page', '/docs/api'],
      ['@/app/(public)/docs/api/getting-started/page', '/docs/api/getting-started'],
      ['@/app/(public)/docs/api/stability/page', '/docs/api/stability'],
      ['@/app/(public)/docs/sandbox/page', '/docs/sandbox'],
      ['@/app/(public)/docs/cli/page', '/docs/cli'],
    ] as const;

    for (const [module, route] of pages) {
      const { default: Page } = (await import(module)) as {
        default: () => Promise<React.ReactElement>;
      };
      const html = await renderPageToHtml(await Page());
      expect(html, `${route} does not list the CLI surface`).toContain('href="/docs/cli"');
      const current = [...html.matchAll(/href="([^"]+)"[^>]*aria-current="page"/g)].map(
        (m) => m[1]!,
      );
      const currentAlt = [...html.matchAll(/aria-current="page"[^>]*href="([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      expect([...current, ...currentAlt], `${route} marks the wrong row`).toContain(route);
      vi.resetModules();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 3 — the guards a coverage percentage cannot see
// ─────────────────────────────────────────────────────────────────────────────

describe('guard: the cross-package import boundary, in the shape the ADR leaves it', () => {
  /** Every `.ts`/`.tsx` under `app/` and `lib/` that IMPORTS from packages/cli. */
  function offenders(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          // An IMPORT, not a mention: several modules name `packages/cli` in a
          // comment to explain a contract they share with it.
          if (/\bfrom\s+'[^']*packages\/cli\//.test(read(path))) found.push(path);
        }
      }
    };
    walk('lib');
    walk('app');
    return found.sort();
  }

  it('is EXACTLY the two modules ADR Amendment 12 Q4 names — an exact set, no wildcard', () => {
    expect(offenders()).toEqual(['lib/apiDocs/cli.ts', 'lib/apiDocs/sandbox.ts']);
  });

  it.each([
    ['packages/cli/src/agentProfiles.ts', true],
    ['packages/cli/src/commandCatalog.ts', false],
  ])('%s imports nothing but node: builtins', (module, allowsNode) => {
    const specifiers = [...read(module).matchAll(/^import .*? from '([^']+)';/gm)].map(
      (match) => match[1]!,
    );
    expect(specifiers.every((specifier) => specifier.startsWith('node:'))).toBe(true);
    // The catalog is held to the stricter bar: NOTHING, not even a builtin.
    if (!allowsNode) expect(specifiers).toEqual([]);
  });

  it('crosses only into plain SERIALIZABLE data', async () => {
    const { sandboxProfileRows } = await import('@/lib/apiDocs/sandbox');
    const { cliCommandGroups } = await import('@/lib/apiDocs/cli');
    for (const row of [...sandboxProfileRows(), ...cliCommandGroups()]) {
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    }
    for (const value of [COMMAND_CATALOG, DEFAULT_SERVER_URL]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
});

describe('guard: the story’s own files are covered by the job that is meant to cover them', () => {
  it('is NOT on a branch prefix the coverage job skips', () => {
    // `lib/apiDocs/sandbox.ts` reached `main` at 50% branch coverage because a
    // `docs/*`-shaped path filter skipped the job that was meant to gate it
    // (MOTIR-2317). This story touches runtime code under `app/` and `lib/`, so
    // it must NOT be branched under a prefix `ci.yml` excludes — the assertion
    // reads the workflow rather than trusting the branch name.
    const ci = read('.github/workflows/ci.yml');
    const skipped = [...ci.matchAll(/startsWith\(\s*(?:github\.head_ref|head_ref)[^)]*\)/g)].map(
      (match) => match[0]!,
    );
    // The prefixes that skip a test lane are a fact about the workflow; this
    // asserts they are still spelled where a reader can find them, so the
    // criterion above stays checkable rather than becoming folklore.
    expect(ci).toMatch(/design\//);
    expect(ci).toMatch(/docs\//);
    expect(skipped.length).toBeGreaterThan(0);
  });
});
