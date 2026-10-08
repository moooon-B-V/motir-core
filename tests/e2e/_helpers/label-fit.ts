// Does every control's label FIT inside its control? (Story MOTIR-7730 ·
// MOTIR-7759.) The product's controls were sized for English; German and Polish
// labels run 30–40% longer, and German and Dutch compounds cannot break at a
// space. A label that does not fit is not INVISIBLE — it is clipped, spills out
// of a one-line box, breaks mid-word or slides under its neighbour — so a
// visibility assertion passes over every one of them. This measures geometry.
//
// Four predicates, on every button, tab, column header, menu item, option in a
// `Segmented` group or listbox, and link in the sidebar or top-bar navigation:
//
//   1. NO HORIZONTAL CLIP   every line of text lies horizontally inside each
//                           ancestor, up to the control, that clips or
//                           ellipsizes it (±1px).
//   2. NO SPILL             every text box lies inside the control's box
//                           (vertically and horizontally).
//   3. NO MID-WORD BREAK    a Range over each word yields ONE client rect.
//   4. NO OVERLAP           the control's box intersects no sibling control in
//                           the same cluster.
//
// The one exemption is a `Segmented` FILL segment (MOTIR-7759's sanctioned
// truncation) whose `title` AND accessible name both equal its full label.
//
// Exported so the story E2E (MOTIR-7761) can run it in `ja` and `ko`, and the
// per-language font sets story can keep a wider font inside these bounds.

import { expect, type Locator, type Page } from '@playwright/test';

export interface LabelFitContext {
  /** Where the walk is: the surface name, locale and viewport, for the report. */
  label: string;
  /** Measure only inside this subtree (a menu, a dialog). Default: the page. */
  scope?: Locator;
}

export interface LabelFitViolation {
  predicate: 'clip' | 'spill' | 'mid-word' | 'overlap';
  role: string;
  name: string;
  detail: string;
}

/** Collects every label-fit violation inside `root` (runs in the browser). */
function measure(root: Element): LabelFitViolation[] {
  const SELECTOR = [
    'button',
    '[role="button"]',
    '[role="tab"]',
    'th',
    '[role="columnheader"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[role="group"] > button[aria-pressed]',
    'nav a[href]',
    'header a[href]',
    'aside a[href]',
  ].join(',');

  const violations: LabelFitViolation[] = [];

  function visible(el: Element): boolean {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    // Closed / hidden subtrees (an inert drawer, a `hidden` ancestor).
    return !el.closest('[hidden], [aria-hidden="true"], [inert]');
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'TH') return 'columnheader';
    return el.tagName.toLowerCase();
  }

  function nameOf(el: Element): string {
    return (
      el.getAttribute('aria-label') ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    ).slice(0, 80);
  }

  function textNodes(el: Element): Text[] {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const out: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      if (!text.data.trim()) continue;
      const parent = text.parentElement;
      if (!parent || !visible(parent)) continue;
      // Screen-reader-only text is clipped by design.
      if (parent.closest('.sr-only')) continue;
      out.push(text);
    }
    return out;
  }

  // The sanctioned ellipsis: a FILL segment whose title and name keep the label.
  function sanctionedTruncation(el: Element): boolean {
    if (!el.matches('[role="group"] > button[aria-pressed]')) return false;
    const span = el.querySelector('span.truncate');
    if (!span) return false;
    const full = (span.textContent ?? '').trim();
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
    return el.getAttribute('title') === full && name.includes(full);
  }

  const controls = Array.from(root.querySelectorAll(SELECTOR)).filter(
    (el) => visible(el) && (el.textContent ?? '').trim().length > 0,
  );

  for (const el of controls) {
    const role = roleOf(el);
    const name = nameOf(el);
    const box = el.getBoundingClientRect();
    const exempt = sanctionedTruncation(el);

    // 1. Horizontal clip — measured on the TEXT, not on boxes. A box can
    //    overflow its clipping parent by its own padding or a negative margin
    //    (a sort button in a `truncate` column header) while every glyph still
    //    shows, so `scrollWidth` alone over-reports. Instead, every laid-out
    //    line of every text node must lie horizontally inside each ancestor —
    //    from the text's parent up to and including the control — that clips
    //    (overflow-x not visible) or ellipsizes. A Range keeps the text's full
    //    laid-out width even when an ellipsis paints over its tail, so a real
    //    truncation is still caught.
    if (!exempt) {
      let clipped = false;
      for (const t of textNodes(el)) {
        if (clipped) break;
        const clippers: Element[] = [];
        for (let a: Element | null = t.parentElement; a; a = a.parentElement) {
          const style = getComputedStyle(a);
          if (style.overflowX !== 'visible' || style.textOverflow === 'ellipsis') clippers.push(a);
          if (a === el) break;
        }
        if (clippers.length === 0) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const r of Array.from(range.getClientRects())) {
          if (clipped || r.width === 0) continue;
          for (const c of clippers) {
            // The clip edge is the padding box: border-box left + border width.
            const left = c.getBoundingClientRect().left + c.clientLeft;
            const right = left + c.clientWidth;
            if (r.left < left - 1 || r.right > right + 1) {
              const over = Math.max(left - r.left, r.right - right);
              violations.push({
                predicate: 'clip',
                role,
                name,
                detail: `text ${Math.round(r.left)}–${Math.round(r.right)} (${Math.round(r.width)}px) outside <${c.tagName.toLowerCase()}> ${Math.round(left)}–${Math.round(right)} (${c.clientWidth}px) by ${Math.round(over)}px`,
              });
              clipped = true;
              break;
            }
          }
        }
      }
    }

    // 2. Spill and 3. mid-word break, from the text's own boxes.
    let spilled = false;
    let broken = false;
    for (const t of textNodes(el)) {
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0) continue;
        if (!spilled && (r.top < box.top - 1 || r.bottom > box.bottom + 1)) {
          spilled = true;
          violations.push({
            predicate: 'spill',
            role,
            name,
            detail: `text ${Math.round(r.top)}–${Math.round(r.bottom)} outside control ${Math.round(box.top)}–${Math.round(box.bottom)}`,
          });
        }
        // The same containment across: a word wider than a control that does
        // not clip (no overflow ancestor for predicate 1 to catch) spills out
        // of its side instead.
        if (!spilled && !exempt && (r.left < box.left - 1 || r.right > box.right + 1)) {
          spilled = true;
          violations.push({
            predicate: 'spill',
            role,
            name,
            detail: `text ${Math.round(r.left)}–${Math.round(r.right)} outside control ${Math.round(box.left)}–${Math.round(box.right)} (horizontal)`,
          });
        }
      }
      if (broken) continue;
      const re = /\S+/g;
      for (let m = re.exec(t.data); m; m = re.exec(t.data)) {
        const word = document.createRange();
        word.setStart(t, m.index);
        word.setEnd(t, m.index + m[0].length);
        const lines = new Set(
          Array.from(word.getClientRects())
            .filter((r) => r.width > 0)
            .map((r) => Math.round(r.top)),
        );
        if (lines.size > 1) {
          broken = true;
          violations.push({
            predicate: 'mid-word',
            role,
            name,
            detail: `"${m[0]}" spans ${lines.size} lines`,
          });
          break;
        }
      }
    }

    // 4. Overlap with a sibling control in the same cluster.
    const parent = el.parentElement;
    if (parent) {
      for (const sib of Array.from(parent.children)) {
        if (sib === el || !controls.includes(sib)) continue;
        const s = sib.getBoundingClientRect();
        const overlapX = Math.min(box.right, s.right) - Math.max(box.left, s.left);
        const overlapY = Math.min(box.bottom, s.bottom) - Math.max(box.top, s.top);
        if (overlapX > 1 && overlapY > 1) {
          violations.push({
            predicate: 'overlap',
            role,
            name,
            detail: `overlaps "${nameOf(sib)}" by ${Math.round(overlapX)}×${Math.round(overlapY)}px`,
          });
          break;
        }
      }
    }
  }
  return violations;
}

/** Measures every control on the page (or inside `scope`) and fails, naming each
 *  violation's surface, locale, viewport, role, accessible name and numbers.
 *  The failure is SOFT, so one run reports every surface's violations rather
 *  than stopping at the first; the test still fails at its end. */
export async function assertLabelsFit(page: Page, context: LabelFitContext): Promise<void> {
  const violations = await (context.scope ?? page.locator('body')).evaluate(measure);
  const viewport = page.viewportSize();
  const where = `${context.label} @ ${viewport ? `${viewport.width}×${viewport.height}` : '?'}`;
  expect
    .soft(
      violations.map((v) => `${where} · ${v.predicate} · ${v.role} "${v.name}" · ${v.detail}`),
      `labels that do not fit their control (${where})`,
    )
    .toEqual([]);
}
