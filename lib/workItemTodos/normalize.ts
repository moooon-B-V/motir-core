// The three field NORMALIZERS for a to-do row (Story MOTIR-3808 · MOTIR-3813),
// lifted out of `workItemTodosService` by MOTIR-4618 so that the SECOND writer
// of these rows — `plansService.materialize`, when it turns an approved
// proposal's `todos` into real rows — reaches the same functions rather than a
// copy of their rules.
//
// ⚠️ THIS IS THE `limits.ts` ARGUMENT ONE LAYER OUT. That file exists so the
// NUMBER has one home; this one exists so the RULES ABOUT the number do —
// reject-never-truncate on `text`, whitespace-only-becomes-`null` on the two
// optional fields, trim before compare on all three. A materialize that
// re-implemented them would be a second bar, and the drift would be silent in
// the worst direction: a row accepted at approve that the card's own edit
// surface would then refuse.
//
// PURE — no DB, no Prisma, no `tx`. They throw the domain's own typed errors,
// which every caller already translates.

import {
  EmptyTodoTextError,
  TodoCommandTooLongError,
  TodoNotesTooLongError,
  TodoTextTooLongError,
} from './errors';
import { TODO_COMMAND_MAX_LENGTH, TODO_NOTES_MAX_LENGTH, TODO_TEXT_MAX_LENGTH } from './limits';

/**
 * Validate a to-do's text against the granularity bar and return it trimmed.
 *
 * REJECTS, never truncates — the difference matters: a truncated step is a
 * step whose second half is silently gone, and the author is the only person
 * who can decide which two steps it should have been.
 */
export function requireText(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) throw new EmptyTodoTextError();
  if (text.length > TODO_TEXT_MAX_LENGTH) throw new TodoTextTooLongError(text.length);
  return text;
}

/**
 * Validate the optional INSTRUCTIONS and return them, or `null`.
 *
 * Markdown, unlike `text` — the how of a dashboard flow wants a numbered list
 * and a link, and a plain-text field would strip exactly the part that makes
 * *"go to the dashboard"* actionable. Whitespace-only normalises to `null` so a
 * row cannot render an empty disclosure.
 *
 * ⚠️ THIS CAP IS NOT A GRANULARITY BAR. `text`'s 200 asks *"is this one
 * operation?"*; this 2000 asks *"has the how become a document?"* — and the
 * remedy for hitting it is a card, not a split, which is what its typed error
 * says.
 */
export function normalizeNotes(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const notes = raw.trim();
  if (notes.length === 0) return null;
  if (notes.length > TODO_NOTES_MAX_LENGTH) throw new TodoNotesTooLongError(notes.length);
  return notes;
}

/**
 * Validate an optional command. An empty / whitespace-only string normalises to
 * `null` rather than to `''` — the DTO's contract is that `commandText === null`
 * is exactly "not a command row", and an empty string would make a row that
 * renders a copy button for nothing.
 */
export function normalizeCommand(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const command = raw.trim();
  if (command.length === 0) return null;
  if (command.length > TODO_COMMAND_MAX_LENGTH) throw new TodoCommandTooLongError(command.length);
  return command;
}
