-- A TERMINAL RELAY THAT DIES LEAVES NO ROW OPEN FOR EVER (MOTIR-6959, Story
-- MOTIR-6861). Two columns on `agent_terminal_connection`, additive only:
--
--   * `relay_machine_id` — which relay process holds the row (`FLY_MACHINE_ID`,
--     or hostname+pid off Fly). A relay's boot closes its own leftovers by it.
--   * `last_seen_at` — refreshed by the holding relay about once a minute while
--     the row is open. `system.agent-instance-sweep` closes an open row not seen
--     for 5 minutes, `relay_lost`, with `closed_at = last_seen_at`.
--
-- No backfill: the table has not shipped, and the DEFAULT gives any existing row
-- a `last_seen_at` of this migration's time (so an old open row is swept five
-- minutes after it rather than at once). The RLS policies are table-wide and
-- need nothing for new columns. No index is partial (CLAUDE.md): open rows are
-- found through `closed_at` as the leading column.
-- AlterTable
ALTER TABLE "agent_terminal_connection" ADD COLUMN     "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "relay_machine_id" TEXT;

-- CreateIndex
CREATE INDEX "agent_terminal_connection_closed_at_last_seen_at_idx" ON "agent_terminal_connection"("closed_at", "last_seen_at");

-- CreateIndex
CREATE INDEX "agent_terminal_connection_relay_machine_id_closed_at_idx" ON "agent_terminal_connection"("relay_machine_id", "closed_at");
