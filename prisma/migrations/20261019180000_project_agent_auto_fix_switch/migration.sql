-- PROJECT AGENT AUTO-FIX SWITCH (Story MOTIR-8981 · MOTIR-9060).
--
-- Whether a delivery set reported red starts the fix in the card's own agent on
-- its own. One boolean, off for every existing and every new project.
--
-- `NOT NULL DEFAULT false` IS the whole data step: a project that predates the
-- column is correctly off, so there is nothing to copy forward.
ALTER TABLE "project" ADD COLUMN "agent_auto_fix_enabled" BOOLEAN NOT NULL DEFAULT false;
