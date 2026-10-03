-- MOTIR-7406: remember why a stop was begun, so a stop the sweep settles closes
-- the interval with that reason. Nullable: null outside `hibernating`, and on a
-- row that entered it before this column existed (the settle falls back to
-- `hibernated`, its old behaviour).
ALTER TABLE "agent_instance" ADD COLUMN "hibernate_reason" "agent_instance_interval_end_reason";
