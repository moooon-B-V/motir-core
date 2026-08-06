/**
 * The `/api/v1` wire types.
 *
 * ⚠️ GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with `pnpm generate:cli-api` from the repository root (or
 * `pnpm --filter @motir/cli generate:api`, which delegates to it). CI
 * regenerates and fails on any diff, so a hand edit cannot survive a PR.
 *
 * Source: `emitOpenApiDocument()` in `lib/api/v1/openapi/emit.ts` — the same
 * value `/api/openapi/v1.json` serves. See `docs/decisions/cli-v1-client.md`.
 */
export interface paths {
    "/api/v1/projects/{projectKey}/work-items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List a project’s work items
         * @description A cursor-paged collection of a project’s work items, optionally narrowed by a filter expression. Ordered by `(createdAt, id)` ascending — the position the cursor encodes.
         *
         *     Requires the `read` scope.
         */
        get: operations["listProjectWorkItems"];
        put?: never;
        /**
         * Create a work item
         * @description Create a work item in a project. The parent, if given, is named by its key and must be a kind-legal parent in the same project.
         *
         *     Requires the `work_items:write` scope.
         */
        post: operations["createWorkItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a work item
         * @description The full work item: its own fields, its parent and children, its five link groups, its readiness verdict and its comment count. The response carries an `ETag` for use as an `If-Match` on a later update.
         *
         *     Requires the `read` scope.
         */
        get: operations["getWorkItem"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update a work item
         * @description Patch any subset of a work item’s fields. A field that is ABSENT is untouched; a field explicitly set to `null` CLEARS it. Send `If-Match` to make the update conditional on the item not having moved.
         *
         *     Requires the `work_items:write` scope.
         */
        patch: operations["updateWorkItem"];
        trace?: never;
    };
    "/api/v1/work-items/{key}/transitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the statuses a work item can move to
         * @description The workflow-legal targets from the item’s current status. An `open`-policy project permits every other status; a `restricted` one permits only the declared edges.
         *
         *     Requires the `read` scope.
         */
        get: operations["listWorkItemTransitions"];
        put?: never;
        /**
         * Move a work item to a new status
         * @description Apply a workflow transition. A status the workflow does not define and a status not reachable from here are DIFFERENT errors, because a client can fix only one of them.
         *
         *     Requires the `work_items:write` scope.
         */
        post: operations["transitionWorkItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}/links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a work item’s relationship edges
         * @description All five edge groups. An empty group is `[]`, never an absent key — to a typed client those are different things.
         *
         *     Requires the `read` scope.
         */
        get: operations["listWorkItemLinks"];
        put?: never;
        /**
         * Create a relationship edge
         * @description Link this work item to another by key. Creating an edge that already exists is a 409 — the body is valid, the state is not what the request assumed.
         *
         *     Requires the `work_items:write` scope.
         */
        post: operations["createWorkItemLink"];
        /**
         * Remove a relationship edge
         * @description Remove the edge named by its ENDPOINTS — the same pair that created it. Idempotent: 204 whether or not an edge was there, because the post-condition holds either way.
         *
         *     Requires the `work_items:write` scope.
         */
        delete: operations["deleteWorkItemLink"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List a work item’s comments
         * @description Root comments with their single-level reply threads, cursor-paged. This collection DOES report a total, because the shipped read computes it as a bounded aggregate.
         *
         *     Requires the `read` scope.
         */
        get: operations["listWorkItemComments"];
        put?: never;
        /**
         * Comment on a work item
         * @description Add a root comment, or a reply by naming a root comment as its parent. Replies are single-level: a reply to a reply is a 422.
         *
         *     Requires the `work_items:write` scope.
         */
        post: operations["createWorkItemComment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Archive a work item
         * @description A recoverable soft-remove. Does NOT cascade to children — the irreversible subtree delete is not exposed by this API at all (ADR §3).
         *
         *     Requires the `work_items:archive` scope.
         */
        post: operations["archiveWorkItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore an archived work item
         * @description The inverse of archiving. Idempotent on an item that is not archived.
         *
         *     Requires the `work_items:archive` scope.
         */
        post: operations["restoreWorkItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Who this token is
         * @description The token owner, the workspace the token is bound to, and the scopes it was granted. Call this first: the scope list is how a client discovers what its own credential may do without probing endpoints and collecting 403s.
         *
         *     Requires the `read` scope.
         */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the workspaces this token’s owner belongs to
         * @description A discovery read, and the ONE place v1 answers at the account level rather than the bound workspace: it returns the workspaces the token OWNER is a member of, so a client holding a fresh token can learn which workspace ids exist for it. Every resource endpoint stays scoped to the bound workspace.
         *
         *     Requires the `read` scope.
         */
        get: operations["listWorkspaces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the projects in this token’s workspace
         * @description Every project the token owner may browse in the bound workspace, ordered by key ascending — a total order the page addressing owns, so a cursor can never skip or duplicate a row.
         *
         *     Requires the `read` scope.
         */
        get: operations["listProjects"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{projectKey}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a project
         * @description One project by key. A project the caller may not browse answers 404, not 403 — a 403 would confirm the project exists and let a caller enumerate which keys are real.
         *
         *     Requires the `read` scope.
         */
        get: operations["getProject"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{projectKey}/sprints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List a project’s sprints
         * @description The project’s sprints in sequence order, cursor-paged.
         *
         *     Requires the `read` scope.
         */
        get: operations["listProjectSprints"];
        put?: never;
        /**
         * Create a planned sprint
         * @description Create a sprint in the `planned` state. ⚠️ TWO gates apply: the token needs `sprints:write`, AND its OWNER must be a sprint admin — a scope narrows a role and never widens it, so an ordinary member’s token is refused with the distinct `NOT_SPRINT_ADMIN` code rather than `INSUFFICIENT_SCOPE`. The `Location` header names the created sprint.
         *
         *     Requires the `sprints:write` scope.
         */
        post: operations["createSprint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{projectKey}/backlog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a project’s backlog
         * @description The to-be-planned pile, in backlog-rank order. ⚠️ Done-category items are EXCLUDED — a finished unsprinted item does not belong in the backlog. (A sprint’s members are deliberately NOT filtered that way; see `listSprintWorkItems`.) Reports a total, because the read behind it already computes one.
         *
         *     Requires the `read` scope.
         */
        get: operations["getProjectBacklog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{projectKey}/backlog/work-items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Move work items out of their sprint and back to the backlog
         * @description An atomic batch move. An EMPTY array is a deliberate 200 no-op, not an error: a script that computed an empty batch has nothing to do rather than a mistake to fix. An over-cap batch is refused WHOLE, never partially applied.
         *
         *     Requires the `sprints:write` scope.
         */
        post: operations["moveWorkItemsToBacklog"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{projectKey}/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a project’s READY set
         * @description The work items whose every `blocked_by` dependency is done — what an agent loop claims from. Each row carries its dependency edges. Reports no total: unlike the backlog, this read has no cheap bounded count.
         *
         *     Requires the `read` scope.
         */
        get: operations["getProjectReadySet"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sprints/{sprintId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a sprint
         * @description One sprint by id. A sprint in another workspace and one that never existed are the same 404 — the existence-oracle rule.
         *
         *     Requires the `read` scope.
         */
        get: operations["getSprint"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update a sprint
         * @description Patch a sprint’s name, goal or window. A COMPLETED sprint is frozen: the body is fine, the state is not, so the refusal is a 409 rather than a 422.
         *
         *     Requires the `sprints:write` scope.
         */
        patch: operations["updateSprint"];
        trace?: never;
    };
    "/api/v1/sprints/{sprintId}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start a sprint
         * @description Move a planned sprint to active. ⚠️ Losing the race to activate is a 409, not a 422: the request was valid when it was sent and another one committed first, so the right instruction is re-read-and-retry rather than fix-your-body. Starting a sprint that is not planned is a 422 — a state the caller can see from a read.
         *
         *     Requires the `sprints:write` scope.
         */
        post: operations["startSprint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sprints/{sprintId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete a sprint
         * @description Close an active sprint, optionally carrying its unfinished items over to a named target. Completing a sprint that is not active is a 422.
         *
         *     Requires the `sprints:write` scope.
         */
        post: operations["completeSprint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sprints/{sprintId}/work-items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List a sprint’s members
         * @description The items in a sprint, in rank order. ⚠️ Deliberately asymmetric with the backlog: done items STAY in their sprint, because that is what makes a completed sprint a historical record. Reports a total, because the read behind it already computes one.
         *
         *     Requires the `read` scope.
         */
        get: operations["listSprintWorkItems"];
        put?: never;
        /**
         * Move work items into a sprint
         * @description An atomic batch move into this sprint. An empty array is a 200 no-op; an item belonging to another project rejects the WHOLE batch before any write, so a partial move cannot happen.
         *
         *     Requires the `sprints:write` scope.
         */
        post: operations["moveWorkItemsToSprint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}/dispatch-prompt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the canonical coding-agent prompt for a work item
         * @description Return the server-assembled prompt for one work item — the CONTEXT / WHAT TO DO / ACCEPTANCE CRITERIA / GIT WORKFLOW sections built from the item, its parent, its dependencies and its repo — plus the repo to run it in and which git workflow it carries. A PURE READ: it does not claim the item, move its status, or change its recorded session branch, so fetching a prompt to look at it is always safe. The text is deliberately identical for every agent harness; do not rewrite it. `advisories` is never a gate — it changes what you are told, never what you may do.
         *
         *     Requires the `read` scope.
         */
        get: operations["getWorkItemDispatchPrompt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}/integration": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record a work item as integrated on a session branch
         * @description Record that a work item’s work has been integrated onto a session branch: it moves to “In review” and records the branch, in ONE transaction, which unblocks its dependents while the session pull request awaits a human merge. Optionally self-report the implementation harness and model (`implementationSource` defaults to `byok`); omit all three to leave the item’s recorded provenance untouched. Honors the project’s workflow rules — an item with no legal path to “In review” is refused and its branch is left unchanged.
         *
         *     Requires the `integration` scope.
         */
        post: operations["recordWorkItemIntegration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sessions/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close out a merged session branch
         * @description Close out a session branch after its pull request is merged: every work item recorded on the branch moves to “Done” and its recorded branch is cleared. Returns a PER-ITEM outcome (`completed` / `already_done` / `failed`) — a partial close-out is a real result, not an error: the items that could close DID, and the ones that could not are named with a reason. Read the results; do not infer an outcome from their count. A branch nothing is recorded on returns an empty list, not a 404. The branch travels in the BODY because a git ref routinely contains `/`.
         *
         *     Requires the `integration` scope.
         */
        post: operations["completeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}/expansions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit an AI expansion of a container work item
         * @description Submit an AI expansion of one CONTAINER work item (epic / story / task / bug): the planner drafts the children it should have. Returns `202` with `{ jobId, planId, statusUrl }` the moment the job is ACCEPTED — it does not wait for the planner, and the body carries no result because there is none yet. ⚠️ IMPORTANT: this does NOT create work items. The job produces a PLAN of proposals, and approving that plan in Motir is the only thing that turns a proposal into a work item. Do not report expanded children as created. ⚠️ A submit SPENDS the token owner’s AI credits, so wrapping this call in a blind retry-on-timeout costs real money — poll `statusUrl` instead of resubmitting. A leaf (subtask) cannot be expanded.
         *
         *     Requires the `work_items:write` scope.
         */
        post: operations["submitWorkItemExpansion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plans/{planId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read what became of a submitted planning job
         * @description Read a plan’s status (`generating` / `planned` / `approved` / `declined`), how many PROPOSALS it bundles, and — while it is still generating — whether the producing job is alive or already FAILED. That last distinction is the point of this endpoint: a failed job leaves its plan `generating` forever, so the plan status alone cannot tell you to stop polling. `job.reachable: false` means motir-ai could not be asked, not that the job died. A pure read; the proposal count is NOT a count of created work items.
         *
         *     Requires the `read` scope.
         */
        get: operations["getPlanStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plans/{planId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a plan with the proposals it bundles
         * @description Read a plan WITH its proposals — what a planning pass actually proposed, not just how many. Each proposal carries its `op` (`add` / `modify` / `remove`), the `proposedFields` of an `add`, the `patch` of a `modify`, and the `parentRef` / `blockedByRefs` that let you rebuild the proposed tree and its dependency edges. ⚠️ These are PROPOSALS, not work items: an `add`’s `workItemKey` is `null` and stays null until the plan is approved in Motir, which is the only path from a proposal to a work item. A plan still generating returns the proposals that have arrived so far.
         *
         *     Requires the `read` scope.
         */
        get: operations["getPlan"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{projectKey}/plan-session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open or resume the planning conversation for a scope
         * @description Open — or RESUME — the planning conversation for a project, and read its thread. Changing a plan in Motir is a multi-turn CONVERSATION: add turns, then send the accumulated intent. There is ONE thread per project per anchor set, so calling this again returns the SAME conversation, with every turn already on it — including the one the Motir web app shows. Pass `targetKeys` to anchor the conversation at specific work items ("re-plan these two"); omit it for the project-wide thread. The anchor set is the thread’s identity: order and duplicates do not matter. Opening submits nothing and costs nothing — which is why it is `read`-scoped despite being a POST (a GET that creates a row would not be safe).
         *
         *     Requires the `read` scope.
         */
        post: operations["openPlanSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{projectKey}/plan-session/turns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add one turn to the planning conversation
         * @description Add ONE turn — what you want changed about the plan. ⚠️ IMPORTANT: appending does NOT submit. The turn is persisted immediately, but no job starts, no credits are spent and no work item changes; turns ACCUMULATE until you post a submission, which is what sends them to the planner. That separation is the point — a later turn REFINES the earlier ones rather than replacing them, so "add auth to the billing epic" then "keep them under 3 points" go out as ONE coherent change. Addresses the thread by scope, so it always extends the same conversation.
         *
         *     Requires the `work_items:write` scope.
         */
        post: operations["appendPlanTurn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{projectKey}/plan-session/submissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send the thread’s accumulated intent to the planner
         * @description Send this conversation’s accumulated intent to the planner: every turn on the thread, in order, as ONE change. Returns `202` with `{ jobId, planId, statusUrl }` the moment the job is accepted — it does not wait, and the body carries no result because there is none yet. The thread stays INTACT and can be refined with another turn. ⚠️ This is the act that SPENDS the token owner’s AI credits, and it produces a PLAN of proposals: approving that plan in Motir is the only thing that turns a proposal into a work item. Submitting a thread with no turns is refused.
         *
         *     Requires the `work_items:write` scope.
         */
        post: operations["submitPlanSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work-items/{key}/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read a work item’s activity — changes, comments, or both
         * @description Read a work item’s activity in one of three views: `all` (default — comments and the change trail interleaved in timestamp order), `comments` (the discussion), or `history` (the change trail only). Every entry carries a `type` so one renderer serves all three. The `cursor` is OPAQUE and SCOPED TO ITS VIEW: echo it back verbatim, never construct or parse one, and never hand a cursor from one view to another — that is a 422, not a silent restart. A page may be SHORTER than you expect while more remains (the change scan is noise-filtered and a comment page drags whole reply threads along), so walk until `nextCursor` is `null`, never until a page looks short. `GET /api/v1/work-items/{key}/comments` still exists and is unchanged — this view is the same data through the same read, offered so one code path can walk all three.
         *
         *     Requires the `read` scope.
         */
        get: operations["getWorkItemActivity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ErrorBody: {
            code: string;
            error: string;
        };
        InternalErrorBody: {
            error: string;
        };
        PageEnvelope: {
            items: unknown[];
            nextCursor: string | null;
        };
        RankedPageEnvelope: {
            items: unknown[];
            nextCursor: string | null;
            totalCount: number;
        };
        WorkItemSummary: {
            key: string;
            /** @enum {string} */
            kind: "epic" | "story" | "task" | "subtask" | "bug";
            type: ("code" | "design" | "test" | "content" | "research" | "review" | "decision" | "deploy" | "manual" | "chore") | null;
            title: string;
            status: string;
            /** @enum {string} */
            priority: "lowest" | "low" | "medium" | "high" | "highest";
            assigneeId: string | null;
            reporterId: string;
            dueDate: string | null;
            estimateMinutes: number | null;
            storyPoints: number | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            dependencies: {
                blockedBy: {
                    key: string;
                    title: string;
                    status: string;
                }[];
                blocks: {
                    key: string;
                    title: string;
                    status: string;
                }[];
            };
        };
        WorkItemDetail: {
            key: string;
            /** @enum {string} */
            kind: "epic" | "story" | "task" | "subtask" | "bug";
            type: ("code" | "design" | "test" | "content" | "research" | "review" | "decision" | "deploy" | "manual" | "chore") | null;
            title: string;
            status: string;
            /** @enum {string} */
            priority: "lowest" | "low" | "medium" | "high" | "highest";
            assigneeId: string | null;
            reporterId: string;
            dueDate: string | null;
            estimateMinutes: number | null;
            storyPoints: number | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            descriptionMd: string | null;
            parentKey: string | null;
            ancestorKeys: string[];
            children: {
                key: string;
                /** @enum {string} */
                kind: "epic" | "story" | "task" | "subtask" | "bug";
                title: string;
                status: string;
                /** @enum {string} */
                priority: "lowest" | "low" | "medium" | "high" | "highest";
                assigneeId: string | null;
                estimateMinutes: number | null;
                storyPoints: number | null;
                parentKey: string | null;
                archived: boolean;
                dependencies: {
                    blockedBy: {
                        key: string;
                        title: string;
                        status: string;
                    }[];
                    blocks: {
                        key: string;
                        title: string;
                        status: string;
                    }[];
                };
            }[];
            links: {
                blockedBy: {
                    key: string;
                    /** @enum {string} */
                    kind: "epic" | "story" | "task" | "subtask" | "bug";
                    title: string;
                    status: string;
                    /** @enum {string} */
                    priority: "lowest" | "low" | "medium" | "high" | "highest";
                    assigneeId: string | null;
                    estimateMinutes: number | null;
                    storyPoints: number | null;
                    parentKey: string | null;
                    archived: boolean;
                }[];
                blocks: {
                    key: string;
                    /** @enum {string} */
                    kind: "epic" | "story" | "task" | "subtask" | "bug";
                    title: string;
                    status: string;
                    /** @enum {string} */
                    priority: "lowest" | "low" | "medium" | "high" | "highest";
                    assigneeId: string | null;
                    estimateMinutes: number | null;
                    storyPoints: number | null;
                    parentKey: string | null;
                    archived: boolean;
                }[];
                relatesTo: {
                    key: string;
                    /** @enum {string} */
                    kind: "epic" | "story" | "task" | "subtask" | "bug";
                    title: string;
                    status: string;
                    /** @enum {string} */
                    priority: "lowest" | "low" | "medium" | "high" | "highest";
                    assigneeId: string | null;
                    estimateMinutes: number | null;
                    storyPoints: number | null;
                    parentKey: string | null;
                    archived: boolean;
                }[];
                duplicates: {
                    key: string;
                    /** @enum {string} */
                    kind: "epic" | "story" | "task" | "subtask" | "bug";
                    title: string;
                    status: string;
                    /** @enum {string} */
                    priority: "lowest" | "low" | "medium" | "high" | "highest";
                    assigneeId: string | null;
                    estimateMinutes: number | null;
                    storyPoints: number | null;
                    parentKey: string | null;
                    archived: boolean;
                }[];
                clones: {
                    key: string;
                    /** @enum {string} */
                    kind: "epic" | "story" | "task" | "subtask" | "bug";
                    title: string;
                    status: string;
                    /** @enum {string} */
                    priority: "lowest" | "low" | "medium" | "high" | "highest";
                    assigneeId: string | null;
                    estimateMinutes: number | null;
                    storyPoints: number | null;
                    parentKey: string | null;
                    archived: boolean;
                }[];
            };
            readiness: {
                ready: boolean;
                openBlockers: {
                    key: string;
                    /** @enum {string} */
                    kind: "epic" | "story" | "task" | "subtask" | "bug";
                    title: string;
                    status: string;
                    /** @enum {string} */
                    priority: "lowest" | "low" | "medium" | "high" | "highest";
                    assigneeId: string | null;
                    estimateMinutes: number | null;
                    storyPoints: number | null;
                    parentKey: string | null;
                    archived: boolean;
                }[];
                blockedByAncestorKey: string | null;
                blockedByAncestorTitle: string | null;
            };
            labels: {
                name: string;
            }[];
            components: {
                name: string;
            }[];
            commentCount: number;
            sprintId: string | null;
            targetRepo: string | null;
            executor: ("coding_agent" | "human") | null;
            planningSource: ("native" | "mcp" | "manual" | "api") | null;
            planningHarness: string | null;
            planningModel: string | null;
            implementationSource: ("hosted" | "byok" | "manual") | null;
            implementationHarness: string | null;
            implementationModel: string | null;
            archivedAt: string | null;
        };
        WorkItemLinkGroups: {
            blockedBy: {
                key: string;
                /** @enum {string} */
                kind: "epic" | "story" | "task" | "subtask" | "bug";
                title: string;
                status: string;
                /** @enum {string} */
                priority: "lowest" | "low" | "medium" | "high" | "highest";
                assigneeId: string | null;
                estimateMinutes: number | null;
                storyPoints: number | null;
                parentKey: string | null;
                archived: boolean;
            }[];
            blocks: {
                key: string;
                /** @enum {string} */
                kind: "epic" | "story" | "task" | "subtask" | "bug";
                title: string;
                status: string;
                /** @enum {string} */
                priority: "lowest" | "low" | "medium" | "high" | "highest";
                assigneeId: string | null;
                estimateMinutes: number | null;
                storyPoints: number | null;
                parentKey: string | null;
                archived: boolean;
            }[];
            relatesTo: {
                key: string;
                /** @enum {string} */
                kind: "epic" | "story" | "task" | "subtask" | "bug";
                title: string;
                status: string;
                /** @enum {string} */
                priority: "lowest" | "low" | "medium" | "high" | "highest";
                assigneeId: string | null;
                estimateMinutes: number | null;
                storyPoints: number | null;
                parentKey: string | null;
                archived: boolean;
            }[];
            duplicates: {
                key: string;
                /** @enum {string} */
                kind: "epic" | "story" | "task" | "subtask" | "bug";
                title: string;
                status: string;
                /** @enum {string} */
                priority: "lowest" | "low" | "medium" | "high" | "highest";
                assigneeId: string | null;
                estimateMinutes: number | null;
                storyPoints: number | null;
                parentKey: string | null;
                archived: boolean;
            }[];
            clones: {
                key: string;
                /** @enum {string} */
                kind: "epic" | "story" | "task" | "subtask" | "bug";
                title: string;
                status: string;
                /** @enum {string} */
                priority: "lowest" | "low" | "medium" | "high" | "highest";
                assigneeId: string | null;
                estimateMinutes: number | null;
                storyPoints: number | null;
                parentKey: string | null;
                archived: boolean;
            }[];
        };
        CommentThread: {
            id: string;
            parentCommentId: string | null;
            authorId: string;
            author: {
                id: string;
                name: string;
            };
            bodyMd: string;
            /** Format: date-time */
            createdAt: string;
            editedAt: string | null;
            mentionedUserIds: string[];
            replies: {
                id: string;
                parentCommentId: string | null;
                authorId: string;
                author: {
                    id: string;
                    name: string;
                };
                bodyMd: string;
                /** Format: date-time */
                createdAt: string;
                editedAt: string | null;
                mentionedUserIds: string[];
            }[];
        };
        TransitionList: {
            transitions: {
                key: string;
                label: string;
                /** @enum {string} */
                category: "todo" | "in_progress" | "done";
            }[];
        };
        Me: {
            user: {
                id: string;
                name: string;
                email: string;
            };
            workspaceId: string;
            scopes: string[];
        };
        WorkspaceSummary: {
            id: string;
            name: string;
            slug: string;
            createdAt: string;
        };
        Project: {
            key: string;
            name: string;
            /** @enum {string} */
            accessLevel: "open" | "limited" | "private" | "public";
            archived: boolean;
        };
        Sprint: {
            id: string;
            name: string;
            goal: string | null;
            /** @enum {string} */
            state: "planned" | "active" | "complete";
            startDate: string | null;
            endDate: string | null;
            completedAt: string | null;
            sequence: number;
            issueCount: number;
            committedPoints: number | null;
            committedIssueCount: number | null;
        };
        ReadyItem: {
            key: string;
            /** @enum {string} */
            kind: "epic" | "story" | "task" | "subtask" | "bug";
            title: string;
            /** @enum {string} */
            priority: "lowest" | "low" | "medium" | "high" | "highest";
            status: {
                key: string;
                category: string;
            };
            type: ("code" | "design" | "test" | "content" | "research" | "review" | "decision" | "deploy" | "manual" | "chore") | null;
            executor: ("coding_agent" | "human") | null;
            assigneeId: string | null;
            assignee: {
                id: string;
                name: string;
            } | null;
            descriptionExcerpt: string | null;
            dependencies: {
                blockedBy: {
                    key: string;
                    title: string;
                    status: string;
                }[];
                blocks: {
                    key: string;
                    title: string;
                    status: string;
                }[];
            };
        };
        MembershipMoveResult: {
            movedKeys: string[];
        };
        WorkItemRef: {
            key: string;
            /** @enum {string} */
            kind: "epic" | "story" | "task" | "subtask" | "bug";
            title: string;
            status: string;
            /** @enum {string} */
            priority: "lowest" | "low" | "medium" | "high" | "highest";
            assigneeId: string | null;
            estimateMinutes: number | null;
            storyPoints: number | null;
            parentKey: string | null;
            archived: boolean;
        };
        DispatchPrompt: {
            key: string;
            prompt: string;
            targetRepo: string | null;
            targetRepoCloneUrl: string | null;
            targetRepoDefaultBranch: string | null;
            /** @enum {string} */
            workflowMode: "per_item_pr" | "session_lineage";
            sessionBranch: string | null;
            advisories: ({
                /** @constant */
                kind: "shape";
                item: string;
                severity: string;
                criterionIndex: number;
                phrase?: string;
                path?: string;
                repo?: string;
                reason?: string;
            } | {
                /** @constant */
                kind?: "reference";
                item: string;
                referenced: string;
                referencedStatus: string;
                severity: string;
            })[];
        };
        IntegrationResult: {
            key: string;
            status: string;
            sessionBranch: string | null;
            updatedAt: string;
            implementationSource: ("byok" | "manual") | null;
            implementationHarness: string | null;
            implementationModel: string | null;
        };
        SessionCloseOut: {
            sessionBranch: string;
            results: {
                key: string;
                /** @enum {string} */
                outcome: "completed" | "already_done" | "failed";
                reason?: string;
            }[];
        };
        PlanJobHandle: {
            jobId: string;
            planId: string;
            statusUrl: string;
        };
        PlanOutcome: {
            planId: string;
            /** @enum {string} */
            status: "generating" | "planned" | "approved" | "declined";
            /** @enum {string} */
            origin: "user" | "cadence";
            jobId: string | null;
            proposalCount: number;
            createdAt: string;
            plannedAt: string | null;
            decidedAt: string | null;
            job: {
                status: string | null;
                reachable: boolean;
                failure: {
                    code: string;
                    message: string;
                } | null;
            } | null;
        };
        Plan: {
            id: string;
            /** @enum {string} */
            status: "generating" | "planned" | "approved" | "declined";
            /** @enum {string} */
            origin: "user" | "cadence";
            title: string | null;
            summary: string | null;
            sourceJobId: string | null;
            proposalCount: number;
            createdAt: string;
            plannedAt: string | null;
            decidedAt: string | null;
            proposals: {
                id: string;
                /** @enum {string} */
                op: "add" | "modify" | "remove";
                workItemKey: string | null;
                proposedFields: {
                    title: string;
                    kind: string | null;
                    type: string | null;
                    priority: string | null;
                    executor: string | null;
                    storyPoints: number | null;
                    estimateMinutes: number | null;
                    descriptionMd: string | null;
                    targetRepo: string | null;
                } | null;
                patch: {
                    [key: string]: unknown;
                } | null;
                parentRef: string | null;
                blockedByRefs: string[];
            }[];
        };
        PlanSession: {
            id: string;
            targetKeys: string[];
            turnCount: number;
            lastJobId: string | null;
            lastSubmittedAt: string | null;
            createdAt: string;
            updatedAt: string;
            turns: {
                id: string;
                seq: number;
                /** @enum {string} */
                role: "user" | "system" | "assistant";
                body: string;
                jobId: string | null;
                question: string | null;
                isAnswer: boolean;
                authorId: string | null;
                createdAt: string;
            }[];
        };
        ActivityEntry: {
            /** @constant */
            type: "comment";
            comment: {
                id: string;
                parentCommentId: string | null;
                authorId: string;
                author: {
                    id: string;
                    name: string;
                };
                bodyMd: string;
                /** Format: date-time */
                createdAt: string;
                editedAt: string | null;
                mentionedUserIds: string[];
                replies: {
                    id: string;
                    parentCommentId: string | null;
                    authorId: string;
                    author: {
                        id: string;
                        name: string;
                    };
                    bodyMd: string;
                    /** Format: date-time */
                    createdAt: string;
                    editedAt: string | null;
                    mentionedUserIds: string[];
                }[];
            };
        } | {
            /** @constant */
            type: "change";
            change: {
                id: string;
                changeKind: string;
                changedAt: string;
                actor: {
                    userId: string;
                    name: string | null;
                };
                parts: ({
                    /** @constant */
                    kind: "created";
                } | {
                    /** @constant */
                    kind: "archived";
                } | {
                    /** @constant */
                    kind: "unarchived";
                } | {
                    /** @constant */
                    kind: "field";
                    field: string;
                    from: {
                        /** @constant */
                        type: "none";
                    } | {
                        /** @constant */
                        type: "text";
                        text: string;
                    } | {
                        /** @constant */
                        type: "status";
                        key: string;
                        label: string | null;
                    } | {
                        /** @constant */
                        type: "user";
                        userId: string;
                        name: string | null;
                    } | {
                        /** @constant */
                        type: "date";
                        date: string;
                    } | {
                        /** @constant */
                        type: "sprint";
                        sprintId: string;
                        name: string | null;
                    } | {
                        /** @constant */
                        type: "issue";
                        workItemKey: string | null;
                    };
                    to: {
                        /** @constant */
                        type: "none";
                    } | {
                        /** @constant */
                        type: "text";
                        text: string;
                    } | {
                        /** @constant */
                        type: "status";
                        key: string;
                        label: string | null;
                    } | {
                        /** @constant */
                        type: "user";
                        userId: string;
                        name: string | null;
                    } | {
                        /** @constant */
                        type: "date";
                        date: string;
                    } | {
                        /** @constant */
                        type: "sprint";
                        sprintId: string;
                        name: string | null;
                    } | {
                        /** @constant */
                        type: "issue";
                        workItemKey: string | null;
                    };
                } | {
                    /** @constant */
                    kind: "fieldEdited";
                    field: string;
                } | {
                    /** @constant */
                    kind: "link";
                    /** @enum {string} */
                    op: "added" | "removed";
                    linkKind: string;
                    target: {
                        /** @constant */
                        type: "none";
                    } | {
                        /** @constant */
                        type: "text";
                        text: string;
                    } | {
                        /** @constant */
                        type: "status";
                        key: string;
                        label: string | null;
                    } | {
                        /** @constant */
                        type: "user";
                        userId: string;
                        name: string | null;
                    } | {
                        /** @constant */
                        type: "date";
                        date: string;
                    } | {
                        /** @constant */
                        type: "sprint";
                        sprintId: string;
                        name: string | null;
                    } | {
                        /** @constant */
                        type: "issue";
                        workItemKey: string | null;
                    };
                } | {
                    /** @constant */
                    kind: "collection";
                    field: string;
                    /** @enum {string} */
                    op: "added" | "removed";
                    items: string[];
                } | {
                    /** @constant */
                    kind: "commentDeleted";
                    author: {
                        /** @constant */
                        type: "none";
                    } | {
                        /** @constant */
                        type: "text";
                        text: string;
                    } | {
                        /** @constant */
                        type: "status";
                        key: string;
                        label: string | null;
                    } | {
                        /** @constant */
                        type: "user";
                        userId: string;
                        name: string | null;
                    } | {
                        /** @constant */
                        type: "date";
                        date: string;
                    } | {
                        /** @constant */
                        type: "sprint";
                        sprintId: string;
                        name: string | null;
                    } | {
                        /** @constant */
                        type: "issue";
                        workItemKey: string | null;
                    };
                    replyCount: number;
                } | {
                    /** @constant */
                    kind: "generic";
                    key: string;
                    from: string | null;
                    to: string | null;
                })[];
            };
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listProjectWorkItems: {
        parameters: {
            query?: {
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. A cursor is signed and scoped to its collection — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
                /** @description Rows per page. Defaults to 50; a larger value is CLAMPED to 100 rather than rejected. */
                limit?: number;
                /** @description A serialised filter expression, in the same form the product’s own list views use. An unknown field, operator or value is a 422 naming which. */
                filter?: string;
            };
            header?: never;
            path: {
                /** @description The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of work-item summaries. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PageEnvelope"] & {
                        items?: components["schemas"]["WorkItemSummary"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    createWorkItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        /** @description The work item to create. */
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    kind: "epic" | "story" | "task" | "subtask" | "bug";
                    title: string;
                    parentKey?: string | null;
                    descriptionMd?: string | null;
                    /** @enum {string} */
                    priority?: "lowest" | "low" | "medium" | "high" | "highest";
                    type?: ("code" | "design" | "test" | "content" | "research" | "review" | "decision" | "deploy" | "manual" | "chore") | null;
                    executor?: ("coding_agent" | "human") | null;
                    storyPoints?: number | null;
                    estimateMinutes?: number | null;
                    targetRepo?: string | null;
                    assigneeId?: string | null;
                    dueDate?: string | null;
                };
            };
        };
        responses: {
            /** @description The created work item. */
            201: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItemDetail"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    getWorkItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The work item. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItemDetail"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    updateWorkItem: {
        parameters: {
            query?: never;
            header?: {
                /** @description An `ETag` from a previous read of this work item. When present, the update is refused with 412 if the item moved since that read. Omitting it means last-write-wins. */
                "If-Match"?: string;
            };
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        /** @description The fields to change. */
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    kind?: "epic" | "story" | "task" | "subtask" | "bug";
                    title?: string;
                    descriptionMd?: string | null;
                    explanationMd?: string | null;
                    parentKey?: string | null;
                    /** @enum {string} */
                    priority?: "lowest" | "low" | "medium" | "high" | "highest";
                    type?: ("code" | "design" | "test" | "content" | "research" | "review" | "decision" | "deploy" | "manual" | "chore") | null;
                    executor?: ("coding_agent" | "human") | null;
                    storyPoints?: number | null;
                    estimateMinutes?: number | null;
                    targetRepo?: string | null;
                    assigneeId?: string | null;
                    dueDate?: string | null;
                };
            };
        };
        responses: {
            /** @description The updated work item. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItemDetail"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An `If-Match` precondition failed — the resource moved since the validator was issued. */
            412: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    listWorkItemTransitions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The legal transition targets. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TransitionList"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    transitionWorkItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        /** @description The target status key. */
        requestBody: {
            content: {
                "application/json": {
                    status: string;
                };
            };
        };
        responses: {
            /** @description The work item at its new status. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItemDetail"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    listWorkItemLinks: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The five edge groups. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItemLinkGroups"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    createWorkItemLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        /** @description The other endpoint and the relationship. */
        requestBody: {
            content: {
                "application/json": {
                    toKey: string;
                    /** @enum {string} */
                    relationship: "blocked_by" | "blocks" | "relates_to" | "duplicates" | "clones";
                };
            };
        };
        responses: {
            /** @description The created edge. */
            201: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        toKey: string;
                        /** @enum {string} */
                        relationship: "blocked_by" | "blocks" | "relates_to" | "duplicates" | "clones";
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request conflicts with existing state. The body is well-formed; the state is not what the request assumed. */
            409: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    deleteWorkItemLink: {
        parameters: {
            query: {
                /** @description The other endpoint’s key. */
                toKey: string;
                /** @description The relationship to remove. */
                relationship: "blocked_by" | "blocks" | "relates_to" | "duplicates" | "clones";
            };
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The edge does not exist. */
            204: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    listWorkItemComments: {
        parameters: {
            query?: {
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. A cursor is signed and scoped to its collection — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
                /** @description Rows per page. Defaults to 50; a larger value is CLAMPED to 100 rather than rejected. */
                limit?: number;
                /** @description Root-comment order — `asc` (oldest first, the default) or `desc`. */
                order?: "asc" | "desc";
            };
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of comment threads, with the total behind it. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RankedPageEnvelope"] & {
                        items?: components["schemas"]["CommentThread"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    createWorkItemComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        /** @description The comment to add. */
        requestBody: {
            content: {
                "application/json": {
                    bodyMd: string;
                    parentCommentId?: string;
                };
            };
        };
        responses: {
            /** @description The created comment. */
            201: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        parentCommentId: string | null;
                        authorId: string;
                        author: {
                            id: string;
                            name: string;
                        };
                        bodyMd: string;
                        /** Format: date-time */
                        createdAt: string;
                        editedAt: string | null;
                        mentionedUserIds: string[];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    archiveWorkItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The archived work item. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItemDetail"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    restoreWorkItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key. Never its internal id (ADR §7). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The restored work item. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkItemDetail"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The token’s identity and granted scopes. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    listWorkspaces: {
        parameters: {
            query?: {
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. Cursors are signed and scoped to their own collection — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
                /** @description Rows per page. Defaults to 50; a larger value is CLAMPED to 100 rather than rejected. */
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of workspaces. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PageEnvelope"] & {
                        items?: components["schemas"]["WorkspaceSummary"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    listProjects: {
        parameters: {
            query?: {
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. Cursors are signed and scoped to their own collection — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
                /** @description Rows per page. Defaults to 50; a larger value is CLAMPED to 100 rather than rejected. */
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of projects. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PageEnvelope"] & {
                        items?: components["schemas"]["Project"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    getProject: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The project. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    listProjectSprints: {
        parameters: {
            query?: {
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. Cursors are signed and scoped to their own collection — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
                /** @description Rows per page. Defaults to 50; a larger value is CLAMPED to 100 rather than rejected. */
                limit?: number;
            };
            header?: never;
            path: {
                /** @description The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of sprints. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PageEnvelope"] & {
                        items?: components["schemas"]["Sprint"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    createSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        /** @description The sprint to create. */
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    goal?: string | null;
                    startDate?: string | null;
                    endDate?: string | null;
                };
            };
        };
        responses: {
            /** @description The created sprint. */
            201: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sprint"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    getProjectBacklog: {
        parameters: {
            query?: {
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. Cursors are signed and scoped to their own collection — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
                /** @description Rows per page. Defaults to 50; a larger value is CLAMPED to 100 rather than rejected. */
                limit?: number;
                /** @description A serialised filter expression, in the same grammar the product’s own list views use — never an ad-hoc `?status=&assignee=` axis. An unknown field, operator or value is a 422 naming which. */
                filter?: string;
            };
            header?: never;
            path: {
                /** @description The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of backlog items, with the total behind it. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RankedPageEnvelope"] & {
                        items?: components["schemas"]["WorkItemRef"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    moveWorkItemsToBacklog: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        /** @description The work items to move. */
        requestBody: {
            content: {
                "application/json": {
                    workItemKeys: string[];
                };
            };
        };
        responses: {
            /** @description The keys that moved, in request order. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MembershipMoveResult"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    getProjectReadySet: {
        parameters: {
            query?: {
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. Cursors are signed and scoped to their own collection — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
                /** @description Rows per page. Defaults to 50; a larger value is CLAMPED to 100 rather than rejected. */
                limit?: number;
                /** @description Narrow to one or more work-item kinds. Repeatable. An unknown kind is a 422. */
                kind?: string;
                /** @description Narrow to one or more priorities. Repeatable. An unknown priority is a 422. */
                priority?: string;
                /** @description TRI-STATE, and all three are reachable: OMIT for any assignee, the literal `none` for the unassigned bucket, or a user id for that user's items. An empty value is treated as omitted. */
                assigneeId?: string;
            };
            header?: never;
            path: {
                /** @description The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of ready work items with their dependency edges. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PageEnvelope"] & {
                        items?: components["schemas"]["ReadyItem"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    getSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. A sprint has no `MOTIR-<n>` key, so its id is its name on the wire. */
                sprintId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The sprint. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sprint"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    updateSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. A sprint has no `MOTIR-<n>` key, so its id is its name on the wire. */
                sprintId: string;
            };
            cookie?: never;
        };
        /** @description The fields to change. */
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    goal?: string | null;
                    startDate?: string | null;
                    endDate?: string | null;
                };
            };
        };
        responses: {
            /** @description The updated sprint. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sprint"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request conflicts with existing state. The body is well-formed; the state is not what the request assumed. */
            409: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    startSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. A sprint has no `MOTIR-<n>` key, so its id is its name on the wire. */
                sprintId: string;
            };
            cookie?: never;
        };
        /** @description The sprint window, if it is being set here. */
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    goal?: string | null;
                    startDate?: string | null;
                    endDate?: string | null;
                };
            };
        };
        responses: {
            /** @description The active sprint. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sprint"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request conflicts with existing state. The body is well-formed; the state is not what the request assumed. */
            409: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    completeSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. A sprint has no `MOTIR-<n>` key, so its id is its name on the wire. */
                sprintId: string;
            };
            cookie?: never;
        };
        /** @description Where unfinished items go, if anywhere. */
        requestBody: {
            content: {
                "application/json": {
                    carryOverTo?: "backlog" | {
                        sprintId: string;
                    };
                };
            };
        };
        responses: {
            /** @description The completed sprint. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sprint"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    listSprintWorkItems: {
        parameters: {
            query?: {
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. Cursors are signed and scoped to their own collection — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
                /** @description Rows per page. Defaults to 50; a larger value is CLAMPED to 100 rather than rejected. */
                limit?: number;
                /** @description A serialised filter expression, in the same grammar the product’s own list views use — never an ad-hoc `?status=&assignee=` axis. An unknown field, operator or value is a 422 naming which. */
                filter?: string;
            };
            header?: never;
            path: {
                /** @description The sprint’s id. A sprint has no `MOTIR-<n>` key, so its id is its name on the wire. */
                sprintId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of sprint members, with the total behind it. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RankedPageEnvelope"] & {
                        items?: components["schemas"]["WorkItemRef"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    moveWorkItemsToSprint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The sprint’s id. A sprint has no `MOTIR-<n>` key, so its id is its name on the wire. */
                sprintId: string;
            };
            cookie?: never;
        };
        /** @description The work items to move. */
        requestBody: {
            content: {
                "application/json": {
                    workItemKeys: string[];
                };
            };
        };
        responses: {
            /** @description The keys that moved, in request order. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MembershipMoveResult"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    getWorkItemDispatchPrompt: {
        parameters: {
            query?: {
                /** @description A session branch to FALL BACK to when this item carries no lineage of its own — the unattended-run seed. It never overrides: an item whose dependencies are already integrated, or that is itself integrated, keeps its own branch, so a caller cannot redirect a live lineage. */
                sessionBranch?: string;
            };
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key (case-insensitive). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The assembled prompt and the facts a client routes on. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DispatchPrompt"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    recordWorkItemIntegration: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key (case-insensitive). */
                key: string;
            };
            cookie?: never;
        };
        /** @description The session branch the work was integrated onto, and optional provenance. */
        requestBody: {
            content: {
                "application/json": {
                    sessionBranch: string;
                    /** @enum {string} */
                    implementationSource?: "byok" | "manual";
                    implementationHarness?: string;
                    implementationModel?: string;
                };
            };
        };
        responses: {
            /** @description The item’s new status, its recorded branch and its provenance. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntegrationResult"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    completeSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description The merged session branch, and optional provenance for every item closed. */
        requestBody: {
            content: {
                "application/json": {
                    sessionBranch: string;
                    /** @enum {string} */
                    implementationSource?: "byok" | "manual";
                    implementationHarness?: string;
                    implementationModel?: string;
                };
            };
        };
        responses: {
            /** @description The branch and one outcome per item that was recorded on it. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionCloseOut"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    submitWorkItemExpansion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The container work item’s `MOTIR-<n>` key (case-insensitive). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The job was accepted. Nothing has been planned yet — poll `statusUrl` for the outcome. */
            202: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanJobHandle"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace owner’s AI credits are exhausted. The request was valid; it was refused for want of balance, and retrying will not help until credits are topped up. */
            402: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
            /** @description A dependency this operation needs — the motir-ai planning service — could not be reached or is misconfigured. The request itself was fine; retrying later is the right response. */
            503: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    getPlanStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The plan id an expansion or plan-session submit returned. */
                planId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The plan’s status, its proposal count, and the job’s liveness. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanOutcome"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    getPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The plan id. */
                planId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The plan and its proposals. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plan"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    openPlanSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The project key, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        /** @description The optional anchor set. Omit for the project-wide thread. */
        requestBody: {
            content: {
                "application/json": {
                    targetKeys?: string[];
                };
            };
        };
        responses: {
            /** @description The thread, with every turn on it. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanSession"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    appendPlanTurn: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The project key, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        /** @description What to say in this turn, and the optional anchor set it belongs to. */
        requestBody: {
            content: {
                "application/json": {
                    targetKeys?: string[];
                    body: string;
                };
            };
        };
        responses: {
            /** @description The thread, with the new turn appended. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanSession"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request conflicts with existing state. The body is well-formed; the state is not what the request assumed. */
            409: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
    submitPlanSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The project key, e.g. `MOTIR`. */
                projectKey: string;
            };
            cookie?: never;
        };
        /** @description The optional anchor set naming which thread to submit. */
        requestBody: {
            content: {
                "application/json": {
                    targetKeys?: string[];
                };
            };
        };
        responses: {
            /** @description The job was accepted. Nothing has been planned yet — poll `statusUrl` for the outcome. */
            202: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanJobHandle"];
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The workspace owner’s AI credits are exhausted. The request was valid; it was refused for want of balance, and retrying will not help until credits are topped up. */
            402: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
            /** @description A dependency this operation needs — the motir-ai planning service — could not be reached or is misconfigured. The request itself was fine; retrying later is the right response. */
            503: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
        };
    };
    getWorkItemActivity: {
        parameters: {
            query?: {
                /** @description Which stream to read. Defaults to `all`. */
                view?: "all" | "comments" | "history";
                /** @description Page-walk direction. Omit for each view’s shipped default — `desc` (newest first) for `all` and `history`, `asc` for `comments`. */
                order?: "asc" | "desc";
                /** @description An opaque page cursor from a previous response’s `nextCursor`. Omit for the first page. Scoped to its own VIEW — one issued elsewhere is a 422, never a silent reset. */
                cursor?: string;
            };
            header?: never;
            path: {
                /** @description The work item’s `MOTIR-<n>` key (case-insensitive). */
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of activity entries, with `totalCount` the number of entries in this view. */
            200: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RankedPageEnvelope"] & {
                        items?: components["schemas"]["ActivityEntry"][];
                    };
                };
            };
            /** @description Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated. */
            401: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token is valid but its granted scopes do not include the one this operation requires. */
            403: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer. */
            404: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation. */
            422: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills. */
            429: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorBody"];
                };
            };
            /** @description An unexpected server fault. The body carries no `code`, no stack and no driver text. */
            500: {
                headers: {
                    /** @description A correlation id for this response. Echoes the request `X-Request-Id` when it is id-shaped (`[A-Za-z0-9._-]{1,128}`), otherwise newly minted. Present on every response, success and failure alike. */
                    "X-Request-Id"?: string;
                    /** @description The version of the API CONTRACT that served this response, as `MAJOR.MINOR.PATCH` — the same value as this document's `info.version`. MAJOR is the path version (`1`), MINOR moves on an additive change, PATCH on a documentation-only correction. It is NOT the deployment's release number. Present on every response, success and failure alike, so a client can check for version skew without fetching this document. */
                    "X-Motir-Api-Version"?: string;
                    /** @description The number of requests this token may make in the current window. */
                    "X-RateLimit-Limit"?: string;
                    /** @description Requests left in the current window. Reaches `0` before a 429 is returned. */
                    "X-RateLimit-Remaining"?: string;
                    /** @description Unix epoch SECONDS at which the current window resets and the budget refills. This is the value a client backs off until after a 429 — v1 sends no `Retry-After`, deliberately, because one absolute instant cannot go stale in transit the way a relative duration can. */
                    "X-RateLimit-Reset"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InternalErrorBody"];
                };
            };
        };
    };
}
