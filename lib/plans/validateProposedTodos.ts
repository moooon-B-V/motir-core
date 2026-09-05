// ── The proposed to-do list's bar, at BOTH proposal write boundaries ──────────
// (Story MOTIR-3810 · MOTIR-4616; `docs/decisions/agent-authored-plans.md`
// AMENDMENT 13 D4.)
//
// A proposal can carry a card's ordered STEPS, and approve turns them into real
// `work_item_todo` rows. So the proposal path is a SECOND writer of those rows —
// and a second writer is exactly how a bar stops being a bar.
//
// ⚠️ THE THREE CAPS ARE IMPORTED, NEVER RE-DECLARED. `lib/workItemTodos/limits.ts`
// exists so the number has ONE home: "a bar enforced in two places is a bar that
// drifts". A proposal path that declared its own `200` would let a 400-character
// step — two operations wearing one checkbox — through a door the store never
// sees, and it would be accepted at plan time and rejected on the card it
// materialized into.
//
// PURE: no DB, no Prisma client, no `tx`. It runs at `addProposals` (the append)
// and again on the MERGED result at `updateProposal` / `correctProposal` (the
// deepen and the correction), which is what makes the kind gate hold when a
// deepen flips `kind` rather than the list.
//
// Every refusal is an `InvalidProposalError` — the routes already map it to 422
// `PROPOSALS_INVALID` — and every message names the ROW INDEX, because the
// caller correcting it is usually an agent that can act on a coordinate and
// cannot act on "one of your steps is too long".

import type { ProposedTodoInput } from '@/lib/dto/plans';
import { InvalidProposalError } from '@/lib/plans/errors';
import { TYPEABLE_KINDS } from '@/lib/issues/executorDefaults';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import {
  TODO_COMMAND_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_TEXT_MAX_LENGTH,
} from '@/lib/workItemTodos/limits';

/** The two executors a row may name — the Prisma `Executor` enum, as a value. */
const PROPOSED_TODO_EXECUTORS: readonly string[] = ['coding_agent', 'human'];

/**
 * A length measured the way the STORE measures it — on the TRIMMED value.
 *
 * `workItemTodosService`'s `requireText` / `normalizeNotes` / `normalizeCommand`
 * all trim before they compare, so a proposal judged on the raw string would
 * reject a step the card itself would have accepted (and, worse, the reverse is
 * impossible to hit, so the asymmetry would only ever surface as a false
 * refusal nobody could reproduce from the rendered value).
 */
function trimmedLength(value: string): number {
  return value.trim().length;
}

/**
 * Validate an `add`'s proposed to-do list against the store's own bar, for a
 * proposal of `kind`.
 *
 * `undefined` / `null` pass — a proposal with no steps is the ordinary case, and
 * NOTHING here makes a list mandatory (AMENDMENT 13 D4). That a `manual` card
 * has one is a planning RULE with two homes, deliberately not a validator.
 *
 * @param todos  the proposed list, as it arrived (or as the sparse merge left it)
 * @param kind   the proposal's EFFECTIVE kind — merged, not patched: a deepen
 *               that turns an `add` carrying steps into a `story` is refused
 *               here, and it can only be seen on the merge
 * @param label  how the proposal is named in a refusal (`proposalLabel(...)`)
 */
export function validateProposedTodos(
  todos: unknown,
  kind: string,
  label: string,
): asserts todos is ProposedTodoInput[] | null | undefined {
  if (todos === undefined || todos === null) return;

  if (!Array.isArray(todos)) {
    throw new InvalidProposalError(
      `${label}: \`todos\` must be an array of steps, in the order they are performed.`,
    );
  }

  // The CONTAINER gate (AMENDMENT 13 D4). A container's steps are its CHILDREN,
  // so a story with a checklist is a story whose children were never planned —
  // and the schema is the right place to say so, rather than a reviewer three
  // days later. Read off `TYPEABLE_KINDS`, the same single source of truth the
  // leaf-only `type` / `executor` enforcement uses, so "what is a leaf" cannot
  // acquire a second answer here.
  if (todos.length > 0 && !TYPEABLE_KINDS.has(kind as WorkItemKindDto)) {
    throw new InvalidProposalError(
      `${label}: a \`${kind}\` is a container and its steps are its children, so it cannot carry a to-do list. Move the steps onto the leaf that performs them.`,
    );
  }

  todos.forEach((raw, index) => {
    const at = `${label}: step ${index + 1}`;

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidProposalError(`${at} must be an object with a \`text\`.`);
    }
    const row = raw as Record<string, unknown>;

    if (typeof row.text !== 'string' || trimmedLength(row.text) === 0) {
      throw new InvalidProposalError(`${at} must say what to do — \`text\` is required.`);
    }
    if (trimmedLength(row.text) > TODO_TEXT_MAX_LENGTH) {
      throw new InvalidProposalError(
        `${at}: a to-do is one operation, so its text is capped at ${TODO_TEXT_MAX_LENGTH} characters (this one is ${trimmedLength(row.text)}). Split it into two steps.`,
      );
    }

    if (row.notesMd !== undefined && row.notesMd !== null) {
      if (typeof row.notesMd !== 'string') {
        throw new InvalidProposalError(`${at}: \`notesMd\` must be Markdown text or null.`);
      }
      if (trimmedLength(row.notesMd) > TODO_NOTES_MAX_LENGTH) {
        throw new InvalidProposalError(
          `${at}: a to-do's instructions are capped at ${TODO_NOTES_MAX_LENGTH} characters (these are ${trimmedLength(row.notesMd)}). A step needing more than that is a work item.`,
        );
      }
    }

    if (row.commandText !== undefined && row.commandText !== null) {
      if (typeof row.commandText !== 'string') {
        throw new InvalidProposalError(`${at}: \`commandText\` must be a string or null.`);
      }
      if (trimmedLength(row.commandText) > TODO_COMMAND_MAX_LENGTH) {
        throw new InvalidProposalError(
          `${at}: a to-do's command is capped at ${TODO_COMMAND_MAX_LENGTH} characters (this one is ${trimmedLength(row.commandText)}).`,
        );
      }
    }

    if (row.executor !== undefined && row.executor !== null) {
      if (typeof row.executor !== 'string' || !PROPOSED_TODO_EXECUTORS.includes(row.executor)) {
        throw new InvalidProposalError(
          `${at}: \`executor\` must be one of ${PROPOSED_TODO_EXECUTORS.join(', ')}, or null to inherit the card's.`,
        );
      }
    }
  });
}
