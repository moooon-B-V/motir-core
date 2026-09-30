-- THE RELAY'S CHAT CHANNEL (Story MOTIR-6863 · MOTIR-7013,
-- `docs/decisions/agent-chat.md` Q4): a terminal ticket names the socket it opens,
-- and a connection row records the socket it carried. Existing rows were all
-- terminal, so both columns default to `terminal`, and the ticket route keeps
-- that default when a request names no channel. The relay redeems a ticket only
-- on its own channel's path (`/v1/terminal` or `/v1/chat`); a mismatch is 4401.
--
-- No new table, no new policy: both tables are already RLS-gated on
-- `workspace_id`, and a column inherits its table's policies. The connection row
-- stays the ONLY record of a chat (Q10): who, which agent, which channel, open and
-- close — never a frame, a transcript or a title.

-- CreateEnum
CREATE TYPE "agent_terminal_channel" AS ENUM ('terminal', 'chat');

-- AlterTable
ALTER TABLE "agent_terminal_ticket" ADD COLUMN "channel" "agent_terminal_channel" NOT NULL DEFAULT 'terminal';

-- AlterTable
ALTER TABLE "agent_terminal_connection" ADD COLUMN "channel" "agent_terminal_channel" NOT NULL DEFAULT 'terminal';
