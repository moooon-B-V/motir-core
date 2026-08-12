-- MOTIR-2680 — retire the preset project avatar.
--
-- `project.avatarIcon` / `project.avatarColor` (added by
-- 20260612135924_add_project_key_alias_and_avatar) held keys into a curated
-- icon + colour registry. That registry, its picker and its renderer are gone:
-- a project's mark is now an uploaded image (`project.image`, MOTIR-2676) and a
-- project with none renders nothing at all (docs/decisions/entity-marks.md §3).
--
-- The values are LOST, deliberately. They are keys into a map that no longer
-- exists, so there is nothing a later change could do with them — losing them
-- IS the retirement, not collateral damage.

ALTER TABLE "project" DROP COLUMN "avatarColor",
DROP COLUMN "avatarIcon";
