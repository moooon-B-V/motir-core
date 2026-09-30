-- MOTIR-6993 — per-project hosted-agent model overrides, one per leaf difficulty.
-- NULL means "use motir-ai's platform default for that level".
ALTER TABLE "project" ADD COLUMN     "hosted_model_high" TEXT,
ADD COLUMN     "hosted_model_low" TEXT,
ADD COLUMN     "hosted_model_medium" TEXT,
ADD COLUMN     "hosted_model_trivial" TEXT;
