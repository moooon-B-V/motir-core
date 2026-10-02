-- Story MOTIR-727 · MOTIR-7294 — when motir-ai's platform usage rollup accepted a
-- settled container's / a charged storage day's meter report. NULL until then; the
-- backfill sends only rows still NULL, so a second run sends nothing new.
ALTER TABLE "ci_container_usage" ADD COLUMN "platform_meter_reported_at" TIMESTAMP(3);
ALTER TABLE "agent_instance_storage_charge" ADD COLUMN "platform_meter_reported_at" TIMESTAMP(3);
