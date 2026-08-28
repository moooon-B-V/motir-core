import type { ExecutorDto } from '@/lib/dto/workItems';

/**
 * A single TO-DO on a work item (Story MOTIR-3808 · MOTIR-3814) — the wire
 * shape of one step of a card's own work, specified by
 * `docs/decisions/work-item-todo-list.md`.
 *
 * Drops the tenancy scalars (`workspaceId` / `workItemId` — implicit in the
 * read that serves the list) and keeps `position`, which the client needs in
 * order to reason about a drop target.
 */
export interface WorkItemTodoDto {
  id: string;
  /**
   * The step, in plain text — ONE operation, capped by the service at
   * `TODO_TEXT_MAX_LENGTH`. **Never Markdown**, so a renderer must not pass it
   * through the Markdown pipeline.
   */
  text: string;
  /**
   * The command this step runs, when it runs one — **on the response body, not
   * merely in the table**, because a copy affordance is discharged by a value
   * the client actually receives.
   *
   * **`null` ⇔ the row is not a command row.** That is a data fact, so a client
   * decides whether to draw the copy affordance by testing this field and never
   * by inspecting `text` for something command-shaped (ADR §5). A row with no
   * command maps to `null`, never to `''`.
   */
  commandText: string | null;
  /**
   * Who this operation is FOR. **Declarative: it authorizes nothing** (ADR §2).
   * A person may tick a `coding_agent` row; a `coding_agent` row with nothing
   * able to run it renders as the agent's with no run control — never disabled.
   */
  executor: ExecutorDto | null;
  /** The opaque fractional index this row sorts by. */
  position: string;
  /**
   * Whether the step is ticked.
   *
   * ⚠️ DERIVED FROM `doneAt`, never stored beside it. The ADR refuses an
   * `isDone` COLUMN because two columns encoding one fact can disagree in the
   * database; a boolean computed at the mapper cannot, and it saves every
   * consumer a null test on a timestamp it does not otherwise want. The
   * distinction is where the value LIVES, not whether it exists.
   */
  done: boolean;
  /** When it was ticked, ISO-8601; `null` when it is not done. */
  doneAt: string | null;
  /**
   * Who ticked it. `null` when the step is not done — and also when the person
   * who ticked it has since left the workspace, because `done_by_id` is
   * `SetNull`: the tick survives its attribution.
   */
  doneBy: { id: string; name: string } | null;
}

/** The two numbers the section header reads — `{done} of {total} done`. */
export interface TodoProgressDto {
  done: number;
  total: number;
}

/**
 * A card's whole to-do list plus its progress.
 *
 * `progress` is carried on the ENVELOPE rather than left for the client to
 * derive, and it is read inside the same transaction as any write that changes
 * it — so a header can never disagree with the list printed beneath it, which
 * is what a second, later count would eventually produce.
 */
export interface WorkItemTodoListDto {
  items: WorkItemTodoDto[];
  progress: TodoProgressDto;
}
