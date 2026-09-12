import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// The RATCHET scanner (MOTIR-2941) — the sixth instrument in `tests/rls/`, and
// the only one that reads the guards themselves rather than the tree.
//
// ── What it enumerates ─────────────────────────────────────────────────────
// A `const <NAME>_CEILING = <n>` / `<NAME>_FLOOR = <n>` in a guard, together
// with the `expect(value, message).toBeLessThanOrEqual(NAME)` (or
// `.toBeGreaterThanOrEqual(NAME)`) that reads it, and the SOURCE TEXT of that
// message. That triple — name, value, message — is what the staleness rule
// needs, and each part is derived, so no list of it can go out of date.
//
// ── Why a scan and not the list the card asked for ─────────────────────────
// MOTIR-2941's first acceptance criterion asks for every ratchet constant under
// `tests/rls/` enumerated with its value. A hand-written table would have
// satisfied it and been the wrong deliverable, for the card's OWN reason: it is
// a measurement of a population, transcribed into the source tree, that a
// sibling can falsify by merging. MOTIR-2945 is in flight against
// `bare-transaction-guard.test.ts` as this ships and will very likely move
// `GATED_BARE_TRANSACTION_CEILING` off 8. A derived enumeration survives that; a
// transcribed one becomes the second instance of the defect it documents, inside
// the card that documents it.
//
// ── Why an AST and not a grep ──────────────────────────────────────────────
// The same three reasons `testSingletonStatementScan` gives. Specifically here:
// the message is a multi-line concatenation of template literals, so no line
// regex can tell "this constant's message" from "the message two assertions
// down"; and a comparator has to be attributed to the constant it READS, not to
// the one declared nearest it (`test-singleton-statement-guard.test.ts` declares
// three constants adjacently and asserts them 100 lines later).
//
// ── What it deliberately does NOT enumerate ────────────────────────────────
// Bare numeric sanity floors — `expect(all.length).toBeGreaterThan(200)` — are
// not ratchets. They carry no named constant, they are set an order of magnitude
// below the population precisely so that ordinary movement cannot reach them,
// and there is nothing to re-measure when one fires. The naming convention IS
// the enrolment mechanism: a number worth ratcheting is a number worth naming.
// The latency ceiling in `shared-read-seams.test.ts` (`elapsedMs < 2_500`) is
// excluded on the same ground and one more: it measures the machine, not a
// population, so `origin/main` cannot adjudicate it.

// ── MOTIR-5207: enrolment by NAME was a NARROWER NET THAN IT READS AS ──────
// `ratchet-constant-staleness.md` said "enrolment is by NAME, so there is no
// list to join", and that was true of the population it could see: a NUMBER, in
// ONE directory. MOTIR-5037's ratchet is a SET (`tests/helpers/
// pageRootedLocatorAllowList.json`), in another, so it shipped with no preamble
// and spent two merge-queue slots on the accusation this whole mechanism exists
// to stop. The convention did not fail to hold; it failed to notice there was
// something to hold.
//
// Two derived widenings, neither of which introduces a list:
//
//   ROOT  — the walk starts at `tests/` and RECURSES, so a ratchet constant is
//           enrolled wherever it is written. A directory named `__fixtures__`
//           is skipped (the reason the old walk was flat), and a file is parsed
//           only if its TEXT carries a ratchet name — 1 700 files, six parses.
//           This found `SERIAL_READ_CEILING` in `tests/navigation/`, live and
//           unenrolled, which is the second instance and the reason the ROOT
//           half is not merely tidiness.
//
//   SHAPE — a CONTRACT ratchet: a checked-in JSON under the root declaring a
//           numeric `count` and an array of exactly that length. That is, by
//           construction, a committed measurement of a population — and it is
//           precisely what separates MOTIR-5037's hand-shrunk allow-list from
//           `pageLocatorInventory.json`, the re-generated EVIDENCE beside it,
//           which declares no `count` at all. Its GUARD is derived too: the
//           test file whose source names the contract's path.
//
// ── What stays OUT, and why it is not a list either ────────────────────────
// A ratchet counts a POPULATION, so its value is a non-negative INTEGER.
// `ARRIVAL_FLOOR = 0.8` in `tests/e2e/cloud-roadmap-arrival.spec.ts` is the
// design's measured legibility floor, asserted with `toBeCloseTo` — it measures
// GEOMETRY, not a counted set, so `origin/main` cannot adjudicate it. Same
// exclusion, same reason, as the latency ceiling above; the integer rule is
// what derives it rather than naming it.

/** Which way the comparator that reads the constant points. */
export type RatchetDirection = 'ceiling' | 'floor';

export interface RatchetAssertion {
  /** 1-based line of the comparator call. */
  line: number;
  /** `toBeLessThanOrEqual` -> ceiling, `toBeGreaterThanOrEqual` -> floor. */
  direction: RatchetDirection;
  /**
   * Source text of the second argument to `expect(value, message)` — '' when
   * the assertion passes no message at all, which for a ratchet is its own
   * defect and is reported as one.
   */
  message: string;
}

export interface Ratchet {
  /** Repo-relative, POSIX separators — stable across platforms in messages. */
  file: string;
  name: string;
  value: number;
  /** 1-based line of the `const` declaration. */
  line: number;
  /**
   * The direction its assertions agree on; falls back to the name suffix for an
   * ORPHAN (a declared constant nothing asserts), which is the only case with no
   * comparator to read it from.
   */
  direction: RatchetDirection;
  assertions: RatchetAssertion[];
}

/** A ratchet is enrolled by its NAME. See the header note on why. */
export const RATCHET_NAME = /_(?:CEILING|FLOOR)$/;

const COMPARATORS: Readonly<Record<string, RatchetDirection>> = {
  toBeLessThanOrEqual: 'ceiling',
  toBeGreaterThanOrEqual: 'floor',
};

export const defaultRatchetRoot = (): string => path.join(process.cwd(), 'tests');

// ⚠️ Memoised per ROOT, for the reason `callSiteScan` was: a guard that
// re-derives a TypeScript parse on every `it` passes bare and TIMES OUT under
// `vitest run --coverage`, where the v8 provider instruments every module the
// parse touches (MOTIR-2815). Keyed by root because the fixture deliberately
// scans a different tree, and one unkeyed cache would hand it the real repo's
// answer and pass vacuously. The filesystem cannot change inside a run, so the
// cache needs no invalidation.
const cache = new Map<string, readonly Ratchet[]>();

/**
 * Every `.ts` file under `root`, recursively.
 *
 * A directory NAMED `__fixtures__` is skipped, which is the exclusion the old
 * flat walk bought by accident: `tests/rls/__fixtures__/` holds trees that exist
 * to be mis-shaped, and enrolling them would make the meta-guard assert against
 * its own negative cases. Keyed on the NAME rather than on the path, so pointing
 * the scanner AT a fixture root still works — the fixture tests do exactly that,
 * and no `__fixtures__` directory exists beneath one.
 */
function walk(root: string, ext: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === '__fixtures__' || entry === 'node_modules') continue;
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) visit(abs);
      else if (entry.endsWith(ext)) out.push(abs);
    }
  };
  visit(root);
  return out;
}

/**
 * Every ratchet CONSTANT declared under `root`, recursively.
 *
 * ⚠️ The TEXT pre-filter is what makes the wider root affordable. `tests/`
 * carries ~1 700 `.ts` files and a TypeScript parse of each is the workload
 * MOTIR-2815 and MOTIR-3144 both exist because of; a file with no ratchet name
 * in it cannot declare one, so it is never parsed. Six files survive the filter
 * today against twelve the flat walk used to parse outright.
 */
export function scanRatchets(root: string = defaultRatchetRoot()): readonly Ratchet[] {
  const cached = cache.get(root);
  if (cached) return cached;

  const found: Ratchet[] = [];
  for (const abs of walk(root, '.ts')) {
    if (!RATCHET_NAME_IN_TEXT.test(readFileSync(abs, 'utf8'))) continue;
    found.push(...scanFile(abs));
  }

  const result: readonly Ratchet[] = found;
  cache.set(root, result);
  return result;
}

/** The cheap pre-filter — a superset of what `RATCHET_NAME` enrols, so it can
 *  only ever cost a parse, never lose a ratchet. `g`-less on purpose: a global
 *  regex carries `lastIndex` across calls. */
const RATCHET_NAME_IN_TEXT = /[A-Z0-9]_(?:CEILING|FLOOR)\b/;

/** An IMPORT of this module — the tell that a file is enrolment machinery
 *  rather than a guard. A bare mention is not one: a guard that explains where
 *  its own rule lives is still a guard. */
const IMPORTS_THE_SCANNER = /from\s+['"][^'"]*ratchetScan['"]/;

function scanFile(abs: string): Ratchet[] {
  const text = readFileSync(abs, 'utf8');
  const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const file = path.relative(process.cwd(), abs).split(path.sep).join('/');

  const declared = new Map<string, Ratchet>();
  const walk = (node: ts.Node): void => {
    collectDeclaration(node, source, file, declared);
    collectAssertion(node, source, declared);
    ts.forEachChild(node, walk);
  };
  walk(source);

  return [...declared.values()];
}

/** `const NAME_CEILING = 12;` at any scope — the guards declare at module scope. */
function collectDeclaration(
  node: ts.Node,
  source: ts.SourceFile,
  file: string,
  into: Map<string, Ratchet>,
): void {
  if (!ts.isVariableDeclaration(node)) return;
  if (!ts.isIdentifier(node.name)) return;
  const name = node.name.text;
  if (!RATCHET_NAME.test(name)) return;

  const init = node.initializer;
  if (!init || !ts.isNumericLiteral(init)) return;

  // A ratchet counts a POPULATION, so its value is a non-negative INTEGER. This
  // is what excludes `ARRIVAL_FLOOR = 0.8` — a geometry floor that measures the
  // machine rather than a counted set, on the same ground the header gives for
  // the latency ceiling. Derived, so there is nothing to add to when the next
  // one is written.
  const value = Number(init.text);
  if (!Number.isInteger(value) || value < 0) return;

  into.set(name, {
    file,
    name,
    value,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    // Provisional: replaced by the comparator's direction once one is found.
    direction: name.endsWith('_FLOOR') ? 'floor' : 'ceiling',
    assertions: [],
  });
}

/** `expect(value, message).toBeLessThanOrEqual(NAME)` and its floor twin. */
function collectAssertion(node: ts.Node, source: ts.SourceFile, into: Map<string, Ratchet>): void {
  if (!ts.isCallExpression(node)) return;
  if (!ts.isPropertyAccessExpression(node.expression)) return;

  const direction = COMPARATORS[node.expression.name.text];
  if (!direction) return;

  const [bound] = node.arguments;
  if (!bound || !ts.isIdentifier(bound)) return;

  const ratchet = into.get(bound.text);
  if (!ratchet) return;

  ratchet.direction = direction;
  ratchet.assertions.push({
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    direction,
    message: expectMessage(node.expression.expression, source),
  });
}

/**
 * The message argument of the `expect(…)` the comparator hangs off.
 *
 * Walks back through any modifier chain (`.not`, `.resolves`) so a future
 * assertion written that way is read rather than silently treated as
 * message-less — the failure mode where the meta-guard would report a defect
 * that is really its own blind spot.
 */
function expectMessage(receiver: ts.Expression, source: ts.SourceFile): string {
  let node: ts.Expression = receiver;
  while (ts.isPropertyAccessExpression(node)) node = node.expression;

  if (!ts.isCallExpression(node)) return '';
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'expect') return '';

  const message = node.arguments[1];
  return message ? message.getText(source) : '';
}

/** The exposed subset: a value of 0 cannot be moved by anything merging beneath it. */
export const exposedRatchets = (root?: string): readonly Ratchet[] =>
  scanRatchets(root).filter((r) => r.value !== 0);

// ───────────────────────────────────────────────────────────────────────────
// THE SECOND SHAPE — a CONTRACT ratchet (MOTIR-5207)
// ───────────────────────────────────────────────────────────────────────────

export interface SetRatchet {
  /** Repo-relative, POSIX separators — the contract file. */
  file: string;
  /** The contract's basename, which is the name its preamble is rendered for. */
  name: string;
  /** The declared population size. `0` is immune for the same reason a zero
   *  ceiling is: an empty contract asserts nothing a sibling can move. */
  count: number;
  /** Repo-relative paths of the test files whose SOURCE names `file`. Derived,
   *  so a contract that changes hands needs nothing updated here. */
  guards: string[];
}

/** An `expect(value, message)` in a guard, with the SOURCE TEXT of its message.
 *  A call with no message argument is not one: it accuses nobody, which is the
 *  same ground the header gives for excluding a bare numeric sanity floor. */
export interface GuardMessage {
  file: string;
  line: number;
  message: string;
}

const setCache = new Map<string, readonly SetRatchet[]>();

/**
 * Every CONTRACT ratchet under `root` — a checked-in JSON declaring a numeric
 * `count` alongside an array of exactly that length.
 *
 * ⚠️ That predicate is the whole enrolment rule, and it is doing real work
 * rather than describing one file. `tests/helpers/` holds BOTH of MOTIR-5037's
 * artifacts: `pageRootedLocatorAllowList.json`, the hand-shrunk CONTRACT, and
 * `pageLocatorInventory.json`, the re-generated EVIDENCE its own note insists is
 * "not a contract". The evidence file declares no top-level `count`, so it is
 * not enrolled — the distinction the guard's header argues for in prose falls
 * out of the shape here, which is why this is a rule and not a list.
 */
export function scanSetRatchets(root: string = defaultRatchetRoot()): readonly SetRatchet[] {
  const cached = setCache.get(root);
  if (cached) return cached;

  const rel = (abs: string): string => path.relative(process.cwd(), abs).split(path.sep).join('/');
  // ⚠️ A file that mentions `ratchetScan` is part of the ENROLMENT MACHINERY,
  // not a guard holding a contract — it names a contract path to REASON about
  // it, never to read it. Without this the meta-guard enrols ITSELF the moment
  // it asserts which contracts exist, and then demands a re-measure preamble on
  // its own assertion about contracts (measured: three of its own messages).
  // Keyed on the IMPORT, not on a mention: this file's own guards CITE
  // `ratchetScan.ts` in their header comments, and a substring test excluded
  // MOTIR-5037's guard for saying where its enrolment rule lives.
  const sources = walk(root, '.ts')
    .map((abs) => ({ file: rel(abs), text: readFileSync(abs, 'utf8') }))
    .filter((s) => !IMPORTS_THE_SCANNER.test(s.text));

  const found: SetRatchet[] = [];
  for (const abs of walk(root, '.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      continue; // not our business to rule on malformed JSON
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    const count = record.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
    const declares = Object.values(record).some((v) => Array.isArray(v) && v.length === count);
    if (!declares) continue;

    const file = rel(abs);
    found.push({
      file,
      name: path.basename(file),
      count,
      guards: sources.filter((s) => s.text.includes(file)).map((s) => s.file),
    });
  }

  const result: readonly SetRatchet[] = found;
  setCache.set(root, result);
  return result;
}

/** The exposed subset: a contract declaring nothing cannot be moved by a merge. */
export const exposedSetRatchets = (root?: string): readonly SetRatchet[] =>
  scanSetRatchets(root).filter((r) => r.count !== 0);

/**
 * Every `expect(value, message)` in `file`, with its message's source text.
 *
 * This is the CONTRACT shape's obligation surface, and it is deliberately
 * file-wide rather than per-assertion. A numeric ratchet is attributed through
 * the comparator that READS it; a contract has no such comparator — MOTIR-5037's
 * guard computes its offender list in one statement and asserts it in the next —
 * so there is no identifier for an attribution to follow. What survives the loss
 * is the question the preamble answers: **when this guard is red, does the human
 * reading it get told the movement may not be theirs?** That is a property of
 * every message the guard can print.
 */
export function guardMessages(file: string): GuardMessage[] {
  const abs = path.join(process.cwd(), file);
  const text = readFileSync(abs, 'utf8');
  const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);

  const out: GuardMessage[] = [];
  const walkNode = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect' &&
      node.arguments.length > 1
    ) {
      const message = node.arguments[1];
      if (message) {
        out.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          message: message.getText(source),
        });
      }
    }
    ts.forEachChild(node, walkNode);
  };
  walkNode(source);
  return out;
}
