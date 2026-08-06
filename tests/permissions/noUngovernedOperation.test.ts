import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The NO-UNGOVERNED-OPERATION guard (Story MOTIR-2255 · Subtask MOTIR-2278).
//
// This is the INVERSE of the orphan guard. That one asserts *every permission
// has a consumer* — no key exists that nothing enforces. This one asserts
// *every actor-initiated operation has an answer* — no operation exists that no
// permission covers.
//
// The asymmetry is why this direction was the one missing. A permission nobody
// enforces is a lie VISIBLE on the settings page, so it gets noticed. An
// operation no permission covers is invisible everywhere, because a missing gate
// looks exactly like a working feature. That is how 82 of 122 services reached
// production ungoverned while the 11 that were governed were carefully tested.
//
// ⚠️ THE ALLOWLIST IS DERIVED FROM THE INVENTORY, NOT HAND-WRITTEN. A bare list
// of paths is a place to put things you would rather not think about, and it
// grows until the guard means nothing. Here, an operation may be un-gated only
// because `docs/decisions/permission-inventory.md` records a DECISION for it —
// so skipping the guard requires arguing with a document, not editing an array.

const ROOT = join(__dirname, '..', '..');
const DOC = join(ROOT, 'docs', 'decisions', 'permission-inventory.md');

// A gate — the shipped `assertCan*` surface, the capability reads, or the
// permission model itself.
const GATE =
  /assertCan[A-Za-z]+|get[A-Za-z]*Capabilities|hasPermission\(|canManageProject\(|canBrowse\(|canEdit\(/;
/**
 * Every `someService.someMethod(` call in `source`.
 *
 * ⚠️ The regex is built FRESH per call and never shared. A `g`-flagged regex
 * carries `lastIndex` as mutable state, so one shared instance used inside the
 * recursion below has its cursor clobbered by the recursive call and the outer
 * loop never terminates. (Found the hard way — the first version of this file
 * hung the suite rather than failing it.)
 */
function serviceCalls(source: string): [string, string][] {
  return [...source.matchAll(/\b([a-z][A-Za-z0-9]*Service)\.([a-zA-Z_][\w]*)\s*\(/g)].map(
    (m) => [m[1]!, m[2]!] as [string, string],
  );
}

function walk(dir: string, hit: (p: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, hit);
    else hit(p);
  }
}

/** Every service method body, by `service.method`. */
function serviceBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  const dir = join(ROOT, 'lib', 'services');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const svc = file.slice(0, -3);
    const src = readFileSync(join(dir, file), 'utf8');
    // Methods of the exported service object are indented exactly two spaces.
    const re = /^ {2}(?:async\s+)?([a-zA-Z_][\w]*)\s*(?:<[^>]*>)?\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const name = m[1]!;
      if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
      const open = src.indexOf('{', m.index + m[0].length);
      if (open < 0) continue;
      let depth = 0;
      let j = open;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}' && --depth === 0) break;
      }
      const key = `${svc}.${name}`;
      bodies.set(key, (bodies.get(key) ?? '') + src.slice(open, j + 1));
    }
  }
  return bodies;
}

const BODIES = serviceBodies();
const gateMemo = new Map<string, boolean>();

/** Whether `service.method` enforces a gate, directly or through what it calls. */
function methodIsGated(key: string, seen = new Set<string>()): boolean {
  const memo = gateMemo.get(key);
  if (memo !== undefined) return memo;
  if (seen.has(key) || seen.size > 6) return false;
  const body = BODIES.get(key);
  if (body === undefined) return false;
  if (GATE.test(body)) {
    gateMemo.set(key, true);
    return true;
  }
  const next = new Set(seen).add(key);
  for (const [svc, method] of serviceCalls(body)) {
    if (methodIsGated(`${svc}.${method}`, next)) {
      gateMemo.set(key, true);
      return true;
    }
  }
  return false;
}

interface Operation {
  url: string;
  gated: boolean;
}

function operations(): Operation[] {
  const ops: Operation[] = [];
  walk(join(ROOT, 'app', 'api'), (p) => {
    if (!p.endsWith(`${'route'}.ts`)) return;
    const url =
      '/' +
      relative(join(ROOT, 'app'), p)
        .replace(/\\/g, '/')
        .replace(/\/route\.ts$/, '');
    const src = readFileSync(p, 'utf8');
    let gated = GATE.test(src);
    if (!gated) {
      gated = serviceCalls(src).some(([svc, method]) => methodIsGated(`${svc}.${method}`));
    }
    ops.push({ url, gated });
  });
  return ops.sort((a, b) => a.url.localeCompare(b.url));
}

const doc = readFileSync(DOC, 'utf8');

/**
 * The inventory's rows, indexed by operation.
 *
 * ⚠️ Cells are TRIMMED, never matched by prefix. Prettier pads markdown table
 * cells to align the columns, so a `line.startsWith('| \`/api/x\` |')` match
 * silently finds nothing and every lookup returns null — which reads as "the
 * inventory does not know about this route" for the whole table at once.
 */
const ROWS: Map<string, string[]> = new Map(
  doc
    .split('\n')
    .filter((l) => l.trimStart().startsWith('| `'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    )
    .filter((cells) => cells.length >= 4)
    .map((cells) => [cells[0]!.replace(/`/g, ''), cells]),
);

/** The decision the inventory records for an operation, or null if absent. */
function decisionFor(url: string): string | null {
  const cells = ROWS.get(url);
  return cells ? (cells[cells.length - 2] ?? null) : null;
}

/** The permission the inventory names for an operation (`—` when none). */
function permissionFor(url: string): string {
  const cells = ROWS.get(url);
  return cells ? (cells[cells.length - 3] ?? '') : '';
}

/**
 * Decisions that permanently justify NO project gate. These are answers, not
 * omissions — each is argued in the inventory's Reasons section.
 */
const PERMANENTLY_UNGATED = new Set([
  'workspace-scoped', // governed by the workspace role axis, out of this epic
  'user-scoped', // acts on the actor's own account
  'token-scoped', // narrowed by API-token scopes instead
  'no-gate', // no actor at all — serviceAuth, job runner, webhook
  'finding', // logged as a defect rather than silently permitted
]);

/**
 * Decisions that justify no gate YET. `new` means the inventory named the
 * permission and MOTIR-2256 has not wired it. This set shrinks to nothing as
 * that story lands, and the count below is what stops it growing meanwhile.
 */
const PENDING = new Set(['new']);

/**
 * ⚠️ THE DISCREPANCY BUCKET. The inventory marks these `existing` — "already
 * governed by a shipped predicate" — but this walk cannot CONFIRM a gate on the
 * path. Two readings, and the difference matters:
 *
 *   1. the gate is real but reached by a hop the static walk cannot follow (a
 *      dynamic dispatch, a wrapper, a re-export), or
 *   2. the claim is wrong and the operation is genuinely ungoverned.
 *
 * The inventory's `existing` labels were assigned by URL pattern — a CLAIM. This
 * guard is the verifier, and where the two disagree the disagreement is the
 * finding. It is recorded rather than resolved because resolving it either way
 * without reading each path would be guessing: silently trusting the claim hides
 * a possible hole, and silently failing them would block on 38 investigations
 * this card is not scoped for.
 *
 * MOTIR-2256 must confirm each one as it wires that domain. The count is pinned
 * so the bucket can only shrink.
 */
const CLAIMED_BUT_UNVERIFIED = new Set(['existing']);

describe('every actor-initiated operation has an ANSWER', () => {
  const ops = operations();

  it('enumerates a real surface (a guard over an empty set passes for the wrong reason)', () => {
    expect(ops.length).toBeGreaterThan(200);
    expect(ops.filter((o) => o.gated).length).toBeGreaterThan(30);
  });

  it('no operation is ungated WITHOUT a decision recorded in the inventory', () => {
    const undecided = ops
      .filter((o) => !o.gated)
      .filter((o) => {
        const d = decisionFor(o.url);
        return (
          d === null ||
          !(PERMANENTLY_UNGATED.has(d) || PENDING.has(d) || CLAIMED_BUT_UNVERIFIED.has(d))
        );
      })
      .map((o) => `${o.url} → ${decisionFor(o.url) ?? 'NOT IN THE INVENTORY'}`);
    expect(
      undecided,
      'an operation reaching the database with no gate must have a decided policy in ' +
        'docs/decisions/permission-inventory.md — add the row, do not add an exemption',
    ).toEqual([]);
  });

  it('every gated operation is one the inventory also knows about', () => {
    // The map must not fall behind in the other direction either.
    const unknown = ops.filter((o) => o.gated).filter((o) => decisionFor(o.url) === null);
    expect(
      unknown.map((o) => o.url),
      'a gated route still needs its inventory row',
    ).toEqual([]);
  });
});

describe('the PENDING set is bounded and shrinking', () => {
  const ops = operations();

  it('pins how many operations still await MOTIR-2256, so the number cannot creep', () => {
    const pending = ops.filter((o) => !o.gated && PENDING.has(decisionFor(o.url) ?? ''));
    // Adding an ungated route bumps this and fails the test; wiring one in
    // MOTIR-2256 lowers it and fails it too — both are changes worth noticing.
    // MOTIR-2256 is done when this reaches 0 and the arm can be deleted.
    expect(pending.length).toBe(94);
  });

  it('pins the CLAIMED-BUT-UNVERIFIED bucket so it can only shrink', () => {
    const unverified = ops.filter(
      (o) => !o.gated && CLAIMED_BUT_UNVERIFIED.has(decisionFor(o.url) ?? ''),
    );
    // 38 operations the inventory calls `existing` that this walk cannot confirm.
    // Each needs a human read in MOTIR-2256: either the gate is reached by a hop
    // the walk cannot follow, or the operation is genuinely ungoverned. Lowering
    // this number is progress; raising it is a regression.
    expect(unverified.length).toBe(38);
  });

  it('every pending operation names the permission that will govern it', () => {
    const nameless = ops
      .filter((o) => !o.gated && PENDING.has(decisionFor(o.url) ?? ''))
      .filter((o) => !permissionFor(o.url).startsWith('`'));
    expect(
      nameless.map((o) => o.url),
      'a pending operation must name its target key',
    ).toEqual([]);
  });
});

describe('the guard can actually fail (a guard never seen red is not evidence)', () => {
  it('detects a gate in a governed service, and its absence in an ungoverned one', () => {
    // Positive control: projectAccessService.assertCanEdit plainly gates.
    expect(methodIsGated('projectAccessService.assertCanEdit')).toBe(true);
    // Negative control: a method that does not exist cannot be gated, and a
    // known-ungoverned service reports false rather than defaulting to true.
    expect(methodIsGated('projectAccessService.__doesNotExist')).toBe(false);
    expect(methodIsGated('dashboardsService.listDashboards')).toBe(false);
  });

  it('flags a synthetic ungated operation that has no inventory row', () => {
    // Exactly the check the suite runs, against a route that does not exist —
    // proving the failure path is reachable rather than merely never taken.
    const synthetic = { url: '/api/definitely-not-a-real-route', gated: false };
    const decision = decisionFor(synthetic.url);
    expect(decision).toBeNull();
    const wouldFail =
      decision === null ||
      !(
        PERMANENTLY_UNGATED.has(decision) ||
        PENDING.has(decision) ||
        CLAIMED_BUT_UNVERIFIED.has(decision)
      );
    expect(wouldFail, 'an unknown ungated operation must be rejected').toBe(true);
  });

  it('rejects a decision string that is not one of the seven', () => {
    expect(PERMANENTLY_UNGATED.has('probably-fine')).toBe(false);
    expect(PENDING.has('probably-fine')).toBe(false);
    expect(CLAIMED_BUT_UNVERIFIED.has('probably-fine')).toBe(false);
  });
});
