// MOTIR-2491 — the `Modal.Body`-bypass scanner.
//
// `Modal`'s panel is `flex max-h-[90vh] flex-col overflow-hidden`. A consumer
// whose children are a bare `<div>` / `<form>` gets a flex item with
// `min-height: auto`, which cannot shrink below its content, so on a short
// viewport the overflow is CLIPPED by the panel and no scrollbar appears
// anywhere — whatever sits at the bottom (usually the footer, i.e. the primary
// action) becomes unreachable. `Modal.Body` owns the recipe that makes that
// survivable (`flex min-h-0 flex-1 flex-col overflow-y-auto`).
//
// Two instances shipped past their own test suites before this scanner existed
// (MOTIR-462, MOTIR-2488), and the two had OPPOSITE source shapes:
//
//   * MOTIR-462 — a ~20-line `<Modal>` whose whole body was ONE child component
//     (`<SprintReport>`) that rendered a chart. Nothing about the call site said
//     "tall"; the height lived in a file the call site never names.
//   * MOTIR-2488 — a 180-line `<form>` with four fields, one of them
//     progressively disclosed, so the tallest state rendered in no fixture.
//
// So the predicate is about SHAPE, not line count. A `<Modal>` that does not
// wrap its content in `Modal.Body` is SHORT — and allowed bare — only when its
// height is knowable from the call site alone: no child component whose
// rendering lives elsewhere, no repeated element (`.map`, a list, a table, a
// `<pre>`), at most two form fields, and a bounded region. Everything else
// must either use `Modal.Body` or carry a MEASUREMENT on the line — a comment
// saying it was rendered at a short viewport, in its tallest reachable state,
// and fit:
//
//     {/* modal-scroll-container: measured 1280x700, tallest = <state>, panel <n>px */}
//
// The exemption is deliberately a claim about a MEASUREMENT rather than an
// opinion about the markup: the card that introduced this guard found that
// reading JSX and reasoning about height is exactly how both prior instances
// were missed, and the sweep that measured every site at 1280×700 is what the
// comment records.
//
// This module parses text handed to it (`classifyModalSource`) and walks the
// tree only through `scanModalSites`; the guard that consumes it is
// `tests/theme/modalScrollContainer.test.ts`, a member of the structural-guard
// lane (`tests/helpers/structuralGuardLane.ts`).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export const SCANNED_ROOTS = ['app', 'components', 'packages/design-system/src'] as const;

/** Where the primitive is DEFINED (and re-exported). Never a call site. */
const DEFINITION_FILES = new Set([
  'components/ui/Modal.tsx',
  'packages/design-system/src/components/ui/Modal.tsx',
]);

/**
 * Form controls the design system ships. Each adds a known, bounded row to the
 * modal; more than `MAX_BARE_FIELDS` of them is the MOTIR-2488 shape.
 */
export const FIELD_TAGS = new Set([
  'Input',
  'Textarea',
  'Combobox',
  'Select',
  'DatePicker',
  'Segmented',
  'Checkbox',
  'Toggle',
  'Switch',
  'FormField',
  'Stepper',
  'ColorSwatchPicker',
  'RadioGroup',
  'input',
  'textarea',
  'select',
]);

/** Intrinsic elements that repeat or hold unbounded content. */
const REPEATING_TAGS = new Set(['ul', 'ol', 'table', 'pre', 'dl']);

/**
 * Primitives whose height is bounded and known at the call site: they render a
 * control or a chip, never arbitrary content of their own. (Containers such as
 * `Card` are not listed because their CHILDREN are what decide the height, and
 * those children are in the same file — the walk sees them.)
 */
const INLINE_PRIMITIVES = new Set([
  'Button',
  'IconButton',
  'Pill',
  'Badge',
  'Spinner',
  'Kbd',
  'Fragment',
  'Tooltip',
  'Link',
  'Image',
]);

/** Import sources whose named exports are design-system primitives, not app components. */
const PRIMITIVE_SOURCES = [
  /^@\/components\/ui\//,
  /^@motir\/design-system$/,
  /^\.\.?\/(\.\.\/)*ui\//,
];
const ICON_SOURCES = [/^lucide-react$/, /^@\/components\/icons/];

/** The bounds under which a bare `<Modal>` counts as SHORT. */
export const MAX_BARE_FIELDS = 2;
export const MAX_BARE_LINES = 80;

/** The exemption marker. The viewport and the state are both REQUIRED. */
export const MEASURED_MARKER =
  /modal-scroll-container:\s*measured\s+(\d+)x(\d+)\s*,\s*tallest\s*=\s*([^\n*]+?)(?:,\s*panel\s*(\d+)px)?\s*(?:\*\/|$)/;

export type ModalVerdict = 'body' | 'short' | 'measured' | 'VIOLATION';

export interface ModalSite {
  /** Repo-relative path with POSIX separators. */
  file: string;
  /** 1-based line of the opening `<Modal`. */
  line: number;
  endLine: number;
  lines: number;
  hasBody: boolean;
  /** Field-like primitives inside the element. */
  fields: number;
  /** Child components whose rendering lives in another file (or `{children}`). */
  opaque: string[];
  /** `.map(` calls and repeating intrinsics inside the element. */
  repeats: string[];
  measured: { viewport: string; height: number; state: string; panel: number | null } | null;
  verdict: ModalVerdict;
  /** Why it is not SHORT — empty when it is. */
  reasons: string[];
}

function tagNameOf(node: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node))
    return `${tagNameOf(node.expression as ts.JsxTagNameExpression)}.${node.name.text}`;
  if (ts.isThisTypeNode(node)) return 'this';
  return node.getText();
}

interface ImportIndex {
  icons: Set<string>;
  primitives: Set<string>;
}

function indexImports(sf: ts.SourceFile): ImportIndex {
  const icons = new Set<string>();
  const primitives = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const source = stmt.moduleSpecifier.text;
    const names: string[] = [];
    const clause = stmt.importClause;
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) names.push(el.name.text);
    }
    if (ICON_SOURCES.some((re) => re.test(source))) names.forEach((n) => icons.add(n));
    else if (PRIMITIVE_SOURCES.some((re) => re.test(source)))
      names.forEach((n) => primitives.add(n));
  }
  return { icons, primitives };
}

function isModalTag(name: string): boolean {
  return name === 'Modal';
}

function classifyElement(
  el: ts.JsxElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
  file: string,
  imports: ImportIndex,
  source: string,
): ModalSite {
  const start = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1;
  const end = sf.getLineAndCharacterOfPosition(el.getEnd()).line + 1;
  let hasBody = false;
  let fields = 0;
  const opaque: string[] = [];
  const repeats: string[] = [];

  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const name = tagNameOf(n.tagName);
      if (name === 'Modal.Body') hasBody = true;
      else if (name === 'Modal.Footer' || name === 'Modal.Trigger' || name === 'Modal') {
        // the primitive's own parts
      } else if (FIELD_TAGS.has(name)) fields++;
      else if (REPEATING_TAGS.has(name)) repeats.push(`<${name}>`);
      else if (/^[a-z]/.test(name)) {
        // an intrinsic element: its children are walked
      } else if (imports.icons.has(name) || /Icon$/.test(name)) {
        // an icon glyph
      } else if (INLINE_PRIMITIVES.has(name) || imports.primitives.has(name)) {
        // a design-system primitive: bounded, or a container whose children are walked
      } else if (!opaque.includes(name)) {
        opaque.push(name);
      }
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'map')
        repeats.push('.map(');
    } else if (
      ts.isJsxExpression(n) &&
      n.expression &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'children'
    ) {
      if (!opaque.includes('{children}')) opaque.push('{children}');
    }
    ts.forEachChild(n, visit);
  };
  // Walk the element's CHILDREN (its own opening tag would name `Modal` again).
  if (ts.isJsxElement(el)) el.children.forEach((c) => visit(c));

  // The exemption may sit inside the element or on the lines directly above it.
  const lineStarts = source.split('\n');
  const above = lineStarts.slice(Math.max(0, start - 1 - 6), start - 1).join('\n');
  const region = lineStarts.slice(start - 1, end).join('\n');
  const marker = MEASURED_MARKER.exec(region) ?? MEASURED_MARKER.exec(above);
  const measured = marker
    ? {
        viewport: `${marker[1]}x${marker[2]}`,
        height: Number(marker[2]),
        state: marker[3]!.trim(),
        panel: marker[4] ? Number(marker[4]) : null,
      }
    : null;

  const lines = end - start + 1;
  const reasons: string[] = [];
  if (opaque.length) reasons.push(`renders ${opaque.join(', ')} — height decided in another file`);
  if (repeats.length) reasons.push(`repeats content (${[...new Set(repeats)].join(', ')})`);
  if (fields > MAX_BARE_FIELDS) reasons.push(`${fields} form fields (> ${MAX_BARE_FIELDS})`);
  if (lines > MAX_BARE_LINES) reasons.push(`${lines} lines (> ${MAX_BARE_LINES})`);

  const verdict: ModalVerdict = hasBody
    ? 'body'
    : measured
      ? 'measured'
      : reasons.length === 0
        ? 'short'
        : 'VIOLATION';

  return {
    file,
    line: start,
    endLine: end,
    lines,
    hasBody,
    fields,
    opaque,
    repeats,
    measured,
    verdict,
    reasons,
  };
}

/** Classify every `<Modal>` call site in one source text. Parses nothing else. */
export function classifyModalSource(source: string, file: string): ModalSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = indexImports(sf);
  const sites: ModalSite[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && isModalTag(tagNameOf(n.openingElement.tagName))) {
      sites.push(classifyElement(n, sf, file, imports, source));
      // A Modal nested inside a Modal is its own site; keep walking.
    } else if (ts.isJsxSelfClosingElement(n) && isModalTag(tagNameOf(n.tagName))) {
      sites.push(classifyElement(n, sf, file, imports, source));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.tsx')) out.push(full);
  }
}

/** Every `<Modal>` call site under the scanned roots, repo-relative. */
export function scanModalSites(repoRoot: string): ModalSite[] {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) walk(join(repoRoot, root), files);
  const sites: ModalSite[] = [];
  for (const full of files) {
    const rel = relative(repoRoot, full).split(sep).join('/');
    if (DEFINITION_FILES.has(rel)) continue;
    const source = readFileSync(full, 'utf8');
    if (!/<Modal(\s|>|\/)/.test(source)) continue;
    sites.push(...classifyModalSource(source, rel));
  }
  return sites;
}
