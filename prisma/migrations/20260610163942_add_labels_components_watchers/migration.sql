-- Labels + components + watchers data model (Story 5.4 · Subtask 5.4.1).
-- One atomic step (migration-by-concern, PRODECT_FINDINGS #20 — every table
-- lands WITH its RLS policy so there is never an unguarded window):
--   1. `label` (the project-scoped folksonomy row — `name_lower` is the
--      case-insensitive uniqueness key per project, the recorded wart-fix of
--      Jira's 'Performance'/'performance' duplicate complaint) +
--      `work_item_label` (multi-valued issue↔label join);
--   2. `component` (the admin-managed taxonomy: name + description +
--      nullable default assignee — Jira's five-way default-assignee enum
--      collapsed, recorded in the schema docs) + `work_item_component`;
--   3. `watcher` (user follows issue for notifications, distinct from
--      assignee);
--   4. ENABLE + FORCE row-level security on all five + tenancy policies.
--
-- Delete semantics:
--   * label joins CASCADE both sides — the SERVICE (5.4.2) owns
--     delete-on-last-use (a label row dies when its last join goes);
--   * `work_item_component.component_id` is RESTRICT — deliberately
--     asymmetric: a component delete must run the service's verified
--     move-or-remove flow (5.4.3) first; the DB backstops a missed path;
--   * `component.default_assignee_id` is SET NULL — a departed user clears
--     the default, never blocks;
--   * `watcher` CASCADES both sides — notification substrate, not audit
--     (the comment_mention precedent).
--
-- The Epic-6 join-predicate contract (the by-label / by-component filter
-- JOIN sketches over the `[label_id]` / `[component_id]` indexes) is
-- documented on the join models in schema.prisma, beside the 5.3.1
-- custom-field one.
--
-- RLS policy shapes (mirroring add_comments_and_rls):
--   * `label` / `component` — pure workspace gate (NON-NULL `workspace_id`,
--     always written inside an active workspace context): one PERMISSIVE FOR
--     ALL policy, USING + WITH CHECK against
--     `current_setting('app.workspace_id', true)` (missing_ok → unset GUC
--     yields NULL → row hidden — safe failure). ENABLE + FORCE so the
--     table-owner `prodect` role is subject too (production connects as the
--     non-BYPASSRLS `prodect_app`, PRODECT_FINDINGS #5). No system-admin
--     escape hatch — every row is tenanted.
--   * `work_item_label` / `work_item_component` / `watcher` — NO
--     `workspace_id` column by design (denormalized tenancy on a child row
--     could lie), so each policy JOINS through the parent `work_item` and
--     tests THAT row's `workspace_id` — structurally the
--     work_item_revision / comment_mention pattern. The EXISTS resolves via
--     `work_item_pkey` (one index lookup per row touched); WITH CHECK closes
--     the "insert a row pointing at another workspace's issue" hole.
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every NEW table created by the `prodect` role,
-- so none of the five needs an explicit GRANT (same as comment / sprint).

-- CreateTable
CREATE TABLE "label" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_lower" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_label" (
    "id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "component" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_lower" TEXT NOT NULL,
    "description" TEXT,
    "default_assignee_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_component" (
    "id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "component_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watcher" (
    "id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watcher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "label_workspace_id_idx" ON "label"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "label_project_id_name_lower_key" ON "label"("project_id", "name_lower");

-- CreateIndex
CREATE INDEX "work_item_label_label_id_idx" ON "work_item_label"("label_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_label_work_item_id_label_id_key" ON "work_item_label"("work_item_id", "label_id");

-- CreateIndex
CREATE INDEX "component_workspace_id_idx" ON "component"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "component_project_id_name_lower_key" ON "component"("project_id", "name_lower");

-- CreateIndex
CREATE INDEX "work_item_component_component_id_idx" ON "work_item_component"("component_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_component_work_item_id_component_id_key" ON "work_item_component"("work_item_id", "component_id");

-- CreateIndex
CREATE INDEX "watcher_user_id_idx" ON "watcher"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "watcher_work_item_id_user_id_key" ON "watcher"("work_item_id", "user_id");

-- AddForeignKey
ALTER TABLE "label" ADD CONSTRAINT "label_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label" ADD CONSTRAINT "label_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_label" ADD CONSTRAINT "work_item_label_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_label" ADD CONSTRAINT "work_item_label_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component" ADD CONSTRAINT "component_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component" ADD CONSTRAINT "component_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "component" ADD CONSTRAINT "component_default_assignee_id_fkey" FOREIGN KEY ("default_assignee_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_component" ADD CONSTRAINT "work_item_component_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_component" ADD CONSTRAINT "work_item_component_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watcher" ADD CONSTRAINT "watcher_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watcher" ADD CONSTRAINT "watcher_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — label / component (pure workspace gate, no escape
-- hatch — the comment / attachment / sprint shape)
-- ===========================================================================
ALTER TABLE "label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "label" FORCE ROW LEVEL SECURITY;

CREATE POLICY "label_active_workspace" ON "label"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "component" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "component" FORCE ROW LEVEL SECURITY;

CREATE POLICY "component_active_workspace" ON "component"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- ===========================================================================
-- Row-level security — work_item_label / work_item_component / watcher
-- (no workspace_id by design; the policies join through the parent
-- work_item — the work_item_revision / comment_mention pattern. The parent
-- policy composes: the inner work_item read is itself RLS-gated for
-- non-bypass roles, which is exactly the same-workspace predicate this
-- policy wants.)
-- ===========================================================================
ALTER TABLE "work_item_label" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_label" FORCE ROW LEVEL SECURITY;

CREATE POLICY "work_item_label_active_workspace" ON "work_item_label"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "work_item" wi
      WHERE wi."id" = "work_item_label"."work_item_id"
        AND wi."workspaceId" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "work_item" wi
      WHERE wi."id" = "work_item_label"."work_item_id"
        AND wi."workspaceId" = current_setting('app.workspace_id', true)
    )
  );

ALTER TABLE "work_item_component" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_component" FORCE ROW LEVEL SECURITY;

CREATE POLICY "work_item_component_active_workspace" ON "work_item_component"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "work_item" wi
      WHERE wi."id" = "work_item_component"."work_item_id"
        AND wi."workspaceId" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "work_item" wi
      WHERE wi."id" = "work_item_component"."work_item_id"
        AND wi."workspaceId" = current_setting('app.workspace_id', true)
    )
  );

ALTER TABLE "watcher" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "watcher" FORCE ROW LEVEL SECURITY;

CREATE POLICY "watcher_active_workspace" ON "watcher"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "work_item" wi
      WHERE wi."id" = "watcher"."work_item_id"
        AND wi."workspaceId" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "work_item" wi
      WHERE wi."id" = "watcher"."work_item_id"
        AND wi."workspaceId" = current_setting('app.workspace_id', true)
    )
  );
