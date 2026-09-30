-- THE AGENT TERMINAL RELAY'S TWO TABLES (Story MOTIR-6861 · MOTIR-6940),
-- `docs/decisions/agent-terminal.md` Q3 and Q8.
--
--   * `agent_terminal_ticket` — the one-shot ticket the owner's browser hands the
--     relay in its first frame. Only the SHA-256 of the 32 random bytes is kept;
--     it lives 60 seconds, is consumed by one guarded update, and expired rows
--     are deleted by `system.agent-instance-sweep`.
--   * `agent_terminal_connection` — one row per relay connection: who, which
--     agent, opened, closed, the close code and reason. NO column for anything
--     that flowed through it.
--
-- Every FK is a Prisma `@relation` (CLAUDE.md), and no index is partial.
-- CreateTable
CREATE TABLE "agent_terminal_ticket" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_terminal_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_terminal_connection" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "close_code" INTEGER,
    "close_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_terminal_connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_terminal_ticket_token_hash_key" ON "agent_terminal_ticket"("token_hash");

-- CreateIndex
CREATE INDEX "agent_terminal_ticket_expires_at_idx" ON "agent_terminal_ticket"("expires_at");

-- CreateIndex
CREATE INDEX "agent_terminal_ticket_instance_id_idx" ON "agent_terminal_ticket"("instance_id");

-- CreateIndex
CREATE INDEX "agent_terminal_ticket_user_id_idx" ON "agent_terminal_ticket"("user_id");

-- CreateIndex
CREATE INDEX "agent_terminal_ticket_workspace_id_idx" ON "agent_terminal_ticket"("workspace_id");

-- CreateIndex
CREATE INDEX "agent_terminal_connection_instance_id_opened_at_idx" ON "agent_terminal_connection"("instance_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "agent_terminal_connection_user_id_idx" ON "agent_terminal_connection"("user_id");

-- CreateIndex
CREATE INDEX "agent_terminal_connection_workspace_id_idx" ON "agent_terminal_connection"("workspace_id");

-- AddForeignKey
ALTER TABLE "agent_terminal_ticket" ADD CONSTRAINT "agent_terminal_ticket_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_terminal_ticket" ADD CONSTRAINT "agent_terminal_ticket_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "agent_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_terminal_ticket" ADD CONSTRAINT "agent_terminal_ticket_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_terminal_connection" ADD CONSTRAINT "agent_terminal_connection_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_terminal_connection" ADD CONSTRAINT "agent_terminal_connection_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "agent_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_terminal_connection" ADD CONSTRAINT "agent_terminal_connection_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, in the same migration as the tables, the `agent_instance` shape
-- (20260928220000): FORCE, gated on each row's OWN `workspace_id`; the runtime
-- role is auto-granted by the workspace RLS migration's default privileges.
ALTER TABLE "agent_terminal_ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_terminal_ticket" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_terminal_ticket_active_workspace" ON "agent_terminal_ticket"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "agent_terminal_connection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_terminal_connection" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_terminal_connection_active_workspace" ON "agent_terminal_connection"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- A SYSTEM READ ARM, `FOR SELECT` only (the `agent_instance_system_read` shape).
-- The relay holds a ticket and no tenant: it finds the ticket's row by its hash
-- system-wide, then CONSUMES it re-bound to that row's own workspace. The sweep
-- reads expired tickets across tenants the same way and deletes per workspace.
-- So nothing is ever written untenanted. PERMISSIVE: OR-ed with the policy above.
CREATE POLICY "agent_terminal_ticket_system_read" ON "agent_terminal_ticket"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "agent_terminal_connection_system_read" ON "agent_terminal_connection"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
