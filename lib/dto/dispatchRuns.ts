import type { WorkItemDeliveryDto } from '@/lib/dto/github';
import type {
  DispatchCardDisposition,
  DispatchCommand,
  DispatchEventKind,
  DispatchRunOrigin,
  DispatchRunStatus,
  DispatchSkipReason,
  DispatchStopReason,
} from '@/generated/prisma/client';

// The DISPATCH RUN DTOs (Story MOTIR-1789 · MOTIR-1792), the shape
// `docs/decisions/dispatch-run-record.md` decides.
//
// ⚠️ THE VOCABULARIES ARE THE PRISMA ENUMS, ALIASED — never re-declared. A
// second copy of a closed enum is a second thing to keep total: the day the ADR
// grows a member, a hand-written union here would silently stop being able to
// carry it while every renderer downstream kept compiling. Aliasing means adding
// a member to the schema is a type error at every non-total `switch` in the
// tree, which is the whole reason the ADR made them closed.
//
// ⚠️ AND THERE IS NO PULL REQUEST, NO CI VERDICT, NO WORK-ITEM STATUS AND NO
// COST ON ANY SHAPE HERE (ADR Q3). The run says what the run DID; the read side
// JOINS the delivery set for what shipped. A field added here would be the first
// place the two could disagree, because a DTO is where a surface stops asking
// and starts rendering.

export type {
  DispatchCardDisposition,
  DispatchCommand,
  DispatchEventKind,
  DispatchRunOrigin,
  DispatchRunStatus,
  DispatchSkipReason,
  DispatchStopReason,
};

/** One LEG — one card this run owns, at its place in the run's own order. */
export interface DispatchRunCardDto {
  id: string;
  /**
   * The card's `MOTIR-<n>` key.
   *
   * ⚠️ NEVER NULL, even when the work item has been deleted: it is stored on the
   * leg precisely so a run's history stays readable after its subjects are gone.
   * `workItemId` is the one that goes null.
   */
  key: string | null;
  /** Null once the card has been deleted — the leg survives it. */
  workItemId: string | null;
  /** The run's OWN order. Never re-derive it from a dependency graph. */
  position: number;
  disposition: DispatchCardDisposition;
  /** Non-null exactly when `disposition === 'skipped'`. */
  skipReason: DispatchSkipReason | null;
  sessionBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
}

/** One entry in the ordered stream. */
export interface DispatchRunEventDto {
  id: string;
  /** Monotonic per RUN, and the stream's resume cursor. Never order by time. */
  seq: number;
  kind: DispatchEventKind;
  /** The leg this event belongs to, or null for a RUN-scoped event. */
  cardId: string | null;
  /** Structured detail. Never a log body. */
  data: unknown;
  /**
   * The opt-in log body (ADR Q4), or null.
   *
   * Null means one of three things and the surface must not guess between them:
   * the event carries no body, the run was not started with `--report-log`, or
   * the 30-day retention window has passed and the sweep cleared it.
   */
  body: string | null;
  createdAt: string;
}

/** The run HEADER plus its SET — what `/runs/[id]` renders. */
export interface DispatchRunDto {
  id: string;
  projectId: string;
  command: DispatchCommand;
  origin: DispatchRunOrigin;
  /** The scope's work-item id, or null for an unscoped run (`auto`, `batch`). */
  scopeWorkItemId: string | null;
  /** What the CLI printed for the scope. Survives the scope card's deletion. */
  scopeLabel: string | null;
  status: DispatchRunStatus;
  stopReason: DispatchStopReason | null;
  agent: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  createdById: string | null;
  /** The run's cards, in the run's own stored order. */
  cards: DispatchRunCardDto[];
  /**
   * The highest `seq` this run has stored, or 0 for a run with no events — the
   * cursor a client resumes the stream from.
   *
   * ⚠️ 0 rather than null, so `?since=<seq>` takes one type on the wire and a
   * client that has seen nothing uses the same call as one that has seen 400.
   */
  seq: number;
}

/** What the OPEN operation answers with. */
export interface DispatchRunOpenedDto {
  run: DispatchRunDto;
  /**
   * Whether this call CREATED the run, or found the one the same
   * `idempotencyKey` already opened. A repeat is a success, not an error — the
   * flag is what lets a reporter tell a first attempt from a retry without
   * comparing timestamps.
   */
  created: boolean;
}

/** What the APPEND operation answers with. */
export interface DispatchRunAppendedDto {
  runId: string;
  /** How many events this call actually wrote. */
  appended: number;
  /** The run's new highest `seq` — the cursor for the next append. */
  seq: number;
  /** Every leg this batch moved, so a caller need not re-read the run. */
  cards: DispatchRunCardDto[];
}

/**
 * One LEG with its card's DELIVERY SET joined on.
 *
 * ⚠️ THE DELIVERIES ARE JOINED, NEVER STORED. The run record holds no
 * pull-request or CI column at all (ADR Q3), so this shape is where the two
 * owners meet: the run says what it DID, `work_item_delivery` says what SHIPPED,
 * and `derivePrCiState` — the one CI derivation in the product — says whether it
 * is green. A second copy on the run row would be the first place the two could
 * disagree, and a person would then have two screens with two answers to *did
 * this ship*.
 *
 * Empty is the ordinary answer: a card the run skipped, or one whose agent has
 * not pushed yet, has no delivery and never had one.
 */
export interface DispatchRunCardWithDeliveriesDto extends DispatchRunCardDto {
  deliveries: WorkItemDeliveryDto[];
}

/** The run as the BROWSER reads it — the header, its set, and what each leg shipped. */
export interface DispatchRunDetailDto extends Omit<DispatchRunDto, 'cards'> {
  cards: DispatchRunCardWithDeliveriesDto[];
}

/**
 * One LIVE run in a project, as `/ready`'s strip reads it.
 *
 * Deliberately NARROWER than the detail shape: the strip renders a per-row
 * indicator over a list that can be long, so it needs each leg's KEY and
 * DISPOSITION and nothing else. Sending the full detail for every live run would
 * make the busiest surface in the product pay for a run view nobody opened.
 */
export interface ActiveDispatchRunDto {
  id: string;
  command: DispatchCommand;
  origin: DispatchRunOrigin;
  scopeLabel: string | null;
  startedAt: string;
  cards: Array<{ key: string | null; disposition: DispatchCardDisposition }>;
}
