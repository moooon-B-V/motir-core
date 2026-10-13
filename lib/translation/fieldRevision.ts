import { createHash } from 'node:crypto';

// A translatable field's address and revision (Story MOTIR-7735 · Subtask
// MOTIR-8114). Pure — no I/O.
//
// A FIELD is one of a work item's title, description or explanation, or one
// to-do's text or notes. It is addressed by a stable `fieldRef` string, and the
// builders below are the ONLY producer of one: no caller spells a ref by hand,
// so the kept-translation store (`workItemTranslationRepository`) and every
// reader agree on the key.
//
// A field's REVISION is the sha256 of its own current text. Editing one field
// changes that field's revision only, so the other fields' kept translations
// stay valid, and there is no version counter for the edit paths to keep in
// step. The `fieldRef` space is OPEN (one `todo:<id>:…` pair per to-do), so no
// map keyed on a closed union may stand in for it.

/** One field to translate or look up: its address and its CURRENT stored text. */
export interface TranslatableField {
  fieldRef: string;
  text: string;
}

export const fieldRef = {
  title: (): string => 'title',
  description: (): string => 'description',
  explanation: (): string => 'explanation',
  todoText: (todoId: string): string => `todo:${todoId}:text`,
  todoNotes: (todoId: string): string => `todo:${todoId}:notes`,
} as const;

/** The revision of a field's text: sha256, as 64 lowercase hex characters. */
export function hashFieldText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Whether a field's text is worth translating at all. Empty or whitespace-only
 * text is never stored and never served: there is nothing to translate.
 */
export function hasTranslatableText(text: string): boolean {
  return text.trim().length > 0;
}
