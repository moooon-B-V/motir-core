import type { Locator, Page } from '@playwright/test';

// THE READER'S PLACE, RECORDED BEFORE A BURST AND COMPARED AFTER IT
// (Story MOTIR-8539 · Subtask MOTIR-8580).
//
// "The page did not refresh" is half the story's claim. The other half is that
// the reader is still WHERE THEY WERE: the same scroll offset, the same focused
// control holding the same half-typed text and the same selection inside it, and
// the same DOM nodes — not an identical-looking copy React mounted in their place.
// Every one of those is read from the browser, never from component state.
//
// ⚠️ NODE IDENTITY IS A MARKER, NOT A SELECTOR. A remount renders the same text
// in the same place, so a locator that finds "the port" after the burst proves
// nothing. {@link stampNode} writes an attribute onto the live element; React
// never writes it, so it survives only if that exact element was never replaced.
//
// ⚠️ "NOTHING CHANGED" IS COUNTED, NOT INFERRED. {@link recordMutations} installs
// a `MutationObserver` on a subtree and counts every record it delivers. A quiet
// window is then a measured zero, not the absence of a visible difference.

const PROBE_ATTR = 'data-place-probe';
const MUTATIONS_KEY = '__placeMutations';

/** Mark `target`'s element as `mark` — the identity a remount would lose. */
export async function stampNode(target: Locator, mark: string): Promise<void> {
  await target.evaluate((el, [attr, value]) => el.setAttribute(attr!, value!), [PROBE_ATTR, mark]);
}

/** How many elements still carry `mark`: 1 when the stamped node is still mounted. */
export function stamped(page: Page, mark: string): Locator {
  return page.locator(`[${PROBE_ATTR}="${mark}"]`);
}

/** What the reader is doing, read in one tick. */
export interface Place {
  /** `scrollTop` of every stamped element, by its mark. */
  scroll: Record<string, number>;
  /** The mark of the focused element, or null when it carries none. */
  activeMark: string | null;
  /** The focused control's value — the half-typed text. */
  activeValue: string | null;
  /** The focused control's own selection, as `[start, end]`. */
  activeSelection: [number, number] | null;
}

/** Read the reader's place. Stamp the scroll containers and the focused control first. */
export async function readPlace(page: Page): Promise<Place> {
  return page.evaluate((attr) => {
    const scroll: Record<string, number> = {};
    document.querySelectorAll(`[${attr}]`).forEach((el) => {
      scroll[el.getAttribute(attr)!] = Math.round((el as HTMLElement).scrollTop);
    });
    const active = document.activeElement as HTMLElement | null;
    const field =
      active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
    return {
      scroll,
      activeMark: active?.getAttribute(attr) ?? null,
      activeValue: field ? field.value : null,
      activeSelection:
        field && field.selectionStart !== null && field.selectionEnd !== null
          ? ([field.selectionStart, field.selectionEnd] as [number, number])
          : null,
    };
  }, PROBE_ATTR);
}

/**
 * Count every mutation record delivered for `target`'s subtree under `key` —
 * child lists, attributes and text. Re-installing under the same key restarts
 * the count.
 */
export async function recordMutations(target: Locator, key: string): Promise<void> {
  await target.evaluate(
    (el, [store, name]) => {
      const w = window as unknown as Record<
        string,
        Record<string, { count: number; observer: MutationObserver }>
      >;
      const all = (w[store!] ??= {});
      all[name!]?.observer.disconnect();
      const entry = {
        count: 0,
        observer: new MutationObserver((records) => {
          entry.count += records.length;
        }),
      };
      entry.observer.observe(el, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      all[name!] = entry;
    },
    [MUTATIONS_KEY, key],
  );
}

/** The mutation records counted for `key` since {@link recordMutations}. */
export async function mutationsOf(page: Page, key: string): Promise<number> {
  return page.evaluate(
    ([store, name]) => {
      const w = window as unknown as Record<string, Record<string, { count: number }> | undefined>;
      return w[store!]?.[name!]?.count ?? -1;
    },
    [MUTATIONS_KEY, key],
  );
}
