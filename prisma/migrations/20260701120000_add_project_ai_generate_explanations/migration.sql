-- AI-drafted explanations opt-in (Story 7.4 · MOTIR-850): when true the
-- `generate_tree` planner drafts an `explanationMd` per proposed item, carried
-- through to the materialized work item. Default false so every existing
-- project backfills to OFF with no data step.
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "ai_generate_explanations" BOOLEAN NOT NULL DEFAULT false;
