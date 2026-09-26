-- MOTIR-688: a run-bound Motir credential (`docs/decisions/hosted-agent-run.md` §3).
-- A nullable pointer from `api_token` to the dispatch run it serves. Every existing
-- row stays NULL (an ordinary PAT or device credential). `api_token` remains a leaf:
-- nothing references it, so the revoke-by-delete contract (MOTIR-3546) is unchanged.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN "dispatch_run_id" TEXT;

-- CreateIndex
CREATE INDEX "api_token_dispatch_run_id_idx" ON "api_token"("dispatch_run_id");

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
