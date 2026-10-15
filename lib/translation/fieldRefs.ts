// A translatable field's ADDRESS (Story MOTIR-7735 · MOTIR-8114) — split from
// `fieldRevision.ts` (MOTIR-8122) so the browser can build the same refs: that
// module hashes with `node:crypto`, which a client component cannot import.
// `fieldRevision` re-exports both names, so every server caller is unchanged.

/** One field to translate or look up: its address and its CURRENT stored text. */
export interface TranslatableField {
  fieldRef: string;
  text: string;
}

/** The ONLY producer of a fieldRef: no caller spells one by hand. */
export const fieldRef = {
  title: (): string => 'title',
  description: (): string => 'description',
  explanation: (): string => 'explanation',
  todoText: (todoId: string): string => `todo:${todoId}:text`,
  todoNotes: (todoId: string): string => `todo:${todoId}:notes`,
} as const;
