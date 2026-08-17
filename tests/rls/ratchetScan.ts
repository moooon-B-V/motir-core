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

export const defaultRatchetRoot = (): string => path.join(process.cwd(), 'tests/rls');

// ⚠️ Memoised per ROOT, for the reason `callSiteScan` was: a guard that
// re-derives a TypeScript parse on every `it` passes bare and TIMES OUT under
// `vitest run --coverage`, where the v8 provider instruments every module the
// parse touches (MOTIR-2815). Keyed by root because the fixture deliberately
// scans a different tree, and one unkeyed cache would hand it the real repo's
// answer and pass vacuously. The filesystem cannot change inside a run, so the
// cache needs no invalidation.
const cache = new Map<string, readonly Ratchet[]>();

/**
 * Every ratchet declared in the `.ts` files DIRECTLY under `root`.
 *
 * Non-recursive on purpose: `tests/rls/__fixtures__/` holds trees that exist to
 * be mis-shaped, and enrolling them would make the meta-guard assert against its
 * own negative cases.
 */
export function scanRatchets(root: string = defaultRatchetRoot()): readonly Ratchet[] {
  const cached = cache.get(root);
  if (cached) return cached;

  const found: Ratchet[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (!entry.endsWith('.ts')) continue;
    const abs = path.join(root, entry);
    if (!statSync(abs).isFile()) continue;
    found.push(...scanFile(abs));
  }

  const result: readonly Ratchet[] = found;
  cache.set(root, result);
  return result;
}

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

  into.set(name, {
    file,
    name,
    value: Number(init.text),
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
