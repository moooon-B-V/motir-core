-- CreateTable
CREATE TABLE "email_change_request" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "new_email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_change_request_new_email_key" ON "email_change_request"("new_email");

-- CreateIndex
CREATE UNIQUE INDEX "email_change_request_token_key" ON "email_change_request"("token");

-- CreateIndex
CREATE INDEX "email_change_request_user_id_idx" ON "email_change_request"("user_id");

-- AddForeignKey
ALTER TABLE "email_change_request" ADD CONSTRAINT "email_change_request_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
