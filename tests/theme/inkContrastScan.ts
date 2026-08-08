import ts from 'typescript';

// The ink-contrast scanner (MOTIR-2459). It ships on its own, ahead of the
// repo-wide lint that consumes it (MOTIR-2475 turns on the faint arm with its
// sweep, MOTIR-2477 the muted arm with its own), so that the classification
// below can be reviewed and pinned to fixtures — including a deliberately
// violating one — before it is pointed at 134 files. A lint whose negative case
// is never exercised is a lint nobody knows is running.
//
// ── What it decides, and why an AST rather than a grep ──────────────────────
// MOTIR-2455 measured that `--el-text-faint` clears AA on NO surface in either
// theme (2.37–2.61:1), which leaves it exactly two legitimate jobs: decorative
// glyphs, whose meaning lives in a label rather than in the pixels, and
// disabled / inactive text, which WCAG 1.4.3 explicitly exempts. Both of those
// are STRUCTURE, not text: `aria-hidden`, `role="img"`, a `disabled` attribute,
// a `disabled ? faint : ink` ternary. A grep sees the class and none of the
// structure, so it can only ever count occurrences; the parser sees the element
// the class lands on and can therefore say which of the three cases it is.
//
// The same argument decides the second rule. `--el-text-muted` is 4.54:1 on the
// white page/card and fails on every tinted surface (4.12–4.34:1), so the
// verdict depends on the BACKGROUND the ink sits over — which means walking up
// the JSX tree to the nearest ancestor that paints one.
//
// ── What it deliberately cannot see ─────────────────────────────────────────
// Surface inheritance stops at the file boundary: an element whose background
// is painted by a `<Card>` in another module reads here as "no surface in this
// file", and the muted rule abstains. The faint rule has no such hole — it is a
// property of the element itself — which is why that one is the enforced sweep
// and the muted one is scoped to what a single file can prove.

/** The two inks under measurement, as they appear in an arbitrary-value class. */
export const FAINT_CLASS = 'text-(--el-text-faint)';
export const MUTED_CLASS = 'text-(--el-text-muted)';

/**
 * Backgrounds that are NOT the white page/card, on which `--el-text-muted`
 * drops below 4.5:1 (MOTIR-2455's measured table). `--el-card` and the bare
 * page are the safe ones and are deliberately absent.
 */
const TINTED_SURFACE_CLASSES = [
  'bg-(--el-surface)',
  'bg-(--el-surface-soft)',
  'bg-(--el-muted)',
] as const;

/**
 * Predicates whose TRUE branch is a disabled / inactive state — the 1.4.3
 * exemption. Matched against the ternary's condition source, so `disabled`,
 * `isDisabled`, `seatOff`, `!canEdit` and `locked` all land here.
 */
const DISABLED_TEST =
  /\b(?:is|are|has)?[A-Za-z]*(?:disabled|locked|inactive|readonly|unavailable)\b|\b[a-z][A-Za-z]*Off\b|\bnot(?:Allowed|Held|Available)\b/i;

/** Predicates whose FALSE branch is the disabled one (`enabled ? ink : faint`). */
const ENABLED_TEST =
  /\b(?:is|can|has)?[A-Za-z]*(?:enabled|active|available|editable|allowed|held)\b/i;

export type Verdict = 'decorative' | 'disabled' | 'violation' | 'unattributable';

export interface InkFinding {
  file: string;
  line: number;
  /** Which measured ink this finding is about. */
  ink: 'faint' | 'muted';
  verdict: Verdict;
  /** Why the scanner ruled the way it did — quoted verbatim in the failure. */
  reason: string;
  /** The element the class landed on, or `null` when it landed on a constant. */
  element: string | null;
  snippet: string;
}

/** Every string-ish node whose text contains `needle`, with its position. */
function classLiterals(source: ts.SourceFile, needle: string): ts.Node[] {
  const hits: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      node.text.includes(needle)
    ) {
      hits.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return hits;
}

/** The JSX element a node sits inside an ATTRIBUTE of, if any. */
function owningElement(node: ts.Node): ts.JsxOpeningLikeElement | null {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    if (ts.isJsxAttribute(cursor)) {
      const parent = cursor.parent.parent;
      return ts.isJsxOpeningLikeElement(parent) ? parent : null;
    }
    // A nested element ends the search: the class belongs to whatever attribute
    // we are inside, and crossing an element boundary means we were never in
    // one (a class constant declared mid-render, say).
    if (ts.isJsxElement(cursor) || ts.isJsxSelfClosingElement(cursor)) return null;
  }
  return null;
}

function attributesOf(element: ts.JsxOpeningLikeElement): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const attr of element.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name)) continue;
    const initializer = attr.initializer;
    if (!initializer) {
      attrs.set(attr.name.text, 'true'); // bare `aria-hidden` / `disabled`
    } else if (ts.isStringLiteral(initializer)) {
      attrs.set(attr.name.text, initializer.text);
    } else {
      attrs.set(attr.name.text, initializer.getText());
    }
  }
  return attrs;
}

function tagNameOf(element: ts.JsxOpeningLikeElement): string {
  return element.tagName.getText();
}

/**
 * Does this element render any text of its own? A control whose entire content
 * is glyphs paints no characters for 1.4.3 to measure, so the ink on it is
 * governed by 1.4.11 (a separate threshold and a separate card), not by this
 * sweep. A `{…}` child is counted as text: the scanner cannot see what an
 * expression renders, and "I can't tell" has to mean "assume text".
 */
function rendersText(element: ts.JsxOpeningLikeElement): boolean {
  if (ts.isJsxSelfClosingElement(element)) return false; // a glyph by construction
  const node = element.parent;
  if (!node || !ts.isJsxElement(node)) return false;
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim().length > 0) return true;
      continue;
    }
    if (ts.isJsxExpression(child)) {
      if (child.expression) return true;
      continue;
    }
    const opening = ts.isJsxElement(child)
      ? child.openingElement
      : ts.isJsxSelfClosingElement(child)
        ? child
        : null;
    if (!opening) continue;
    const hidden = attributesOf(opening).get('aria-hidden');
    if (hidden !== undefined && hidden !== 'false' && hidden !== '{false}') continue;
    if (rendersText(opening)) return true;
  }
  return false;
}

/** Does the element carry an accessible name of its own? */
function accessibleName(element: ts.JsxOpeningLikeElement): boolean {
  const attrs = attributesOf(element);
  return attrs.has('aria-label') || attrs.has('aria-labelledby');
}

/**
 * `true` when the element is a glyph whose meaning is carried elsewhere — the
 * first of the two legitimate jobs. Note this asks for an EXPLICIT marker: an
 * icon that merely looks decorative but is announced by a screen reader is a
 * defect in its own right, so "make it legibly decorative" is the fix rather
 * than an exemption.
 */
function isDecorative(element: ts.JsxOpeningLikeElement): string | null {
  const attrs = attributesOf(element);
  const hidden = attrs.get('aria-hidden');
  if (hidden !== undefined && hidden !== 'false' && hidden !== '{false}') {
    return `<${tagNameOf(element)}> is aria-hidden`;
  }
  if (attrs.get('role') === 'img') {
    // An UNLABELLED role="img" carries meaning nothing else states.
    return accessibleName(element) ? `<${tagNameOf(element)}> is a labelled role="img"` : null;
  }
  if (accessibleName(element) && !rendersText(element)) {
    return `<${tagNameOf(element)}> is a labelled control whose content is glyphs only`;
  }
  return null;
}

/** `true` when the element itself declares the disabled state 1.4.3 exempts. */
function isDisabledElement(element: ts.JsxOpeningLikeElement): string | null {
  const attrs = attributesOf(element);
  for (const key of ['disabled', 'aria-disabled']) {
    const value = attrs.get(key);
    if (value !== undefined && value !== 'false' && value !== '{false}') {
      return `<${tagNameOf(element)}> carries ${key}`;
    }
  }
  return null;
}

/**
 * `true` when the class sits in the disabled branch of a ternary — the shape
 * `disabled ? faint : ink`, which is the 1.4.3 exemption written as a style.
 */
function inDisabledBranch(node: ts.Node): string | null {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    const parent = cursor.parent;
    if (parent && ts.isConditionalExpression(parent)) {
      const test = parent.condition.getText();
      const inTrue = parent.whenTrue === cursor || contains(parent.whenTrue, cursor);
      const inFalse = parent.whenFalse === cursor || contains(parent.whenFalse, cursor);
      if (inTrue && DISABLED_TEST.test(test)) return `disabled branch of \`${test}\``;
      if (inFalse && ENABLED_TEST.test(test)) return `inactive branch of \`${test}\``;
    }
    if (ts.isJsxAttribute(cursor)) break; // do not escape the attribute
  }
  return null;
}

function contains(haystack: ts.Node, needle: ts.Node): boolean {
  return needle.pos >= haystack.pos && needle.end <= haystack.end;
}

/** The class strings any JSX element carries, flattened to one searchable blob. */
function classBlob(element: ts.JsxOpeningLikeElement): string {
  const className = element.attributes.properties.find(
    (attr) =>
      ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === 'className',
  );
  return className ? className.getText() : '';
}

/**
 * The nearest ancestor (within this file) that paints a background, and whether
 * that background is one the muted ink fails on. Returns `null` when no
 * ancestor in this file paints one — the abstention documented at the top.
 */
function nearestSurface(node: ts.Node): { className: string; tinted: boolean } | null {
  for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
    const element = ts.isJsxElement(cursor)
      ? cursor.openingElement
      : ts.isJsxSelfClosingElement(cursor)
        ? cursor
        : ts.isJsxOpeningLikeElement(cursor)
          ? cursor
          : null;
    if (!element) continue;
    const blob = classBlob(element);
    if (/\bbg-\(--el-card\)/.test(blob)) return { className: blob, tinted: false };
    const tinted = TINTED_SURFACE_CLASSES.find((surface) => blob.includes(surface));
    if (tinted) return { className: tinted, tinted: true };
  }
  return null;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/**
 * The snippet a reader sees in the failure. It deliberately includes the
 * element's CHILDREN where there are any: the opening tag alone shows the class
 * and hides the thing the verdict is about — whether this element paints real
 * copy — which is exactly the judgement the reader is being asked to check.
 */
function snippetOf(source: ts.SourceFile, node: ts.Node): string {
  const element = owningElement(node);
  const subject =
    element && ts.isJsxOpeningElement(element) && ts.isJsxElement(element.parent)
      ? element.parent
      : (element ?? node);
  const text = subject.getText(source).replace(/\s+/g, ' ');
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

/**
 * Scan one source file. `fileName` is only used for reporting, so a synthetic
 * fixture can be scanned by passing its text directly.
 */
export function scanSource(fileName: string, text: string): InkFinding[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: InkFinding[] = [];

  for (const node of classLiterals(source, FAINT_CLASS)) {
    const element = owningElement(node);
    const line = lineOf(source, node);
    const snippet = snippetOf(source, node);
    const base = { file: fileName, line, ink: 'faint' as const, snippet };

    if (!element) {
      findings.push({
        ...base,
        verdict: 'unattributable',
        reason:
          'the class is not attached to a JSX element here, so nothing can show it is decorative or disabled',
        element: null,
      });
      continue;
    }

    const decorative = isDecorative(element);
    const disabled = isDisabledElement(element) ?? inDisabledBranch(node);
    findings.push({
      ...base,
      element: tagNameOf(element),
      verdict: decorative ? 'decorative' : disabled ? 'disabled' : 'violation',
      reason:
        decorative ??
        disabled ??
        `<${tagNameOf(element)}> paints active informational text with an ink that clears AA on no surface`,
    });
  }

  for (const node of classLiterals(source, MUTED_CLASS)) {
    const element = owningElement(node);
    if (!element) continue; // the muted rule needs an element to find a surface for
    // 1.4.3 measures TEXT. A glyph or a disabled control is out of its scope
    // whichever ink it takes, so those are filtered before the surface lookup.
    if (isDecorative(element) || isDisabledElement(element) || inDisabledBranch(node)) continue;
    const surface = nearestSurface(element);
    if (!surface?.tinted) continue;
    findings.push({
      file: fileName,
      line: lineOf(source, node),
      ink: 'muted',
      verdict: 'violation',
      element: tagNameOf(element),
      reason: `--el-text-muted is 4.12–4.34:1 on ${surface.className}; it clears AA only on the white page/card`,
      snippet: snippetOf(source, node),
    });
  }

  return findings;
}

/** The findings that FAIL the guard — everything the two legitimate jobs do not cover. */
export function violations(findings: InkFinding[]): InkFinding[] {
  return findings.filter(
    (finding) => finding.verdict === 'violation' || finding.verdict === 'unattributable',
  );
}

export function formatFinding(finding: InkFinding): string {
  return `${finding.file}:${finding.line} — ${finding.reason}\n    ${finding.snippet}`;
}
