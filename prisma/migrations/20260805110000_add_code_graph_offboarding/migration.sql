-- CreateTable
CREATE TABLE "code_graph_offboarding" (
    "id" TEXT NOT NULL,
    "core_workspace_id" TEXT NOT NULL,
    "core_project_id" TEXT NOT NULL,
    "repo_ref" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_graph_offboarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_graph_offboarding_due_at_idx" ON "code_graph_offboarding"("due_at");

-- CreateIndex
CREATE UNIQUE INDEX "code_graph_offboarding_core_workspace_id_core_project_id_re_key" ON "code_graph_offboarding"("core_workspace_id", "core_project_id", "repo_ref");

-- ===========================================================================
-- ⚠️ NO FOREIGN KEYS — and that is the point of the table
-- ===========================================================================
-- `core_workspace_id` / `core_project_id` deliberately carry NO references to
-- `workspace` / `project`, for the reason `docs/decisions/code-graph-index-fleet.md`
-- §14.5 records: this row must OUTLIVE the rows it names. The workspace-delete
-- arm is exactly the case where the tenant is gone and this row is the ONLY
-- record that a derived code graph still needs removing.
--
-- An FK here would cascade the row away at the instant it becomes load-bearing,
-- reproducing one repo over the defect §14.1 is about: the `AiProject` FK cascade
-- destroys the `CodeRepo` rows that are the only inventory of which snapshots
-- exist, converting retained data into UNREFERENCED retained data. That is the
-- whole reason Decision 10 exists, and it would arrive here looking correct,
-- because every other id column in this schema SHOULD be a relation.
--
-- (Same reasoning, already shipped: `fleet_in_flight_slot`'s attribution columns
-- are not FKs because "a slot must survive the deletion of whatever it pointed
-- at". CLAUDE.md's rule that every FK must be modelled as a Prisma `@relation`
-- is satisfied vacuously — there is no FK here to model, in either place.)

-- ===========================================================================
-- Row-level security — code_graph_offboarding
-- ===========================================================================
-- SYSTEM-ONLY, and stated rather than defaulted (MOTIR-2166's own instruction).
-- The default for a new workspace-bearing table is a `workspace_id` policy, and
-- it is wrong here on two counts:
--
--   1. IT WOULD MAKE THE ROW UNREADABLE IN THE ONE CASE IT EXISTS FOR. The policy
--      would gate on a workspace that a workspace-delete has already removed, so
--      the immediate-removal arm — the row that matters most — would be invisible
--      to everything, including the sweep. A tenancy boundary drawn on a tenant
--      that no longer exists is not a boundary, it is a leak of the wrong kind.
--   2. IT WOULD LET A TENANT CANCEL THEIR OWN RETENTION REMOVAL. A user-reachable
--      DELETE on this table is a way to keep a derived graph past the window the
--      product promises — enforcement expressed in terms the product does NOT
--      control (`notes.html` #185).
--
-- So the policy is the narrow one, exactly as `fleet_in_flight_slot` (an
-- operational, cross-tenant table swept by `system.*` work) already does — and it
-- matches every caller's actual reach: the four lifecycle triggers enqueue
-- POST-COMMIT under `withSystemContext`, and `system.code-graph-offboard-sweep`
-- (MOTIR-2168) drains under the same. None has an active workspace at the moment
-- it writes, which is not an accident of implementation but the shape §14.5 pins.
--
-- This table holds NO customer content — a workspace id, a project id, a repo
-- reference and a due date. It is the record that customer content must GO.
--
-- ENABLE + FORCE so even the table-owner `prodect` role is subject to it
-- (production and the service writes connect as the non-BYPASSRLS `prodect_app`
-- role). The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every NEW table created by the `prodect` role, so
-- no explicit GRANT is needed.
ALTER TABLE "code_graph_offboarding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "code_graph_offboarding" FORCE ROW LEVEL SECURITY;

CREATE POLICY "code_graph_offboarding_system_only" ON "code_graph_offboarding"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
