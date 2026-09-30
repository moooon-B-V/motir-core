-- THE AGENT'S TERMINAL SERVER, PROBED (Story MOTIR-6861 · MOTIR-6939),
-- `docs/decisions/agent-terminal.md` Q8: after a boot whose pinned image digest
-- was not probed yet, the lifecycle runs `motir agent-terminal --help` on the
-- machine and records whether the image serves a terminal, and for which digest.
--
-- Additive only: two columns on `agent_instance` with a default, so every
-- existing row reads `unknown` / never probed and is probed on its next boot.
-- No foreign key and no new index — nothing queries by these columns; the
-- table's existing RLS policies cover them.
-- CreateEnum
CREATE TYPE "agent_terminal_server" AS ENUM ('unknown', 'present', 'absent');

-- AlterTable
ALTER TABLE "agent_instance" ADD COLUMN     "terminal_server" "agent_terminal_server" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "terminal_server_digest" TEXT;
