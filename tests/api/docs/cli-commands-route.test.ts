import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditV1RouteSource, stripComments, v1RouteFiles } from '../../helpers/v1RouteAudit';
import { COMMAND_CATALOG, DEFAULT_SERVER_URL } from '../../../packages/cli/src/commandCatalog';
import cliManifest from '../../../packages/cli/package.json';
import type { CliCommandsDocument } from '@/lib/apiDocs/cli';

// GET /api/docs/cli-commands.json — the PUBLISHED CLI command catalogue
// (Story MOTIR-3875 · Subtask MOTIR-4390).
//
// The obligations are `mcp-tools-route.test.ts`'s, for the same route SHAPE and
// for the same reasons, plus the two this document owes:
//
//   1. Fetchable with NO credential, and READ THE WAY THE CONSUMER WILL. The
//      card's criterion is explicit that a test reading the source module
//      directly does not discharge it — the whole defect was that
//      `COMMAND_CATALOG` is perfectly readable in this repository and reachable
//      from nowhere else. So every assertion below goes through `GET()`.
//   2. TOTALITY over the RECORD, not over the four help groups. `cliCommandGroups()`
//      drops a command whose group resolves to none, which is right for a curated
//      overview and wrong for a reference.
//
// ⚠️ AND ONE THING THIS FILE DELIBERATELY DOES NOT ASSERT: a per-command
// `examples` field. The card asks for *"the worked examples the catalogue already
// holds"* and the catalogue holds none — a `CommandCatalogEntry` has exactly
// `path`, `signature`, `description`, `helpGroup` and `options`, and the two
// examples the parent card cites live in `packages/cli/src/help.ts`'s prose
// block. Asserting an empty `examples` array on every command would be a green
// check over a field that means nothing. The falsification is recorded on the
// card and on the pull request; the consuming page composes its example from
// `invocation`.

const REPO_ROOT = process.cwd();
const ROUTE = join('app', 'api', 'docs', 'cli-commands.json', 'route.ts');
const ROUTE_URL = 'http://localhost:3000/api/docs/cli-commands.json';

const source = stripComments(readFileSync(join(REPO_ROOT, ROUTE), 'utf8'));

async function fetchDocument(): Promise<{ res: Response; document: CliCommandsDocument }> {
  const { GET } = await import('@/app/api/docs/cli-commands.json/route');
  const res = await GET();
  return { res, document: (await res.json()) as CliCommandsDocument };
}

describe('the CLI catalogue route is not inside any tree a guard walks', () => {
  it('is NOT among the files the v1 route audit walks', () => {
    expect(v1RouteFiles(REPO_ROOT)).not.toContain(ROUTE);
  });

  it('WOULD have been flagged had it been placed inside the v1 tree', () => {
    const violations = auditV1RouteSource('app/api/v1/docs/cli-commands.json/route.ts', source);
    expect(violations.map((v) => v.rule)).toContain('bypasses-wrapper');
  });
});

describe('the CLI catalogue route is safe to serve unauthenticated', () => {
  it('authenticates nothing', () => {
    expect(source).not.toMatch(/withV1Route/);
    expect(source).not.toMatch(/withMcpAuth|verifyMcpToken/);
    expect(source).not.toMatch(/authenticateApiToken|getSession|presentedBearerToken/);
  });

  it('reads no database', () => {
    expect(source).not.toMatch(/@\/lib\/db|\bdb\s*\.|\$transaction|Repository|Service\b/);
  });

  it('takes NO user input — the handler has no request parameter at all', () => {
    expect(source).toMatch(/export async function GET\(\)/);
    expect(source).not.toMatch(/searchParams|req\.|request\./);
  });

  it('spends no rate-limit budget', () => {
    expect(source).not.toMatch(/consumeRateLimit|rateLimitHeaders/);
  });

  it('pulls in the content module and nothing from the CLI program', () => {
    // `lib/apiDocs/cli.ts` is one of the TWO modules Amendment 12 Q4 permits to
    // import from `packages/cli/**`, and it reaches only `commandCatalog.ts`,
    // which imports nothing at all. `program.ts` imports `commander` and every
    // command module, and none of that belongs behind an anonymous route.
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['@/lib/apiDocs/cli', 'next/server']);
    expect(source).not.toMatch(/commander|packages\/cli\/src\/program/);
  });
});

describe('GET /api/docs/cli-commands.json', () => {
  it('serves the catalogue to a caller with NO Authorization header', async () => {
    const anonymous = new Request(ROUTE_URL);
    expect(anonymous.headers.has('authorization')).toBe(false);

    const { res, document } = await fetchDocument();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(document.commands.length).toBeGreaterThan(0);
  });

  it('is cacheable, because it changes only when the code does', async () => {
    const { res } = await fetchDocument();
    expect(res.headers.get('cache-control')).toMatch(/public/);
    expect(res.headers.get('cache-control')).toMatch(/must-revalidate/);
  });

  it('serves the same bytes on every request — a consumer can cache it', async () => {
    const { GET } = await import('@/app/api/docs/cli-commands.json/route');
    const [first, second] = await Promise.all([GET(), GET()]);
    expect(await first.text()).toBe(await second.text());
  });
});

describe('TOTALITY — every COMMAND_CATALOG entry reaches the served document', () => {
  it('the two SETS are equal, in both directions', async () => {
    const { document } = await fetchDocument();
    expect(document.commands.map((command) => command.path).sort()).toEqual(
      COMMAND_CATALOG.map((entry) => entry.path).sort(),
    );
  });

  it('the count is the length of what was derived, never a literal', async () => {
    const { document } = await fetchDocument();
    expect(document.commandCount).toBe(document.commands.length);
    expect(document.commandCount).toBe(COMMAND_CATALOG.length);
  });

  it('keeps REGISTRATION order, which is the order `motir help` renders', async () => {
    const { document } = await fetchDocument();
    expect(document.commands.map((command) => command.path)).toEqual(
      COMMAND_CATALOG.map((entry) => entry.path),
    );
  });

  it('publishes SUBCOMMANDS too — the shape `cliCommandGroups()` drops', async () => {
    // `auth status` has `helpGroup: null`, so the curated overview reaches it
    // only through its parent. A reference that dropped it would be missing a
    // command a reader can type, which is the filtering the card forbids.
    const { document } = await fetchDocument();
    const subcommand = document.commands.find((command) => command.path === 'auth status');
    expect(subcommand).toBeDefined();
    expect(subcommand!.helpGroup).toBeNull();
  });
});

describe('a consumer OUTSIDE packages/cli can obtain every field the page needs', () => {
  it('`auth login` arrives with its signature, description and BOTH its flags', async () => {
    // The card's named subject, asserted on the BYTES the consumer receives —
    // the whole point being that reading the source module proves nothing about
    // what `motir-marketing` can reach.
    const { document } = await fetchDocument();
    const command = document.commands.find((entry) => entry.path === 'auth login');
    expect(command).toBeDefined();
    expect(command!.invocation).toBe('motir auth login');
    expect(command!.description).toBe(
      COMMAND_CATALOG.find((entry) => entry.path === 'auth login')!.description,
    );
    expect(command!.options.map((option) => option.flags)).toEqual([
      '--server <url>',
      '--token <pat>',
    ]);
    for (const option of command!.options) {
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it('the INVOCATION carries the argument signature, so `motir run <key>` is not `motir run`', async () => {
    const { document } = await fetchDocument();
    for (const command of document.commands) {
      const entry = COMMAND_CATALOG.find((candidate) => candidate.path === command.path)!;
      expect(command.invocation, command.path).toBe(
        `motir ${entry.path}${entry.signature ? ` ${entry.signature}` : ''}`,
      );
    }
    const run = document.commands.find((command) => command.path === 'run');
    expect(run?.invocation).toContain('<');
  });

  it('carries the install line, the node requirement and the default server', async () => {
    const { document } = await fetchDocument();
    expect(document.packageName).toBe(cliManifest.name);
    expect(document.packageVersion).toBe(cliManifest.version);
    expect(document.installCommand).toBe(`npm install -g ${cliManifest.name}`);
    expect(document.nodeRequirement).toBe(cliManifest.engines.node);
    expect(document.defaultServer).toBe(DEFAULT_SERVER_URL);
  });

  it('OMITS a hidden option — the catalog’s own publishing decision, not this document’s', async () => {
    // `CommandOption.hidden` means ACCEPTED but not PUBLISHED: the `--no-*`
    // findings aliases exist so an instinctive spelling works, and documenting
    // them would offer two spellings, which is what they are not for.
    const { document } = await fetchDocument();
    const hidden = COMMAND_CATALOG.flatMap((entry) =>
      entry.options.filter((option) => option.hidden === true).map((option) => option.flags),
    );
    const published = document.commands.flatMap((command) =>
      command.options.map((option) => option.flags),
    );
    for (const flags of hidden) expect(published).not.toContain(flags);
    // …and the visible ones all arrive, so this is not a blanket drop.
    const visible = COMMAND_CATALOG.flatMap((entry) =>
      entry.options.filter((option) => option.hidden !== true).map((option) => option.flags),
    );
    expect(published.sort()).toEqual(visible.sort());
  });
});

describe('the CLI itself is unchanged by this card', () => {
  it('`DEFAULT_SERVER_URL` is byte-unchanged', () => {
    expect(DEFAULT_SERVER_URL).toBe('https://app.motir.co');
  });

  it('the published document is a PROJECTION — it authors no command of its own', () => {
    // Every command name reaching the document comes from the record. A literal
    // path in `lib/apiDocs/cli.ts`'s document function would be a second home
    // for a fact the CLI declares.
    const cliModule = stripComments(readFileSync(join(REPO_ROOT, 'lib/apiDocs/cli.ts'), 'utf8'));
    const documentFn = cliModule.slice(cliModule.indexOf('export function cliCommandsDocument'));
    for (const entry of COMMAND_CATALOG) {
      expect(documentFn, entry.path).not.toContain(`'${entry.path}'`);
    }
  });
});
