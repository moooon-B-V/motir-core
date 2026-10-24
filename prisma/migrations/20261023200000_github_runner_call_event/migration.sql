-- THE GITHUB RUNNER-CALL LEDGER (Story MOTIR-8953 · MOTIR-8969).
--
-- One row per runner mint or delete that reached GitHub, keyed on the RUNNER'S
-- GitHub org (the repo owner the JIT config was minted in), never on the
-- machine's account. A registration costs GitHub capacity whether or not a
-- machine then booted, and GitHub exposes no read of an org's registration count,
-- so the headroom pass counts from here. Pruned to about two hours by the pass.
--
-- Platform bookkeeping with no workspace, like `fleet_shard`: RLS admits
-- `app.system_admin` only.

CREATE TYPE "github_runner_call_kind" AS ENUM ('mint', 'delete');

CREATE TABLE "github_runner_call_event" (
  "id"             TEXT NOT NULL,
  "github_org"     TEXT NOT NULL,
  "kind"           "github_runner_call_kind" NOT NULL,
  "at"             TIMESTAMP(3) NOT NULL,
  "fleet_shard_id" TEXT,
  CONSTRAINT "github_runner_call_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "github_runner_call_event_org_lower_check" CHECK ("github_org" = lower("github_org"))
);

CREATE INDEX "github_runner_call_event_github_org_at_idx"
  ON "github_runner_call_event"("github_org", "at");
CREATE INDEX "github_runner_call_event_at_idx" ON "github_runner_call_event"("at");

ALTER TABLE "github_runner_call_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_runner_call_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_runner_call_event_system_only" ON "github_runner_call_event"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
