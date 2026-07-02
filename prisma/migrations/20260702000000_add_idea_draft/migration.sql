-- CreateTable
CREATE TABLE "idea_draft" (
    "id" TEXT NOT NULL,
    "idea" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idea_draft_expires_at_idx" ON "idea_draft"("expires_at");
