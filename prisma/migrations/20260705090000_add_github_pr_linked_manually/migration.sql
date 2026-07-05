-- AlterTable
ALTER TABLE "github_pull_request" ADD COLUMN     "linked_manually" BOOLEAN NOT NULL DEFAULT false;
