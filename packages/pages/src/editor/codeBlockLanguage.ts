import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeView,
  type NodeViewConstructor,
} from '@tiptap/pm/view';

// The code block's LANGUAGE field (Story MOTIR-5752 · MOTIR-7275), copied from
// the description editor's `components/ui/markdownEditorCodeBlock.ts`
// (MOTIR-5458) — by copy, because the package may not import `@/…`. The class
// names are that file's, so the app's shipped `markdown-editor.css` rules for
// the bar (`design/pages/design-notes.md` § _The toolbar_) style this one too.
//
// ⚠️ ONE DEPARTURE, and it is what keeps the page's ONE extension list one list.
// The description editor swaps StarterKit's code block for an extended copy that
// carries a node view. The page editor cannot: `pageExtensions()` is the schema
// the server derives every format from (MOTIR-7272), and a second code-block
// node in the editor's list would be a duplicate name. So this is an EXTENSION
// whose plugin supplies the node view through ProseMirror's `nodeViews` prop.
// Tiptap puts only the views its NODE extensions declare on the view's own
// props, and StarterKit's code block declares none, so ProseMirror falls through
// to this plugin's — same node, same schema, a field added.
//
// It is plain ProseMirror rather than a React node view for the reason the
// original gives: a React root per block flushes synchronously inside an act
// scope, and the field is only a label and an input.

/** The class the node view's outer element carries. */
export const CODE_BLOCK_CLASS = 'motir-editor-code-block';

const CODE_BLOCK = 'codeBlock';

function languageOf(node: ProseMirrorNode): string {
  const language: unknown = node.attrs.language;
  return typeof language === 'string' ? language : '';
}

/**
 * The bar-plus-`<pre>` view; `contentDOM` is the `<code>`, as CodeBlock renders
 * it. Exported for its unit test; the package barrel does not re-export it.
 */
export class CodeBlockLanguageView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private node: ProseMirrorNode;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    label: string,
  ) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = CODE_BLOCK_CLASS;

    this.bar = document.createElement('div');
    this.bar.className = `${CODE_BLOCK_CLASS}-bar`;
    // Chrome, not content: no position maps into it.
    this.bar.contentEditable = 'false';

    const caption = document.createElement('span');
    caption.className = `${CODE_BLOCK_CLASS}-label`;
    caption.textContent = label;

    this.input = document.createElement('input');
    this.input.className = `${CODE_BLOCK_CLASS}-language`;
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('aria-label', label);
    this.input.value = languageOf(node);
    this.input.addEventListener('input', () => {
      const pos = getPos();
      if (pos === undefined) return;
      // Empty means no language — a bare fence — which is CodeBlock's `null`.
      const typed = this.input.value.trim();
      const language = typed.length > 0 ? typed : null;
      if (language === this.node.attrs.language) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language }));
    });

    this.bar.append(caption, this.input);
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.appendChild(code);
    this.dom.append(this.bar, pre);
    this.contentDOM = code;
    this.syncLanguageClass();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // Never write over what somebody is typing in the field.
    const language = languageOf(node);
    if (document.activeElement !== this.input && this.input.value !== language) {
      this.input.value = language;
    }
    this.syncLanguageClass();
    return true;
  }

  /** Every event inside the bar is the field's, never the document's. */
  stopEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Node && this.bar.contains(target);
  }

  /** The bar is ours to mutate; only `contentDOM` is ProseMirror's. */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return !this.contentDOM.contains(mutation.target);
  }

  private syncLanguageClass(): void {
    const language = languageOf(this.node);
    this.contentDOM.className = language ? `language-${language}` : '';
  }
}

const codeBlockLanguageKey = new PluginKey('motirPageCodeBlockLanguage');

/**
 * The Language field on every code block, shown (by the stylesheet) only on the
 * block the caret is in: the plugin marks that block `data-focused`.
 */
export function codeBlockLanguage(label: string): Extension {
  return Extension.create({
    name: 'pageCodeBlockLanguage',
    addProseMirrorPlugins() {
      const editor = this.editor;
      // A read-only page never holds a caret, so its code blocks draw only their
      // own frame (design-notes § _State 10_): no field is built for a view that
      // is not editable when the block renders — returning nothing hands the
      // block back to CodeBlock's own rendering.
      const nodeView = ((node, view, getPos) =>
        view.editable
          ? new CodeBlockLanguageView(node, view, getPos, label)
          : undefined) as NodeViewConstructor;
      return [
        new Plugin({
          key: codeBlockLanguageKey,
          props: {
            nodeViews: { [CODE_BLOCK]: nodeView },
            decorations(state) {
              if (!editor.isEditable) return null;
              const { $from } = state.selection;
              for (let depth = $from.depth; depth > 0; depth -= 1) {
                const node = $from.node(depth);
                if (node.type.name !== CODE_BLOCK) continue;
                const pos = $from.before(depth);
                return DecorationSet.create(state.doc, [
                  Decoration.node(pos, pos + node.nodeSize, { 'data-focused': '' }),
                ]);
              }
              return null;
            },
          },
        }),
      ];
    },
  });
}
