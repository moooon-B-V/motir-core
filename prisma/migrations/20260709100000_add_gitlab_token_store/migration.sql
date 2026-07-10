-- AlterTable
ALTER TABLE "github_installation" ADD COLUMN     "access_token_encrypted" TEXT,
ADD COLUMN     "refresh_token_encrypted" TEXT,
ADD COLUMN     "token_expires_at" TIMESTAMP(3);
