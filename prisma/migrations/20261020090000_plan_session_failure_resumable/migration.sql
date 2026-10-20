-- MOTIR-9121 — a failure record says whether its attempt can be resumed.
--
-- motir-ai refuses to resume a job that failed before its conversation settled, and
-- core offered Resume on it anyway: the session stayed failed-waiting with its target
-- held at Planning, every Resume refused and every new turn refused in favour of
-- Resume. `failure_resumable` carries motir-ai's verdict onto the record. Nullable,
-- no default: an existing failure keeps reading as resumable, as it always did.

ALTER TABLE "plan_change_session" ADD COLUMN "failure_resumable" BOOLEAN;
