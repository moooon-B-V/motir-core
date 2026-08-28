import type { ExecutorDto } from '@/lib/dto/workItems';

/**
 * A single TO-DO on a work item (Story MOTIR-3808 · MOTIR-3813) — the wire
 * shape of one step of a card's own work, specified by
 * `docs/decisions/work-item-todo-list.md`.
 *
 * Drops the tenancy scalars (`workspaceId` / `workItemId` — implicit in the
 * read that serves the list) and keeps `position`, which the client needs in
 * order to compute a drop target's neighbours.
 */
export interface WorkItemTodoDto {
  id: string;
  /**
   * The step, in plain text — ONE operation. Capped at
   * `TODO_TEXT_MAX_LENGTH` by the service; never Markdown, so a renderer must
   * NOT pass it through the Markdown pipeline.
   */
  text: string;
  /**
   * The command this step runs, when it runs one. **`null` ⇔ the row is not a
   * command row** — that is a data fact, not a rendering heuristic, so a
   * client decides whether to draw a copy affordance by testing this field
   * and never by inspecting `text` (ADR §5).
   */
  commandText: string | null;
  /**
   * Who this operation is FOR. **Declarative: it authorizes nothing** (ADR
   * §2). A person may tick a `coding_agent` row; a `coding_agent` row with
   * nothing able to run it renders as the agent's with no run control — never
   * as disabled.
   */
  executor: ExecutorDto | null;
  /** The opaque fractional index this row sorts by. */
  position: string;
  /**
   * When the step was ticked, ISO-8601 — and **`null` IS the not-done state**.
   * There is no `done` boolean beside it: two fields encoding one fact can
   * disagree.
   */
  doneAt: string | null;
  /** Who ticked it. `null` when not done, and also when that member has since left. */
  doneById: string | null;
}

/**
 * A card's whole to-do list plus the two numbers its section header reads
 * (`{done} of {total} done`).
 *
 * The counts are computed in the SAME transaction as the rows, so a caller can
 * never render a header that disagrees with the list under it — which is what
 * a second, later `count()` would eventually produce.
 */
export interface WorkItemTodoListDto {
  todos: WorkItemTodoDto[];
  /** How many of `todos` are ticked. */
  done: number;
  /** `todos.length`, carried explicitly so a header needs no derivation. */
  total: number;
}
