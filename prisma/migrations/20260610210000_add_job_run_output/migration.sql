-- Subtask 5.2.7 — record a job run's resolved output on the ledger row.
--
-- `defineJob` already returns the handler's resolved value to Inngest; this
-- column persists the JSON-safe form of it on the `succeeded` job_run row so
-- a run's summary (the attachment-GC's { scanned, deleted, failed } counts,
-- an email job's { sent } flag, …) is readable from OUR ledger / the 1.6.5
-- dashboard without round-tripping to the Inngest dashboard. Nullable —
-- `running`/`failed` rows and handlers that resolve to nothing store NULL.
ALTER TABLE "job_run" ADD COLUMN "output" JSONB;
