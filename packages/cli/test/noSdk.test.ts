import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// THE GUARD THAT KEEPS THE MIGRATION DONE (Subtask 11.5.6 · MOTIR-2214).
//
// Story 11.5 moved every method of `@motir/cli` from the MCP tool protocol onto
// the documented public API at `/api/v1`, and this card removed the transport,
// the handshake and `@modelcontextprotocol/sdk` itself. Removing an import is a
// moment; keeping it removed is a PROPERTY, and the difference between the two
// is a test.
//
// Without one, the SDK comes back the first time someone needs a capability
// `/api/v1` does not expose yet — quietly, in a single import line — and the CLI
// is a dual-protocol client again with nobody having decided that. The failure
// message below is therefore addressed to that person: the answer is to add the
// endpoint, not the dependency.
//
// ⚠️ NOT a rule about MCP. The server surface at `app/api/mcp` + `lib/mcp/` is
// untouched, still serves agents, and still depends on the SDK from the ROOT
// package. This is scoped to `packages/cli`, which is published to npm and
// installed by humans: what it declares is what every installer downloads.

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = '@modelcontextprotocol/sdk';

/**
 * An IMPORT of the SDK, not a MENTION of it.
 *
 * The distinction is load-bearing: this file names the package in its own
 * failure message, `client.ts` explains in a header comment why it no longer
 * imports it, and an ADR quotes the specifier. A guard that matched the STRING
 * would fire on every one of those — so it would be deleted, and the property
 * would go with it. Matching `from '…'` / `require('…')` / `import('…')` fires
 * only on a file that actually pulls the package in.
 */
const SDK_IMPORT = /(?:from|require\(|import\()\s*'@modelcontextprotocol\/sdk/;

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('the CLI does not depend on the MCP SDK', () => {
  it('declares no dependency on it, in any dependency block', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | unknown
    >;
    // Every block, not just `dependencies`: moving it to `devDependencies` or
    // `peerDependencies` would keep it in the tree and pass a narrower check.
    for (const block of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const deps = manifest[block];
      if (deps === undefined) continue;
      expect(Object.keys(deps as Record<string, string>)).not.toContain(SDK);
    }
  });

  it('imports it from no file under src/ or test/', () => {
    const offenders = [join(PACKAGE_ROOT, 'src'), join(PACKAGE_ROOT, 'test')]
      .flatMap(sourceFiles)
      .filter((path) => SDK_IMPORT.test(readFileSync(path, 'utf8')));

    expect(
      offenders,
      `${SDK} is back in packages/cli. The CLI is an HTTP client of /api/v1 (docs/decisions/cli-v1-client.md); ` +
        'if a capability is missing, add the v1 endpoint rather than a second protocol.',
    ).toEqual([]);
  });

  // ⚠️ THE GUARD, WATCHED GOING RED (added by the story gate, 11.5.7). Every
  // form a reintroduction could take, plus the two mentions that must NOT trip
  // it. Without this, a `SDK_IMPORT` regex that quietly stopped matching would
  // pass forever by finding nothing — which is exactly how the scope-seam guard
  // this story retired decayed across five cards.
  //
  // ⚠️ The samples are BUILT from `SDK` rather than written out. Spelling a real
  // import line here would put one in a file under `test/` — and the guard,
  // correctly, flagged this very file the first time. Interpolation keeps the
  // sample honest (it is the exact string a violator would write) without the
  // guard's own evidence becoming a violation.
  it.each([
    [`import { Client } from '${SDK}/client/index.js';`, 'a static import'],
    [`export * from '${SDK}/types.js';`, 're-export'],
    [`const sdk = require('${SDK}');`, 'require'],
    [`await import('${SDK}/client/streamableHttp.js');`, 'dynamic import'],
  ])('FAILS on %s (%s)', (line) => {
    expect(SDK_IMPORT.test(line)).toBe(true);
  });

  it('does NOT fire on prose that merely names the package', () => {
    // `client.ts`'s header explains why it no longer imports the SDK, this file
    // names it in its own failure message, and an ADR quotes the specifier. A
    // guard that fired on all three would be deleted — and the property would
    // go with it.
    expect(SDK_IMPORT.test(`// 11.5.6 removed ${SDK} from this package.`)).toBe(false);
    expect(SDK_IMPORT.test(`const SDK = '${SDK}';`)).toBe(false);
  });
});
