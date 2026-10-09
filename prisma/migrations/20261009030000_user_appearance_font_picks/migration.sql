-- Story MOTIR-7736 · Subtask MOTIR-7894: a per-locale font-set member pick on
-- the appearance preference row. Additive nullable columns only (NULL = automatic).
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_en" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_zh" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_ja" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_ko" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_de" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_fr" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_es" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_it" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_nl" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_pl" TEXT;
ALTER TABLE "user_appearance_preference" ADD COLUMN "font_pick_pt" TEXT;
