-- Story MOTIR-6526 · Subtask MOTIR-6532: `motir continue <key>` opens its run through
-- the server's continue claim, and the open `continue` run is the lock. Expand-only:
-- one enum member, appended.
ALTER TYPE "dispatch_command" ADD VALUE 'continue';
