-- MOTIR-7026 (docs/decisions/agent-instance-run.md §4): the two probes a start
-- reads without waking the machine — whether the pinned image carries the run
-- launcher (with the digest it was probed for), and the coding agent's last
-- answered sign-in (with its time).

-- CreateEnum
CREATE TYPE "agent_run_launcher" AS ENUM ('unknown', 'present', 'absent');

-- CreateEnum
CREATE TYPE "agent_sign_in_state" AS ENUM ('unknown', 'signed_in', 'signed_out');

-- AlterTable
ALTER TABLE "agent_instance" ADD COLUMN     "run_launcher" "agent_run_launcher" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "run_launcher_digest" TEXT,
ADD COLUMN     "sign_in_checked_at" TIMESTAMP(3),
ADD COLUMN     "sign_in_state" "agent_sign_in_state" NOT NULL DEFAULT 'unknown';
