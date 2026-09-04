import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MCP_ENDPOINT_PATH,
  MCP_EXAMPLE_ORIGIN,
  mcpClients,
  mcpToolCount,
  mcpTransportFacts,
} from '@/lib/apiDocs/mcp';

// THE MCP DOCUMENTATION MODULE'S OTHER THREE GUARDS — Story MOTIR-2309's truth
// gate (Subtask MOTIR-2330 · ADR `public-api-conventions.md` Amendment 13 Q2 and
// Q3a), restored here by MOTIR-4269.
//
// ── Why this file exists twice over ────────────────────────────────────────
// `tests/api-docs/mcp-truth.test.ts` was FOUR independent guard groups sharing
// one file, because the surface they all stood over — the MCP tool catalogue —
// happened to be rendered by a page in that directory. MOTIR-3951 deleted the
// `app/(public)/docs/**` pages and MOTIR-3932 deleted the directory with them,
// so four properties stopped being checked in one commit. MOTIR-4165 restored
// the first (the fingerprint pin, now `tests/mcp/tool-doc-truth.test.ts`)
// because its failure was already visible: a merged pull request had reworded a
// tool the next day and gone green. The other three failed SILENTLY, which is
// why they needed somebody to go and look:
//
//   1. THE PROSE COUNT     `docs/mcp.md` states the tool count in a sentence,
//                          and nothing under `tests/` compared it to the
//                          registry. It has drifted once before, silently, by
//                          three — and the assertion that caught it is the one
//                          that was deleted here.
//   2. CLIENT CONTAINMENT  Amendment 13 Q3a: every vendor block carries a
//                          checked date and a documentation link, INTERPOLATES
//                          the four shared transport facts rather than
//                          hard-coding them, and publishes no plausible-looking
//                          credential.
//   3. THE DEPENDENCY EDGE Amendment 13 Q2: `lib/apiDocs/mcp.ts` imports only
//                          `@/lib/mcp/toolPermissions` from `lib/mcp/`, never
//                          the registry, and no `node:` builtin — plus the
//                          no-count-literal rule that keeps the count derived.
//
// ── The one case that is NOT restored ──────────────────────────────────────
// `keeps the registry out of every public page` read
// `app/(public)/docs/mcp/page.tsx` and `.../tools/page.tsx`. Those paths left
// with MOTIR-3951 and there is nothing to assert about them. The property they
// held — that the catalogue's public reader cannot drag the registry, the
// services and Prisma into its graph — now belongs to the ROUTE that replaced
// them, and `tests/api/docs/mcp-tools-route.test.ts` holds it there. Arm 3
// below holds the module side of the same property, which is the half a page
// move cannot carry off.
//
// ── The home, chosen for one property ──────────────────────────────────────
// Like its sibling: this file imports NO route, NO page and nothing under
// `app/`. It reads two files as TEXT and calls two data functions, so no
// deletion of a page can take it along a second time. That is asserted below
// rather than merely intended.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

/**
 * THE COUNT PREDICATE, extracted so the counterfactuals below drive the SAME
 * code the real assertion runs. A gate proved only to pass is a comment — and
 * this one guards a sentence in a Markdown file, which is precisely the kind of
 * subject a tautological assertion looks green over forever.
 *
 * Returns the complaint, or `null` when the reference agrees with the registry.
 */
function countMismatch(reference: string, registry: number): string | null {
  const match = reference.match(/registers \*\*(\d+) tools\*\*/);
  if (!match) return '`docs/mcp.md` states no `registers **N tools**` sentence at all';
  const stated = Number(match[1]);
  return stated === registry
    ? null
    : `\`docs/mcp.md\` states ${stated} tools, the registry holds ${registry}`;
}

describe('the in-repo reference states the SAME tool count as the registry (MOTIR-3121)', () => {
  // The catalogue module DERIVES its count, so it cannot drift. The in-repo
  // reference the module fronts (`MCP_REFERENCE_URL`) states it in PROSE, and a
  // prose number cannot be held total by typecheck the way a
  // `Record<Name, …>` can. Until MOTIR-3121 nothing compared the two and the
  // sentence absorbed three tools silently: at MOTIR-3098's base the registry
  // held 41 while the sentence said 39. The natural move for anyone adding a
  // tool is to INCREMENT the number they read rather than to count the
  // registry, which propagates the error instead of fixing it — so the
  // assertion is the only thing that holds it, and it costs one line.
  //
  // ⚠️ AND THE SECOND DRIFT MOTIR-4269 WAS FILED ABOUT DID NOT HAPPEN — kept
  // here because the mis-measurement is a better argument for this gate than the
  // defect would have been. The card measured the registry with
  // `grep -c 'descriptionFingerprint:' lib/apiDocs/mcp.ts`, which answers 56:
  // 55 tool entries plus the `descriptionFingerprint: string` line of the
  // INTERFACE that declares the field. `mcpToolCount()` reads the catalogue and
  // returns 55, which is what `docs/mcp.md` already said. The card's command was
  // a proxy for the predicate its claim was about, and the two differ by one
  // type declaration. This gate is what closes that gap for good: the number is
  // never counted by hand again, by anyone, in either direction.
  it('`docs/mcp.md` states the count the registry holds', () => {
    expect(countMismatch(read('docs/mcp.md'), mcpToolCount())).toBeNull();
  });

  it('FIRES on a drifted sentence, naming both numbers', () => {
    const registry = mcpToolCount();
    const drifted = read('docs/mcp.md').replace(
      /registers \*\*\d+ tools\*\*/,
      `registers **${registry + 1} tools**`,
    );

    expect(countMismatch(drifted, registry)).toBe(
      `\`docs/mcp.md\` states ${registry + 1} tools, the registry holds ${registry}`,
    );
  });

  it('FIRES when the sentence is gone altogether — an absent claim is not a passing one', () => {
    const stripped = read('docs/mcp.md').replace(/registers \*\*\d+ tools\*\*/, 'registers tools');

    expect(countMismatch(stripped, mcpToolCount())).toBe(
      '`docs/mcp.md` states no `registers **N tools**` sentence at all',
    );
  });
});

describe('the client matrix containment (Amendment 13 Q3a)', () => {
  it('gives every block a checked date and a vendor documentation link', () => {
    for (const client of mcpClients()) {
      expect(client.checkedOn, `${client.id} has no checkedOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(client.docsUrl, `${client.id} has no docsUrl`).toMatch(/^https:\/\//);
    }
  });

  // The negative case Amendment 13 Q3a names: build the matrix with a sentinel
  // origin. A block that INTERPOLATES the single source carries the sentinel; a
  // block that hard-codes its own URL does not, and fails here.
  it('makes a block that hard-codes its own endpoint a RED BUILD', () => {
    const sentinel = 'https://sentinel.invalid';
    const offenders = mcpClients(mcpTransportFacts(sentinel)).filter(
      (client) =>
        !client.config.includes(`${sentinel}${MCP_ENDPOINT_PATH}`) ||
        client.config.includes(MCP_EXAMPLE_ORIGIN),
    );
    expect(
      offenders.map((client) => client.id),
      'these client blocks do not interpolate the shared endpoint',
    ).toEqual([]);
  });

  it('never publishes a plausible-looking credential in any block', () => {
    for (const client of mcpClients()) {
      expect(client.config).not.toMatch(/motir_pat_[A-Za-z0-9]{10,}/);
    }
  });
});

describe('the dependency-graph boundary (Amendment 13 Q2)', () => {
  it('imports nothing from lib/mcp except the tool→permission map', () => {
    // The boundary, re-pinned by MOTIR-2581: it was `lib/mcp/scopes`, which is
    // now the legacy table and no longer what this module reads.
    // `toolPermissions` is a LEAF whose only imports are types, so the property
    // this pin protects — a public reader that cannot drag the registry, the
    // services or Prisma into its bundle — is unchanged. The reader is now the
    // `/api/docs/mcp-tools.json` route (MOTIR-4194) rather than a page, which
    // changes nothing about the rule: it is still anonymous and still on the
    // internet.
    const source = read('lib/apiDocs/mcp.ts');
    const mcpImports = [...source.matchAll(/from '(@\/lib\/mcp\/[^']+)'/g)].map((m) => m[1]);
    expect([...new Set(mcpImports)]).toEqual(['@/lib/mcp/toolPermissions']);
  });

  it('never reaches the registry — the module that drags the services and Prisma', () => {
    expect(read('lib/apiDocs/mcp.ts')).not.toContain('lib/mcp/registry');
  });

  it('keeps node: builtins out of the module a public route imports', () => {
    // `fingerprintToolText` needs node:crypto, which is why it lives in its own
    // module that only the gate imports.
    expect(read('lib/apiDocs/mcp.ts')).not.toMatch(/from 'node:/);
    expect(read('lib/apiDocs/mcpFingerprint.ts')).toContain("from 'node:crypto'");
  });

  it('writes no tool COUNT as a literal in the content module', () => {
    const source = read('lib/apiDocs/mcp.ts');
    const body = source.slice(source.indexOf('export type McpCatalogueToolName'));
    expect(body).not.toMatch(new RegExp(`\\b${mcpToolCount()}\\b`));
  });
});

describe('the catalogue module cites no test that does not exist (MOTIR-4269)', () => {
  // The module tells its reader which gate holds each of its properties, and
  // those sentences are what a later reader trusts instead of going to look.
  // Both of the deletions above left such a sentence standing over a file that
  // no longer existed — `lib/apiDocs/mcp.ts` was still pointing at MOTIR-2330's
  // negative case months after it was deleted. A citation is a claim; this is
  // the one line that makes it fail like one.
  it('every `tests/…test.ts` path it names is a real file', () => {
    const source = read('lib/apiDocs/mcp.ts');
    const cited = [
      ...new Set([...source.matchAll(/tests\/[\w./-]+\.test\.tsx?/g)].map((m) => m[0])),
    ];

    expect(
      cited.length,
      '`lib/apiDocs/mcp.ts` cites no test at all — has the module been gutted?',
    ).toBeGreaterThan(0);

    const missing = cited.filter((path) => {
      try {
        read(path);
        return false;
      } catch {
        return true;
      }
    });
    expect(missing, 'these cited test files do not exist').toEqual([]);
  });
});

describe('the guards cannot be carried off by a page move again (MOTIR-4269)', () => {
  it('imports no route, no page and nothing under `app/`', () => {
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(imports.filter((specifier) => specifier?.includes('@/app/'))).toEqual([]);
    expect(imports.filter((specifier) => specifier?.includes('apiDocs/guide'))).toEqual([]);
  });
});
