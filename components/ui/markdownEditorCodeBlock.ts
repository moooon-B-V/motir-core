import { CodeBlock } from '@tiptap/extension-code-block';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

// The code block's LANGUAGE, as a field on the block (Story MOTIR-5450 ·
// Subtask MOTIR-5458; `design/github/design-notes.md` §24, panel 13b).
//
// The rendered block prints each fence's language above the code (§20), so an
// agent writing ```` ```sh ```` gets a labelled, copyable command. The shipped
// editor's Code block button calls `toggleCodeBlock()` with no attributes and
// nothing shows or changes one — a person's rich text would be strictly poorer
// than an agent's, which the parity rule forbids. This module is the field.
//
// ⚠️ IT ADDS NO SCHEMA. `language` is an attribute CodeBlock has always had:
// its input rule (```` ```sh ```` + space/Enter) sets it, its `parseHTML` reads
// it back off the `language-*` class markdown-it emits, and tiptap-markdown
// serializes it as the fence's info string. What was missing is a CONTROL, so
// this is a node view over the same node — which is why turning it on cannot
// change what any existing document round-trips to.
//
// ⚠️ IT IS PLAIN PROSEMIRROR, not `ReactNodeViewRenderer`, and deliberately.
// A React node view mounts a root per block and flushes synchronously, which
// inside an act scope is the "not wrapped in act(...)" shape CLAUDE.md treats as
// a real finding. The field is a label and an input; it does not need React, and
// a headless editor (the round-trip gate) can build it with no React at all.
//
// The LABEL is passed in rather than translated here, the same way the mention
// picker's labels are: the extension list is fixed at editor creation, so the
// locale is captured at mount and stays stable for that editor's lifetime.

/** The class the node view's outer element carries — see `markdown-editor.css`. */
export const CODE_BLOCK_CLASS = 'motir-editor-code-block';

/**
 * The bar-plus-`<pre>` node view. `contentDOM` is the `<code>` element, exactly
 * where `CodeBlock.renderHTML` puts it, so ProseMirror's text handling — the tab
 * indentation, the triple-Enter exit, the paste plugin — is untouched.
 */
class CodeBlockLanguageView implements NodeView {
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
    // The bar is chrome, not content: ProseMirror must not try to map a
    // position into it, and a click in it must not move the caret there.
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
      // EMPTY means no language — a bare ``` fence, not a fence labelled with
      // the empty string. `null` is CodeBlock's own default for the attribute.
      const typed = this.input.value.trim();
      const language = typed.length > 0 ? typed : null;
      if (language === (this.node.attrs.language ?? null)) return;
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
    // Never write over what somebody is typing — the dispatch above comes BACK
    // through here on every keystroke, and re-setting `value` would collapse a
    // selection and fight a trailing space.
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

  private syncLanguageClass() {
    const language = languageOf(this.node);
    this.contentDOM.className = language ? `language-${language}` : '';
  }
}

function languageOf(node: ProseMirrorNode): string {
  const language = node.attrs.language;
  return typeof language === 'string' ? language : '';
}

const focusedCodeBlockKey = new PluginKey('motirFocusedCodeBlock');

/**
 * Marks the code block the selection is INSIDE with `data-focused`, which is
 * what the stylesheet reveals the bar on. A node decoration's attributes land
 * on the node view's outer element, so this needs no communication with the
 * view itself. (`:focus-within` covers the other half — while the caret is in
 * the input the editor is blurred, and the bar has to stay.)
 */
function focusedCodeBlockPlugin(typeName: string): Plugin {
  return new Plugin({
    key: focusedCodeBlockKey,
    props: {
      decorations(state) {
        const { $from } = state.selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          const node = $from.node(depth);
          if (node.type.name !== typeName) continue;
          const pos = $from.before(depth);
          return DecorationSet.create(state.doc, [
            Decoration.node(pos, pos + node.nodeSize, { 'data-focused': '' }),
          ]);
        }
        return null;
      },
    },
  });
}

/**
 * CodeBlock with the language field. Drops into the extension list in place of
 * StarterKit's own code block — same node name, same attributes, same input
 * rules and keymap, so the schema and every serialization is identical.
 */
export function buildCodeBlockWithLanguage(label: string) {
  return CodeBlock.extend({
    addNodeView() {
      return ({ node, editor, getPos }) =>
        new CodeBlockLanguageView(node, editor.view, getPos, label);
    },
    addProseMirrorPlugins() {
      return [...(this.parent?.() ?? []), focusedCodeBlockPlugin(this.name)];
    },
  });
}
