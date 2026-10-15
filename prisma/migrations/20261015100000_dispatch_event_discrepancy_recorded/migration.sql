-- MOTIR-8655 (Story MOTIR-8651, a run builds through a plan that is wrong only about the
-- HOW): the SERVER-WRITTEN event a run's discrepancy record leaves on its leg
-- (`record_run_discrepancy`; decision page MOTIR-8654). CARD-scoped, one per leg, with a
-- pointer-only `data`. Additive: a new enum member, no row changes — so it is usable by
-- the release before it (MOTIR-8315 expand step).
ALTER TYPE "dispatch_event_kind" ADD VALUE IF NOT EXISTS 'discrepancy_recorded';
