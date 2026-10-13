-- A PERMANENT refresh refusal, recorded on the grant (MOTIR-8170). When the
-- provider says the stored refresh token can never work again ("Given refresh
-- token does not exist"), the reconciling poll stops visiting the grant's
-- bindings until a person re-authorises, instead of spending a provider call and
-- a warn line every five minutes. EXPAND-ONLY: one nullable column, no backfill,
-- no default, no index. A grant already dead before this deploy is refused once
-- more on its next tick and is recorded then.
--
-- RLS is UNCHANGED: the column rides the existing `monitor_installation` policy
-- (row-level, not column-level).

-- AlterTable
ALTER TABLE "monitor_installation" ADD COLUMN     "refresh_revoked_at" TIMESTAMP(3);
