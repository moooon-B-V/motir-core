-- How a code-graph outage touched an assistant turn (Story MOTIR-8136 · MOTIR-8141).
--
-- One new enum and one NULLABLE column on `plan_change_turn`, no back-fill: a null reads
-- exactly as it did before. The table's RLS policies are row-level and unchanged.
--
--   code_unreadable   `declined` (a plan-writing turn that wrote no plan) or `answered`
--                     (a question answered without the code).

-- CreateEnum
CREATE TYPE "plan_change_turn_outage" AS ENUM ('declined', 'answered');

-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN     "code_unreadable" "plan_change_turn_outage";
