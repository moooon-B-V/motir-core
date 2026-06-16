-- AlterTable
ALTER TABLE "project" ADD COLUMN     "public_tagline" TEXT,
ADD COLUMN     "public_tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
