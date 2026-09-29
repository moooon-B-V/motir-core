-- Story MOTIR-6590 · MOTIR-6880 — a card whose run DIED is To fix too.
--
-- ⚠️ HAND-WRITTEN `BEFORE`. The enum's DECLARATION ORDER IS PRIORITY (the To fix
-- list sorts `{ fixReason: 'asc' }` on it), and `run_died` ranks FIRST. A generated
-- `ADD VALUE` appends at the END, which would make it the LOWEST priority.
ALTER TYPE "work_item_fix_reason" ADD VALUE 'run_died' BEFORE 'queue_failed';
