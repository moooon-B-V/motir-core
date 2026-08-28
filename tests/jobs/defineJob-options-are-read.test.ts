import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import type { DefineJobOptions } from '@/lib/jobs/defineJob';

// THE ACCEPTED-AND-IGNORED-OPTION GUARD (bug MOTIR-3731 ·
// `docs/decisions/job-queue-foundation.md` §14).
//
// ── The property, and why it is stated this way ─────────────────────────────
// `defineJob` accepted a `concurrency` option and forwarded it to a scheduler
// that implemented it. When the Postgres engine took over, the engine never read
// the field — `claimDueRuns` consults no per-job limit and `registerEngineJob`
// does not carry the option — so for the whole cutover a job declaring one got
// silence. The runtime cost of that was zero, because the one job that declared
// one (`account/data-export.requested`) was serialised by a `FOR UPDATE` on the
// request row anyway. The cost was to the AUTHOR, who did the analysis, reached
// the right answer, wrote it down, read it back in review, and shipped a job with
// no serialisation at all — having been told nothing.
//
// ⚠️ SO THE GUARD IS NOT "NO `concurrency` OPTION". A ban on the word would pass
// on the day the same mistake ships under a different name, which is the
// enumerate-the-instances shape this repository keeps paying for. The property is
// the general one:
//
//     every option `DefineJobOptions` declares is READ by something.
//
// "Read by something" is two places, because `defineJob` does not consume all of
// its own options: it destructures most of them, and hands the WHOLE options
// object to `resolveRetries`, which is where `retries` and `retryPolicy` are
// actually read. So the reader set is derived rather than listed — the callees
// that receive the bare `options` identifier are found in the AST, their import
// specifiers are resolved, and their sources are read too. A helper added later
// is picked up without editing this file.
//
// ⚠️ AND THE TYPE-LEVEL HALF IS BELOW, not here. The AST answers "is this
// declared option read?"; it cannot answer "is an UNDECLARED option rejected?",
// because that is a compiler question. The `@ts-expect-error` at the bottom is
// that half, and it is checked by `pnpm typecheck` rather than by this run — an
// excess-property check that stopped firing would make that line an unused
// expect-error and fail the typecheck lane.
//
// ── Cost ────────────────────────────────────────────────────────────────────
// Two files parsed, both named. This walks no tree and globs nothing, so it is
// not a member of the structural-guard lane (`tests/helpers/structuralGuardLane.ts`)
// — the same footing as `tests/jobs/emit-seam.test.ts`, which parses one file
// inline for the same reason.

const REPO_ROOT = resolve(__dirname, '..', '..');
const DEFINE_JOB = join(REPO_ROOT, 'lib', 'jobs', 'defineJob.ts');

/** The type alias whose members ARE the public option surface. */
const OPTIONS_TYPE = 'DefineJobOptions';

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

/**
 * Every property name reachable from a type alias, following references to other
 * aliases declared in the SAME file.
 *
 * The alias is an intersection of two unions and one object literal
 * (`JobIdAndTrigger<N> & { … } & JobScheduleAndCatchUp`), so a reader that only
 * looked at the object literal would miss `id`, `trigger`, `cron` and `catchUp`
 * — four of the eight. Following the references is what makes the answer total
 * over the surface a caller can actually pass.
 *
 * ⚠️ A PROPERTY'S NAME IS AN OPTION; ITS MEMBERS ARE NOT — so the walk records a
 * `PropertySignature` and then STOPS, rather than descending into its type. The
 * control below is what found this: an option declared with an inline object
 * type (`concurrency?: { limit: number }`) otherwise contributes `limit` as if
 * it were an option of its own, and the guard would then demand that `defineJob`
 * read a name no caller can pass at the top level. Today's surface hides the
 * defect — every nested option type here is an imported reference
 * (`DebounceOption`, `CatchUpPolicy`), which the walk does not follow — so it
 * would have shipped green and fired on whoever next wrote an inline one.
 */
export function declaredOptionNames(source: ts.SourceFile, rootAlias: string): string[] {
  const aliases = new Map<string, ts.TypeNode>();
  source.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type);
  });

  const found = new Set<string>();
  const visited = new Set<string>();

  const walk = (node: ts.Node): void => {
    if (ts.isPropertySignature(node) && ts.isIdentifier(node.name)) {
      found.add(node.name.text);
      return; // the members BELOW a property are that option's shape, not more options
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const name = node.typeName.text;
      const target = aliases.get(name);
      if (target && !visited.has(name)) {
        visited.add(name);
        walk(target);
      }
    }
    node.forEachChild(walk);
  };

  const root = aliases.get(rootAlias);
  if (!root) throw new Error(`${rootAlias} is not a type alias in ${source.fileName}`);
  visited.add(rootAlias);
  walk(root);
  return [...found].sort();
}

/**
 * The names a source READS: every `x.NAME` access and every destructured binding.
 *
 * Deliberately not scoped to the options object. A name that appears as a read
 * anywhere in `defineJob.ts` or in a module it forwards the options to is being
 * consumed; narrowing it to "reads off the identifier `options`" would fail on
 * `const { id } = options` (a binding, not an access) and on the forwarded
 * module, whose parameter is called `opts`. Over-inclusion here can only make the
 * guard MISS, never make it fire wrongly — and what it would miss is a coincidental
 * same-named read, which §14's `concurrency_key` note is the only plausible source of.
 */
export function readNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key)) names.add(key.text);
    }
    node.forEachChild(walk);
  };
  walk(source);
  return names;
}

/**
 * The RELATIVE import specifiers of every function `defineJob` hands the bare
 * `options` identifier to — i.e. the modules that read options `defineJob`
 * itself never names.
 */
export function forwardedModuleSpecifiers(source: ts.SourceFile, paramName: string): string[] {
  const callees = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.arguments.some((a) => ts.isIdentifier(a) && a.text === paramName)
    ) {
      callees.add(node.expression.text);
    }
    node.forEachChild(walk);
  };
  walk(source);

  const specifiers = new Set<string>();
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const spec = node.moduleSpecifier.text;
    if (!spec.startsWith('.')) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    if (bindings.elements.some((e) => callees.has(e.name.text))) specifiers.add(spec);
  });
  return [...specifiers].sort();
}

describe('defineJob accepts no option that nothing reads (MOTIR-3731 · ADR §14)', () => {
  const source = parse(DEFINE_JOB, readFileSync(DEFINE_JOB, 'utf8'));
  const declared = declaredOptionNames(source, OPTIONS_TYPE);

  it('reads the option surface it is meant to be reading', () => {
    // A pin on the DERIVATION, not on the option list — it fails if a future
    // shape (a nested alias, a mapped type) makes the walk stop finding members,
    // which would otherwise turn the assertion below vacuously green. Adding an
    // option is expected to change this line; losing four of them silently is not.
    expect(declared).toEqual([
      'catchUp',
      'cron',
      'debounce',
      'id',
      'idempotency',
      'retries',
      'retryPolicy',
      'trigger',
    ]);
  });

  it('every declared option is read by defineJob or by a module it forwards to', () => {
    const readers = new Set(readNames(source));

    // The forwarded readers, derived: `resolveRetries(options)` is why `retries`
    // and `retryPolicy` are read nowhere in `defineJob.ts` itself.
    const forwarded = forwardedModuleSpecifiers(source, 'options');
    expect(forwarded.length).toBeGreaterThan(0);
    for (const spec of forwarded) {
      const file = join(dirname(DEFINE_JOB), `${spec.replace(/^\.\//, '')}.ts`);
      for (const name of readNames(parse(file, readFileSync(file, 'utf8')))) readers.add(name);
    }

    const unread = declared.filter((name) => !readers.has(name));
    expect(unread).toEqual([]);
  });

  it('the detector fails on an option nothing reads — the control', () => {
    // The whole guard is an assertion that a set is EMPTY, and an empty set is
    // what a broken detector returns too. So drive the same pure functions over
    // a synthetic source carrying the exact defect: an option declared on the
    // type and consumed by nobody.
    const fixture = parse(
      'fixture.ts',
      `
      type FixtureOptions = { id: string; concurrency?: { limit: number } };
      export function defineFixture(options: FixtureOptions) {
        const { id } = options;
        return { id };
      }
      `,
    );
    const names = declaredOptionNames(fixture, 'FixtureOptions');
    const readers = readNames(fixture);
    // ⚠️ `limit` is absent, and that is the second thing this control asserts:
    // the nested member of an inline option type is not itself an option. This
    // case is what caught the walk descending one level too far — see
    // `declaredOptionNames`'s header.
    expect(names).toEqual(['concurrency', 'id']);
    expect(names.filter((n) => !readers.has(n))).toEqual(['concurrency']);
  });

  it('rejects an undeclared option at COMPILE time — checked by `pnpm typecheck`', () => {
    // ⚠️ THE ASSERTION IS THE `@ts-expect-error`, not the `expect` below. The AST
    // guard above proves every DECLARED option is read; this proves an UNDECLARED
    // one cannot be PASSED, which is the other half of "the type refuses it". If
    // the excess-property check ever stopped firing — a widening to an index
    // signature, an `unknown` in the intersection — the directive becomes unused
    // and `tsc --noEmit` fails, which is exactly the moment somebody needs to be
    // told.
    //
    // ⚠️ IT IS A TYPE-LEVEL FIXTURE, NOT A `defineJob` CALL, and deliberately.
    // Calling it would import the engine registry and re-register a live job id
    // as a side effect of a guard about a type — this file reads source and
    // asserts on a type, and touches no runtime.
    const rejected: DefineJobOptions<'system.daily-health-check'> = {
      id: 'system.daily-health-check',
      // @ts-expect-error — `concurrency` is not an option: the engine enforces no
      // per-job limit and will not grow one (ADR §14). Reach for a request-time
      // row lock, `idempotency`, `debounce`, or a domain admission cap — §14.3.
      concurrency: { limit: 1, key: 'event.data.userId' },
      cron: '0 9 * * *',
      catchUp: 'skip',
    };
    expect(rejected.id).toBe('system.daily-health-check');
  });
});
