-- Story MOTIR-5871 · Subtask MOTIR-5956: an `overturned` gate is a DECISION, so the
-- decided-row immutability trigger holds it exactly as it holds `approved` and
-- `changes_requested` (ADR `approval-gates.md` §1's MOTIR-5952 amendment, point 6a).
-- The function's predicate ENUMERATES the decided states, so a new one is not
-- covered until it is named here. Everything else is the MOTIR-4912 body verbatim.
CREATE OR REPLACE FUNCTION enforce_approval_gate_decided_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" IN ('approved', 'changes_requested', 'overturned') THEN
    -- A `SetNull` referential action on either user FK, changing nothing else.
    IF (to_jsonb(NEW) - 'decided_by_id' - 'routed_to_id')
         = (to_jsonb(OLD) - 'decided_by_id' - 'routed_to_id')
       AND (NEW."decided_by_id" IS NULL
            OR NEW."decided_by_id" IS NOT DISTINCT FROM OLD."decided_by_id")
       AND (NEW."routed_to_id" IS NULL
            OR NEW."routed_to_id" IS NOT DISTINCT FROM OLD."routed_to_id")
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'AG_DECIDED_IMMUTABLE: approval gate % was decided (%) at % and cannot be updated',
      OLD."id", OLD."state", OLD."decided_at"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
