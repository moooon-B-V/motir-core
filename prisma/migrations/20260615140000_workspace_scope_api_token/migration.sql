-- Workspace-scope API tokens (Story 7.8 · bug 7.21). A PAT now belongs to ONE
-- workspace (the verified Linear mirror), captured from the creator's active
-- workspace at mint time; the MCP bearer gate resolves the request workspace
-- from this column instead of the owner's default workspace (the bug 7.21 fix).
--
-- Forward-safe for existing rows: add the column nullable, BACKFILL each token
-- to its owner's OLDEST workspace membership (the same workspace the old
-- `resolveActiveWorkspace(user, null)` path would have picked — so a legacy
-- token keeps the behaviour it shipped with), DROP any token whose owner has no
-- membership (an unusable orphan — a PAT with no reachable workspace), then make
-- the column NOT NULL and wire the index + FK. On a fresh DB the table is empty,
-- so the backfill/delete are no-ops.

-- AlterTable — add nullable, then tighten after backfill.
ALTER TABLE "api_token" ADD COLUMN "workspace_id" TEXT;

-- Backfill: the owner's oldest workspace membership (createdAt asc = the
-- auto-created default first), matching the retired default-workspace resolution.
UPDATE "api_token" t
   SET "workspace_id" = (
     SELECT m."workspaceId"
       FROM "workspace_membership" m
      WHERE m."userId" = t."user_id"
      ORDER BY m."createdAt" ASC
      LIMIT 1
   );

-- Drop orphans: a token whose owner has zero memberships can bind to no
-- workspace and is unusable under workspace-scoped auth.
DELETE FROM "api_token" WHERE "workspace_id" IS NULL;

ALTER TABLE "api_token" ALTER COLUMN "workspace_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "api_token_workspace_id_idx" ON "api_token"("workspace_id");

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
