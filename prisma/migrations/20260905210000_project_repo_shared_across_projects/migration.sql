-- A REPOSITORY IN TWO PROJECTS IS THE ORDINARY CASE
-- Story MOTIR-4669 · subtask MOTIR-4648.
--
-- `project_repository.github_repo_id` was UNIQUE, and the model it enforced was:
-- "a realized repo is claimed by AT MOST ONE project row, so a repo created for
-- project A can never be recorded as project B's" (MOTIR-1780). That model is
-- reversed. A repository belongs to the ORGANISATION, and which projects use it
-- is visibility configuration — MOTIR-2029's rule for the code graph, applied to
-- the thing the graph is built FROM.
--
-- ⚠️ THE CONSTRAINT IS REPLACED, NOT REMOVED. Dropping a unique index without
-- putting the surviving guarantee back would take a capability away, not a
-- concept: the 409 on connecting the same repository into one project twice is
-- a real product behaviour, and it stays enforced by the DATABASE rather than
-- moving into application code where a race can slip past it.
--
--   was:  UNIQUE (github_repo_id)              -- one repo, one project, org-wide
--   now:  UNIQUE (project_id, github_repo_id)  -- one repo, at most once per project
--
-- Many NULLs remain allowed in both, which is exactly right: every `proposed`
-- row is unrealized and claims nothing.
--
-- NO BACKFILL AND NO DATA MOVEMENT. This only ever RELAXES: every row that
-- satisfied the old index satisfies the new one, because a set of rows unique on
-- `github_repo_id` is trivially unique on `(project_id, github_repo_id)`. So the
-- CreateIndex below cannot fail on existing data, in either direction of the
-- deploy — which is what makes it safe to run while the old build is still
-- serving.
--
-- RLS is untouched: `project_repository_active_workspace` predicates on
-- `workspace_id` and neither index is part of it.

-- DropIndex
DROP INDEX "project_repository_github_repo_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "project_repository_project_id_github_repo_id_key" ON "project_repository"("project_id", "github_repo_id");
