-- MOTIR-6519: the Motir Integration identity supports EXPIRING user tokens
-- (8 h access token + a rotating refresh token). All nullable: an identity
-- linked while the App issued non-expiring tokens has none and keeps working.
-- AlterTable
ALTER TABLE "github_identity" ADD COLUMN     "access_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "refresh_token_encrypted" TEXT,
ADD COLUMN     "refresh_token_expires_at" TIMESTAMP(3);
