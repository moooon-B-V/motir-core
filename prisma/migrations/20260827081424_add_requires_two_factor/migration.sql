-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "requires_two_factor" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "workspace" ADD COLUMN     "requires_two_factor" BOOLEAN NOT NULL DEFAULT false;
