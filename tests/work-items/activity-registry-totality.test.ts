import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isRegisteredDiffKey } from '@/lib/activity/renderers';

// The registry totality guard (Subtask 5.5.1 · mistake #29). The renderer
// registry must hold an EXPLICIT disposition (renderable or suppressed) for
// every diff key any `recordRevision` call site can write — the generic
// fallback exists so an unknown key degrades legibly at RUNTIME, but a key
// the codebase itself writes must never ship on the fallback unnoticed. This
// test statically scans every service file that records revisions, extracts
// the diff-key vocabulary from the three construction styles the codebase
// uses, and fails when a key has no explicit registry entry — pointing the
// sibling story that introduced it at the renderable-vs-suppressed decision.
//
// Construction styles covered (the shapes in the plan-time audit):
//   1. inline literals:    diff: { sprintId: { from, to }, ... }
//   2. built-up variables: const diff = {};  diff.kind = { from, to };
//                          diff['x'] = ...;  diff: { ...spread } (flagged)
//   3. builder helpers:    set('title', row.title) inside buildCreatedDiff
//
// A computed key (e.g. a template literal `customFields.${key}`) must match a
// registered PREFIX; any other dynamic key fails the scan outright — "I can't
// see what you write" is itself a registry gap to resolve, not a pass.

const SERVICES_DIR = join(__dirname, '../../lib/services');

/** The plan-time audited vocabulary (2026-06-10) — the floor the registry may never drop below. */
const AUDITED_DIFF_KEYS = [
  'projectId',
  'parentId',
  'kind',
  'key',
  'identifier',
  'title',
  'descriptionMd',
  'explanationMd',
  'explanationSource',
  'status',
  'priority',
  'assigneeId',
  'reporterId',
  'dueDate',
  'estimateMinutes',
  'storyPoints',
  'sprintId',
  'backlogRank',
  'position',
  'archivedAt',
  'links',
];

interface ScanResult {
  keys: Map<string, string>; // key → "file:pos" provenance (first sighting)
  dynamic: string[]; // unanalyzable computed keys (file + snippet)
}

function propertyNameText(name: ts.PropertyName, source: ts.SourceFile): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return computedKeyText(name.expression, source);
  return null;
}

/** A computed key resolves only when its compile-time PREFIX is visible. */
function computedKeyText(expr: ts.Expression, _source: ts.SourceFile): string | null {
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isTemplateExpression(expr) && expr.head.text.length > 0) return expr.head.text;
  return null;
}

/** True when the node sits inside a function bound to the name `set`. */
function isInsideSetBuilder(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name?.text === 'set') return true;
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name) &&
      cur.parent.name.text === 'set'
    ) {
      return true;
    }
  }
  return false;
}

function scanServiceFile(filePath: string, out: ScanResult): void {
  const text = readFileSync(filePath, 'utf8');
  if (!text.includes('recordRevision')) return;
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const where = (node: ts.Node): string =>
    `${filePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  const record = (key: string | null, node: ts.Node): void => {
    if (key === null) {
      out.dynamic.push(`${where(node)} — ${node.getText(source).slice(0, 80)}`);
      return;
    }
    if (!out.keys.has(key)) out.keys.set(key, where(node));
  };

  const visit = (node: ts.Node): void => {
    // Style 1 — `diff: { ... }` inline object literal.
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name, source) === 'diff' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
          record(propertyNameText(prop.name, source), prop);
        } else {
          record(null, prop); // spreads / accessors are unanalyzable
        }
      }
    }
    // Style 2 — assignments onto an identifier named `diff`:
    // `diff.kind = ...` / `diff['x'] = ...`. The body of a `set` builder
    // helper is exempt: its `diff[k] = ...` writes whatever key its CALLERS
    // pass, and those call sites are what style 3 scans.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === 'diff' &&
      !isInsideSetBuilder(node)
    ) {
      if (ts.isPropertyAccessExpression(node.left)) {
        record(node.left.name.text, node);
      } else {
        record(computedKeyText(node.left.argumentExpression, source), node);
      }
    }
    // Style 3 — `set('title', ...)` builder calls (buildCreatedDiff's shape;
    // a bare-identifier call, so `map.set(...)` never matches).
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'set' &&
      node.arguments.length >= 1
    ) {
      const first = node.arguments[0] as ts.Expression;
      record(computedKeyText(first, source), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function scanAllServices(): ScanResult {
  const out: ScanResult = { keys: new Map(), dynamic: [] };
  for (const entry of readdirSync(SERVICES_DIR)) {
    if (entry.endsWith('.ts')) scanServiceFile(join(SERVICES_DIR, entry), out);
  }
  return out;
}

describe('activity renderer registry totality (mistake #29)', () => {
  const scan = scanAllServices();

  it('finds the audited call-site vocabulary (the scanner itself works)', () => {
    // If the scanner went blind (a refactor changed the construction style),
    // every key would silently pass — so assert it still sees the floor.
    for (const key of AUDITED_DIFF_KEYS) {
      expect(scan.keys.has(key), `scanner no longer finds audited key '${key}'`).toBe(true);
    }
  });

  it('every diff key the services write has an explicit registry disposition', () => {
    const unregistered = [...scan.keys.entries()].filter(([key]) => !isRegisteredDiffKey(key));
    const message = unregistered
      .map(
        ([key, site]) =>
          `'${key}' (written at ${site}) has no entry in lib/activity/renderers.ts — ` +
          `add an explicit renderable or suppressed disposition`,
      )
      .join('\n');
    expect(unregistered, message).toEqual([]);
  });

  it('every audited key stays registered (the registry can only grow)', () => {
    const missing = AUDITED_DIFF_KEYS.filter((key) => !isRegisteredDiffKey(key));
    expect(missing).toEqual([]);
  });

  it('no unanalyzable dynamic diff keys exist', () => {
    // Template keys with a static head (`customFields.${key}`) resolve to
    // that head and are checked as prefixes above; anything landing here had
    // NO visible compile-time prefix, so the registry cannot vouch for it.
    expect(
      scan.dynamic,
      `dynamic diff keys the scanner cannot resolve:\n${scan.dynamic.join('\n')}\n` +
        `give the key a static prefix and register it in PREFIX_REGISTRY`,
    ).toEqual([]);
  });
});
