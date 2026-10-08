import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';
import { Extension, type Editor } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion';
import { WorkItemMention } from '../document/extensions';
import type { PageEditorMessages } from './messages';

// MENTION A WORK ITEM in the page editor (Story MOTIR-5747 · MOTIR-7574), to
// `design/pages/page--work-item-mention.mock.html` and
// `design/pages/design-notes.md` § _Mention a work item_.
//
// Three pieces live here, beside the picker (`WorkItemPicker.tsx`):
//
//  • the CHIP — a React node view over the document's headless
//    `workItemMention` node (MOTIR-7570). It draws the LIVE summary for the
//    node's id, read from the host's `workItemRefs` (what the page loaded with)
//    or, for a chip inserted this session, from the candidate that was picked.
//    The live and archived chips are the HOST's renderer (the app's shipped
//    `WorkItemRefChip`); the UNAVAILABLE chip is drawn here, so whatever the host
//    renders, a deleted or unreadable item shows neither key nor title;
//  • the `@` DOOR — a Tiptap suggestion on `@` that reports its query and caret
//    to `<PageEditor>`, which mounts the picker;
//  • the toolbar DOOR's helper — `openMentionTrigger` writes the `@` that opens
//    the same suggestion.
//
// ⚠️ THE NODE STORES THE ID ONLY. A page body is a Yjs document every reader
// receives, so a key or title written into the node would reach a reader the
// chip is hiding it from (the notes: "So the page's node stores the work item's
// id only"). A pick inserts `{ id, label: null }`; key, title, kind and status
// are resolved at render, per reader.
//
// ⚠️ EVERY PIECE OF APP WIRING IS A PROP, as for the rest of the editor
// (`docs/decisions/pages.md` §2): the search, the summaries, the chip and the
// picker row arrive from `components/pages/PageEditorHost.tsx`.

/** A status's lifecycle category — the chip's dot. */
export type WorkItemStatusCategory = 'todo' | 'in_progress' | 'done';

/** The live summary of a mentioned work item the reader may see. */
export interface AvailableWorkItemRefView {
  accessible: true;
  id: string;
  /** The current key, e.g. `MOTIR-805`. */
  identifier: string;
  title: string;
  /** The work item's kind (`epic`, `story`, `task`, `bug`, `subtask`). */
  kind: string;
  archived: boolean;
  /** `null` when the stored status no longer resolves to a workflow status. */
  status: { key?: string; label: string; category: WorkItemStatusCategory } | null;
}

/**
 * What the chip knows about one mentioned id — the app's `WorkItemRefSummaryDto`,
 * restated because the package may not import the app. `accessible: false` is an
 * item in a project the reader may not browse; an id with no entry at all is a
 * deleted one. Both draw the unavailable chip.
 */
export type WorkItemRefView = AvailableWorkItemRefView | { accessible: false; id: string };

/** One row the picker offers — what a search returns. */
export interface WorkItemCandidate {
  /** The work item's id: the only thing the inserted node stores. */
  id: string;
  identifier: string;
  title: string;
  kind: string;
  /**
   * The current status. `category` is what the inserted chip's dot reads until
   * the page is reloaded; without one the chip draws no dot.
   */
  status: { label: string; category?: WorkItemStatusCategory | null } | null;
}

/** `QUICK_SEARCH_MIN_QUERY_LENGTH` — below it the picker asks for more. */
export const MENTION_MIN_QUERY_LENGTH = 2;
/** One settled keystroke per search, as the description editor's picker waits. */
export const MENTION_SEARCH_DEBOUNCE_MS = 250;

/** The summary a just-picked candidate shows until the page is read again. */
export function candidateView(candidate: WorkItemCandidate): AvailableWorkItemRefView {
  const category = candidate.status?.category;
  return {
    accessible: true,
    id: candidate.id,
    identifier: candidate.identifier,
    title: candidate.title,
    kind: candidate.kind,
    archived: false,
    status: candidate.status && category ? { label: candidate.status.label, category } : null,
  };
}

// ── The chip ─────────────────────────────────────────────────────────────────

/** What every chip on the page reads; `<PageEditor>` provides it. */
export interface MentionChipContextValue {
  /** The summary for an id, or `undefined` for a deleted one. */
  lookup: (id: string) => WorkItemRefView | undefined;
  /** The host's live / archived chip. */
  renderChip: (view: AvailableWorkItemRefView) => ReactNode;
  messages: PageEditorMessages['mention'];
  editable: boolean;
  /** A plain click on a read-only chip the rendered chip did not handle itself. */
  onOpen?: (id: string) => void;
}

export const MentionChipContext = createContext<MentionChipContextValue | null>(null);

/** The chip the package draws when the host passes no renderer: key and title. */
export function defaultChip(view: AvailableWorkItemRefView): ReactNode {
  return (
    <span className={view.archived ? 'wi-chip is-archived' : 'wi-chip'}>
      <span className="wi-key">{view.identifier}</span>
      <span className="wi-title">{view.title}</span>
    </span>
  );
}

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The class the chip's node-view element carries — the selection ring's hook. */
export const MENTION_VIEW_CLASS = 'motir-wi-mention';

/** The React node view: the live chip, or the unavailable one. */
export function WorkItemChipView({ node }: Pick<NodeViewProps, 'node'>) {
  const ctx = useContext(MentionChipContext);
  const id = String(node.attrs.id ?? '');
  const view = ctx?.lookup(id);
  const available = view?.accessible === true ? view : null;

  // In the editor a click SELECTS the chip (ProseMirror selects the atom on
  // mousedown) and never follows it: the capture phase stops the click before
  // the chip's own link sees it.
  const onClickCapture = (event: MouseEvent) => {
    if (!ctx?.editable) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // In the read-only page a live chip opens the item. The host's chip is a link
  // that opens the peek itself (and prevents the default); a chip that does not
  // is opened here.
  const onClick = (event: MouseEvent) => {
    if (!available || event.defaultPrevented || !isPlainClick(event)) return;
    event.preventDefault();
    ctx?.onOpen?.(id);
  };

  return (
    <NodeViewWrapper
      as="span"
      data-work-item-id={id}
      onClickCapture={onClickCapture}
      onClick={onClick}
    >
      {available && ctx ? (
        ctx.renderChip(available)
      ) : (
        // Deleted, or not readable by this reader — drawn the same, on purpose,
        // with neither key nor title (the notes: a reader cannot tell
        // "deleted" from "hidden").
        <span className="wi-chip is-unavailable" title={ctx?.messages.unavailableTitle}>
          <span className="wi-label">{ctx?.messages.unavailable}</span>
        </span>
      )}
    </NodeViewWrapper>
  );
}

/** The document's mention node, given the live chip as its node view. */
export function workItemMentionWithChip() {
  return WorkItemMention.extend({
    addNodeView() {
      return ReactNodeViewRenderer(WorkItemChipView, {
        as: 'span',
        className: MENTION_VIEW_CLASS,
      });
    },
  });
}

// ── The `@` door ─────────────────────────────────────────────────────────────

/** What the suggestion reports while it is open. */
export interface MentionSuggestionState {
  /** The text after the `@`. */
  query: string;
  /** The caret's box, in viewport coordinates, when it can be measured. */
  rect: DOMRect | null;
  /** The positioned element the picker is placed in (`[data-mention-anchor]`). */
  anchor: Element | null;
  /** Insert the picked candidate in place of the `@query`. */
  pick: (candidate: WorkItemCandidate) => void;
}

export interface MentionSuggestionWiring {
  /** The suggestion opened, or its query moved. */
  onChange: (state: MentionSuggestionState) => void;
  /** It closed — a pick, Escape, the caret leaving it, a space. */
  onClose: () => void;
  /** A candidate was inserted. */
  onInsert: (candidate: WorkItemCandidate) => void;
}

/**
 * The event the suggestion hands an open picker each key it uses — ↑, ↓ and
 * Enter — with the key as its `detail`. Focus stays in the editor, so the keys
 * reach the picker this way rather than as key events of its own.
 */
export const PICKER_KEY_EVENT = 'motir-work-item-picker-key';
const PICKER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Enter']);

/** Hand `key` to the picker open beside `editorDom`; `true` when there is one. */
function forwardToPicker(editorDom: Element, key: string): boolean {
  if (!PICKER_KEYS.has(key)) return false;
  const picker = editorDom.closest('[data-mention-anchor]')?.querySelector('[data-mention-picker]');
  if (!picker) return false;
  picker.dispatchEvent(new CustomEvent(PICKER_KEY_EVENT, { detail: key }));
  return true;
}

export const MENTION_SUGGESTION_KEY = new PluginKey('workItemMentionSuggestion');

function measure(props: SuggestionProps<WorkItemCandidate, WorkItemCandidate>): DOMRect | null {
  try {
    return props.clientRect?.() ?? null;
  } catch {
    // A layout-less environment cannot measure the caret; the picker still opens.
    return null;
  }
}

/** Insert one mention, id only, and a space after it. */
export function insertWorkItemMention(
  editor: Editor,
  range: { from: number; to: number },
  candidate: WorkItemCandidate,
): void {
  const nodeAfter = editor.state.selection.$to.nodeAfter;
  const to = nodeAfter?.text?.startsWith(' ') ? range.to + 1 : range.to;
  editor
    .chain()
    .focus()
    .insertContentAt({ from: range.from, to }, [
      { type: WorkItemMention.name, attrs: { id: candidate.id, label: null } },
      { type: 'text', text: ' ' },
    ])
    .run();
}

/**
 * The `@` suggestion. Not offered inside a code block (a mention is not allowed
 * there), and inert in a read-only editor — the suggestion plugin reads
 * `editor.isEditable` — where `@` stays a plain character.
 */
export function workItemSuggestion(wiring: MentionSuggestionWiring) {
  return Extension.create({
    name: 'workItemMentionSuggestion',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        Suggestion<WorkItemCandidate, WorkItemCandidate>({
          editor,
          pluginKey: MENTION_SUGGESTION_KEY,
          char: '@',
          allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
          items: () => [],
          command: ({ editor: e, range, props: candidate }) => {
            insertWorkItemMention(e, range, candidate);
            wiring.onInsert(candidate);
          },
          render: () => {
            const report = (props: SuggestionProps<WorkItemCandidate, WorkItemCandidate>) =>
              wiring.onChange({
                query: props.query,
                rect: measure(props),
                anchor: props.editor.view.dom.closest('[data-mention-anchor]'),
                pick: (candidate) => props.command(candidate),
              });
            return {
              onStart: report,
              onUpdate: report,
              onExit: () => wiring.onClose(),
              // Escape is the plugin's own: it closes the suggestion.
              onKeyDown: ({ view, event }) => forwardToPicker(view.dom, event.key),
            };
          },
        }),
      ];
    },
  });
}

// ── The toolbar door ─────────────────────────────────────────────────────────

/**
 * Write an `@` at the caret, so the suggestion opens there — the toolbar's Work
 * item button. A selection is replaced by it. After a word the `@` takes a
 * space first: the suggestion opens only at a word's start.
 */
export function openMentionTrigger(editor: Editor): void {
  const { $from } = editor.state.selection;
  const before =
    $from.parentOffset > 0
      ? $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, '', '￼')
      : '';
  const trigger = before === '' || /\s/.test(before) ? '@' : ' @';
  editor.chain().focus().insertContent(trigger).run();
}
