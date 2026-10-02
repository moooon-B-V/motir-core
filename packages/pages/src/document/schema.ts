import { getSchema } from '@tiptap/core';
import { pageExtensions } from './extensions';

/**
 * The Yjs fragment a page's body lives in — the name Tiptap's collaboration
 * extension binds by default (`docs/decisions/pages.md` §3), so the editor and
 * the server read and write the same fragment.
 */
export const PAGE_FRAGMENT = 'default';

/** The page document's ProseMirror schema, derived once from `pageExtensions()`. */
export const pageSchema = getSchema(pageExtensions());
