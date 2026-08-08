import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { V1_OPERATIONS } from '../src/api/operations.js';

// THE ARCHITECTURE GUARDS STORY 11.5 OWES (Subtask 11.5.7 · MOTIR-2215).
//
// Coverage measures whether a line RAN. These guard properties instead — the
// things that decay silently because nothing executes them and no percentage
// moves when they break:
//
//   1. No file outside `src/transport.ts` + `src/adapters/` sees a generated
//      wire type (ADR `cli-v1-client.md` Q4's auditable rule).
//   2. `@modelcontextprotocol/sdk` is gone and stays gone — asserted next door
//      in `noSdk.test.ts`, which owns it because it also reads the manifest.
//   3. No `as` cast on a wire payload in the layer that can see one.
//   4. `render.ts` carries no rendering change from this story.
//   5. Every `MotirClient` method reaches a DECLARED v1 operation.
//
// ⚠️ EVERY GUARD BELOW IS PROVEN TO FAIL. Each is written as a pure predicate
// over source text, and each has a second test that runs it over a deliberately
// violating input and asserts it reports the violation. This is not ceremony:
// the scope-seam guard this story replaced passed for five cards while its
// regex quietly matched less and less each time, and nobody could tell a real
// pass from a vacuous one. A guard that has only ever been green might be
// asserting nothing at all, and the only way to know is to watch it go red.

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PACKAGE_ROOT, 'src');

// ─────────────────────────────────────────────────────────────────────────────
// Reading source as CODE, not as text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blank out comments and string/template contents, leaving code and offsets.
 *
 * Load-bearing, and the reason is the failure this project keeps hitting: a
 * guard that greps raw source fires on the comment EXPLAINING the rule. That
 * happened twice in this story — the scope-seam guard matched the word
 * `callTool` in the note saying `callTool` was gone, and `noSdk.test.ts`'s
 * first version matched the SDK's name in `client.ts`'s header explaining why it
 * no longer imports it. Both times the tempting fix was to soften the guard.
 *
 * Characters are replaced one-for-one with spaces so line and column numbers
 * survive, which is what lets a violation be reported at a place a reader can
 * open.
 */
export function stripNonCode(source: string): string {
  const out = source.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let k = i + 1;
      while (k < source.length) {
        if (source[k] === '\\') {
          k += 2;
          continue;
        }
        if (source[k] === ch) break;
        k += 1;
      }
      // The QUOTES survive so a string literal is still visibly a string; only
      // its contents are blanked. That keeps `request('getMe')` distinguishable
      // from `request(getMe)` while making the prose inside a message inert.
      blank(i + 1, k);
      i = k + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Every `.ts` file under `dir`, recursively, repo-relative. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * Blank COMMENTS only, leaving string literals readable.
 *
 * Guard 5 needs the opposite of {@link stripNonCode}: the thing it reads IS a
 * string literal (`request('getMe')`), so blanking string contents would make
 * it see a client that requests nothing — and pass, loudly, for the emptiest
 * possible reason. Comments still go, because a comment naming an operation is
 * prose about the client, not a call from it.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      let k = i + 1;
      while (k < source.length) {
        if (source[k] === '\\') {
          k += 2;
          continue;
        }
        if (source[k] === ch) break;
        k += 1;
      }
      out += source.slice(i, k + 1);
      i = k + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every CLI source file the rules apply to — the generated tree is exempt. */
function authoredSources(): { path: string; rel: string; code: string }[] {
  return sourceFiles(SRC)
    .map((path) => ({ path, rel: relative(SRC, path).split('\\').join('/') }))
    .filter(({ rel }) => !rel.startsWith('api/'))
    .map((f) => ({ ...f, code: stripNonCode(readFileSync(f.path, 'utf8')) }));
}

describe('the source scanner reads CODE, not prose', () => {
  it('blanks comment and string CONTENT while keeping offsets', () => {
    const source = [
      "const a = 'SuccessBody<X>'; // SuccessBody<X>",
      '/* SuccessBody<X> */ b();',
    ].join('\n');
    const code = stripNonCode(source);
    expect(code).not.toContain('SuccessBody');
    expect(code.length).toBe(source.length);
    expect(code.split('\n')).toHaveLength(2);
    // …and real code survives intact.
    expect(code).toContain('const a =');
    expect(code).toContain('b();');
  });

  it('does not swallow the rest of the file on an apostrophe inside a comment', () => {
    // The bug this test exists for: treating a comment's `don't` as an opening
    // quote blanks everything after it, and every guard downstream silently
    // sees an empty file — passing for the worst possible reason.
    const source = "// don't do this\nimport { Client } from '@sdk';\n";
    expect(stripNonCode(source)).toContain('import { Client } from');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 1 — the Q4 adapter boundary
// ─────────────────────────────────────────────────────────────────────────────

/** The only files ADR Q4 lets see a generated wire type. */
const WIRE_FACING = (rel: string): boolean => rel === 'transport.ts' || rel.startsWith('adapters/');

/**
 * Where a file names a generated type — by IMPORT or by DERIVATION.
 *
 * Both forms, because the ADR's auditable rule ("no file outside
 * `src/transport.ts` and `src/adapters/` may import from `src/api/`") has a
 * hole the story fell into: `transport.ts` re-exports `SuccessBody<Id>`, so
 * `type Row = SuccessBody<'getProjectReadySet'>['items'][number]` puts a wire
 * shape on a signature having imported nothing from `src/api/` at all. That
 * line existed in `client.ts` — added by 11.5.23, removed by this card — and
 * the literal rule would never have seen it. A derived type is the rejected
 * "view models re-exported from the generated types" alternative wearing a
 * different hat.
 */
export function wireTypeReferences(code: string): string[] {
  const found: string[] = [];
  for (const m of code.matchAll(/from\s+'[^']*\/api(?:\/[^']*)?'/g)) found.push(m[0]);
  for (const m of code.matchAll(/\b(SuccessBody|RequestInput|PathParams|QueryParams)\s*</g)) {
    found.push(m[0].trim());
  }
  for (const m of code.matchAll(/\b(paths|operations|components)\s*\[\s*'/g))
    found.push(m[0].trim());
  return found;
}

describe('GUARD 1 — no generated wire type outside the adapter boundary', () => {
  it('holds across every authored source file', () => {
    const offenders = authoredSources()
      .filter(({ rel }) => !WIRE_FACING(rel))
      .flatMap(({ rel, code }) => wireTypeReferences(code).map((hit) => `${rel}: ${hit}`));

    expect(
      offenders,
      'ADR cli-v1-client.md Q4: only src/transport.ts and src/adapters/ may see a generated ' +
        'wire type. Add an adapter function; do not widen the boundary.',
    ).toEqual([]);
  });

  it('the two wire-facing files DO reference them — the guard is scoped, not vacuous', () => {
    // Without this, deleting the generated client entirely would make guard 1
    // pass. What it protects is a boundary, and a boundary with nothing on
    // either side is not one.
    const wireFacing = authoredSources().filter(({ rel }) => WIRE_FACING(rel));
    expect(wireFacing.length).toBeGreaterThanOrEqual(2);
    expect(wireFacing.flatMap(({ code }) => wireTypeReferences(code)).length).toBeGreaterThan(5);
  });

  it('FAILS on an import from src/api', () => {
    expect(wireTypeReferences("import type { paths } from '../api/schema.js';")).toHaveLength(1);
  });

  it('FAILS on the DERIVED form the literal rule misses', () => {
    // Verbatim the line this card removed from `client.ts`.
    const derived = "type ReadyRow = SuccessBody<'getProjectReadySet'>['items'][number];";
    expect(wireTypeReferences(derived)).toContain('SuccessBody<');
  });

  it('passes clean code, so a green run means something', () => {
    expect(wireTypeReferences("import { toWhoami } from './adapters/reads.js';")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 3 — no `as` cast on a wire payload
// ─────────────────────────────────────────────────────────────────────────────
//
// (Guard 2 — the SDK — is `test/noSdk.test.ts`, which owns it because the same
// property spans the manifest and the import graph.)

/**
 * The casts the wire-facing layer is allowed to carry, each with its reason.
 *
 * An ALLOW-LIST rather than a flat ban, and the choice is the finding this card
 * reports: three casts DO exist inside `src/adapters/reads.ts`, on real wire
 * payloads. Banning them outright would fail today and the fix would be a
 * refactor of shipped mapping code, which this card is not for. Listing them
 * makes them visible, bounded and reviewed — and makes a FOURTH one fail here
 * rather than arrive unremarked.
 *
 * `as const` is not in scope: it narrows a literal the CLI itself wrote.
 */
const ALLOWED_WIRE_CASTS: Record<string, string[]> = {
  // The Ajv predicate. Documented at length in transport.ts: both sides are
  // generated from the same document keyed by the same operationId, and this is
  // precisely what lets `request()` return a narrowed value with NO cast on the
  // payload itself. The `Record` pair reads the ERROR envelope, never a success
  // body — an envelope is untyped by design.
  'transport.ts': ['as SuccessBody<Id>', 'as Record<string, unknown>'],
  // Wire enum → view-model enum, and the `?? []` fallback's union. Each widens
  // a value the validator has already accepted; none reaches for a field.
  //
  // ⚠️ `as PlanJobState[' ']` looks wrong and is not: {@link stripNonCode} has
  // blanked the `'status'` inside the index, because a guard that read string
  // CONTENT would fire on prose. The list records what the scanner produces,
  // not what the editor shows.
  'adapters/reads.ts': ['as RowOf<B>[]', 'as DispatchAdvisory[]', "as PlanJobState[' ']"],
};

/**
 * Every `as X` cast in code, `as const` excluded, whitespace collapsed.
 *
 * Collapsed so the allow-list can be matched by EXACT equality — a prefix match
 * would let `as Record<string, string>` past an entry for `as Record<string,
 * unknown>`, which is the kind of near-miss an allow-list exists to catch.
 */
export function typeCasts(code: string): string[] {
  return [...code.matchAll(/\bas\s+(?!const\b)([\w$]+(?:<[^;\n]*?>)?(?:\[[^\]\n]*\])*)/g)].map(
    (m) => `as ${(m[1] as string).replace(/\s+/g, ' ')}`,
  );
}

describe('GUARD 3 — the wire-facing layer casts only where it says it does', () => {
  it('every cast in transport.ts / client.ts / adapters is on the list', () => {
    const unexpected = authoredSources()
      .filter(({ rel }) => WIRE_FACING(rel) || rel === 'client.ts')
      .flatMap(({ rel, code }) =>
        typeCasts(code)
          .filter((cast) => !(ALLOWED_WIRE_CASTS[rel] ?? []).includes(cast))
          .map((cast) => `${rel}: ${cast}`),
      );

    expect(
      unexpected,
      'A new cast on a wire payload. The validator already narrowed the body — if the shape ' +
        'you need is unreachable, the schema is what to change.',
    ).toEqual([]);
  });

  it('client.ts casts NOTHING at all — it only ever holds view models', () => {
    const client = authoredSources().find(({ rel }) => rel === 'client.ts');
    expect(typeCasts(client!.code)).toEqual([]);
  });

  it('the allow-list is EXHAUSTED — every entry still describes a real cast', () => {
    // An allow-list nobody prunes becomes a list of permissions for code that
    // no longer exists, and the next reviewer reads it as precedent. A stale
    // entry fails here.
    for (const [rel, allowed] of Object.entries(ALLOWED_WIRE_CASTS)) {
      const file = authoredSources().find((f) => f.rel === rel);
      expect(file, `${rel} is on the cast allow-list but does not exist`).toBeDefined();
      const present = typeCasts(file!.code);
      for (const cast of allowed) {
        expect(present, `${rel} no longer contains ${cast} — drop it from the list`).toContain(
          cast,
        );
      }
    }
  });

  it('FAILS on a cast, and ignores `as const`', () => {
    expect(typeCasts('const x = body as WorkItemDetail;')).toEqual(['as WorkItemDetail']);
    expect(typeCasts('const y = { a: 1 } as const;')).toEqual([]);
  });

  it('sees through a comment that merely TALKS about a cast', () => {
    const source = '// this used to be `structuredContent as T`\nconst x = body.items;';
    expect(typeCasts(stripNonCode(source))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 4 — render.ts carries no rendering change
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `render.ts`, pinned by content hash.
 *
 * ⚠️ IT IS NOT BYTE-IDENTICAL TO ITS PRE-STORY SELF, and that is reported rather
 * than papered over. The story base is `8c42971c`, where the file hashed
 * `34bc6b5e…`; it now hashes the value below. The whole delta is TWO lines, both
 * from 11.5.6's module rename — the `import type { … } from './mcpClient.js'`
 * specifier, and one comment that named `mcpClient.ts`. No rendering logic, no
 * signature, no output. Re-check with:
 *
 *     git diff 8c42971c -- packages/cli/src/render.ts
 *
 * A hash rather than a live `git show` because CI checks out shallow: a guard
 * that needs a commit the runner may not have fetched fails for a reason that
 * has nothing to do with the property. The cost is that a legitimate edit must
 * update this constant — which is the point. `render.ts` changing is exactly the
 * event that deserves a deliberate line in a diff and a sentence in a review.
 */
const RENDER_TS_SHA256 = '0e427121c212ac096643ff5aa09bb4dfc533cd8d742c67c93c1ec73d057d38e5';

describe('GUARD 4 — render.ts is pinned', () => {
  it('matches the recorded hash', () => {
    const actual = createHash('sha256')
      .update(readFileSync(join(SRC, 'render.ts')))
      .digest('hex');
    expect(
      actual,
      'render.ts changed. If that is intended, say what changed and why in the PR, then ' +
        'update RENDER_TS_SHA256. If it is not, a wire shape reached the renderer — which is ' +
        'the failure ADR cli-v1-client.md Q4 exists to prevent.',
    ).toBe(RENDER_TS_SHA256);
  });

  it('the hash is of the real file, not of nothing', () => {
    // A guard whose subject vanished would otherwise pass by hashing an empty
    // buffer forever.
    const source = readFileSync(join(SRC, 'render.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain('export function renderReadyTable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARD 5 — every client method reaches a declared v1 operation
// ─────────────────────────────────────────────────────────────────────────────

/** Every `operationId` string handed to the transport, in source order. */
export function requestedOperationIds(code: string): string[] {
  return [...code.matchAll(/\.request\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1] as string);
}

/** One member of the client class: its name, whether it is public, and its body. */
export interface ClassMember {
  name: string;
  isPublic: boolean;
  body: string;
}

/**
 * A line that OPENS a class member — the two-space-indented signature prettier
 * produces, with any modifier and any generic parameter list.
 *
 * ⚠️ `private` and the `*` of a generator are the load-bearing parts. The first
 * version of this guard omitted them, so `private async *walkReady()` was not
 * recognised as a member, its body was attributed to the PUBLIC method above
 * it, and four correct methods were reported as reaching nothing. Under-matching
 * here does not produce a false pass — it produces a false FAILURE, which is at
 * least loud; the same omission in a guard shaped the other way would have gone
 * green forever.
 */
const MEMBER_START =
  /^ {2}(private |public |protected )?(?:readonly )?(?:async )?\*?([A-Za-z_$][\w$]*)\s*[(<]/;

/**
 * Split `export class MotirClient` into its members.
 *
 * By member-start LINES rather than by brace depth, because a generic
 * constraint carries braces of its own — `walkPages<P extends { nextCursor:
 * string | null }>` closes a brace inside its own signature, and a depth
 * counter splits the method in half there. Indentation is the reliable
 * boundary in a prettier-formatted file, and the suite asserts that assumption
 * below rather than trusting it.
 */
export function classMembers(code: string): ClassMember[] {
  const classAt = code.indexOf('export class MotirClient');
  if (classAt === -1) return [];
  const lines = code.slice(classAt).split('\n');

  const starts: { line: number; name: string; isPublic: boolean }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = MEMBER_START.exec(line);
    if (match) {
      starts.push({ line: index, name: match[2] as string, isPublic: match[1] !== 'private ' });
    }
  }

  return starts.map(({ line, name, isPublic }, index) => {
    const next = starts[index + 1];
    return { name, isPublic, body: lines.slice(line, next?.line ?? lines.length).join('\n') };
  });
}

/** `this.v1.request(…)`, however prettier wrapped it across lines. */
const CALLS_TRANSPORT = /this\.v1\s*\.\s*request\(/;

/** Can `name` reach the transport, directly or through the members it calls? */
export function reachesTransport(
  name: string,
  members: ClassMember[],
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const member = members.find((m) => m.name === name);
  if (member === undefined) return false;
  if (CALLS_TRANSPORT.test(member.body)) return true;
  return members.some(
    (sibling) =>
      sibling.name !== name &&
      member.body.includes(`this.${sibling.name}(`) &&
      reachesTransport(sibling.name, members, seen),
  );
}

describe('GUARD 5 — the client reaches only declared operations', () => {
  const clientSource = (): string => stripComments(readFileSync(join(SRC, 'client.ts'), 'utf8'));

  it('every operationId it names is in the generated table', () => {
    const declared = new Set(Object.keys(V1_OPERATIONS));
    const requested = [...new Set(requestedOperationIds(clientSource()))];

    // A FLOOR, so a scanner that quietly stops matching cannot pass by finding
    // nothing — the exact way the scope-seam guard this replaced decayed.
    expect(requested.length, 'the client requests no operations at all').toBeGreaterThanOrEqual(19);
    expect(
      requested.filter((id) => !declared.has(id)),
      'the client asks for an operation the server document does not declare',
    ).toEqual([]);
  });

  it('every PUBLIC method reaches the transport — none is a stub with nothing behind it', () => {
    // The shape this whole story exists to eliminate: a method that LOOKS like
    // part of the client surface and talks to nothing.
    //
    // TRANSITIVELY, because delegation is normal and correct here: `getWorkItem`
    // reads through `readWorkItem`, `nextReady` walks `walkReady`, and
    // `listProjects` pages through `walkPages` — none of which is a shortcut
    // around the boundary. And PUBLIC only: `walkPages` takes the fetch as a
    // CALLBACK and touches no transport of its own, which is a fine shape for a
    // private combinator and a meaningless thing to assert about.
    const members = classMembers(clientSource());
    expect(members.length, 'the class body did not parse into members').toBeGreaterThan(20);
    expect(members.some((m) => m.name === 'whoami')).toBe(true);

    const offenders = members
      .filter((m) => m.isPublic && m.name !== 'constructor')
      .filter((m) => !reachesTransport(m.name, members))
      .map((m) => m.name);

    expect(offenders, 'these client methods reach no v1 operation').toEqual([]);
  });

  it('FAILS on a method that reaches nothing', () => {
    const stub = [
      'export class MotirClient {',
      '  async whoami() {',
      '    return CACHE;',
      '  }',
      '}',
    ].join('\n');
    const members = classMembers(stub);
    expect(members.map((m) => m.name)).toEqual(['whoami']);
    expect(reachesTransport('whoami', members)).toBe(false);
  });

  it('FAILS on an operationId the table does not declare', () => {
    const ids = requestedOperationIds("await this.v1.request('nextReady', {});");
    expect(ids).toEqual(['nextReady']);
    expect(Object.keys(V1_OPERATIONS)).not.toContain('nextReady');
  });

  it('attributes a PRIVATE helper to itself, not to the method above it', () => {
    // The first version of this guard got exactly this wrong.
    const source = [
      'export class MotirClient {',
      '  async nextReady() {',
      '    for await (const x of this.walkReady()) return x;',
      '  }',
      '',
      '  private async *walkReady() {',
      "    yield await this.v1.request('getProjectReadySet');",
      '  }',
      '}',
    ].join('\n');
    const members = classMembers(source);
    expect(members.map((m) => m.name)).toEqual(['nextReady', 'walkReady']);
    expect(members.map((m) => m.isPublic)).toEqual([true, false]);
    // The public method reaches the transport only THROUGH the private one —
    // which is the whole reason the check is transitive.
    expect(members[0]!.body).not.toMatch(/this\.v1\s*\.\s*request\(/);
    expect(reachesTransport('nextReady', members)).toBe(true);
  });
});
