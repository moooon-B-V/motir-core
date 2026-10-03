import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { parseMarkdown, serializeMarkdown } from './markdown';
import { PAGE_FRAGMENT, pageSchema } from './schema';
import { PageUpdateMalformedError } from '../errors';

// The page body's conversions (Story MOTIR-5752 · MOTIR-7272), all pure and
// headless, over `Uint8Array` states (`docs/decisions/pages.md` §3).
//
// A STATE is the canonical body as stored — `Y.encodeStateAsUpdate(doc)` — and
// an UPDATE is a Yjs update produced against one. Everything else is DERIVED
// from a state: the ProseMirror JSON the read model returns, the markdown the
// agents read, and the plain text search and previews use. Nothing here reads a
// derived format to produce the state, except `markdownToUpdate`, which is the
// markdown WRITE door's way in and produces an update like any editor would.

/** The three formats derived from a state, written beside it on every save. */
export interface DerivedFormats {
  json: JSONContent;
  markdown: string;
  text: string;
}

function load(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

/**
 * The page document a state holds. y-prosemirror drops any element the schema
 * cannot hold, and an empty fragment is filled to the schema's minimum (one
 * empty paragraph), so the result always validates.
 */
function stateToDoc(state: Uint8Array): ProseMirrorNode {
  const fragment = load(state).getXmlFragment(PAGE_FRAGMENT);
  const content: Fragment = yXmlFragmentToProseMirrorFragment(fragment, pageSchema);
  return pageSchema.topNodeType.createAndFill(null, content)!;
}

/** A state holding an empty page. */
export function emptyState(): Uint8Array {
  const doc = new Y.Doc();
  doc.getXmlFragment(PAGE_FRAGMENT);
  return Y.encodeStateAsUpdate(doc);
}

/** The ProseMirror JSON of a state — valid against `pageSchema`. */
export function stateToJson(state: Uint8Array): JSONContent {
  return stateToDoc(state).toJSON() as JSONContent;
}

/** The markdown of a state. */
export function stateToMarkdown(state: Uint8Array): string {
  return serializeMarkdown(stateToDoc(state));
}

function docToText(doc: ProseMirrorNode): string {
  return doc.textBetween(0, doc.content.size, '\n', (leaf) =>
    leaf.type.name === 'hardBreak' ? '\n' : '',
  );
}

/** The plain text of a state: each block's text on its own line. */
export function stateToText(state: Uint8Array): string {
  return docToText(stateToDoc(state));
}

/** All three derived formats of a state, from one read of it. */
export function deriveFormats(state: Uint8Array): DerivedFormats {
  const doc = stateToDoc(state);
  return {
    json: doc.toJSON() as JSONContent,
    markdown: serializeMarkdown(doc),
    text: docToText(doc),
  };
}

/**
 * A state with an update applied — Yjs merges, so order never matters.
 *
 * Throws `PageUpdateMalformedError` when the UPDATE is empty or the Yjs decoder
 * refuses it (it throws a bare `Error` such as "Unexpected end of array"), so a
 * bad request is a typed refusal rather than an unexplained failure. The STATE is
 * loaded outside that guard: a stored state that will not decode is the server's
 * defect, not the caller's, and must not be reported as theirs.
 */
export function applyUpdate(state: Uint8Array, update: Uint8Array): Uint8Array {
  const doc = load(state);
  if (update.byteLength === 0) throw new PageUpdateMalformedError('empty');
  try {
    Y.applyUpdate(doc, update);
  } catch {
    throw new PageUpdateMalformedError('undecodable');
  }
  return Y.encodeStateAsUpdate(doc);
}

/**
 * The ONE update that brings a state's document to `json`.
 *
 * The fragment of a COPY of the document is brought to the JSON — y-prosemirror
 * diffs, so unchanged blocks keep their Yjs identity — and the update is
 * everything the copy has that the original lacks. Applied to the original it
 * yields the JSON's document; applied after a concurrent edit it merges, as any
 * editor's update would. The markdown write and the restore both go through
 * here, so the two cannot drift.
 */
function jsonToUpdate(state: Uint8Array, json: Record<string, unknown>): Uint8Array {
  const original = load(state);
  const copy = load(state);
  prosemirrorJSONToYXmlFragment(pageSchema, json, copy.getXmlFragment(PAGE_FRAGMENT));
  return Y.encodeStateAsUpdate(copy, Y.encodeStateVector(original));
}

/** The ONE update that makes a state's document read as `markdown`. */
export function markdownToUpdate(state: Uint8Array, markdown: string): Uint8Array {
  return jsonToUpdate(state, parseMarkdown(markdown).toJSON() as Record<string, unknown>);
}

/**
 * The ONE update that makes a state's document read as `targetState`'s — a
 * restore's diff (§6). The target's CONTENT is copied, not its Yjs history: the
 * stored state is never rewound, so a client holding newer state still merges.
 */
export function stateToUpdate(state: Uint8Array, targetState: Uint8Array): Uint8Array {
  return jsonToUpdate(state, stateToDoc(targetState).toJSON() as Record<string, unknown>);
}
