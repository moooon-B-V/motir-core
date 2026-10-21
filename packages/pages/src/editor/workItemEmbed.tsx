import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Extension, type CommandProps, type Editor } from '@tiptap/core';
import { NodeSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { ExternalLink, MoreHorizontal, TriangleAlert } from 'lucide-react';
import { WorkItemEmbed, WorkItemMention } from '../document/extensions';
import type { PageEditorMessages } from './messages';
import type {
  AvailableWorkItemRefView,
  WorkItemCandidate,
  WorkItemRefView,
} from './workItemMention';

// EMBED A WORK ITEM in the page editor (Story MOTIR-7566 · MOTIR-9182), to
// `design/pages/page--work-item-embed.mock.html` and
// `design/pages/design-notes.md` § _Embed a work item_.
//
// The mention's BLOCK twin (`workItemMention.tsx`). Three pieces live here:
//
//  • the CARD — a React node view over the document's headless `workItemEmbed`
//    node (MOTIR-9180). It draws the live summary for the node's id from the same
//    `lookup` closure the chip reads. The live and archived card is the HOST's
//    renderer; the UNAVAILABLE card is drawn here, so whatever the host renders,
//    a deleted or unreadable item shows no key, title, type, status or assignee;
//  • the INSERT — `insertWorkItemEmbed`, the card placement of the picker's pick;
//  • the CONVERSIONS — `convertMentionToEmbed` / `convertEmbedToMention`, each one
//    transaction, and their `Mod-Enter` shortcut.
//
// ⚠️ THE NODE STORES THE ID ONLY (see `workItemMention.tsx`): a pick inserts
// `{ id, label: null }` and the five facts are resolved at render, per reader.

// ── The card ─────────────────────────────────────────────────────────────────

/** What every card on the page reads; `<PageEditor>` provides it. */
export interface EmbedCardContextValue {
  /** The summary for an id, or `undefined` for a deleted one. */
  lookup: (id: string) => WorkItemRefView | undefined;
  /** The host's live / archived card — the card's body in both modes. */
  renderCard: (view: AvailableWorkItemRefView) => ReactNode;
  messages: PageEditorMessages['embed'];
  editable: boolean;
  /** Opens the work item; the card's click door in both modes. */
  onOpen?: (id: string) => void;
  /** Where the read card's single anchor points, for a modified click. */
  hrefFor?: (view: AvailableWorkItemRefView) => string;
}

export const EmbedCardContext = createContext<EmbedCardContextValue | null>(null);

/** The card the package draws when the host passes no renderer: key, title and status. */
export function defaultEmbedCard(view: AvailableWorkItemRefView): ReactNode {
  return (
    <span className={view.archived ? 'wi-card is-archived' : 'wi-card'}>
      <span className="wi-key">{view.identifier}</span>
      <span className="wi-title">{view.title}</span>
      {view.status ? <span className="wi-status">{view.status.label}</span> : null}
    </span>
  );
}

/** The class the card's node-view element carries — the selection ring's hook. */
export const EMBED_VIEW_CLASS = 'motir-wi-embed';

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const CONTROL =
  'inline-flex h-(--height-control-32) w-(--height-control-32) items-center justify-center rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) text-(--el-icon-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:text-(--el-text-faint)';
const MENU_ITEM =
  'flex w-full items-center rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13px] text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

/** The control cluster of the edit card: Open and the ⋯ menu. */
function CardCluster({
  id,
  available,
  messages,
  onOpen,
  onToMention,
  onRemove,
}: {
  id: string;
  available: boolean;
  messages: PageEditorMessages['embed'];
  onOpen?: (id: string) => void;
  onToMention: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  return (
    <div
      ref={rootRef}
      data-embed-control
      className="wi-card-cluster"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={CONTROL}
        aria-label={messages.open}
        title={messages.open}
        disabled={!available || !onOpen}
        onClick={() => onOpen?.(id)}
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        className={CONTROL}
        aria-label={messages.menu}
        title={messages.menu}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        <div role="menu" aria-label={messages.menu} className="wi-card-menu">
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              setOpen(false);
              onToMention();
            }}
          >
            {messages.toMention}
          </button>
          <hr className="my-1 border-(--el-border)" />
          <button
            type="button"
            role="menuitem"
            className={`${MENU_ITEM} text-(--el-danger-on-surface)`}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            {messages.remove}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The React node view: the live card, or the unavailable one. */
export function WorkItemEmbedView({
  node,
  editor,
  getPos,
  deleteNode,
}: Pick<NodeViewProps, 'node'> & Partial<Pick<NodeViewProps, 'editor' | 'getPos' | 'deleteNode'>>) {
  const ctx = useContext(EmbedCardContext);
  const id = String(node.attrs.id ?? '');
  const view = ctx?.lookup(id);
  const available = view?.accessible === true ? view : null;
  const editable = ctx?.editable ?? false;

  // In the editor a click SELECTS the card (ProseMirror selects the atom on
  // mousedown) and never follows it; the cluster's own controls are let through.
  const onClickCapture = (event: MouseEvent) => {
    if (!editable) return;
    if ((event.target as Element).closest('[data-embed-control]')) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const select = () => {
    const pos = getPos?.();
    if (editor && typeof pos === 'number') editor.commands.setNodeSelection(pos);
  };

  const unavailable = (
    // Deleted, or not readable by this reader — drawn the same, on purpose, with
    // none of the five facts (a reader cannot tell "deleted" from "hidden").
    <div className="wi-card is-unavailable" title={ctx?.messages.unavailableTitle}>
      <TriangleAlert className="h-4 w-4 flex-none text-(--el-warning-text)" aria-hidden />
      <span className="wi-label">{ctx?.messages.unavailable}</span>
    </div>
  );

  let body: ReactNode;
  if (!ctx) {
    body = unavailable;
  } else if (editable) {
    body = (
      <>
        <div
          className="wi-card-frame"
          role="group"
          contentEditable={false}
          aria-label={available ? ctx.messages.cardLabel(available.identifier) : undefined}
        >
          {available ? ctx.renderCard(available) : unavailable}
        </div>
        <CardCluster
          id={id}
          available={available !== null}
          messages={ctx.messages}
          onOpen={ctx.onOpen}
          onToMention={() => {
            select();
            editor?.commands.convertEmbedToMention();
          }}
          onRemove={() => deleteNode?.()}
        />
      </>
    );
  } else if (available) {
    // The read card is ONE anchor: its name is its own content, and the host's
    // card holds no interactive descendant.
    body = (
      <a
        className="wi-card-frame"
        href={ctx.hrefFor?.(available) ?? '#'}
        onClick={(event) => {
          if (event.defaultPrevented || !isPlainClick(event)) return;
          event.preventDefault();
          ctx.onOpen?.(id);
        }}
      >
        {ctx.renderCard(available)}
      </a>
    );
  } else {
    body = unavailable;
  }

  return (
    <NodeViewWrapper as="div" data-work-item-id={id} onClickCapture={onClickCapture}>
      {body}
    </NodeViewWrapper>
  );
}

/** The document's embed node, given the live card as its node view. */
export function workItemEmbedWithCard() {
  return WorkItemEmbed.extend({
    addNodeView() {
      return ReactNodeViewRenderer(WorkItemEmbedView, {
        as: 'div',
        className: EMBED_VIEW_CLASS,
      });
    },
  });
}

// ── Insert and convert ───────────────────────────────────────────────────────

const CARD_TYPE = WorkItemEmbed.name;
const CHIP_TYPE = WorkItemMention.name;

/**
 * Replace the textblock `from` sits in with `[before?, block, after?]`, where
 * `before` / `after` hold the textblock's content either side of `from..to`.
 * A side that is empty, or only whitespace, is dropped — it is not text.
 * Writes into `tr` and returns the position of the block, or `null` (leaving
 * `tr` untouched) when the schema forbids it.
 */
function splitAround(
  state: EditorState,
  tr: Transaction,
  from: number,
  to: number,
  block: PMNode,
): number | null {
  const $from = state.doc.resolve(from);
  const parent = $from.parent;
  if (parent.type.name !== 'paragraph' || !state.doc.resolve(to).sameParent($from)) return null;
  const start = $from.start();
  const beforeContent = parent.content.cut(0, from - start);
  const afterContent = parent.content.cut(to - start);
  // Any non-text node (a chip) is content; text counts unless it is all whitespace.
  const keep = (content: Fragment) =>
    content.size > 0 && content.textBetween(0, content.size, '', '￼').trim() !== '';
  const nodes: PMNode[] = [];
  if (keep(beforeContent)) nodes.push(parent.type.create(parent.attrs, beforeContent));
  const blockOffset = nodes.reduce((sum, n) => sum + n.nodeSize, 0);
  nodes.push(block);
  if (keep(afterContent)) nodes.push(parent.type.create(parent.attrs, afterContent));

  // The paragraph may be a list item's first child, which must stay a paragraph.
  const container = $from.node(-1);
  const index = $from.index(-1);
  if (!container.canReplace(index, index + 1, Fragment.from(nodes))) return null;

  tr.replaceWith($from.before(), $from.after(), nodes);
  return $from.before() + blockOffset;
}

function selectedNode(state: EditorState, type: string): { node: PMNode; pos: number } | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== type) return null;
  return { node: selection.node, pos: selection.from };
}

/**
 * Insert one card, id only, in place of `range` (the `@query`). On a line of its
 * own the card replaces the line; inside text it splits the paragraph around
 * itself. `false` — and no change — where a block cannot go.
 */
export function insertWorkItemEmbed(
  editor: Editor,
  range: { from: number; to: number },
  candidate: WorkItemCandidate,
): boolean {
  return editor
    .chain()
    .focus()
    .command(({ state, tr }) => {
      const node = state.schema.nodes[CARD_TYPE]?.create({ id: candidate.id, label: null });
      if (!node) return false;
      const at = splitAround(state, tr, range.from, range.to, node);
      if (at === null) return false;
      tr.setSelection(NodeSelection.create(tr.doc, at));
      return true;
    })
    .run();
}

/** Turn the selected chip into a card, in one transaction. */
export function convertMentionToEmbed(editor: Editor): boolean {
  return editor.commands.convertMentionToEmbed();
}

/** Turn the selected card into a chip in a paragraph of its own, in one transaction. */
export function convertEmbedToMention(editor: Editor): boolean {
  return editor.commands.convertEmbedToMention();
}

const mentionToEmbed: CommandFn = ({ state, tr }) => {
  const chip = selectedNode(state, CHIP_TYPE);
  const cardType = state.schema.nodes[CARD_TYPE];
  if (!chip || !cardType) return false;
  const card = cardType.create({ id: chip.node.attrs.id, label: chip.node.attrs.label });
  const at = splitAround(state, tr, chip.pos, chip.pos + chip.node.nodeSize, card);
  if (at === null) return false;
  tr.setSelection(NodeSelection.create(tr.doc, at));
  return true;
};

const embedToMention: CommandFn = ({ state, tr }) => {
  const card = selectedNode(state, CARD_TYPE);
  const { paragraph } = state.schema.nodes;
  const chipType = state.schema.nodes[CHIP_TYPE];
  if (!card || !paragraph || !chipType) return false;
  const $pos = state.doc.resolve(card.pos);
  const index = $pos.index();
  if (!$pos.parent.canReplaceWith(index, index + 1, paragraph)) return false;
  const chip = chipType.create({ id: card.node.attrs.id, label: card.node.attrs.label });
  tr.replaceWith(card.pos, card.pos + card.node.nodeSize, paragraph.create(null, chip));
  // The chip sits one position into its paragraph.
  tr.setSelection(NodeSelection.create(tr.doc, card.pos + 1));
  return true;
};

type CommandFn = (props: CommandProps) => boolean;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    workItemEmbedCommands: {
      /** Turn the selected work-item chip into a block card. */
      convertMentionToEmbed: () => ReturnType;
      /** Turn the selected block card into a chip. */
      convertEmbedToMention: () => ReturnType;
    };
  }
}

/** The two conversions, and `Mod-Enter` bound to whichever applies. */
export const EmbedCommands = Extension.create({
  name: 'workItemEmbedCommands',
  // Above the hard break's own `Mod-Enter`, so a selected chip or card converts first.
  priority: 200,

  addCommands() {
    return {
      convertMentionToEmbed: () => (props) => props.editor.isEditable && mentionToEmbed(props),
      convertEmbedToMention: () => (props) => props.editor.isEditable && embedToMention(props),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Enter': ({ editor }) =>
        editor.isEditable &&
        (editor.commands.convertMentionToEmbed() || editor.commands.convertEmbedToMention()),
    };
  },
});
