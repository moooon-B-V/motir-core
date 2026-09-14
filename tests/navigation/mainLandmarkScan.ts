// MOTIR-5432 — the nested-`main` scanner.
//
// `AppLayout` (`components/ui/AppLayout.tsx`) renders the signed-in document's
// ONE `<main id="main">` — the skip-link's target — around every page under
// `app/(authed)/`, via `app/(authed)/layout.tsx`. A page that renders its own
// `<main>` inside it nests a SECOND `main` landmark: assistive tech is offered
// two "main content" regions, and `page.getByRole('main')` resolves to two
// elements, which Playwright's strict mode refuses. The work item page did
// exactly that from its content column until MOTIR-5432.
//
// The population is decided by LOCATION, and that is exact rather than a
// heuristic: every file under `app/(authed)/` renders inside the shell's
// `<main>`, and every route that legitimately owns its own `main` — the
// onboarding, admin and auth groups, `/tokens`, `not-found` — lives outside it.
// A shared component under `components/` cannot be placed that way (the same
// file may render inside the shell or outside it), which is why the
// `issue-detail-flow` E2E also counts the landmark in the browser.
//
// The predicate reads JSX through the TypeScript compiler, so a COMMENT that
// names `<main>` — the item page carries several — is not a site. It matches
// an intrinsic `<main>` and `role="main"` on any element; `<Main>` is a
// component whose rendering lives elsewhere and is not ruled on here.
//
// This module parses text handed to it (`findMainLandmarks`) and walks the tree
// only through `scanShellMainLandmarks`; the guard that consumes it is
// `tests/navigation/shell-single-main-landmark.test.ts`, a member of the
// structural-guard lane (`tests/helpers/structuralGuardLane.ts`).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/** Every file under this root renders inside `AppLayout`'s `<main>`. */
export const SHELL_ROOT = 'app/(authed)';

export interface MainLandmarkSite {
  /** Repo-relative path with POSIX separators. */
  file: string;
  /** 1-based line of the element's opening tag. */
  line: number;
  /** An intrinsic `<main>`, or `role="main"` on some other element. */
  form: 'element' | 'role';
}

function isRoleMain(attributes: ts.JsxAttributes): boolean {
  return attributes.properties.some((attr) => {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name) || attr.name.text !== 'role') {
      return false;
    }
    const init = attr.initializer;
    if (!init) return false;
    if (ts.isStringLiteral(init)) return init.text === 'main';
    return (
      ts.isJsxExpression(init) &&
      !!init.expression &&
      ts.isStringLiteralLike(init.expression) &&
      init.expression.text === 'main'
    );
  });
}

/** Every `main` landmark one source text renders. Parses nothing else. */
export function findMainLandmarks(source: string, file: string): MainLandmarkSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: MainLandmarkSite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (ts.isIdentifier(node.tagName) && node.tagName.text === 'main') {
        sites.push({ file, line, form: 'element' });
      } else if (isRoleMain(node.attributes)) {
        sites.push({ file, line, form: 'role' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (/\.[jt]sx$/.test(entry)) out.push(full);
  }
}

/** Every `main` landmark rendered under the shell root, and how many files were read. */
export function scanShellMainLandmarks(repoRoot: string): {
  files: number;
  sites: MainLandmarkSite[];
} {
  const files: string[] = [];
  walk(join(repoRoot, SHELL_ROOT), files);
  const sites: MainLandmarkSite[] = [];
  for (const full of files) {
    const source = readFileSync(full, 'utf8');
    // Cheap pre-filter: a file that never spells `main` cannot render one.
    if (!source.includes('main')) continue;
    sites.push(...findMainLandmarks(source, relative(repoRoot, full).split(sep).join('/')));
  }
  return { files: files.length, sites };
}
