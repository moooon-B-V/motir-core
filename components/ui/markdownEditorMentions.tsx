'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ReactRenderer, type Editor } from '@tiptap/react';
import { Mention } from '@tiptap/extension-mention';
import { cn } from '@/lib/utils/cn';

// Mention capability for the shared MarkdownEditor (Subtask 5.1.4). Typing `@`
// opens a caret-anchored member listbox (the Combobox option-row vocabulary —
// design/work-items/comments.mock.html panel 5); picking inserts an atomic
// mention node that SERIALIZES to the durable Markdown token
// `[@Display Name](mention:<userId>)` — the exact format the server-side
// parser (`lib/mentions/parse.ts`, 5.1.2) is the authority on. The body stays
// plain Markdown: one storage format, no parallel rich-text blob.
//
// The host surface supplies the candidates (`mentionCandidates` on
// MarkdownEditor) — the issue-scoped viewable members from the 5.1.2 candidate
// read. This module stays data-source-agnostic; without the prop the extension
// is never registered and the editor is byte-identical to today.
//
// Round-trip: tiptap-markdown loads Markdown via markdown-it, which renders the
// token as `<a href="mention:<id>">@Name</a>` (markdown-it's validateLink only
// blocks javascript:/vbscript:/file:/data:). A high-priority parseHTML rule
// converts that anchor into the mention node, and `storage.markdown.serialize`
// writes the token back out — load → edit → getMarkdown() is stable.

export interface MentionCandidate {
  id: string;
  /** Display name — becomes the token's `@Display Name` label. */
  name: string;
  /** Secondary line in the picker (right-aligned, muted). */
  email?: string | null;
}

/** Wiring the editor hands the extension at create time. Both callbacks read
 * refs so candidate updates never recreate the editor. */
export interface MentionWiring {
  getCandidates: () => MentionCandidate[];
  /** The positioned ancestor the popup mounts into (the editor's bordered
   * wrapper). Absolute coords relative to it work inside a Radix Dialog too —
   * a body portal there hits the focus-trap/pointer-events/transform traps the
   * Combobox already documents, so the popup never portals. */
  getAnchor: () => HTMLElement | null;
}

const MENTION_ID_RE = /^[A-Za-z0-9_-]+$/;

interface MentionListProps {
  items: MentionCandidate[];
  command: (item: { id: string; label: string }) => void;
}

export interface MentionListHandle {
  onKeyDown: (args: { event: KeyboardEvent | ReactKeyboardEvent }) => boolean;
}

/**
 * The caret-anchored member listbox. Focus stays in the editor (the suggestion
 * plugin forwards key events here), so the active row is conveyed with
 * `aria-activedescendant` on the listbox + `aria-selected` on the row — the
 * comments.mock.html panel-5 markup. Rows are the Combobox option-row
 * vocabulary: 22px initial-letter avatar · name · muted right-aligned email.
 */
export const MentionList = forwardRef<MentionListHandle, MentionListProps>(function MentionList(
  { items, command },
  ref,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset the active row whenever the filtered set changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const active = items.length > 0 ? Math.min(selectedIndex, items.length - 1) : 0;

  const select = (index: number) => {
    const item = items[index];
    if (item) command({ id: item.id, label: item.name });
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setSelectedIndex(items.length > 0 ? (active + 1) % items.length : 0);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelectedIndex(items.length > 0 ? (active - 1 + items.length) % items.length : 0);
        return true;
      }
      if (event.key === 'Enter') {
        select(active);
        return true;
      }
      return false;
    },
  }));

  return (
    <div
      role="listbox"
      aria-label="Mention a member"
      aria-activedescendant={items.length > 0 ? `mention-option-${active}` : undefined}
      className="border-(--el-border) bg-(--el-page-bg) shadow-(--shadow-elevated) z-50 w-max max-w-[18rem] rounded-(--radius-card) border p-1"
    >
      {items.length === 0 ? (
        <p className="text-(--el-text-muted) px-(--spacing-control-x) py-(--spacing-control-y) text-sm">
          No matches
        </p>
      ) : (
        items.map((item, index) => (
          <div
            key={item.id}
            id={`mention-option-${index}`}
            role="option"
            aria-selected={index === active}
            onMouseEnter={() => setSelectedIndex(index)}
            // mousedown, not click: the editor keeps focus/selection, so the
            // suggestion range is still there for the command to replace.
            onMouseDown={(event) => {
              event.preventDefault();
              select(index);
            }}
            className={cn(
              'flex min-w-55 cursor-pointer items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm',
              index === active ? 'bg-(--el-surface) text-(--el-text)' : 'text-(--el-text)',
            )}
          >
            <span
              className="bg-(--el-text) text-(--el-text-inverted) inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
              aria-hidden
            >
              {item.name.charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{item.name}</span>
            {item.email ? (
              // The active row sits on the --el-surface tint, where muted text
              // drops under WCAG AA (4.17:1) — step up to secondary there
              // (6.2:1); inactive rows stay muted on the page bg (4.54:1).
              // Caught by the 5.1.7 strict axe sweep (picker open).
              <span
                className={cn(
                  'ml-auto truncate text-xs',
                  index === active ? 'text-(--el-text-secondary)' : 'text-(--el-text-muted)',
                )}
              >
                {item.email}
              </span>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
});

/** Filter candidates the Combobox way — name OR email substring match. */
export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const matched =
    needle === ''
      ? candidates
      : candidates.filter(
          (c) =>
            c.name.toLowerCase().includes(needle) ||
            (c.email ? c.email.toLowerCase().includes(needle) : false),
        );
  return matched.slice(0, 8);
}

/**
 * The configured tiptap Mention extension. Builds on the official extension
 * (atomic inline node, suggestion plugin, default insert command) and adds:
 *  - Markdown serialization to `[@Name](mention:<id>)` (tiptap-markdown spec);
 *  - a parseHTML rule for the `<a href="mention:…">` markdown-it produces on
 *    load, outranking the Link mark so the token round-trips as a node;
 *  - the designed chip rendering in the editor (`mention-chip`, styled in
 *    markdown-editor.css — the same class MarkdownView's renderer emits);
 *  - the caret-anchored MentionList popup, absolutely positioned inside the
 *    editor wrapper (never a body portal — see MentionWiring.getAnchor).
 */
export function buildMentionExtension(wiring: MentionWiring) {
  return Mention.extend({
    addStorage() {
      return {
        markdown: {
          serialize(
            state: { write: (text: string) => void },
            node: { attrs: { id: string; label: string | null } },
          ) {
            state.write(`[@${node.attrs.label ?? ''}](mention:${node.attrs.id})`);
          },
          parse: {}, // load-side parsing is the parseHTML rule below
        },
      };
    },
    parseHTML() {
      return [
        // What the editor itself emits (copy/paste within the editor).
        { tag: 'span[data-type="mention"]' },
        // What markdown-it emits for the stored token on load. Higher priority
        // than the Link mark's generic `a[href]` rule so the anchor becomes a
        // mention node, not a link. A malformed id is left to the Link mark
        // (and degrades to plain text on the render side).
        {
          tag: 'a[href^="mention:"]',
          priority: 1000,
          getAttrs: (element) => {
            const el = element as HTMLElement;
            const id = (el.getAttribute('href') ?? '').slice('mention:'.length);
            if (!MENTION_ID_RE.test(id)) return false;
            const label = (el.textContent ?? '').replace(/^@/, '');
            return { id, label };
          },
        },
      ];
    },
  }).configure({
    HTMLAttributes: { class: 'mention-chip' },
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    suggestion: {
      char: '@',
      items: ({ query }) => filterMentionCandidates(wiring.getCandidates(), query),
      render: () => {
        let component: ReactRenderer<MentionListHandle, MentionListProps> | null = null;
        let popup: HTMLElement | null = null;

        // Anchor the popup at the caret: clientRect is in viewport coords, the
        // popup is absolutely positioned inside the (relative) editor wrapper,
        // so translate via the wrapper's own rect.
        const position = (clientRect: (() => DOMRect | null) | null | undefined) => {
          const anchor = wiring.getAnchor();
          if (!popup || !anchor) return;
          let rect: DOMRect | null = null;
          try {
            rect = clientRect?.() ?? null;
          } catch {
            // Layout-less environments (tests) can't measure the caret; the
            // popup still mounts, just unpositioned.
          }
          if (!rect) return;
          const anchorRect = anchor.getBoundingClientRect();
          popup.style.left = `${Math.round(rect.left - anchorRect.left)}px`;
          popup.style.top = `${Math.round(rect.bottom - anchorRect.top + 4)}px`;
        };

        const destroy = () => {
          popup?.remove();
          popup = null;
          component?.destroy();
          component = null;
        };

        return {
          onStart: (props) => {
            const anchor = wiring.getAnchor();
            if (!anchor) return;
            component = new ReactRenderer(MentionList, {
              props: { items: props.items, command: props.command },
              editor: props.editor as Editor,
            });
            popup = document.createElement('div');
            popup.style.position = 'absolute';
            popup.style.zIndex = '50';
            popup.appendChild(component.element);
            anchor.appendChild(popup);
            position(props.clientRect);
          },
          onUpdate: (props) => {
            component?.updateProps({ items: props.items, command: props.command });
            position(props.clientRect);
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              destroy();
              return true;
            }
            return component?.ref?.onKeyDown({ event: props.event }) ?? false;
          },
          onExit: destroy,
        };
      },
    },
  });
}
