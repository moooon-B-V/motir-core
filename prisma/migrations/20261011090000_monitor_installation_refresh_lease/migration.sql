-- MOTIR-8184: a token refresh no longer holds a row lock and a transaction
-- across the provider call. The single-flight guarantee moves onto a LEASE
-- column set and cleared in two short transactions, and a refresh that got no
-- answer is recorded as uncertain instead of being forgotten.
-- AlterTable
ALTER TABLE "monitor_installation" ADD COLUMN     "refresh_lease_until" TIMESTAMP(3),
ADD COLUMN     "refresh_uncertain_at" TIMESTAMP(3);
