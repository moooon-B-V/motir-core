import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// WHERE THE LIVE HOST IS MOUNTED (Story MOTIR-5238 · Subtask MOTIR-5245).
//
// ⚠️ THIS GUARD EXISTS BECAUSE EVERY OTHER TEST PASSED. `workbench-live.test.tsx`
// and `approval-overlay-subject-moved.test.tsx` both render
// `<WorkbenchLive><ApprovalOverlay /></WorkbenchLive>` — and that arrangement
// existed NOWHERE in the product. The overlay is mounted once in
// `app/(authed)/layout.tsx`, above every page, so while the provider lived
// inside `app/(authed)/workbench/page.tsx` it was not an ancestor of the
// overlay: the overlay read `WorkbenchLiveContext`'s QUIET default, its nudge
// was always `0`, its probe never fired, and MOTIR-5243's whole deliverable was
// inert while its own suite was green. The acceptance E2E found it.
//
// A component test cannot see this, by construction: it has to mount the tree
// itself, and mounting it correctly is the very thing the page was not doing.
// So the assertion is about the SOURCE — who wraps whom — which is the only
// place the relationship is written down.
//
// It is deliberately a TEXT check rather than a render. The alternative is
// rendering the authed layout, which needs a session, an active project, a
// workspace and eight providers — a test that would break for a dozen reasons
// having nothing to do with the one fact it is guarding.

const root = path.resolve(__dirname, '../..');

/**
 * The file with its COMMENTS removed.
 *
 * ⚠️ Both files explain this mount at length, and the explanations name
 * `<WorkbenchLive>` — so a guard reading the raw text would find the provider in
 * the prose that says where the provider is NOT. What is being asserted is the
 * TREE, so the prose has to go first.
 */
function code(relative: string): string {
  // ⚠️ LINE COMMENTS FIRST, THEN BLOCKS, and the order is not cosmetic: strip
  // `{/* … */}` first and a stray `/*` left behind pairs with a `*/` hundreds of
  // lines away, swallowing the very element this asserts on. One block rule
  // covers `{/* … */}` too; the leftover braces are nothing to an index check.
  return readFileSync(path.join(root, relative), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const layout = code('app/(authed)/layout.tsx');
const workbenchPage = code('app/(authed)/workbench/page.tsx');

describe('the live host is an ANCESTOR of everything that reads it', () => {
  it('wraps BOTH the page children and the approval overlay, in the shell', () => {
    const open = layout.indexOf('<WorkbenchLive>');
    const close = layout.indexOf('</WorkbenchLive>');
    const children = layout.indexOf('{children}');
    const overlay = layout.indexOf('<ApprovalOverlay');

    expect(open, '`app/(authed)/layout.tsx` must mount <WorkbenchLive>').toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    // ⚠️ BOTH, and the overlay is the one that was missing.
    expect(children, '{children} must be INSIDE <WorkbenchLive>').toBeGreaterThan(open);
    expect(children).toBeLessThan(close);
    expect(overlay, '<ApprovalOverlay /> must be INSIDE <WorkbenchLive>').toBeGreaterThan(open);
    expect(overlay).toBeLessThan(close);
  });

  it('is mounted ONCE — the Workbench page does not open a second one', () => {
    // A second provider would shadow the shell's for everything below it, and
    // its `useWorkbenchLiveStream` would open a SECOND connection: the exact
    // fan-out `useRunEvents.ts`'s header was written about.
    expect(workbenchPage).not.toContain('<WorkbenchLive>');
    expect(layout.match(/<WorkbenchLive>/g) ?? []).toHaveLength(1);
  });

  it('does NOT put a Suspense boundary above the page children', () => {
    // CLAUDE.md: a boundary that can flush the response head before a page's own
    // gate has run fixes the status at 200, and eleven authed pages call
    // `notFound()`. The host must therefore never be wrapped in one HERE — which
    // is also why it reads no `searchParams` of its own.
    const open = layout.indexOf('<WorkbenchLive>');
    const before = layout.slice(Math.max(0, open - 400), open);
    expect(before).not.toContain('<Suspense');
  });
});
