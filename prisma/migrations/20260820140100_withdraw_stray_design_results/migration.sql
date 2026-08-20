-- ===========================================================================
-- Withdraw the design results published by pull requests that authored NO
-- design (MOTIR-3215 — the data half; MOTIR-3213 is the publisher fix)
-- ===========================================================================
-- WHY THIS EXISTS. `upload-design-assets.mjs` computes the design files a pull
-- request changed by diffing against its merge base. MOTIR-3104 added a guard
-- for the case where that base is wrong; MOTIR-3213 found the guard could never
-- fire in CI's depth-1 clone, because a shallow graft hides HEAD's parents. So
-- the publisher fell through and attributed whatever `design/**` it could see to
-- whichever card the open branch named. MOTIR-3213's fix (#2200) stops any NEW
-- row being written this way. This clears the rows the ungated publisher already
-- wrote onto the live tenant.
--
-- The harm is the one the uploader's own header names: "the design gate that
-- reads it would pass on a lie." Each of these cards renders a Design result
-- panel claiming somebody designed a surface for it. MOTIR-3064 carries 101
-- assets it has nothing to do with.
--
-- WHY A MIGRATION AND NOT A CONSOLE SESSION. Same precedent, and the same
-- reasoning, as `20260819090000_retire_spurious_project_repo_rows` and
-- `20260805150000_clear_cancelled_manual_provenance`: a migration states the
-- footprint up front, is reviewable BEFORE it executes, and self-applies through
-- the `prisma migrate deploy` every release already runs — rather than depending
-- on somebody remembering to run a script against production afterwards.
--
-- WHY IT NAMES IDS RATHER THAN A PREDICATE. Unlike the two migrations above,
-- the defect's signature is NOT expressible in SQL: "the publishing pull request
-- changed no file under design/" is a fact about GitHub, reachable only by
-- resolving `ci_run_url` -> workflow run -> head branch -> pull request -> file
-- list. The detection is therefore a script (`scripts/design-evidence/
-- detect-stray-design-results.mjs`) and its OUTPUT is what this migration
-- carries. The ids below are that output, re-measured against production on
-- 2026-08-20 immediately before this file was written; every one was present,
-- with the asset count named beside it.
--
-- THE POPULATION — every `design_evidence` row (47 of them) cross-checked
-- against its publishing pull request's PAGINATED file list:
--
--   evidence id                  card         PR     design files   assets
--   ---------------------------- ------------ ------ ------------ --------
--   cmt1a0dcd0016i2n8a2sfu5gu    MOTIR-3049   #2187            0          3
--   cmt0gvj0c01f0i3ph2aqxnjuh    MOTIR-3148   #2166            0          4
--   cmszugnbs01jni2phn4z7bloo    MOTIR-3064   #2134            0        101
--   cmsyn7ygl003hi2n8vmqghvkw    MOTIR-2902   #2114            0          5
--   cmsymciqf0109i4phl73opanu    MOTIR-2902   #2114            0          3  (already superseded)
--
-- Four are CURRENT; the fifth is MOTIR-2902's earlier stray, which the second
-- stray superseded. It is withdrawn too: `is_current = false` already keeps it
-- off the panel, but leaving it unstamped would record it as an ordinary
-- superseded design result, which is exactly the wrong answer this table's new
-- `withdrawn_at` column exists to stop. After this runs, MOTIR-2902 has no
-- design result of any kind on record that is not marked withdrawn.
--
-- NOT IN THIS SET, and each excluded on measurement rather than by assumption:
--
--   · MOTIR-3122 (#2161, evidence cmt0di2xm025bi2phyaxua2ki). MOTIR-3215's own
--     description lists this as an OVER-publish, 138 assets against "100" design
--     files. The 100 is an artifact of the measuring instrument: `gh pr view
--     --json files` caps its file list at 100 entries. The paginated REST list
--     (`gh api --paginate /repos/{o}/{r}/pulls/2161/files`) returns 140 files, of
--     which 138 are under `design/` — exactly the asset count. It is a correct
--     publish and is left alone.
--   · MOTIR-3113 / 3114 / 3115 / 3116 / 3117 / 3118 / 3142 / 3169, all published
--     off parent pull request #2163. That branch is a parent-run container and
--     the assets were re-addressed to the children whose commits produced them —
--     the shape MOTIR-3177 fixed, not this one.
--   · Every remaining row's asset count is <= its pull request's design-file
--     count with a non-zero denominator, i.e. it published a subset of what it
--     authored.
--
-- WHAT IS NOT DONE HERE. The blobs stay. `design_asset` rows stay, and so do
-- their `attachment` rows: unlinking them would hand the objects to the
-- orphan-GC and destroy the only evidence of what was wrongly published. A
-- withdrawal is a correction to the RECORD, not a deletion of it — which is the
-- same position `declinePlan` reached in MOTIR-3154/MOTIR-3160 one table over.
--
-- IDEMPOTENT + SAFE ON ANY OTHER DATABASE. The `WHERE id IN (...)` names five
-- cuids that exist in exactly one tenant; on a fresh or self-hosted database it
-- matches nothing and this migration is a no-op. `withdrawn_at IS NULL` in the
-- predicate makes a re-run leave an already-recorded withdrawal (and its actor)
-- untouched rather than re-stamping it with a later timestamp.

UPDATE "design_evidence"
   SET "is_current"      = FALSE,
       "withdrawn_at"    = NOW(),
       -- NULL actor = the system withdrew it. There is no person to name: this
       -- is a repair of rows the publisher wrote unattended.
       "withdrawn_by_id" = NULL,
       "withdrawn_reason" =
         'Withdrawn by MOTIR-3215: published by a pull request that changed no file under design/. '
         || 'The publisher''s merge-base guard could not fire in CI''s depth-1 clone (MOTIR-3213), '
         || 'so these assets were attributed to whichever card the open branch named.',
       "updated_at"      = NOW()
 WHERE "id" IN (
         'cmt1a0dcd0016i2n8a2sfu5gu',  -- MOTIR-3049, PR #2187, 3 assets
         'cmt0gvj0c01f0i3ph2aqxnjuh',  -- MOTIR-3148, PR #2166, 4 assets
         'cmszugnbs01jni2phn4z7bloo',  -- MOTIR-3064, PR #2134, 101 assets
         'cmsyn7ygl003hi2n8vmqghvkw',  -- MOTIR-2902, PR #2114, 5 assets
         'cmsymciqf0109i4phl73opanu'   -- MOTIR-2902, PR #2114, 3 assets (superseded)
       )
   AND "withdrawn_at" IS NULL;
