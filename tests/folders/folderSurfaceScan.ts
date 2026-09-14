import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

// The derivations behind `folder-surface-guard.test.ts` (Story MOTIR-5310 ·
// MOTIR-5420), as PURE functions over source TEXT — so the guard's control can
// drive the identical code over a synthetic `errors.ts` that does not exist on
// disk, and a control that re-implements a predicate cannot stand in for it.
//
// Reads four named files as data through the TypeScript parser and imports none
// of them: the structural-guard lane forbids reaching `lib/`
// (`tests/ci-structural-guards-lane.test.ts`).

export const ROOT = resolve(__dirname, '..', '..');

export const FOLDER_ERRORS_FILE = 'lib/folders/errors.ts';
export const V1_ERRORS_FILE = 'lib/api/v1/errors.ts';
export const TOOL_RESULT_FILE = 'lib/mcp/toolResult.ts';
export const WORK_ITEM_DTO_FILE = 'lib/dto/workItems.ts';
export const V1_WORK_ITEM_SCHEMA_FILE = 'lib/api/v1/workItems/schema.ts';

export const readRepoFile = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

export interface ErrorClass {
  name: string;
  code: string;
}

/**
 * Every EXPORTED class in an errors module that carries a `code` property
 * initialised to a string literal — the typed-error shape every door maps. A
 * class with no literal code is still reported, with `code: ''`, so a new error
 * written in another shape fails the guard by name instead of escaping it.
 */
export function exportedErrorClasses(text: string): ErrorClass[] {
  const source = parse(FOLDER_ERRORS_FILE, text);
  const out: ErrorClass[] = [];
  for (const stmt of source.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name || !isExported(stmt)) continue;
    let code = '';
    for (const member of stmt.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        propertyName(member.name) === 'code' &&
        member.initializer
      ) {
        const init = ts.isAsExpression(member.initializer)
          ? member.initializer.expression
          : member.initializer;
        if (ts.isStringLiteral(init)) code = init.text;
      }
    }
    out.push({ name: stmt.name.text, code });
  }
  return out;
}

function findVariable(source: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function firstObjectLiteral(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(node)) return node;
  return ts.forEachChild(node, firstObjectLiteral);
}

function objectKeys(literal: ts.ObjectLiteralExpression): string[] {
  return literal.properties.flatMap((p) => {
    if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name) {
      const key = propertyName(p.name);
      return key === undefined ? [] : [key];
    }
    return [];
  });
}

/** The codes `DOMAIN_ERROR_STATUS` maps — the keys of its frozen object literal. */
export function domainErrorStatusCodes(text: string): string[] {
  const decl = findVariable(parse(V1_ERRORS_FILE, text), 'DOMAIN_ERROR_STATUS');
  const literal = decl?.initializer && firstObjectLiteral(decl.initializer);
  return literal ? objectKeys(literal) : [];
}

/** Every class `toToolError` tests with `err instanceof <Class>`, anywhere in its body. */
export function toToolErrorInstanceofClasses(text: string): string[] {
  const source = parse(TOOL_RESULT_FILE, text);
  const fn = source.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === 'toToolError',
  );
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(node.right)
    ) {
      names.add(node.right.text);
    }
    ts.forEachChild(node, visit);
  };
  if (fn?.body) visit(fn.body);
  return [...names];
}

/** The member names of an exported interface. */
export function interfaceMembers(text: string, name: string): string[] {
  const source = parse(WORK_ITEM_DTO_FILE, text);
  const decl = source.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
  );
  return (decl?.members ?? []).flatMap((m) => {
    const key = m.name && propertyName(m.name);
    return key ? [key] : [];
  });
}

/**
 * The keys a zod schema constant declares in its OWN object literal — the
 * `z.object({…})` it opens, or the `.extend({…})` it adds. A base it extends is
 * read separately, so the caller walks the chain it cares about.
 */
export function schemaOwnKeys(text: string, name: string): string[] {
  const decl = findVariable(parse(V1_WORK_ITEM_SCHEMA_FILE, text), name);
  const literal = decl?.initializer && firstObjectLiteral(decl.initializer);
  return literal ? objectKeys(literal) : [];
}
