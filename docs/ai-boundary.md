# The Core ↔ AI boundary

This file is a **pointer**. The authoritative spec of the network boundary between `motir-core`
(this repo — GPL-3.0, open, user-facing) and `motir-ai` (proprietary, headless, server-to-server)
lives on the **closed side**, where it is owned and versioned:

> **`motir-ai/docs/contract.md`** — the LIVING `v1` Core ↔ AI API contract: the async job model,
> the request/response envelope, the two auth grants, the shared error taxonomy, and an
> implementation map of where every part lives in code. The boundary is built (Story 7.1).

It is kept there (not here) deliberately: the contract is owned by the closed side, and a copy in
the open repo would drift. Read `motir-ai/docs/contract.md` for the full request/response shapes,
the `jobKind` enum, the `PlanDelta` proposal format, and the environment-key inventory.

## The four open-core invariants

The contract opens with four invariants that hold for the life of the product (`contract.md` §0).
This repo is the side that **enforces** invariants 1, 2, and 4; #3 is the closed side's:

1. **Browsers never call `motir-ai` directly.** Only `motir-core`'s server-side handlers talk to
   `motir-ai`, over a private service channel. The user sees one app, one domain, one cookie; the
   GPL boundary stays a clean network interface (a network service is not a derivative work — see
   `motir-ai/README.md`, ADR-008, and `vision.html` principle #19). No client component, route
   handler reachable from the browser, or public API ever issues a request to `motir-ai`.
2. **The AI never writes the tree directly.** `motir-core` is the **sole** authority over
   `work_item` rows. `motir-ai` only ever **reads** the plan tree and **proposes** — it appends
   `PlanItem` proposals into a `Plan` via `POST /api/internal/ai/plan-proposals`
   (`lib/services/aiGenerationService.ts`), and **nothing becomes a work item until a human
   approves that plan**. There is exactly ONE proposal→tree write path:
   `POST /api/plans/[id]/approve` → `plansService.approvePlan` → `materialize`, behind the 7.12.5
   persist gate, applying the identical permission, workflow, and tenancy checks the UI uses. The
   AI has no other endpoint, credential, or code path that mutates a `work_item`. (Two earlier
   write paths are gone: the buffered whole-delta persist `POST /api/internal/ai/plan-delta`,
   removed by 7.4.4 · MOTIR-846, and the browser-side `POST /api/ai/plan-delta/approve`, removed by
   MOTIR-1747 — every planner returned an empty `planDelta`, so it never carried a proposal at
   all.)
3. **`motir-ai` holds no connection to this repo's database.** The closed side runs its own
   separate datastore and never receives a `work_item` connection string; it learns the tree only
   by asking over the read-back API. (Enforced on the closed side, but stated here so the boundary
   is unambiguous: a `motir-core` DB credential is never handed to `motir-ai`.)
4. **Reads are job-scoped and permission-checked.** Every `ai → core` read-back carries the §4b
   job-scoped token; this repo verifies it (`lib/ai/jobAuth.ts`) and runs the read inside the
   requesting user's `ServiceContext`, so the AI can read (and propose against) only what that user
   could, only for that project, only for the job's lifetime.

The server-to-server surfaces this repo owns for the boundary are the internal read-back routes
(`app/api/internal/ai/*`) — reachable only with the service credential **and** the job-scoped
token, never from a browser session. Their shapes are specified in `motir-ai/docs/contract.md` §6.
