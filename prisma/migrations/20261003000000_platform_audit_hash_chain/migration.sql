-- ===========================================================================
-- The platform audit log's HASH CHAIN (MOTIR-751 · Story 10.3).
--
-- `platform_audit_log` has been append-only by convention since MOTIR-2896 (the
-- repository exposes no mutator; the RLS policy is FOR ALL because the
-- four-verb totality guard requires it). This migration makes it
-- TAMPER-EVIDENT: every row becomes a link in a SHA-256 chain.
--
--   seq        1, 2, 3, … with no gaps — assigned by the append path as
--              head.seq + 1 under a transaction-scoped advisory lock, NOT by a
--              sequence (a rolled-back append would burn a value and leave a gap
--              indistinguishable from a deleted row).
--   prev_hash  the previous row's entry_hash; NULL only for entry #1.
--   entry_hash sha256 over the row's canonical form, which includes prev_hash.
--
-- The canonical form is `lib/platform/auditChain.ts`'s v1, and the two
-- functions below are its SQL mirror. They are KEPT after the backfill, on
-- purpose: (1) `tests/platform/platformAuditChain.test.ts` holds them to
-- byte-equality with the TypeScript, so the backfill below cannot silently
-- disagree with the verifier; (2) they let anyone with a database session
-- recompute the chain without the application — the property that made plain
-- SHA-256 the choice over an HMAC (no secret is needed to verify). Both are
-- IMMUTABLE, SECURITY INVOKER, and pin `search_path`.
--
-- ⚠️ CHANGING THE FORM means a v2 in BOTH places — never an edit to these
-- functions in place: every row already written was hashed with v1.
--
-- LEGACY ROWS (written before this migration) are CHAINED, not exempted: they
-- are numbered in (created_at, id) order — the only order they have — and hashed
-- with the same v1 form, so the chain is whole from entry #1 and the verifier
-- treats them exactly like new rows. What it can NOT claim for them is that they
-- were unaltered BEFORE today: their hashes attest to their content as of this
-- migration. That is stated in `docs/decisions/platform-staff-auth.md` §3b.
--
-- RLS: the table is ENABLE + FORCE with one `app.platform_staff` arm. This runs
-- as the migration role, the BYPASSRLS owner, as every data migration here does,
-- so the backfill sees every row without binding the GUC.
-- ===========================================================================

-- 1. The columns, nullable until the backfill has filled them.
ALTER TABLE "platform_audit_log"
  ADD COLUMN "seq"        INTEGER,
  ADD COLUMN "prev_hash"  TEXT,
  ADD COLUMN "entry_hash" TEXT;

-- 2. The canonical JSON of a jsonb value: object keys sorted (byte order), no
--    whitespace. Scalars print as jsonb prints them, which for strings is the
--    same escaping JSON.stringify produces (\" \\ \b \f \n \r \t, other control
--    characters as lowercase \u00xx). plpgsql because it recurses — a LANGUAGE
--    sql body is validated at CREATE time, before the function it calls exists.
CREATE FUNCTION "platform_audit_canonical_json"(v jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  out text;
BEGIN
  IF v IS NULL THEN
    RETURN 'null';
  END IF;
  CASE jsonb_typeof(v)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_jsonb(e.k)::text || ':' || platform_audit_canonical_json(e.val), ',' ORDER BY e.k COLLATE "C"), '') || '}'
        INTO out
        FROM jsonb_each(v) AS e(k, val);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(platform_audit_canonical_json(a.el), ',' ORDER BY a.ord), '') || ']'
        INTO out
        FROM jsonb_array_elements(v) WITH ORDINALITY AS a(el, ord);
    ELSE
      out := v::text;
  END CASE;
  RETURN out;
END;
$$;

-- 3. The entry hash: sha256 (lowercase hex) over the UTF-8 bytes of
--    ["motir.platform_audit.v1", seq, createdAt ISO-8601 with ms and Z, actor,
--     actorRole, action, targetKind, targetId, targetLabel, organizationId,
--     reason, metadata, prevHash]
--    `created_at` is TIMESTAMP(3) WITHOUT TIME ZONE holding UTC (Prisma's
--    convention), so to_char renders exactly what Date#toISOString renders.
CREATE FUNCTION "platform_audit_entry_hash"(
  p_seq             integer,
  p_created_at      timestamp(3),
  p_actor_user_id   text,
  p_actor_role      text,
  p_action          text,
  p_target_kind     text,
  p_target_id       text,
  p_target_label    text,
  p_organization_id text,
  p_reason          text,
  p_metadata        jsonb,
  p_prev_hash       text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(sha256(convert_to(
    '[' || '"motir.platform_audit.v1"'
    || ',' || p_seq::text
    || ',' || to_jsonb(to_char(p_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',' || coalesce(to_jsonb(p_actor_user_id)::text, 'null')
    || ',' || coalesce(to_jsonb(p_actor_role)::text, 'null')
    || ',' || coalesce(to_jsonb(p_action)::text, 'null')
    || ',' || coalesce(to_jsonb(p_target_kind)::text, 'null')
    || ',' || coalesce(to_jsonb(p_target_id)::text, 'null')
    || ',' || coalesce(to_jsonb(p_target_label)::text, 'null')
    || ',' || coalesce(to_jsonb(p_organization_id)::text, 'null')
    || ',' || coalesce(to_jsonb(p_reason)::text, 'null')
    || ',' || platform_audit_canonical_json(p_metadata)
    || ',' || coalesce(to_jsonb(p_prev_hash)::text, 'null')
    || ']',
    'UTF8')), 'hex')
$$;

-- 4. Number the legacy rows in the only order they have.
UPDATE "platform_audit_log" AS l
   SET "seq" = n.rn
  FROM (
    SELECT "id", row_number() OVER (ORDER BY "created_at", "id")::integer AS rn
      FROM "platform_audit_log"
  ) AS n
 WHERE l."id" = n."id";

-- 5. Chain them, in seq order: each row's prev_hash is the hash just computed
--    for the row before it.
DO $$
DECLARE
  r    record;
  prev text := NULL;
  h    text;
BEGIN
  FOR r IN SELECT * FROM "platform_audit_log" ORDER BY "seq" LOOP
    h := platform_audit_entry_hash(
      r."seq", r."created_at", r."actor_user_id", r."actor_role"::text, r."action",
      r."target_kind"::text, r."target_id", r."target_label", r."organization_id",
      r."reason", r."metadata", prev
    );
    UPDATE "platform_audit_log" SET "prev_hash" = prev, "entry_hash" = h WHERE "id" = r."id";
    prev := h;
  END LOOP;
END;
$$;

-- 6. Hold the shape from here on.
ALTER TABLE "platform_audit_log"
  ALTER COLUMN "seq" SET NOT NULL,
  ALTER COLUMN "entry_hash" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "platform_audit_log_seq_key" ON "platform_audit_log"("seq");
