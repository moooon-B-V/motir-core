-- Per-token SCOPES (Story 7.7 · Subtask 7.7.16). A capability boundary that
-- NARROWS the token owner's 6.4 role to a subset of MCP operations; the
-- dispatch gate (7.7.17) allows a tool only if the token carries the scope it
-- maps to (`lib/mcp/scopes.ts`). New rows always get an explicit scope list from
-- `apiTokensService.create` (the caller's choice, or DEFAULT_TOKEN_SCOPES =
-- all-scopes-minus-delete when omitted); the column default is the empty array.
--
-- AlterTable — add the column (Prisma scalar-list default: empty array).
ALTER TABLE "api_token" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill EXISTING tokens to the default grant set (all scopes EXCEPT
-- `work_items:delete`). A token minted before scopes existed was minted without
-- an explicit choice, so it gets the same default a fresh token would — this
-- keeps every legacy token fully usable (minus the irreversible delete) once the
-- 7.7.17 enforcement gate lands, instead of leaving it with an empty (deny-all)
-- scope set. On a fresh DB the table is empty, so this is a no-op.
UPDATE "api_token"
   SET "scopes" = ARRAY[
     'read',
     'work_items:write',
     'work_items:archive',
     'sprints:write',
     'integration'
   ]::TEXT[]
 WHERE "scopes" = ARRAY[]::TEXT[];
