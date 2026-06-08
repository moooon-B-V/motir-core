// DTOs for the Ready-set surface (Story 7.0 — the AI dispatch surface). These
// define EXACTLY what crosses the HTTP / Server-Action boundary for `GET
// /api/ready` (the page + browse consumer) and `POST /api/ready/next` (the BYOK
// `prodect run` agent consumer). No Prisma model leaks; the service returns
// these, never raw Prisma rows — the established DTO convention (see
// `lib/dto/workItems.ts`).
//
// Two shapes, one split decision (Subtask 7.0.3). A list of 50 rows on the page
// must NOT ship 50 Markdown bodies down the wire; the page renders only an
// excerpt (`ReadyItemDto.descriptionExcerpt`). The dispatch surface, conversely,
// needs the FULL `descriptionMd` + `contextRefs` + the resolved blocker keys —
// that is the payload the agent stuffs into its prompt
// (`ReadyItemDispatchDto`). One DTO that carried everything would either
// over-fetch for the page or under-serve the agent.
//
// Wire-safe scalar choices mirror `lib/dto/workItems.ts`: enums are the
// DTO-local string-literal unions (so this module stays Prisma-free); the
// mapper owns any Prisma→wire conversion.

import type { WorkItemKindDto, WorkItemPriorityDto } from './workItems';

/**
 * NAMING — `key` is the `PROD-<n>` IDENTIFIER string, not the numeric sequence.
 *
 * The core work-item DTOs (`WorkItemSummaryDto` etc.) carry BOTH `key: number`
 * (the per-project sequence) and `identifier: string` (the `PROD-<n>` display
 * string). The Ready surface is the AGENT contract: the agent only ever wants
 * the dispatchable `PROD-<n>` string — it builds `prodect run PROD-7`, it reads
 * `blockerKeys: ["PROD-3"]`. So this DTO collapses to a single `key: string`
 * holding the identifier, and uses "key" consistently for every such field
 * (`key`, `blockerKeys`, `parentKey`). This is the vocabulary Story 7.0's prose
 * + verification recipe already use ("resolved `dependsOn` keys", "PROD-<n>").
 * A deliberate, internally-consistent surface choice — not the core DTOs'
 * numeric `key`.
 */
export interface ReadyItemDto {
  id: string;
  /** The `PROD-<n>` identifier (NOT the numeric key — see the interface doc). */
  key: string;
  kind: WorkItemKindDto;
  title: string;
  priority: WorkItemPriorityDto;
  /**
   * The work item's status: its raw workflow status `key` plus the `category`
   * that key maps to in the project's workflow (`todo` | `in_progress` |
   * `done`). A ready item is by definition non-terminal, so `category` is never
   * `done`; it is still carried so a row renders the same status pill /
   * grouping the rest of the app uses.
   */
  status: { key: string; category: string };
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  /** First ~200 chars of the description, Markdown stripped to plain text. */
  descriptionExcerpt: string | null;
}

/**
 * The dispatch payload (`POST /api/ready/next`) — `ReadyItemDto` PLUS everything
 * a coding agent needs to actually run the item: the full Markdown body, the
 * context-file references, the resolved keys of the (now-terminal) blockers that
 * had to land first, the parent key, and the ready-to-paste run command.
 */
export interface ReadyItemDispatchDto extends ReadyItemDto {
  descriptionMd: string | null;
  /**
   * File paths the agent should read before executing.
   *
   * ⚠️ NOT YET A PERSISTED FIELD. Story 7.0.3's card asserts "Subtask 2.1.5
   * added `contextRefs: string[]` to the schema" — that is FALSE; no such
   * column exists on `work_item` (verified against `prisma/schema.prisma`).
   * The DTO contract is defined here forward-compatibly (so 7.0.5 + consumers
   * can type against it), and the mapper takes `contextRefs` as a pure input
   * rather than reading a non-existent row field. The schema column is its own
   * prerequisite subtask — logged as a finding and wired as a dep of 7.0.5
   * (which is the first subtask that needs REAL values here). Until it lands,
   * the source supplies `[]`.
   */
  contextRefs: string[];
  /** Resolved `PROD-<n>` keys of the items that USED to block this one (all
   *  now terminal). Empty when the item never had blockers. */
  blockerKeys: string[];
  /** The story/task/bug parent's `PROD-<n>` key, or null for a top-level item. */
  parentKey: string | null;
  /** `prodect run <key>` — built server-side so the page's "Copy" affordance and
   *  the CLI agree on the exact string. Always matches `^prodect run PROD-\d+$`. */
  runCommand: string;
}
