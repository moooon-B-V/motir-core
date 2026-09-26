-- MOTIR-6329 (Story MOTIR-6179) — nobody loses a room they have today.
--
-- `plan:view_any` and `run:view_any` (MOTIR-6328) are the keys the Plans and
-- Runs rooms' reads start asserting in this story. Every CUSTOM project role
-- that can browse opens `/plans` and `/runs` today on `project:browse` alone,
-- so each such role gains both keys here, before any read asserts them.
--
-- APPEND ONLY, and idempotent: a key is appended only where it is absent, so a
-- re-run is a no-op and nothing is ever removed. `approval:view_any` is NOT
-- added — no custom role held it implicitly, and adding it would widen them.
--
-- API-token grants are NOT touched here, deliberately: no migration rewrites a
-- live credential's row (`prisma/schema.prisma`, the grant column's comment).
-- Their carry is read-time, in `expandStoredGrant` (`lib/tokens/grant.ts`).
UPDATE "project_role_definition"
SET "permissions" = array_append("permissions", 'plan:view_any')
WHERE 'project:browse' = ANY("permissions")
  AND NOT ('plan:view_any' = ANY("permissions"));

UPDATE "project_role_definition"
SET "permissions" = array_append("permissions", 'run:view_any')
WHERE 'project:browse' = ANY("permissions")
  AND NOT ('run:view_any' = ANY("permissions"));
